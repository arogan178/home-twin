"""IESNA LM-63 and EULUMDAT photometric files and the direct illuminance they support.

A parsed distribution replaces the uniform beam cone with the luminaire's
measured candela values. The result is still a direct point-source
calculation: no inter-reflection, no material response, no daylight. Candela
values already carry the luminaire's own optical losses, so the lumen-method
utilization factor is not applied on this path.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, replace
from itertools import islice
from math import acos, atan2, cos, degrees, isfinite, pi, radians, sqrt
from pathlib import Path

from home_twin.model import Point3D

PHOTOMETRIC_METHOD = "ies_lm63_point_v1"

_TYPE_C = 1


@dataclass(frozen=True, slots=True)
class IesPhotometry:
    """A Type C candela distribution, indexed by horizontal then vertical angle.

    Candela values are already scaled by the file's own candela multiplier and
    ballast factor, so ``candela`` holds the intensity to use directly.
    """

    vertical_angles: tuple[float, ...]
    horizontal_angles: tuple[float, ...]
    candela: tuple[tuple[float, ...], ...]
    rated_lumens: float | None
    input_watts: float | None
    source: str
    # Lamp lumens a relative (LDT) table was scaled to; None for absolute photometry.
    lamp_lumens: float | None = None

    @property
    def rotationally_symmetric(self) -> bool:
        return len(self.horizontal_angles) == 1

    def intensity(self, vertical_deg: float, horizontal_deg: float) -> float:
        """Interpolated candela, or zero outside the tabulated vertical range.

        A downlight measured over 0..90 degrees emits nothing upwards, so an
        angle past the table is zero rather than the nearest reading.
        """

        if not self.vertical_angles[0] <= vertical_deg <= self.vertical_angles[-1]:
            return 0.0
        if self.rotationally_symmetric:
            return _interpolate(self.vertical_angles, self.candela[0], vertical_deg)
        lower, upper, weight = _bracket(self.horizontal_angles, self._fold_horizontal(horizontal_deg))
        low = _interpolate(self.vertical_angles, self.candela[lower], vertical_deg)
        high = _interpolate(self.vertical_angles, self.candela[upper], vertical_deg)
        return low + (high - low) * weight

    def luminous_flux_lm(self) -> float:
        """Zonal-lumen sum of the tabulated intensities.

        Its use is checking a parsed file against the rating it declares; a
        large disagreement means the file was read wrongly or is mislabelled.
        """

        means = [self._mean_intensity(index) for index in range(len(self.vertical_angles))]
        total = 0.0
        for index in range(len(self.vertical_angles) - 1):
            lower = radians(self.vertical_angles[index])
            upper = radians(self.vertical_angles[index + 1])
            solid_angle = 2 * pi * abs(cos(lower) - cos(upper))
            total += solid_angle * (means[index] + means[index + 1]) / 2
        return total

    def rotationally_averaged(self) -> IesPhotometry:
        """The mean over every rotation of the luminaire about its aiming axis.

        How a lamp is seated in its fitting is not recorded, so no azimuth in
        the file can be tied to the building. Flux and on-axis intensity are kept.
        """

        if self.rotationally_symmetric:
            return self
        mean = tuple(self._mean_intensity(index) for index in range(len(self.vertical_angles)))
        return replace(self, horizontal_angles=(0.0,), candela=(mean,))

    def _mean_intensity(self, index: int) -> float:
        """Trapezoidal mean over the tabulated azimuths.

        Folding makes a half or quadrant table's mean the full-circle mean, and
        the half weight on the ends stops a closing C360 plane counting twice.
        """

        angles = self.horizontal_angles
        values = [plane[index] for plane in self.candela]
        span = angles[-1] - angles[0]
        if span <= 0:
            return sum(values) / len(values)
        area = sum(
            (angles[i + 1] - angles[i]) * (values[i] + values[i + 1]) / 2 for i in range(len(angles) - 1)
        )
        return area / span

    def _fold_horizontal(self, horizontal_deg: float) -> float:
        """Map any azimuth onto the quadrant or half the file actually tabulates."""

        angle = horizontal_deg % 360.0
        span = self.horizontal_angles[-1]
        if span <= 90.0:
            if angle > 180.0:
                angle = 360.0 - angle
            if angle > 90.0:
                angle = 180.0 - angle
        elif span <= 180.0 and angle > 180.0:
            angle = 360.0 - angle
        return min(max(angle, self.horizontal_angles[0]), span)


def _bracket(angles: tuple[float, ...], angle: float) -> tuple[int, int, float]:
    if angle <= angles[0]:
        return 0, 0, 0.0
    if angle >= angles[-1]:
        last = len(angles) - 1
        return last, last, 0.0
    upper = bisect_left(angles, angle)
    lower = upper - 1
    span = angles[upper] - angles[lower]
    return lower, upper, (angle - angles[lower]) / span if span > 0 else 0.0


def _interpolate(angles: tuple[float, ...], values: tuple[float, ...], angle: float) -> float:
    lower, upper, weight = _bracket(angles, angle)
    return values[lower] + (values[upper] - values[lower]) * weight


def _count(value: float, label: str, source: str) -> int:
    if not isfinite(value) or value < 1 or value != int(value):
        raise ValueError(f"{source}: the number of {label} must be a positive whole number, not {value}")
    return int(value)


def _require_ascending(angles: tuple[float, ...], label: str, source: str) -> None:
    if any(later < earlier for earlier, later in zip(angles, angles[1:], strict=False)):
        raise ValueError(f"{source}: the {label} angles are not in ascending order")


def _numbers(text: str, source: str) -> list[float]:
    values: list[float] = []
    for token in text.replace(",", " ").split():
        try:
            values.append(float(token))
        except ValueError as error:
            raise ValueError(f"{source}: {token!r} in the photometric block is not a number") from error
    return values


def parse_ies(text: str, *, source: str = "<memory>") -> IesPhotometry:
    """Parse an LM-63 file of any year into a Type C distribution.

    The numeric block is tokenised as one stream rather than line by line,
    because the standard lets a writer wrap those values anywhere.
    """

    lines = text.splitlines()
    tilt_index = next((index for index, line in enumerate(lines) if line.strip().upper().startswith("TILT=")), None)
    if tilt_index is None:
        raise ValueError(f"{source}: no TILT= line, so this is not an IESNA LM-63 file")
    tilt = lines[tilt_index].strip().upper().removeprefix("TILT=").strip()
    stream = iter(_numbers(" ".join(lines[tilt_index + 1 :]), source))

    def take(count: int) -> list[float]:
        values = list(islice(stream, count))
        if len(values) != count:
            raise ValueError(f"{source}: the photometric block ends before its declared values")
        return values

    if tilt == "INCLUDE":
        take(1)
        take(2 * _count(take(1)[0], "tilt angle pairs", source))

    header = take(10)
    lamp_count, lumens_per_lamp, multiplier = header[0], header[1], header[2]
    vertical_count = _count(header[3], "vertical angles", source)
    horizontal_count = _count(header[4], "horizontal angles", source)
    photometric_type = int(header[5])
    if photometric_type != _TYPE_C:
        raise ValueError(
            f"{source}: only Type C photometry is supported, and this file states type {photometric_type}"
        )
    ballast_factor, _, input_watts = take(3)
    if multiplier <= 0 or ballast_factor <= 0:
        raise ValueError(f"{source}: the candela multiplier and ballast factor must both be positive")

    vertical = tuple(take(vertical_count))
    horizontal = tuple(take(horizontal_count))
    _require_ascending(vertical, "vertical", source)
    _require_ascending(horizontal, "horizontal", source)
    scale = multiplier * ballast_factor
    candela = tuple(tuple(value * scale for value in take(vertical_count)) for _ in range(horizontal_count))

    return IesPhotometry(
        vertical_angles=vertical,
        horizontal_angles=horizontal,
        candela=candela,
        rated_lumens=lamp_count * lumens_per_lamp if lumens_per_lamp >= 0 else None,
        input_watts=input_watts if input_watts > 0 else None,
        source=source,
    )


# EULUMDAT symmetry code -> the C-plane span the file stores. Code 3, symmetry
# about C90-C270, stores a range the Type C folding here cannot express.
_LDT_SPAN = {0: 360.0, 1: 0.0, 2: 180.0, 4: 90.0}


def parse_ldt(text: str, *, lumens: float, source: str = "<memory>") -> IesPhotometry:
    """Parse a EULUMDAT file into the same Type C distribution an IES file gives.

    LDT intensities are relative, in candela per 1000 lamp lumens, so the lamp's
    rated ``lumens`` sets the scale. The file's own lamp sets are not used: a
    family file lists sibling products, and none need be the lamp installed.
    """

    if not isfinite(lumens) or lumens <= 0:
        raise ValueError(f"{source}: an LDT file needs the lamp's rated lumens to scale its relative intensities")
    lines = [line.strip() for line in text.splitlines()]

    def number(index: int) -> float:
        try:
            return float(lines[index].replace(",", "."))
        except (IndexError, ValueError) as error:
            raise ValueError(f"{source}: line {index + 1} is not the number EULUMDAT puts there") from error

    symmetry = int(number(2))
    if symmetry not in _LDT_SPAN:
        raise ValueError(f"{source}: EULUMDAT symmetry {symmetry} is not supported")
    plane_count = _count(number(3), "C planes", source)
    vertical_count = _count(number(5), "gamma angles", source)
    light_output_ratio = number(22) / 100
    intensity_factor = number(23)
    lamp_sets = _count(number(25), "lamp sets", source)

    stream = iter(_numbers(" ".join(lines[26 + 6 * lamp_sets + 10 :]), source))

    def take(count: int) -> list[float]:
        values = list(islice(stream, count))
        if len(values) != count:
            raise ValueError(f"{source}: the intensity block ends before its declared values")
        return values

    horizontal = take(plane_count)
    vertical = tuple(take(vertical_count))
    span = _LDT_SPAN[symmetry]
    stored = {0: plane_count, 1: 1, 2: plane_count // 2 + 1, 4: plane_count // 4 + 1}[symmetry]
    scale = intensity_factor * lumens / 1000
    candela = [tuple(value * scale for value in take(vertical_count)) for _ in range(stored)]
    horizontal = horizontal[:stored]
    if symmetry == 0:
        # Close the circle so an azimuth past the last plane interpolates back to C0.
        horizontal.append(360.0)
        candela.append(candela[0])
    if symmetry != 1 and horizontal[-1] != span:
        raise ValueError(f"{source}: the C planes end at {horizontal[-1]:g}, not {span:g} as the symmetry states")
    _require_ascending(vertical, "gamma", source)
    _require_ascending(tuple(horizontal), "C-plane", source)

    return IesPhotometry(
        vertical_angles=vertical,
        horizontal_angles=tuple(horizontal),
        candela=tuple(candela),
        rated_lumens=lumens * light_output_ratio,
        input_watts=None,
        source=source,
        lamp_lumens=lumens,
    )


def rated_flux_agreement(photometry: IesPhotometry) -> float | None:
    """Integrated flux over the flux the file declares, or ``None`` if it declares none.

    A well-formed file reconciles close to 1.0. A ratio far from it means the
    candela block was read wrongly or the file is mislabelled, and either way
    the lux built on it is wrong by that factor. Absolute photometry states no
    rated lumens, so there is nothing to compare against.
    """

    if photometry.rated_lumens is None or photometry.rated_lumens <= 0:
        return None
    return photometry.luminous_flux_lm() / photometry.rated_lumens


def load_photometry(ies_path: str, *, root: Path, lumens: float | None = None) -> IesPhotometry:
    """Read a project-relative IES or LDT file from inside ``root``.

    The path arrives from IFC or the browser, so it is confined to the project
    rather than trusted. An LDT file is relative and is scaled to ``lumens``.
    The distribution is averaged about its axis, as no fitting records its rotation.
    """

    candidate = Path(ies_path)
    if candidate.is_absolute():
        raise ValueError(f"{ies_path}: an IES path must be relative to the project")
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f"{ies_path}: an IES path must stay inside the project")
    if not resolved.is_file():
        raise FileNotFoundError(f"{ies_path}: no IES file at {resolved}")
    text = resolved.read_text(encoding="utf-8", errors="replace")
    if resolved.suffix.lower() == ".ldt":
        if lumens is None:
            raise ValueError(f"{ies_path}: an LDT file needs the lamp's rated lumens to scale its relative intensities")
        return parse_ldt(text, lumens=lumens, source=ies_path).rotationally_averaged()
    return parse_ies(text, source=ies_path).rotationally_averaged()


def _azimuth_deg(offset: tuple[float, float, float], axis: tuple[float, float, float]) -> float:
    """Azimuth about the aiming axis, measured from building +X towards +Y.

    For a downlight that reads as counterclockwise in plan view, which is the
    Type C convention. A luminaire's own rotation about its axis is not
    modelled, so the building frame is the stated reference; it only matters
    for a file that tabulates more than one horizontal plane.
    """

    reference = (0.0, 1.0, 0.0) if abs(axis[0]) > 0.999 else (1.0, 0.0, 0.0)
    along = sum(reference[index] * axis[index] for index in range(3))
    primary = tuple(reference[index] - along * axis[index] for index in range(3))
    length = sqrt(sum(value**2 for value in primary))
    if length <= 0:
        return 0.0
    primary = tuple(value / length for value in primary)
    secondary = (
        primary[1] * axis[2] - primary[2] * axis[1],
        primary[2] * axis[0] - primary[0] * axis[2],
        primary[0] * axis[1] - primary[1] * axis[0],
    )
    return degrees(
        atan2(
            sum(offset[index] * secondary[index] for index in range(3)),
            sum(offset[index] * primary[index] for index in range(3)),
        )
    ) % 360.0


def point_illuminance_lux(
    photometry: IesPhotometry,
    *,
    emitter: Point3D,
    axis: tuple[float, float, float],
    target: Point3D,
) -> float:
    """Direct illuminance on a horizontal plane at ``target``, in lux.

    Inverse-square law with the cosine of incidence, which is the standard
    point-source calculation and is accurate while the distance is large
    against the luminaire's own size.
    """

    offset = (target.x - emitter.x, target.y - emitter.y, target.z - emitter.z)
    distance_mm = sqrt(sum(value**2 for value in offset))
    if distance_mm <= 0:
        return 0.0
    along = sum(offset[index] * axis[index] for index in range(3)) / distance_mm
    if along <= 0:
        return 0.0
    cosine_of_incidence = (emitter.z - target.z) / distance_mm
    if cosine_of_incidence <= 0:
        return 0.0
    azimuth = 0.0 if photometry.rotationally_symmetric else _azimuth_deg(offset, axis)
    candela = photometry.intensity(degrees(acos(min(along, 1.0))), azimuth)
    if candela <= 0:
        return 0.0
    return candela * cosine_of_incidence / (distance_mm / 1000) ** 2
