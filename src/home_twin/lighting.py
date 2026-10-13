"""Deterministic spotlight heuristics and configurable validation."""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, replace
from itertools import count as numbers_from
from math import atan2, ceil, cos, radians, sqrt, tan
from pathlib import Path

from home_twin.constraints import LightingConstraints
from home_twin.fixtures import (
    Fixture,
    LightingLayout,
    PendantFixture,
    PlannedPendant,
    PlannedRopeLight,
    PlannedSpotlight,
    PlannedWallSwitch,
    RoomLightingDesign,
    RopeLightFixture,
    SpotlightSpec,
    WallSwitch,
)
from home_twin.geometry import (
    bounds_overlap_2d,
    circle_fits_polygon,
    distance,
    distance_2d,
    point_in_polygon,
    polygon_area,
    polygon_clearance,
    polygon_edge_distance,
)
from home_twin.model import (
    Bounds3D,
    BuildingObject,
    ObjectKind,
    Point2D,
    Point3D,
    RoomContext,
    WallFace,
)
from home_twin.occlusion import (
    OCCLUSION_METHOD,
    OccluderSet,
    collect_occluders,
    is_shadowed,
    shadow_ray_origin,
)
from home_twin.photometry import (
    PHOTOMETRIC_METHOD,
    IesPhotometry,
    load_photometry,
    point_illuminance_lux,
)
from home_twin.validation import Finding, Severity, ValidationReport

CONE_METHOD = "lumen_beam_cone_v1"
# A uniform emitter mixed in with the cones. Named separately so a grid that
# credits a pendant cannot be mistaken for one built from measured distributions.
DIFFUSER_METHOD = "lumen_beam_cone_with_uniform_diffuser_v1"
PEAK_CANDELA_METHOD = "peak_candela_beam_falloff_v1"
MIXED_METHOD = "mixed_ies_and_lumen_beam_cone_v1"
PHOTOMETRIC_OCCLUSION_METHOD = "ies_lm63_occluded_v1"
PHOTOMETRIC_INTERREFLECTION_METHOD = "ies_lm63_occluded_plus_room_interreflection_v1"

CONE_DISCLAIMER = (
    "Lumen and beam-cone approximation; excludes inter-reflection, materials, daylight, and IES data."
)
PHOTOMETRIC_DISCLAIMER = (
    "Direct IES point-source photometry, averaged about each lamp's axis because its rotation is not"
    " recorded; excludes inter-reflection, materials, and daylight."
)

ANALYSIS_EXCLUSIONS = ("daylight", "inter_reflection", "surface_materials", "ies_photometry")


@dataclass(frozen=True, slots=True)
class Spacing:
    fixture_a: str
    fixture_b: str
    distance_mm: float


@dataclass(frozen=True, slots=True)
class LuxEstimate:
    point: Point3D
    lux: float
    method: str = CONE_METHOD


@dataclass(frozen=True, slots=True)
class DarkZone:
    point: Point3D
    estimated_lux: float
    threshold_lux: float
    method: str = CONE_METHOD
    disclaimer: str = CONE_DISCLAIMER


@dataclass(frozen=True, slots=True)
class TaskArea:
    """Statistics over the room minus a perimeter band.

    A whole-room average includes samples hard against the walls, where a
    downlight grid never puts light, so it drops as the room gets bigger and
    cannot be compared against another tool or a lux meter. Excluding a stated
    border makes the average a defined quantity. ``uniformity`` is the usual
    Emin/Eavg ratio, which is what a designer argues about once the average is
    agreed.
    """

    border_mm: float
    sample_count: int
    mean_lux: float
    minimum_lux: float
    maximum_lux: float
    uniformity: float
    covered_fraction: float


@dataclass(frozen=True, slots=True)
class IlluminanceGrid:
    """Task-plane samples for exactly one candidate layout.

    The grid is what the browser renders as a light-coverage image. It carries
    its own method label because it is a lumen and beam-cone approximation, not
    a photometric simulation.
    """

    samples: tuple[LuxEstimate, ...]
    plane_elevation_mm: float
    step_mm: float
    threshold_lux: float
    maximum_lux: float
    mean_lux: float
    covered_fraction: float
    maintenance_factor: float = 1.0
    task_area: TaskArea | None = None
    method: str = CONE_METHOD


@dataclass(frozen=True, slots=True)
class ElectricLightingAnalysis:
    validation: ValidationReport
    dark_zones: tuple[DarkZone, ...]
    illuminance: IlluminanceGrid | None = None
    method: str = CONE_METHOD
    exclusions: tuple[str, ...] = ANALYSIS_EXCLUSIONS


@dataclass(frozen=True, slots=True)
class LayoutProposal:
    layout: LightingLayout
    validation: ValidationReport
    model_revision: str
    score: tuple[int, float, int, tuple[tuple[float, float, float], ...], tuple[str, ...]]
    method: str = "geometric_with_lumen_approximation"
    assumptions: tuple[str, ...] = (
        "The room ceiling is horizontal.",
        "The task plane is horizontal.",
        "Lumen estimates use a uniform beam cone and no reflected light.",
        "Illuminance is maintained rather than initial.",
    )


def calculate_spacing(layout: LightingLayout) -> tuple[Spacing, ...]:
    pairs = [
        Spacing(a.tag, b.tag, distance(a.point, b.point))
        for index, a in enumerate(layout.fixtures)
        for b in layout.fixtures[index + 1 :]
    ]
    return tuple(sorted(pairs, key=lambda item: (item.distance_mm, item.fixture_a, item.fixture_b)))


# How far off an axis still reads as an attempt to sit on it. Past this the
# spotlight is somewhere else on purpose.
ALIGNMENT_NEAR_BAND_MM = 200.0


def _axes(values: Sequence[float], tolerance_mm: float) -> list[tuple[float, int]]:
    """Coordinate values two or more fixtures already agree on."""

    groups: list[list[float]] = []
    for value in sorted(values):
        if groups and value - groups[-1][-1] <= tolerance_mm:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [(sum(group) / len(group), len(group)) for group in groups if len(group) > 1]


def _off_axis(
    value: float, axes: Sequence[tuple[float, int]], constraints: LightingConstraints
) -> float | None:
    """The axis this value nearly sits on, if it misses one."""

    near = [
        position
        for position, _ in axes
        if constraints.alignment_tolerance_mm < abs(value - position) <= ALIGNMENT_NEAR_BAND_MM
    ]
    if not near:
        return None
    return min(near, key=lambda position: abs(value - position))


def find_bad_alignment(layout: LightingLayout, constraints: LightingConstraints) -> ValidationReport:
    """Spotlights that nearly sit on a row or column the others already share.

    An axis is a coordinate two or more fixtures already agree on. Being off
    one is a slip; being somewhere else entirely is a choice, and a snapped
    grid is nothing but choices, so it reports nothing.
    """

    fixtures = sorted(layout.fixtures, key=lambda fixture: fixture.tag)
    columns = _axes([fixture.point.x for fixture in fixtures], constraints.alignment_tolerance_mm)
    rows = _axes([fixture.point.y for fixture in fixtures], constraints.alignment_tolerance_mm)
    findings: list[Finding] = []
    for fixture in fixtures:
        for value, axes, name in (
            (fixture.point.x, columns, "column"),
            (fixture.point.y, rows, "row"),
        ):
            position = _off_axis(value, axes, constraints)
            if position is None:
                continue
            offset = abs(value - position)
            sharers = [
                other.tag
                for other in fixtures
                if other.tag != fixture.tag
                and abs((other.point.x if name == "column" else other.point.y) - position)
                <= constraints.alignment_tolerance_mm
            ]
            findings.append(
                Finding(
                    "bad_alignment",
                    Severity.WARNING,
                    f"{fixture.tag} is {offset:.1f} mm off the {name} shared by {', '.join(sharers)}",
                    (fixture.tag, *sharers),
                    offset,
                    constraints.alignment_tolerance_mm,
                )
            )
    return ValidationReport(tuple(sorted(findings, key=lambda item: (-(item.measured_mm or 0), item.fixture_tags))))


def align_layout(layout: LightingLayout, constraints: LightingConstraints) -> LightingLayout:
    """Pull every spotlight that nearly sits on an axis onto it.

    Only axes other fixtures already share, and only from within the same band
    the check reports, so what it flags is exactly what this fixes.
    """

    columns = _axes([fixture.point.x for fixture in layout.fixtures], constraints.alignment_tolerance_mm)
    rows = _axes([fixture.point.y for fixture in layout.fixtures], constraints.alignment_tolerance_mm)
    moved = []
    for fixture in layout.fixtures:
        x = _off_axis(fixture.point.x, columns, constraints) or fixture.point.x
        y = _off_axis(fixture.point.y, rows, constraints) or fixture.point.y
        moved.append(replace(fixture, point=Point3D(x, y, fixture.point.z)))
    return LightingLayout(layout.room_id, tuple(moved))


def find_fixture_collisions(
    layout: LightingLayout,
    context: RoomContext,
    constraints: LightingConstraints,
) -> ValidationReport:
    findings: list[Finding] = []
    for spacing in calculate_spacing(layout):
        by_tag = {fixture.tag: fixture for fixture in layout.fixtures}
        required = (
            by_tag[spacing.fixture_a].spec.diameter_mm + by_tag[spacing.fixture_b].spec.diameter_mm
        ) / 2 + constraints.collision_tolerance_mm
        if spacing.distance_mm < required:
            findings.append(
                Finding(
                    "fixture_collision",
                    Severity.ERROR,
                    f"{spacing.fixture_a} overlaps {spacing.fixture_b}",
                    (spacing.fixture_a, spacing.fixture_b),
                    spacing.distance_mm,
                    required,
                )
            )
    for fixture in layout.fixtures:
        fixture_bounds = Bounds3D(
            Point3D(
                fixture.point.x - fixture.spec.diameter_mm / 2,
                fixture.point.y - fixture.spec.diameter_mm / 2,
                fixture.point.z - fixture.spec.mounting_depth_mm,
            ),
            Point3D(
                fixture.point.x + fixture.spec.diameter_mm / 2,
                fixture.point.y + fixture.spec.diameter_mm / 2,
                fixture.point.z,
            ),
        )
        for obstruction in context.obstructions:
            if obstruction.kind not in constraints.avoid_object_kinds:
                continue
            clearance = (
                constraints.shadow_gap_clearance_mm
                if obstruction.kind == ObjectKind.SHADOW_GAP
                else constraints.obstruction_clearance_mm
            )
            if _too_close(fixture, obstruction, clearance, fixture_bounds):
                findings.append(
                    Finding(
                        f"fixture_over_{obstruction.kind.value}",
                        Severity.ERROR,
                        f"{fixture.tag} is over or too close to {obstruction.name}",
                        (fixture.tag,),
                        required_mm=clearance,
                    )
                )
    return ValidationReport(tuple(findings))


def _too_close(fixture, obstruction: BuildingObject, clearance_mm: float, fixture_bounds: Bounds3D) -> bool:
    """Prefer the obstruction's own footprint; a turned solid's box is not its shape."""
    footprint = obstruction.plan_footprint
    if footprint is None:
        return bounds_overlap_2d(fixture_bounds, obstruction.bounds, clearance_mm)
    centre = Point2D(fixture.point.x, fixture.point.y)
    return polygon_clearance(centre, footprint) <= clearance_mm + fixture.spec.diameter_mm / 2


def find_spotlights_over(
    layout: LightingLayout,
    context: RoomContext,
    kinds: frozenset[ObjectKind],
) -> ValidationReport:
    findings: list[Finding] = []
    for fixture in layout.fixtures:
        for obj in (*context.furniture, *context.obstructions):
            if obj.kind not in kinds:
                continue
            point = Point2D(fixture.point.x, fixture.point.y)
            inside_x = obj.bounds.minimum.x <= point.x <= obj.bounds.maximum.x
            inside_y = obj.bounds.minimum.y <= point.y <= obj.bounds.maximum.y
            if inside_x and inside_y:
                findings.append(
                    Finding(
                        f"spotlight_over_{obj.kind.value}",
                        Severity.WARNING,
                        f"{fixture.tag} is directly above {obj.name}",
                        (fixture.tag,),
                    )
                )
    return ValidationReport(tuple(findings))


def validate_layout(
    layout: LightingLayout,
    context: RoomContext,
    constraints: LightingConstraints,
) -> ValidationReport:
    findings: list[Finding] = []
    tags: set[str] = set()
    for fixture in layout.fixtures:
        if fixture.tag in tags:
            findings.append(
                Finding(
                    "duplicate_fixture_tag",
                    Severity.ERROR,
                    f"Fixture tag {fixture.tag!r} is duplicated",
                    (fixture.tag,),
                )
            )
        tags.add(fixture.tag)
        center = Point2D(fixture.point.x, fixture.point.y)
        required_edge = max(constraints.wall_clearance_mm, fixture.spec.diameter_mm / 2)
        if not circle_fits_polygon(center, fixture.spec.diameter_mm / 2, context.ceiling.polygon):
            findings.append(
                Finding(
                    "outside_ceiling",
                    Severity.ERROR,
                    f"{fixture.tag} does not fit inside the ceiling polygon",
                    (fixture.tag,),
                    required_mm=fixture.spec.diameter_mm / 2,
                )
            )
        edge_distance = polygon_edge_distance(center, context.ceiling.polygon)
        if edge_distance < required_edge:
            findings.append(
                Finding(
                    "wall_clearance",
                    Severity.ERROR,
                    f"{fixture.tag} is {edge_distance:.0f} mm from the ceiling edge, short of the "
                    f"{required_edge:.0f} mm this project asks for",
                    (fixture.tag,),
                    edge_distance,
                    required_edge,
                )
            )
        if abs(fixture.point.z - context.ceiling.elevation_mm) > 2:
            findings.append(
                Finding(
                    "wrong_ceiling_elevation",
                    Severity.ERROR,
                    f"{fixture.tag} is not on the room ceiling plane",
                    (fixture.tag,),
                    abs(fixture.point.z - context.ceiling.elevation_mm),
                    2,
                )
            )
        # A recessed fitting occupies the void above the finished ceiling, so it
        # only fits if the slab is far enough above it. A slab level with the
        # finished ceiling means no build-up was recorded, not a measured zero.
        # The board is cut through rather than sat on, so it costs the housing
        # nothing: the depth runs from the finished face to the slab.
        if context.ceiling.structural_elevation_mm is not None:
            plenum = context.ceiling.structural_elevation_mm - context.ceiling.elevation_mm
            if 0 < plenum < fixture.spec.mounting_depth_mm:
                findings.append(
                    Finding(
                        "recess_deeper_than_ceiling_void",
                        Severity.ERROR,
                        f"{fixture.tag} needs {fixture.spec.mounting_depth_mm:.0f} mm of recess "
                        f"but the ceiling void is {plenum:.0f} mm",
                        (fixture.tag,),
                        plenum,
                        fixture.spec.mounting_depth_mm,
                    )
                )
    for spacing in calculate_spacing(layout):
        if spacing.distance_mm < constraints.minimum_spacing_mm:
            findings.append(
                Finding(
                    "minimum_spacing",
                    Severity.ERROR,
                    f"{spacing.fixture_a} and {spacing.fixture_b} are only {spacing.distance_mm:.1f} mm apart",
                    (spacing.fixture_a, spacing.fixture_b),
                    spacing.distance_mm,
                    constraints.minimum_spacing_mm,
                )
            )
    findings.extend(find_fixture_collisions(layout, context, constraints).findings)
    findings.extend(find_bad_alignment(layout, constraints).findings)
    return ValidationReport(tuple(sorted(findings, key=lambda item: (item.severity, item.code, item.fixture_tags))))


def wall_switch_point(device: PlannedWallSwitch | WallSwitch, wall: WallFace, floor_elevation_mm: float) -> Point3D:
    """Resolve a wall-relative switch position in the canonical millimetre frame."""

    length = distance_2d(wall.start, wall.end)
    if length <= 0:
        raise ValueError(f"Host wall {wall.wall_id!r} has no length")
    fraction = device.offset_mm / length
    return Point3D(
        wall.start.x + (wall.end.x - wall.start.x) * fraction,
        wall.start.y + (wall.end.y - wall.start.y) * fraction,
        floor_elevation_mm + device.mounting_height_mm,
    )


def _rope_path_fits_ceiling(
    fixture: PlannedRopeLight | RopeLightFixture,
    context: RoomContext,
) -> bool:
    for start, end in zip(fixture.path, fixture.path[1:], strict=False):
        length = distance(start, end)
        samples = max(1, ceil(length / 50.0))
        for index in range(samples + 1):
            ratio = index / samples
            point = Point2D(
                start.x + (end.x - start.x) * ratio,
                start.y + (end.y - start.y) * ratio,
            )
            if not point_in_polygon(point, context.ceiling.polygon):
                return False
    return True


def validate_room_lighting(
    design: RoomLightingDesign,
    context: RoomContext,
    constraints: LightingConstraints,
) -> ValidationReport:
    """Validate authored devices only; renderer beams and preview state are not inputs."""

    findings = list(validate_layout(design.spotlight_layout, context, constraints).findings)
    for fixture in design.luminaires:
        if isinstance(fixture, (PlannedPendant, PendantFixture)):
            centre = Point2D(fixture.point.x, fixture.point.y)
            radius = max(fixture.spec.canopy_diameter_mm, fixture.spec.bulb_diameter_mm) / 2
            if not circle_fits_polygon(centre, radius, context.ceiling.polygon):
                findings.append(
                    Finding(
                        "pendant_outside_ceiling",
                        Severity.ERROR,
                        f"{fixture.tag} does not fit inside the ceiling polygon",
                        (fixture.tag,),
                        required_mm=radius,
                    )
                )
            if abs(fixture.point.z - context.ceiling.elevation_mm) > 2:
                findings.append(
                    Finding(
                        "pendant_wrong_ceiling_elevation",
                        Severity.ERROR,
                        f"{fixture.tag} anchor is not on the room ceiling plane",
                        (fixture.tag,),
                        abs(fixture.point.z - context.ceiling.elevation_mm),
                        2,
                    )
                )
            if fixture.emitter_point.z <= context.room.elevation_mm:
                findings.append(
                    Finding(
                        "pendant_below_floor",
                        Severity.ERROR,
                        f"{fixture.tag} drop reaches the room floor",
                        (fixture.tag,),
                    )
                )
        elif isinstance(fixture, (PlannedRopeLight, RopeLightFixture)):
            if not _rope_path_fits_ceiling(fixture, context):
                findings.append(
                    Finding(
                        "rope_path_outside_ceiling",
                        Severity.ERROR,
                        f"{fixture.tag} path leaves the ceiling polygon",
                        (fixture.tag,),
                    )
                )
            if fixture.spec.mounting in {"ceiling", "concealed"} and any(
                abs(point.z - context.ceiling.elevation_mm) > 2 for point in fixture.path
            ):
                findings.append(
                    Finding(
                        "rope_wrong_ceiling_elevation",
                        Severity.ERROR,
                        f"{fixture.tag} path is not on the room ceiling plane",
                        (fixture.tag,),
                        required_mm=2,
                    )
                )

    groups_with_lights = {fixture.switching_group for fixture in design.luminaires}
    for device in design.switches:
        wall = next((candidate for candidate in context.walls if candidate.wall_id == device.host_wall_id), None)
        if wall is None:
            findings.append(
                Finding(
                    "unknown_switch_wall",
                    Severity.ERROR,
                    f"{device.tag} does not reference a wall of {context.room.name}",
                    (device.tag,),
                )
            )
            continue
        wall_length = distance_2d(wall.start, wall.end)
        half_width = device.spec.width_mm / 2
        if device.offset_mm < half_width or device.offset_mm > wall_length - half_width:
            findings.append(
                Finding(
                    "switch_outside_wall",
                    Severity.ERROR,
                    f"{device.tag} plate does not fit along its host wall",
                    (device.tag,),
                    device.offset_mm,
                    half_width,
                )
            )
        half_height = device.spec.height_mm / 2
        room_height = context.ceiling.elevation_mm - context.room.elevation_mm
        if device.mounting_height_mm < half_height or device.mounting_height_mm > room_height - half_height:
            findings.append(
                Finding(
                    "switch_height_outside_wall",
                    Severity.ERROR,
                    f"{device.tag} plate does not fit between floor and ceiling",
                    (device.tag,),
                )
            )
        for opening in context.openings:
            if opening.host_wall_id != device.host_wall_id:
                continue
            opening_offsets = (
                distance_2d(wall.start, opening.start),
                distance_2d(wall.start, opening.end),
            )
            overlaps_horizontally = (
                device.offset_mm + half_width >= min(opening_offsets)
                and device.offset_mm - half_width <= max(opening_offsets)
            )
            switch_bottom = device.mounting_height_mm - half_height
            switch_top = device.mounting_height_mm + half_height
            overlaps_vertically = switch_top >= opening.sill_height_mm and switch_bottom <= opening.head_height_mm
            if overlaps_horizontally and overlaps_vertically:
                findings.append(
                    Finding(
                        "switch_over_opening",
                        Severity.ERROR,
                        f"{device.tag} overlaps {opening.name}",
                        (device.tag,),
                    )
                )
        if device.switching_group not in groups_with_lights:
            findings.append(
                Finding(
                    "switch_group_empty",
                    Severity.WARNING,
                    f"{device.tag} does not control any light in this room",
                    (device.tag,),
                )
            )

    for sensor in design.sensors:
        centre = Point2D(sensor.point.x, sensor.point.y)
        radius = sensor.spec.diameter_mm / 2
        if not circle_fits_polygon(centre, radius, context.ceiling.polygon):
            findings.append(
                Finding(
                    "sensor_outside_ceiling",
                    Severity.ERROR,
                    f"{sensor.tag} does not fit inside the ceiling polygon",
                    (sensor.tag,),
                    required_mm=radius,
                )
            )
        if abs(sensor.point.z - context.ceiling.elevation_mm) > 2:
            findings.append(
                Finding(
                    "sensor_wrong_ceiling_elevation",
                    Severity.ERROR,
                    f"{sensor.tag} is not on the room ceiling plane",
                    (sensor.tag,),
                    abs(sensor.point.z - context.ceiling.elevation_mm),
                    2,
                )
            )
        if sensor.switching_group is not None:
            if not any(item.switching_group == sensor.switching_group for item in design.luminaires):
                findings.append(
                    Finding(
                        "sensor_controls_empty_group",
                        Severity.WARNING,
                        f"{sensor.tag} switches {sensor.switching_group}, which lights nothing in this room",
                        (sensor.tag,),
                    )
                )
        # A warning, not an error: a sensor may be installed before the fan it
        # serves, and this model cannot see another room's installation tags.
        elif sensor.controls_tag not in {item.tag for item in (*design.luminaires, *design.sensors)}:
            findings.append(
                Finding(
                    "sensor_controls_unknown_tag",
                    Severity.WARNING,
                    f"{sensor.tag} controls {sensor.controls_tag}, which is not a light in this room",
                    (sensor.tag,),
                )
            )

    return ValidationReport(tuple(sorted(findings, key=lambda item: (item.severity, item.code, item.fixture_tags))))


def beam_axis(fixture: Fixture) -> tuple[float, float, float]:
    """Return the unit aiming vector of a fixture, defaulting to straight down."""

    direction = fixture.direction
    length = sqrt(direction.x**2 + direction.y**2 + direction.z**2)
    if length <= 0:
        return (0.0, 0.0, -1.0)
    return (direction.x / length, direction.y / length, direction.z / length)


def _fixture_photometry(
    fixture: Fixture, photometry: Mapping[str, IesPhotometry] | None
) -> IesPhotometry | None:
    if not photometry or not fixture.spec.ies_path:
        return None
    return photometry.get(fixture.spec.ies_path)


def _layout_method(fixtures: tuple[Fixture, ...], photometry: Mapping[str, IesPhotometry] | None) -> str:
    """Name the weakest tier present, so a partly measured layout cannot read as measured."""

    if not fixtures:
        return CONE_METHOD
    measured = sum(1 for fixture in fixtures if _fixture_photometry(fixture, photometry) is not None)
    if measured == len(fixtures):
        return PHOTOMETRIC_METHOD
    if measured:
        return MIXED_METHOD
    if all(getattr(fixture.spec, "peak_candela", None) is not None for fixture in fixtures):
        return PEAK_CANDELA_METHOD
    return CONE_METHOD


def _drop_ies_exclusion(exclusions: tuple[str, ...], method: str) -> tuple[str, ...]:
    if method in {PHOTOMETRIC_METHOD, PHOTOMETRIC_OCCLUSION_METHOD, PHOTOMETRIC_INTERREFLECTION_METHOD}:
        return tuple(item for item in exclusions if item != "ies_photometry")
    return exclusions


def load_layout_photometry(layout: LightingLayout, root: Path) -> dict[str, IesPhotometry]:
    """Read each IES or LDT path once, keyed by its stated path.

    An LDT table is relative, so it is scaled to each fixture's own rating when lux is estimated.
    """

    result: dict[str, IesPhotometry] = {}
    for fixture in layout.fixtures:
        path = fixture.spec.ies_path
        if not path:
            continue
        if path not in result:
            result[path] = load_photometry(path, root=root, lumens=fixture.spec.lumens)
        elif result[path].lamp_lumens is not None and fixture.spec.lumens is None:
            raise ValueError(f"{path}: an LDT file needs the lamp's rated lumens to scale its relative intensities")
    return result


def _peak_candela_lux(
    peak_candela: float,
    beam_angle_deg: float,
    offset: tuple[float, float, float],
    radial_mm: float,
    along_mm: float,
) -> float:
    """Point-source illuminance from a published peak intensity.

    A rated beam angle is the angle at which intensity has fallen to half of
    peak, so ``0.5 ** (theta / half) ** 2`` is a curve that honours both
    published numbers and nothing more. It is an assumed shape, not a measured
    distribution: a real reflector also throws light outside the rated cone,
    which this keeps clipping away with the cone.

    The utilization factor is deliberately absent. It is a lumen-method
    allowance for what a room does with flux, and a candela figure is already
    an intensity in a direction.
    """

    half = radians(beam_angle_deg / 2)
    distance_mm = sqrt(offset[0] ** 2 + offset[1] ** 2 + offset[2] ** 2)
    if half <= 0 or distance_mm <= 0:
        return 0.0
    theta = atan2(radial_mm, along_mm)
    falloff = 0.5 ** ((theta / half) ** 2)
    incidence = abs(offset[2]) / distance_mm
    return peak_candela * falloff * incidence / (distance_mm / 1000) ** 2


def uniform_diffuser_lux(lumens: float, emitter: Point3D, target: Point3D) -> float:
    """Illuminance from a source that throws its flux evenly in every direction.

    For a uniform emitter the intensity is exactly ``lumens / 4pi`` candela in
    all directions, so this is arithmetic rather than an assumed distribution.
    The assumption is the fitting, not the maths: an opal globe or a bare lamp
    is close to a uniform diffuser, and a shaded or reflectored one is not.

    It is still not photometry. A real shade blocks some directions and the
    stem blocks one, and nothing here knows that.
    """

    offset = (target.x - emitter.x, target.y - emitter.y, target.z - emitter.z)
    distance_mm = sqrt(offset[0] ** 2 + offset[1] ** 2 + offset[2] ** 2)
    if distance_mm <= 0:
        return 0.0
    incidence = abs(offset[2]) / distance_mm
    return (lumens / (4 * 3.141592653589793)) * incidence / (distance_mm / 1000) ** 2


def _estimate_lux_at(
    point: Point3D,
    fixtures: tuple[Fixture, ...],
    constraints: LightingConstraints,
    occluders: OccluderSet | None = None,
    photometry: Mapping[str, IesPhotometry] | None = None,
    diffusers: Sequence[tuple[Point3D, float]] = (),
) -> float:
    """Estimate task-plane illuminance from the stored aiming direction.

    A downlight aimed at ``(0, 0, -1)`` reduces to the original vertical beam
    cone. A tilted fixture uses the same cone about its own axis rather than
    silently being treated as vertical.

    A fixture carrying a parsed IES distribution uses its measured candela
    instead. The utilization factor is a lumen-method allowance and is not
    applied there, because the candela values already carry those losses.

    The maintenance factor applies to both paths. It is a depreciation
    allowance on the installation rather than a property of the luminaire, and
    a design figure quoted to an electrician is a maintained one.
    """

    total = 0.0
    for fixture in fixtures:
        axis = beam_axis(fixture)
        measured = _fixture_photometry(fixture, photometry)
        if measured is not None:
            if occluders is not None and is_shadowed(shadow_ray_origin(fixture.point), point, occluders):
                continue
            lux = point_illuminance_lux(measured, emitter=fixture.point, axis=axis, target=point)
            if measured.lamp_lumens and fixture.spec.lumens:
                lux *= fixture.spec.lumens / measured.lamp_lumens
            total += lux
            continue
        if fixture.spec.lumens is None:
            continue
        offset = (point.x - fixture.point.x, point.y - fixture.point.y, point.z - fixture.point.z)
        along_mm = offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2]
        if along_mm <= 0:
            continue
        perpendicular = (
            offset[0] - along_mm * axis[0],
            offset[1] - along_mm * axis[1],
            offset[2] - along_mm * axis[2],
        )
        radial_mm = sqrt(perpendicular[0] ** 2 + perpendicular[1] ** 2 + perpendicular[2] ** 2)
        beam_radius_mm = along_mm * tan(radians(fixture.spec.beam_angle_deg / 2))
        if radial_mm > beam_radius_mm or beam_radius_mm <= 0:
            continue
        if occluders is not None and is_shadowed(shadow_ray_origin(fixture.point), point, occluders):
            continue
        peak = fixture.spec.peak_candela
        if peak is not None:
            total += _peak_candela_lux(peak, fixture.spec.beam_angle_deg, offset, radial_mm, along_mm)
            continue
        area_m2 = 3.141592653589793 * (beam_radius_mm / 1000) ** 2
        angle = radians(fixture.spec.beam_angle_deg / 2) * (radial_mm / beam_radius_mm)
        total += fixture.spec.lumens * constraints.utilization_factor * max(cos(angle), 0) / area_m2
    for emitter, lumens in diffusers:
        if occluders is not None and is_shadowed(shadow_ray_origin(emitter), point, occluders):
            continue
        total += uniform_diffuser_lux(lumens, emitter, point)
    return total * constraints.maintenance_factor


def task_area_statistics(
    samples: Sequence[LuxEstimate] | Sequence[BakedSample],
    context: RoomContext,
    border_mm: float,
    threshold_lux: float,
) -> TaskArea | None:
    """Summarise only the samples further than ``border_mm`` from a wall.

    Returns ``None`` when the border leaves nothing, which happens in a room
    narrower than twice the border. Saying the statistics are unavailable is
    better than quietly reporting the whole room under a task-area label.
    """

    inner = [
        sample
        for sample in samples
        if polygon_edge_distance(Point2D(sample.point.x, sample.point.y), context.ceiling.polygon)
        >= border_mm
    ]
    if not inner:
        return None
    values = [sample.lux for sample in inner]
    mean = sum(values) / len(values)
    return TaskArea(
        border_mm=border_mm,
        sample_count=len(inner),
        mean_lux=mean,
        minimum_lux=min(values),
        maximum_lux=max(values),
        uniformity=min(values) / mean if mean > 0 else 0.0,
        covered_fraction=sum(1 for value in values if value >= threshold_lux) / len(values),
    )


def sample_illuminance(
    layout: LightingLayout,
    context: RoomContext,
    constraints: LightingConstraints,
    *,
    threshold_lux: float | None = None,
    photometry: Mapping[str, IesPhotometry] | None = None,
    diffusers: Sequence[tuple[Point3D, float]] = (),
) -> tuple[IlluminanceGrid, tuple[DarkZone, ...]]:
    """Sample the task plane once and return both the grid and its dark subset."""

    threshold = constraints.target_lux if threshold_lux is None else threshold_lux
    method = _layout_method(layout.fixtures, photometry)
    if diffusers and method != PHOTOMETRIC_METHOD:
        method = DIFFUSER_METHOD
    disclaimer = PHOTOMETRIC_DISCLAIMER if method == PHOTOMETRIC_METHOD else CONE_DISCLAIMER
    min_x, min_y, max_x, max_y = context.ceiling.polygon.bounds
    z = context.room.elevation_mm + constraints.task_plane_height_mm
    samples: list[LuxEstimate] = []
    dark: list[DarkZone] = []
    y = min_y
    while y <= max_y + 1e-6:
        x = min_x
        while x <= max_x + 1e-6:
            point_2d = Point2D(x, y)
            if point_in_polygon(point_2d, context.ceiling.polygon):
                point = Point3D(x, y, z)
                lux = _estimate_lux_at(
                    point, layout.fixtures, constraints, photometry=photometry, diffusers=diffusers
                )
                samples.append(LuxEstimate(point, lux, method))
                if lux < threshold:
                    dark.append(DarkZone(point, lux, threshold, method, disclaimer))
            x += constraints.grid_step_mm
        y += constraints.grid_step_mm
    values = [sample.lux for sample in samples]
    grid = IlluminanceGrid(
        samples=tuple(samples),
        plane_elevation_mm=z,
        step_mm=constraints.grid_step_mm,
        threshold_lux=threshold,
        maximum_lux=max(values, default=0.0),
        mean_lux=sum(values) / len(values) if values else 0.0,
        covered_fraction=(len(values) - len(dark)) / len(values) if values else 0.0,
        maintenance_factor=constraints.maintenance_factor,
        task_area=task_area_statistics(
            samples, context, constraints.task_area_border_mm, threshold
        ),
        method=method,
    )
    return grid, tuple(sorted(dark, key=lambda zone: (zone.estimated_lux, zone.point.y, zone.point.x)))


def find_dark_zones(
    layout: LightingLayout,
    context: RoomContext,
    constraints: LightingConstraints,
    *,
    threshold_lux: float | None = None,
    photometry: Mapping[str, IesPhotometry] | None = None,
) -> tuple[DarkZone, ...]:
    return sample_illuminance(
        layout, context, constraints, threshold_lux=threshold_lux, photometry=photometry
    )[1]


def analyse_layout(
    layout: LightingLayout,
    context: RoomContext,
    constraints: LightingConstraints,
    *,
    threshold_lux: float | None = None,
    photometry: Mapping[str, IesPhotometry] | None = None,
    diffusers: Sequence[tuple[Point3D, float]] = (),
) -> ElectricLightingAnalysis:
    """Validate and estimate electric-light dark zones for exactly this candidate layout."""

    grid, dark_zones = sample_illuminance(
        layout,
        context,
        constraints,
        threshold_lux=threshold_lux,
        photometry=photometry,
        diffusers=diffusers,
    )
    method = _layout_method(layout.fixtures, photometry)
    if diffusers and method != PHOTOMETRIC_METHOD:
        method = DIFFUSER_METHOD
    return ElectricLightingAnalysis(
        validation=validate_layout(layout, context, constraints),
        dark_zones=dark_zones,
        illuminance=grid,
        method=method,
        exclusions=_drop_ies_exclusion(ANALYSIS_EXCLUSIONS, method),
    )


@dataclass(frozen=True, slots=True)
class BakedSample:
    point: Point3D
    lux: float
    lit_by: int
    shadowed_by: int


INTERREFLECTION_METHOD = "direct_occluded_plus_room_interreflection_v1"

BAKE_EXCLUSIONS = (
    "daylight",
    "inter_reflection",
    "surface_materials",
    "ies_photometry",
    "light_through_glazing",
)
BAKE_INTERREFLECTED_EXCLUSIONS = (
    "daylight",
    "surface_materials",
    "ies_photometry",
    "light_through_glazing",
)

# Typical decorated finishes, and the fallback for a direct caller that states
# none. A project sets its own in config/constraints.yaml; these are still
# typical values rather than measured ones, which is why `surface_materials`
# stays in the exclusions either way.
DEFAULT_REFLECTANCES = {"ceiling": 0.7, "walls": 0.5, "floor": 0.2}


@dataclass(frozen=True, slots=True)
class Interreflection:
    """The room-averaged bounce added on top of the direct component.

    Radiosity for a single enclosure of uniform diffuse surfaces reduces to one
    number: total flux over total surface area, times the average reflectance
    over one minus it. It is uniform by construction, which is the assumption,
    not a result. It says nothing about where the bounce lands.
    """

    lux: float
    average_reflectance: float
    surface_area_m2: float
    luminous_flux_lm: float
    reflectances: tuple[tuple[str, float], ...] = ()
    maintenance_factor: float = 1.0
    method: str = INTERREFLECTION_METHOD
    exclusions: tuple[str, ...] = (
        "directional_bounce",
        "per_surface_materials",
        "specular_reflection",
    )


@dataclass(frozen=True, slots=True)
class DarkRegion:
    """A contiguous run of samples under the threshold.

    A list of dark points does not tell you whether they are one shadow or
    scattered noise; an area and its worst reading do.
    """

    area_m2: float
    minimum_lux: float
    mean_lux: float
    centre: Point3D
    sample_count: int


@dataclass(frozen=True, slots=True)
class BakedLighting:
    """A finer, occlusion-aware surface for one candidate layout.

    This is the same lumen and beam-cone approximation with shadow rays added,
    so it is still not a simulation. It exists because a tall cabinet or a
    stair mass changes where light actually lands, and the interactive grid is
    too coarse to show it.
    """

    room_id: str
    samples: tuple[BakedSample, ...]
    plane_elevation_mm: float
    step_mm: float
    threshold_lux: float
    maximum_lux: float
    mean_lux: float
    covered_fraction: float
    shadowed_fraction: float
    occluders: tuple[str, ...]
    fixture_count: int
    dark_regions: tuple[DarkRegion, ...] = ()
    interreflection: Interreflection | None = None
    maintenance_factor: float = 1.0
    task_area: TaskArea | None = None
    method: str = OCCLUSION_METHOD
    exclusions: tuple[str, ...] = BAKE_EXCLUSIONS


def indirect_flux_lm(design: RoomLightingDesign) -> float:
    """Flux from luminaires the direct pass cannot place on the task plane.

    A rope light is a line in a reveal, not a point with a beam. Until there is
    a tested linear-source model its output belongs in the bounce, where the
    uniform assumption is a fair one, rather than nowhere.
    """

    total = 0.0
    for item in design.luminaires:
        path = getattr(item, "path", None)
        if path is None:
            continue
        lumens_per_m = getattr(item.spec, "lumens_per_m", None)
        if lumens_per_m is None:
            continue
        length_mm = sum(
            distance(path[index], path[index + 1]) for index in range(len(path) - 1)
        )
        total += lumens_per_m * length_mm / 1000
    return total


def room_interreflection(
    layout: LightingLayout,
    context: RoomContext,
    reflectances: Mapping[str, float] | None = None,
    extra_flux_lm: float = 0.0,
    *,
    maintenance_factor: float = 1.0,
) -> Interreflection:
    """The room-averaged bounce for one layout.

    ``extra_flux_lm`` carries luminaires the direct pass cannot use. A cove
    strip pointed into a reveal puts almost nothing on the task plane and
    almost everything into the bounce, so leaving its flux out understates the
    room by more than including it approximately does.

    A wall face carrying its own ``reflectance`` is weighted at that value and
    the rest of the perimeter at the room's. The bounce stays uniform, so this
    changes how much light comes back, never where it lands.
    """

    values = dict(DEFAULT_REFLECTANCES)
    values.update(reflectances or {})
    floor_area = polygon_area(context.ceiling.polygon) / 1_000_000
    height_mm = max(context.ceiling.elevation_mm - context.room.elevation_mm, 1.0)
    ring = context.ceiling.polygon.outer
    perimeter_mm = sum(
        distance_2d(ring[index], ring[(index + 1) % len(ring)]) for index in range(len(ring))
    )
    wall_area = perimeter_mm * height_mm / 1_000_000
    total_area = floor_area * 2 + wall_area
    feature_area = 0.0
    feature_weighted = 0.0
    for wall in context.walls:
        if wall.reflectance is None:
            continue
        area = distance_2d(wall.start, wall.end) * height_mm / 1_000_000
        feature_area += area
        feature_weighted += area * wall.reflectance
    # Faces are measured off their own endpoints, so they can overrun a
    # perimeter taken from the ceiling. Scale rather than exceed the room.
    if feature_area > wall_area and feature_area > 0:
        scale = wall_area / feature_area
        feature_area *= scale
        feature_weighted *= scale
    weighted = (
        floor_area * values["floor"]
        + floor_area * values["ceiling"]
        + (wall_area - feature_area) * values["walls"]
        + feature_weighted
    )
    average = weighted / total_area if total_area > 0 else 0.0
    flux = sum(fixture.spec.lumens or 0 for fixture in layout.fixtures) + extra_flux_lm
    lux = 0.0
    if total_area > 0 and average < 1:
        lux = (flux / total_area) * (average / (1 - average)) * maintenance_factor
    return Interreflection(
        lux,
        average,
        total_area,
        float(flux),
        reflectances=tuple(sorted(values.items())),
        maintenance_factor=maintenance_factor,
    )


def _dark_regions(
    samples: Sequence[BakedSample], step_mm: float, threshold_lux: float
) -> tuple[DarkRegion, ...]:
    """Group under-lit samples into the contiguous patches they form."""

    dark = [sample for sample in samples if sample.lux < threshold_lux]
    if not dark:
        return ()
    index_of = {
        (round(sample.point.x / step_mm), round(sample.point.y / step_mm)): position
        for position, sample in enumerate(dark)
    }
    seen: set[int] = set()
    regions: list[DarkRegion] = []
    for position in range(len(dark)):
        if position in seen:
            continue
        stack = [position]
        seen.add(position)
        members: list[BakedSample] = []
        while stack:
            current = stack.pop()
            sample = dark[current]
            members.append(sample)
            key = (round(sample.point.x / step_mm), round(sample.point.y / step_mm))
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                neighbour = index_of.get((key[0] + dx, key[1] + dy))
                if neighbour is not None and neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
        luxes = [item.lux for item in members]
        regions.append(
            DarkRegion(
                area_m2=len(members) * step_mm * step_mm / 1_000_000,
                minimum_lux=min(luxes),
                mean_lux=sum(luxes) / len(luxes),
                centre=Point3D(
                    sum(item.point.x for item in members) / len(members),
                    sum(item.point.y for item in members) / len(members),
                    members[0].point.z,
                ),
                sample_count=len(members),
            )
        )
    return tuple(sorted(regions, key=lambda region: -region.area_m2))


def bake_method(
    fixtures: tuple[Fixture, ...],
    photometry: Mapping[str, IesPhotometry] | None,
    interreflected: bool,
) -> str:
    if _layout_method(fixtures, photometry) == PHOTOMETRIC_METHOD:
        return PHOTOMETRIC_INTERREFLECTION_METHOD if interreflected else PHOTOMETRIC_OCCLUSION_METHOD
    return INTERREFLECTION_METHOD if interreflected else OCCLUSION_METHOD


def bake_lighting(
    layout: LightingLayout,
    context: RoomContext,
    constraints: LightingConstraints,
    *,
    step_mm: float = 150.0,
    plane: str = "task",
    threshold_lux: float | None = None,
    reflectances: Mapping[str, float] | None = None,
    photometry: Mapping[str, IesPhotometry] | None = None,
    indirect_flux_lm: float = 0.0,
) -> BakedLighting:
    """Sample a room finely, testing each fixture-to-point line for occlusion."""

    if step_mm <= 0:
        raise ValueError("The bake step must be positive")
    threshold = constraints.target_lux if threshold_lux is None else threshold_lux
    elevation = context.room.elevation_mm + (constraints.task_plane_height_mm if plane == "task" else 0.0)
    occluders = collect_occluders(context, minimum_height_mm=elevation)
    min_x, min_y, max_x, max_y = context.ceiling.polygon.bounds
    samples: list[BakedSample] = []
    y = min_y
    while y <= max_y + 1e-6:
        x = min_x
        while x <= max_x + 1e-6:
            if point_in_polygon(Point2D(x, y), context.ceiling.polygon):
                point = Point3D(x, y, elevation)
                visible: list[Fixture] = []
                blocked = 0
                for fixture in layout.fixtures:
                    if is_shadowed(shadow_ray_origin(fixture.point), point, occluders):
                        blocked += 1
                    else:
                        visible.append(fixture)
                samples.append(
                    BakedSample(
                        point,
                        _estimate_lux_at(point, tuple(visible), constraints, photometry=photometry),
                        len(visible),
                        blocked,
                    )
                )
            x += step_mm
        y += step_mm
    bounce = room_interreflection(
        layout,
        context,
        constraints.reflectances if reflectances is None else reflectances,
        indirect_flux_lm,
        maintenance_factor=constraints.maintenance_factor,
    )
    method = bake_method(layout.fixtures, photometry, bounce.lux > 0)
    if bounce.lux > 0:
        samples = [
            BakedSample(sample.point, sample.lux + bounce.lux, sample.lit_by, sample.shadowed_by)
            for sample in samples
        ]
    values = [sample.lux for sample in samples]
    shadowed = sum(1 for sample in samples if sample.shadowed_by > 0)
    return BakedLighting(
        room_id=layout.room_id,
        samples=tuple(samples),
        plane_elevation_mm=elevation,
        step_mm=step_mm,
        threshold_lux=threshold,
        maximum_lux=max(values, default=0.0),
        mean_lux=sum(values) / len(values) if values else 0.0,
        covered_fraction=(
            sum(1 for value in values if value >= threshold) / len(values) if values else 0.0
        ),
        shadowed_fraction=shadowed / len(samples) if samples else 0.0,
        occluders=occluders.summary,
        fixture_count=len(layout.fixtures),
        dark_regions=_dark_regions(samples, step_mm, threshold),
        interreflection=bounce,
        maintenance_factor=constraints.maintenance_factor,
        task_area=task_area_statistics(
            samples, context, constraints.task_area_border_mm, threshold
        ),
        method=method,
        exclusions=_drop_ies_exclusion(
            BAKE_INTERREFLECTED_EXCLUSIONS if bounce.lux > 0 else BAKE_EXCLUSIONS, method
        ),
    )


def predict_lux(
    points: Sequence[Point3D],
    layout: LightingLayout,
    context: RoomContext,
    constraints: LightingConstraints,
    *,
    photometry: Mapping[str, IesPhotometry] | None = None,
    reflectances: Mapping[str, float] | None = None,
    indirect_flux_lm: float = 0.0,
) -> tuple[float, ...]:
    """Predicted maintained illuminance at arbitrary points.

    The bake walks a grid; a meter goes where a person can stand. Predicting at
    the measured point rather than the nearest grid sample keeps the residual a
    measure of the model instead of the grid step.
    """

    if not points:
        return ()
    occluders_by_plane = {
        elevation: collect_occluders(context, minimum_height_mm=elevation)
        for elevation in {point.z for point in points}
    }
    bounce = room_interreflection(
        layout,
        context,
        constraints.reflectances if reflectances is None else reflectances,
        indirect_flux_lm,
        maintenance_factor=constraints.maintenance_factor,
    )
    return tuple(
        _estimate_lux_at(
            point, layout.fixtures, constraints, occluders_by_plane[point.z], photometry
        )
        + bounce.lux
        for point in points
    )


def _grid_points(
    context: RoomContext,
    count: int,
    constraints: LightingConstraints,
    *,
    required_clearance_mm: float,
) -> tuple[Point3D, ...]:
    """Grid seats that already satisfy edge clearance and minimum spacing.

    A bounding-box grid alone puts seats hard against a concave room's
    re-entrant walls, so the proposal came back with blocking findings and could
    not be saved. Candidates are filtered here instead, against the same rules
    :func:`validate_layout` applies.
    """

    min_x, min_y, max_x, max_y = context.ceiling.polygon.bounds
    width = max_x - min_x - 2 * constraints.wall_clearance_mm
    height = max_y - min_y - 2 * constraints.wall_clearance_mm
    if width <= 0 or height <= 0:
        return ()
    nx = max(1, ceil(sqrt(count * width / height)))
    ny = max(1, ceil(count / nx))
    accepted: list[Point2D] = []
    for row in range(ny):
        y = min_y + constraints.wall_clearance_mm + height * (row + 0.5) / ny
        for column in range(nx):
            x = min_x + constraints.wall_clearance_mm + width * (column + 0.5) / nx
            center = Point2D(x, y)
            if not point_in_polygon(center, context.ceiling.polygon):
                continue
            if polygon_edge_distance(center, context.ceiling.polygon) < required_clearance_mm:
                continue
            if any(distance_2d(center, other) < constraints.minimum_spacing_mm for other in accepted):
                continue
            accepted.append(center)
    return tuple(Point3D(point.x, point.y, context.ceiling.elevation_mm) for point in accepted)


def optimise_spotlights(
    revision: str,
    fixture: SpotlightSpec | Sequence[SpotlightSpec],
    context: RoomContext,
    constraints: LightingConstraints,
    photometry: Mapping[str, IesPhotometry] | None = None,
    reserved_tags: Collection[str] = frozenset(),
) -> LayoutProposal:
    """Choose a spotlight layout, and the lamp it is built from.

    Given more than one spec, every lamp is laid out and scored and the best
    result wins. A wide lamp needs more fittings to reach the same target and
    leaves fewer dark samples between them, so which one a room wants is a
    trade the scorer can settle rather than a house-wide assumption.

    New tags skip ``reserved_tags``, the labels other rooms already use.
    """

    specs = (fixture,) if isinstance(fixture, SpotlightSpec) else tuple(fixture)
    if not specs:
        raise ValueError("optimise_spotlights needs at least one spotlight spec")
    area_m2 = polygon_area(context.ceiling.polygon) / 1_000_000
    candidates: list[LayoutProposal] = []
    for spec in specs:
        rated_lumens = spec.lumens or SpotlightSpec().lumens or 1
        effective_lumens = max(
            rated_lumens * constraints.utilization_factor * constraints.maintenance_factor, 1
        )
        target_count = max(1, ceil(area_m2 * constraints.target_lux / effective_lumens))
        required_clearance_mm = max(constraints.wall_clearance_mm, spec.diameter_mm / 2)
        for count in range(max(1, target_count - 2), target_count + 4):
            points = _grid_points(context, count, constraints, required_clearance_mm=required_clearance_mm)
            free_tags = (tag for index in numbers_from(1) if (tag := f"SP{index:02d}") not in reserved_tags)
            planned = tuple(
                PlannedSpotlight(
                    tag=tag,
                    room_id=context.room.id,
                    point=point,
                    spec=spec,
                    switching_group="MAIN",
                )
                for point, tag in zip(points, free_tags, strict=False)
            )
            layout = LightingLayout(context.room.id, planned)
            report = validate_layout(layout, context, constraints)
            dark = sample_illuminance(layout, context, constraints, photometry=photometry)[1]
            hard = sum(finding.severity == Severity.ERROR for finding in report.findings)
            soft = float(len(dark) + sum(finding.severity == Severity.WARNING for finding in report.findings))
            coordinates = tuple(
                (round(item.point.x, 6), round(item.point.y, 6), round(item.point.z, 6))
                for item in planned
            )
            tags = tuple(item.tag for item in planned)
            score = (hard, soft, len(planned), spec.model or "", coordinates, tags)
            candidates.append(LayoutProposal(layout, report, revision, score))
    best = min(candidates, key=lambda proposal: proposal.score)
    if best.layout.fixtures:
        return best

    # An empty proposal reads as "this room needs no light", so say why instead.
    min_x, min_y, max_x, max_y = context.ceiling.polygon.bounds
    narrowest = min(max_x - min_x, max_y - min_y)
    finding = Finding(
        "no_compliant_seat",
        Severity.WARNING,
        f"No spotlight position satisfies {constraints.wall_clearance_mm:.0f} mm edge clearance in "
        f"{context.room.name!r}: the room is {narrowest:.0f} mm across at its narrowest",
        measured_mm=narrowest,
        # The narrowest lamp is the one that had the best chance of seating.
        required_mm=constraints.wall_clearance_mm * 2 + min(spec.diameter_mm for spec in specs),
    )
    return LayoutProposal(
        best.layout,
        ValidationReport((*best.validation.findings, finding)),
        revision,
        best.score,
    )
