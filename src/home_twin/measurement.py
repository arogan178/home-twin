"""Meter readings against the predicted surface.

A prediction that has never been held against a meter is an estimate with a
method label. Comparing them is the only step that says anything about this
building rather than about the arithmetic, so the residual is recorded here
instead of remembered.

The comparison says nothing about why a reading disagrees. Surface reflectance,
lamp output against its rating, and daylight leaking into a night measurement
all land in the same residual. See docs/validation.md for the protocol that
keeps them apart.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from io import StringIO
from statistics import fmean

from home_twin.model import Point3D

COMPARISON_METHOD = "measured_against_predicted_v1"

_COLUMNS = ("x_mm", "y_mm", "z_mm", "measured_lux")


@dataclass(frozen=True, slots=True)
class Reading:
    """One meter reading at a stated point, in the building frame."""

    point: Point3D
    measured_lux: float
    note: str = ""


@dataclass(frozen=True, slots=True)
class Residual:
    point: Point3D
    measured_lux: float
    predicted_lux: float
    note: str = ""

    @property
    def difference_lux(self) -> float:
        """Signed prediction error: positive means the model was optimistic."""

        return self.predicted_lux - self.measured_lux

    @property
    def ratio(self) -> float | None:
        """Predicted over measured, or ``None`` at a reading of zero."""

        if self.measured_lux <= 0:
            return None
        return self.predicted_lux / self.measured_lux


@dataclass(frozen=True, slots=True)
class MeasurementComparison:
    """What the meter said, what the model said, and the gap between them.

    ``mean_bias_lux`` is signed on purpose. A model that is 40 lx high
    everywhere has a calibration problem; one that is 40 lx out in both
    directions has a geometry or reflectance problem, and an unsigned average
    cannot tell them apart.
    """

    room_id: str
    residuals: tuple[Residual, ...]
    mean_absolute_error_lux: float
    mean_bias_lux: float
    worst: Residual | None
    prediction_method: str
    method: str = COMPARISON_METHOD


def parse_readings(text: str) -> tuple[Reading, ...]:
    """Read a CSV of ``x_mm,y_mm,z_mm,measured_lux`` with an optional ``note``.

    Coordinates are in the building frame and millimetres, which is what the
    installation exports already use, so a reading can be taken back to the
    same point.
    """

    rows = list(csv.DictReader(StringIO(text)))
    if not rows:
        raise ValueError("No readings: the file has a header but no rows")
    missing = [column for column in _COLUMNS if column not in (rows[0].keys() or ())]
    if missing:
        raise ValueError(f"The readings file is missing the {', '.join(missing)} column(s)")
    readings: list[Reading] = []
    for line, row in enumerate(rows, start=2):
        try:
            values = [float(row[column]) for column in _COLUMNS]
        except (TypeError, ValueError) as error:
            raise ValueError(f"Line {line}: every coordinate and reading must be a number") from error
        if values[3] < 0:
            raise ValueError(f"Line {line}: a measured illuminance cannot be negative")
        readings.append(
            Reading(Point3D(values[0], values[1], values[2]), values[3], (row.get("note") or "").strip())
        )
    return tuple(readings)


def compare_measurements(
    room_id: str,
    readings: tuple[Reading, ...],
    predicted_lux: tuple[float, ...],
    prediction_method: str,
) -> MeasurementComparison:
    """Pair each reading with its prediction and summarise the disagreement."""

    if len(readings) != len(predicted_lux):
        raise ValueError("Every reading needs exactly one prediction")
    if not readings:
        raise ValueError("No readings to compare")
    residuals = tuple(
        Residual(reading.point, reading.measured_lux, predicted, reading.note)
        for reading, predicted in zip(readings, predicted_lux, strict=True)
    )
    return MeasurementComparison(
        room_id=room_id,
        residuals=residuals,
        mean_absolute_error_lux=fmean(abs(item.difference_lux) for item in residuals),
        mean_bias_lux=fmean(item.difference_lux for item in residuals),
        worst=max(residuals, key=lambda item: abs(item.difference_lux)),
        prediction_method=prediction_method,
    )
