"""Compile a reviewed plan source into a verified draft IFC."""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import StrEnum
from math import atan2, hypot, isfinite
from pathlib import Path
from typing import Annotated, Any, Literal, NamedTuple
from uuid import UUID, uuid5

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import ifcopenshell.validate
import numpy as np
import yaml
from ifcopenshell.util import element as element_util
from ifcopenshell.util import unit as unit_util
from ifcopenshell.util.shape_builder import ShapeBuilder
from pydantic import BaseModel, ConfigDict, Field, model_validator

from home_twin.daylight import clip_convex_to_polygon
from home_twin.geometry import (
    distance_2d,
    point_in_polygon,
    polygon_area,
    polygon_edge_distance,
    triangulate_ring,
)
from home_twin.ifc import bearing_deg_to_true_north_ratios, degrees_to_compound_angle
from home_twin.model import HomeTwin, OpeningKind, Point2D, Polygon2D
from home_twin.validation import StaleRevision

PLAN_RELATIVE_PATH = Path("model/references/plan.yaml")
# Found when no plan.yaml exists, so a project traced before the rename keeps working.
LEGACY_PLAN_RELATIVE_PATH = Path("model/references/m1-plan.yaml")
CANONICAL_RELATIVE_PATH = Path("model/house.ifc")
GENERATOR_VERSION = "3"
GUID_NAMESPACE = UUID("6c613311-f483-588d-8f79-f64bb92fd6b5")
CURRENT_PLAN_SCHEMA = "home-twin.plan/v3"
# A source keeps the schema id it was written with, so an unchanged legacy file
# still serialises byte for byte.
LEGACY_V3_PLAN_SCHEMA = "home-twin.m1-plan/v3"
LEGACY_V2_PLAN_SCHEMA = "home-twin.m1-plan/v2"
# Plan stair kinds mapped to IfcStairTypeEnum and IfcStairFlightTypeEnum.
STAIR_RISE_ROLES = frozenset({"storey", "split_level"})
STAIR_TYPES: dict[str, tuple[str, str]] = {
    "straight_run": ("STRAIGHT_RUN_STAIR", "STRAIGHT"),
    "two_straight_run": ("TWO_STRAIGHT_RUN_STAIR", "STRAIGHT"),
    "quarter_turn": ("QUARTER_TURN_STAIR", "WINDER"),
    "half_turn": ("HALF_TURN_STAIR", "WINDER"),
    "spiral": ("SPIRAL_STAIR", "SPIRAL"),
    "curved_run": ("CURVED_RUN_STAIR", "CURVED"),
}
SUPPORTED_PLAN_SCHEMAS = (LEGACY_V2_PLAN_SCHEMA, LEGACY_V3_PLAN_SCHEMA, CURRENT_PLAN_SCHEMA)


class DraftPlanError(ValueError):
    """The reviewed source plan is incomplete or internally inconsistent."""


class DraftBuildRejected(RuntimeError):
    """A draft failed verification before publication."""


class DraftReplacementRequired(RuntimeError):
    """An existing changed draft requires an exact revision acknowledgement."""


class DraftWouldDiscardFixtures(RuntimeError):
    """Rebuilding would delete luminaires that only exist in the draft."""


class EvidenceStatus(StrEnum):
    CONFIRMED = "confirmed"
    SITE_MEASURED = "site_measured"
    """Measured in the building itself, which beats every other class here.

    Everything else in this plan is traced from a drawing, read off a printed
    dimension, reported by the owner, or assumed. A laser reading of the wall
    that the joinery will actually meet is the only evidence that closes the
    gap between the model and the thing being built.
    """

    OWNER_REPORTED = "owner_reported"
    TRACED = "traced"
    ASSUMED = "assumed"
    UNRESOLVED = "unresolved"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


FiniteNonNegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
FinitePositive = Annotated[float, Field(gt=0, allow_inf_nan=False)]


class SourceDocument(StrictModel):
    file_name: str
    sha256: str
    page: Annotated[int, Field(ge=1)]
    locator: str
    method: str


class CoordinateFrame(StrictModel):
    units: str
    x_axis: str
    y_axis: str
    z_axis: str
    origin: str
    trace_transform: str


class Evidence(StrictModel):
    source: str
    status: EvidenceStatus
    uncertainty_mm: FiniteNonNegative
    note: str | None = None


class PlanPoint(StrictModel):
    x_mm: float = Field(allow_inf_nan=False)
    y_mm: float = Field(allow_inf_nan=False)
    evidence: str

    def domain(self) -> Point2D:
        return Point2D(self.x_mm, self.y_mm)


class ControlDimension(StrictModel):
    id: str
    from_point: str
    to_point: str
    expected_mm: FinitePositive
    tolerance_mm: FiniteNonNegative
    evidence: str | None = None
    """Which evidence class the expected value came from, where it is known.

    A control read off a 1:100 drawing and one measured on site are not the
    same claim, and without this the plan cannot tell them apart: both are just
    a number and a tolerance. Naming the class also stops a tolerance being set
    tighter than the evidence behind it supports.
    """


class RoomSpec(StrictModel):
    id: str
    name: str
    point_ids: tuple[str, ...] = Field(min_length=3)
    floor_elevation_mm: float = Field(default=0.0, allow_inf_nan=False)
    """Floor level above the plan datum.

    A split-level home has rooms on more than one level within a storey, so a
    single datum for every room would put its openings and fixtures at the
    wrong height. ``ceiling_height_mm`` is measured from this floor.
    """

    ceiling_height_mm: FinitePositive
    ceiling_evidence: str
    geometry_evidence: str
    part_of: str | None = None
    """The room this one is a level of, when a room spans more than one.

    A split-level room is one room to live in and two spaces to model: each
    level has its own floor, ceiling and fixtures. Naming the parent keeps
    them one room in the model instead of two that merely adjoin.
    """

    structural_ceiling_height_mm: FinitePositive | None = None
    """The slab soffit above this room's floor, when a gypsum ceiling hangs below it.

    A home can have one structural ceiling level throughout and lower finished
    ceilings in the wet rooms. ``ceiling_height_mm`` stays the finished level,
    because that is what a fixture mounts on and what a beam is measured from.
    """

    ceiling_board_thickness_mm: FiniteNonNegative | None = None
    """The board hung below the slab. A recessed fitting passes through it, so
    the depth it can occupy is the drop less this, not the drop itself."""

    exposure: str | None = None
    """``exterior`` marks outdoor space such as a yard.

    It is still traced and still bounds walls, but it is not internal floor
    area and it is not missing a window.
    """


class DefaultWall(StrictModel):
    thickness_mm: FinitePositive
    evidence: str


class WallOverride(StrictModel):
    point_ids: tuple[str, str]
    thickness_mm: FinitePositive | None = None
    base_elevation_mm: FiniteNonNegative | None = None
    """Where the wall starts, when it runs below the floor of every room it faces.

    An exterior wall alongside a stair down to a lower level carries on to that
    level, but no room at that level traces it, so the room floors alone put its
    base a storey too high.
    """

    omit: bool = False
    """Whether the edge is an open boundary rather than a wall.

    A room traced as a lower level of another shares its outline with the room
    above, and every shared edge becomes a wall face. Where the two are one
    space at two floor levels, that edge is a void the level change runs
    through, not a partition. An aperture cannot say this: an opening needs a
    jamb either side, and a full-width one is refused.
    """

    evidence: str


class ApertureSpec(StrictModel):
    id: str
    name: str
    kind: OpeningKind
    host_edge: tuple[str, str]
    width_mm: FinitePositive
    sill_height_mm: FiniteNonNegative
    height_mm: FinitePositive
    room_ids: tuple[str, ...] = Field(min_length=1)
    exposure: str
    geometry_evidence: str
    height_evidence: str
    glazing_fraction: Annotated[float, Field(ge=0, le=1)] = 0
    overhang_depth_mm: FinitePositive | None = None
    """A horizontal projection above this opening, reaching this far out.

    A balcony floor overhanging a slider is an external obstruction that can
    remove most of the winter sun: with the soffit barely above the head, a ray
    leaving a point near the glass meets the balcony's underside, and only rays
    from deep in the room see sky under its edge.
    """

    overhang_soffit_mm: FiniteNonNegative | None = None
    """Its underside above the room floor; the room's ceiling when unstated."""

    offset_mm: FiniteNonNegative | None = None
    swing: Literal["inward", "outward"] | None = None
    """Distance from the first host point to the near edge of the aperture.

    ``None`` centres the aperture on its host edge, which is what early traces
    assumed. Real doors are rarely centred, so a traced offset is what
    lets a plan carry them.
    """


class StairSpec(StrictModel):
    """A traced stair flight.

    The footprint, the ascending bearing, and the tread depth come from the
    drawing. The tread count is derived from the traced going length. For a
    split-level flight, the two stated floor elevations determine its total
    rise and riser count; a straight run usually has one more riser than the
    number of visible treads.
    """

    id: str
    name: str
    point_ids: tuple[str, ...] = Field(min_length=3)
    kind: str = "straight_run"
    up_bearing_deg: Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)]
    tread_depth_mm: FinitePositive
    riser_height_mm: FinitePositive
    """Height of one riser. A floor plan does not state it, so it carries evidence.

    A normal storey flight falls back to traced tread count times this height.
    A split-level flight uses the difference between its rooms' known floor
    datums when that difference is consistent with this height.
    """

    rise_role: str = "storey"
    """What the flight is for: ``storey`` climbs a full floor, ``split_level``
    steps between levels within one floor.

    A split-level flight is complete at a rise that would be far too short for a
    storey, so the review must not report it as unfinished.
    """

    room_ids: tuple[str, ...] = ()
    geometry_evidence: str
    riser_evidence: str


class DaylightSourceSpec(StrictModel):
    id: str
    name: str
    kind: str
    point_ids: tuple[str, ...] = Field(min_length=3)
    daylight_role: str
    geometry_evidence: str


SOFFIT_KINDS = frozenset({"soffit", "bulkhead", "cove"})


class SoffitSpec(StrictModel):
    """A gypsum ceiling feature over part of a room.

    A room's ``ceiling_height_mm`` is one plane. Real gypsum architecture is
    local: a dropped patch over a shower, a bulkhead band carrying services
    along a wall, a cove around a perimeter. Each is its own polygon at its own
    height, so it obstructs light and reads on the plan where it actually is.
    """

    id: str
    name: str
    room_id: str
    kind: str
    point_ids: tuple[str, ...] = Field(min_length=3)
    height_mm: FinitePositive
    """The finished underside, measured from the room's floor."""

    geometry_evidence: str


class SiteSpec(StrictModel):
    """Geographic placement, used only for solar geometry.

    ``true_north_deg`` is the clockwise bearing of the plan ``+Y`` axis from
    true north. Latitude and longitude stay ``None`` until someone states them,
    because a guessed location produces confident but wrong sun angles.
    """

    name: str = "Site"
    latitude_deg: Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)] | None = None
    longitude_deg: Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)] | None = None
    elevation_mm: float = Field(default=0.0, allow_inf_nan=False)
    true_north_deg: Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)] = 0.0
    timezone: str | None = None
    evidence: str


class PixelPoint(StrictModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)


class UnderlaySpec(StrictModel):
    """A calibrated raster or SVG reference drawing behind the tracing canvas.

    The underlay is never building geometry. It only maps image pixels to plan
    millimetres so a person can trace over it:
    ``plan = rotate(rotation_deg) * ((pixel - origin_px) * mm_per_px)`` with the
    image ``y`` axis pointing down and the plan ``y`` axis pointing up.
    """

    file_name: str
    sha256: str
    width_px: Annotated[int, Field(gt=0)]
    height_px: Annotated[int, Field(gt=0)]
    mm_per_px: FinitePositive
    origin_px: PixelPoint
    rotation_deg: Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)] = 0.0
    opacity: Annotated[float, Field(ge=0, le=1)] = 0.55
    calibration_note: str | None = None
    evidence: str


class PlanDocument(StrictModel):
    schema_id: str = Field(alias="schema")
    project_id: str
    building_name: str
    declared_internal_area_m2: FinitePositive | None = None
    source: SourceDocument
    coordinate_frame: CoordinateFrame
    evidence: dict[str, Evidence]
    points: dict[str, PlanPoint]
    controls: tuple[ControlDimension, ...]
    rooms: tuple[RoomSpec, ...]
    default_wall: DefaultWall
    wall_overrides: tuple[WallOverride, ...] = ()
    apertures: tuple[ApertureSpec, ...] = ()
    daylight_sources: tuple[DaylightSourceSpec, ...] = ()
    stairs: tuple[StairSpec, ...] = ()
    soffits: tuple[SoffitSpec, ...] = ()
    site: SiteSpec | None = None
    underlay: UnderlaySpec | None = None
    review_notes: tuple[str, ...] = ()

    @model_validator(mode="after")
    def validate_references(self) -> PlanDocument:
        if self.schema_id not in SUPPORTED_PLAN_SCHEMAS:
            raise ValueError(
                f"Unsupported plan schema {self.schema_id!r}; expected one of {list(SUPPORTED_PLAN_SCHEMAS)}"
            )
        if (self.site is not None or self.underlay is not None) and self.schema_id == LEGACY_V2_PLAN_SCHEMA:
            raise ValueError(f"A site or underlay block requires schema {CURRENT_PLAN_SCHEMA!r}")
        evidence_ids = set(self.evidence)
        point_ids = set(self.points)
        room_ids = [room.id for room in self.rooms]
        if len(room_ids) != len(set(room_ids)):
            raise ValueError("Room IDs must be unique")
        aperture_ids = [aperture.id for aperture in self.apertures]
        if len(aperture_ids) != len(set(aperture_ids)):
            raise ValueError("Aperture IDs must be unique")
        daylight_source_ids = [source.id for source in self.daylight_sources]
        if len(daylight_source_ids) != len(set(daylight_source_ids)):
            raise ValueError("Daylight source IDs must be unique")
        for point_id, point in self.points.items():
            if point.evidence not in evidence_ids:
                raise ValueError(f"Point {point_id!r} has unknown evidence {point.evidence!r}")
        for room in self.rooms:
            unknown = set(room.point_ids) - point_ids
            if unknown:
                raise ValueError(f"Room {room.id!r} has unknown points {sorted(unknown)}")
            if room.ceiling_evidence not in evidence_ids or room.geometry_evidence not in evidence_ids:
                raise ValueError(f"Room {room.id!r} has unknown evidence")
        for control in self.controls:
            unknown = {control.from_point, control.to_point} - point_ids
            if unknown:
                raise ValueError(f"Control {control.id!r} has unknown points {sorted(unknown)}")
        for override in self.wall_overrides:
            unknown = set(override.point_ids) - point_ids
            if unknown or override.evidence not in evidence_ids:
                raise ValueError("A wall override has an unknown point or evidence reference")
        known_rooms = set(room_ids)
        for aperture in self.apertures:
            unknown = set(aperture.host_edge) - point_ids
            if unknown or set(aperture.room_ids) - known_rooms:
                raise ValueError(f"Aperture {aperture.id!r} has an unknown point or room reference")
            if aperture.geometry_evidence not in evidence_ids or aperture.height_evidence not in evidence_ids:
                raise ValueError(f"Aperture {aperture.id!r} has unknown evidence")
            if aperture.swing is not None and aperture.kind != OpeningKind.DOOR:
                raise ValueError(f"Aperture {aperture.name!r} has a door swing but is not a door")
        for source in self.daylight_sources:
            unknown = set(source.point_ids) - point_ids
            if unknown or source.geometry_evidence not in evidence_ids:
                raise ValueError(f"Daylight source {source.id!r} has an unknown point or evidence reference")
        stair_ids = [stair.id for stair in self.stairs]
        if len(stair_ids) != len(set(stair_ids)):
            raise ValueError("Stair IDs must be unique")
        for stair in self.stairs:
            unknown = set(stair.point_ids) - point_ids
            if unknown:
                raise ValueError(f"Stair {stair.id!r} has unknown points {sorted(unknown)}")
            if set(stair.room_ids) - known_rooms:
                raise ValueError(f"Stair {stair.id!r} references an unknown room")
            if stair.geometry_evidence not in evidence_ids or stair.riser_evidence not in evidence_ids:
                raise ValueError(f"Stair {stair.id!r} has unknown evidence")
        soffit_ids = [soffit.id for soffit in self.soffits]
        if len(soffit_ids) != len(set(soffit_ids)):
            raise ValueError("Soffit IDs must be unique")
        for soffit in self.soffits:
            unknown = set(soffit.point_ids) - point_ids
            if unknown:
                raise ValueError(f"Soffit {soffit.id!r} has unknown points {sorted(unknown)}")
            if soffit.room_id not in known_rooms:
                raise ValueError(f"Soffit {soffit.id!r} references an unknown room {soffit.room_id!r}")
            if soffit.geometry_evidence not in evidence_ids:
                raise ValueError(f"Soffit {soffit.id!r} has unknown evidence")
        if self.site is not None and self.site.evidence not in evidence_ids:
            raise ValueError(f"The site block has unknown evidence {self.site.evidence!r}")
        if self.underlay is not None and self.underlay.evidence not in evidence_ids:
            raise ValueError(f"The underlay block has unknown evidence {self.underlay.evidence!r}")
        return self


@dataclass(frozen=True, slots=True)
class ControlCheck:
    id: str
    expected_mm: float
    traced_mm: float
    discrepancy_mm: float
    tolerance_mm: float
    passed: bool


@dataclass(frozen=True, slots=True)
class PlanFinding:
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class PlanReview:
    source_digest: str
    controls: tuple[ControlCheck, ...]
    blockers: tuple[PlanFinding, ...]
    warnings: tuple[PlanFinding, ...]
    room_count: int
    wall_count: int
    traced_net_area_m2: float
    declared_internal_area_m2: float | None
    review_notes: tuple[str, ...]
    aperture_count: int = 0
    stair_count: int = 0
    site_located: bool = False
    has_underlay: bool = False

    @property
    def publishable(self) -> bool:
        return not self.blockers


@dataclass(frozen=True, slots=True)
class DraftBuildReport:
    path: Path
    revision: str
    source_digest: str
    published: bool
    rooms_verified: tuple[str, ...]
    controls: tuple[ControlCheck, ...]
    schema_issue_count: int
    warnings: tuple[PlanFinding, ...]


@dataclass(frozen=True, slots=True)
class _ValidatedPlan:
    document: PlanDocument
    source_digest: str
    review: PlanReview
    polygons: dict[str, Polygon2D]
    room_point_ids: dict[str, tuple[str, ...]]


@dataclass(frozen=True, slots=True)
class _Edge:
    key: str
    point_ids: tuple[str, str]
    room_ids: tuple[str, ...]
    thickness_mm: float
    wall_key: str
    """The physical wall this room edge is a face of, or "" where there is none.

    Two rooms traced with their own points describe one wall from both sides,
    so several edges share a wall key and compile to a single ``IfcWall``. An
    edge its override omits has no wall and reports a virtual boundary.
    """


@dataclass(frozen=True, slots=True)
class _Wall:
    key: str
    point_ids: tuple[str, str]
    """The face the solid is extruded from, ordered so it grows inwards."""

    room_ids: tuple[str, ...]
    thickness_mm: float
    face_keys: tuple[str, ...]
    base_elevation_mm: float | None = None
    start_override_mm: tuple[float, float] | None = None
    """Plan start of the solid when it runs past the reference face's ends."""
    length_override_mm: float | None = None
    """Solid length when it runs past the reference face's ends."""
    face_offset_mm: float = 0.0
    """Pull-back of the solid towards the reference line, so its faces straddle
    the midline between the traced faces. Zero when the thickness fills the gap
    exactly; down to half the thickness when both faces coincide. Each room then
    resolves its own side instead of both landing on the nearer face."""


def _sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _source_digest(source_bytes: bytes) -> str:
    digest = hashlib.sha256(source_bytes + b"\0" + GENERATOR_VERSION.encode()).hexdigest()
    return f"sha256:{digest}"


def _ifc_guid(project_id: str, ifc_class: str, logical_id: str) -> str:
    value = uuid5(GUID_NAMESPACE, f"{project_id}|{ifc_class}|{logical_id}")
    return ifcopenshell.guid.compress(value.hex)


def _union_span(
    a_start: Point2D, a_end: Point2D, b_start: Point2D, b_end: Point2D
) -> tuple[float, float]:
    """Plan span covering both faces, measured from ``a_start`` along ``a``."""

    dx, dy = a_end.x - a_start.x, a_end.y - a_start.y
    length = hypot(dx, dy)
    unit_x, unit_y = dx / length, dy / length

    def along(point: Point2D) -> float:
        return (point.x - a_start.x) * unit_x + (point.y - a_start.y) * unit_y

    ends = (0.0, length, along(b_start), along(b_end))
    return min(ends), max(ends)


def _signed_area(points: tuple[Point2D, ...]) -> float:
    return (
        sum(
            points[index].x * points[(index + 1) % len(points)].y
            - points[(index + 1) % len(points)].x * points[index].y
            for index in range(len(points))
        )
        / 2
    )


def _orientation(a: Point2D, b: Point2D, c: Point2D) -> float:
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)


def _segments_cross(a: Point2D, b: Point2D, c: Point2D, d: Point2D) -> bool:
    return _orientation(a, b, c) * _orientation(a, b, d) < 0 and _orientation(c, d, a) * _orientation(c, d, b) < 0


def _is_simple(points: tuple[Point2D, ...]) -> bool:
    count = len(points)
    for first in range(count):
        a, b = points[first], points[(first + 1) % count]
        for second in range(first + 1, count):
            if second in {first, (first + 1) % count} or (second + 1) % count in {first, (first + 1) % count}:
                continue
            c, d = points[second], points[(second + 1) % count]
            if _segments_cross(a, b, c, d):
                return False
    return True


def _polygons_overlap(first: Polygon2D, second: Polygon2D, *, tolerance_mm: float = 0.5) -> bool:
    first_edges = tuple(
        (first.outer[index], first.outer[(index + 1) % len(first.outer)]) for index in range(len(first.outer))
    )
    second_edges = tuple(
        (second.outer[index], second.outer[(index + 1) % len(second.outer)]) for index in range(len(second.outer))
    )
    if any(_segments_cross(a, b, c, d) for a, b in first_edges for c, d in second_edges):
        return True

    def strictly_inside(point: Point2D, polygon: Polygon2D) -> bool:
        return point_in_polygon(point, polygon) and polygon_edge_distance(point, polygon) > tolerance_mm

    return any(strictly_inside(point, second) for point in first.outer) or any(
        strictly_inside(point, first) for point in second.outer
    )


def _flight_extent(footprint: Polygon2D, up_bearing_deg: float) -> tuple[float, float, Point2D, tuple[float, float]]:
    """Return the going, the width, the bottom corner, and the ascending unit vector.

    The ascending bearing is measured clockwise from plan ``+Y``, matching the
    site convention, so a plan author states the direction the stair climbs
    rather than a vector.
    """

    radians = np.radians(up_bearing_deg)
    ux, uy = float(np.sin(radians)), float(np.cos(radians))
    nx, ny = uy, -ux
    alongs = [point.x * ux + point.y * uy for point in footprint.outer]
    acrosses = [point.x * nx + point.y * ny for point in footprint.outer]
    min_along, max_along = min(alongs), max(alongs)
    min_across, max_across = min(acrosses), max(acrosses)
    corner = Point2D(min_along * ux + min_across * nx, min_along * uy + min_across * ny)
    return max_along - min_along, max_across - min_across, corner, (ux, uy)


def _stair_vertical_extent(
    stair: StairSpec,
    rooms_by_id: Mapping[str, RoomSpec],
    tread_count: int,
) -> tuple[int, float]:
    """Resolve the risers and rise from the flight's two floor datums.

    A straight flight between landings normally has one more riser than visible
    treads.  The plan already states both split-level floor elevations, so they
    are stronger evidence for the total rise than multiplying the visible
    treads by an assumed riser height.
    """

    if stair.rise_role == "split_level" and stair.room_ids:
        elevations = sorted({rooms_by_id[room_id].floor_elevation_mm for room_id in stair.room_ids})
        if len(elevations) >= 2:
            rise_mm = elevations[-1] - elevations[0]
            riser_count = max(1, round(rise_mm / stair.riser_height_mm))
            if abs(riser_count * stair.riser_height_mm - rise_mm) <= 50:
                return riser_count, rise_mm
    return tread_count, tread_count * stair.riser_height_mm


def _edges_face_each_other(
    a_start: Point2D,
    a_end: Point2D,
    b_start: Point2D,
    b_end: Point2D,
    *,
    gap_mm: float = 450.0,
    angle_deg: float = 4.0,
    overlap_fraction: float = 0.5,
    of_longer: bool = False,
) -> bool:
    """Whether two room edges are the two faces of one wall.

    Near parallel, within a wall thickness of each other, and overlapping along
    most of the shorter edge. This is what distinguishes a party wall from an
    external one when the two rooms were traced with separate points.
    """

    a_length = distance_2d(a_start, a_end)
    b_length = distance_2d(b_start, b_end)
    if a_length < 1 or b_length < 1:
        return False
    ux, uy = (a_end.x - a_start.x) / a_length, (a_end.y - a_start.y) / a_length
    vx, vy = (b_end.x - b_start.x) / b_length, (b_end.y - b_start.y) / b_length
    cosine = abs(ux * vx + uy * vy)
    if cosine < np.cos(np.radians(angle_deg)):
        return False

    def along(point: Point2D) -> float:
        return (point.x - a_start.x) * ux + (point.y - a_start.y) * uy

    def across(point: Point2D) -> float:
        return abs(-(point.x - a_start.x) * uy + (point.y - a_start.y) * ux)

    if (across(b_start) + across(b_end)) / 2 > gap_mm:
        return False
    low, high = sorted((along(b_start), along(b_end)))
    overlap = max(0.0, min(high, a_length) - max(low, 0.0))
    reference = max(a_length, b_length) if of_longer else min(a_length, b_length)
    return overlap >= reference * overlap_fraction


def _edge_key(first: str, second: str) -> str:
    return "--".join(sorted((first, second)))


def _overlapping_wall_edges(
    document: PlanDocument,
    rooms_by_edge: dict[str, set[str]],
    omitted_edges: set[str],
) -> list[PlanFinding]:
    """Two rooms either side of one wall must trace the same edge, not two.

    Traced as separate near-collinear lines they compile to separate walls, and
    an aperture hosted on one of them is then absent from the room behind the
    other. The washroom's yard door vanished from the yard that way and nothing
    reported it.

    A warning and not a blocker: a room that is a level of another shares its
    walls legitimately, and so may a wall traced in two pieces for a good
    reason. What it cannot be is invisible.
    """
    nested = {room.id: room.part_of for room in document.rooms if room.part_of is not None}

    def related(first: set[str], second: set[str]) -> bool:
        return bool(
            first & second
            or {nested.get(item) for item in first} & second
            or first & {nested.get(item) for item in second}
        )

    segments = []
    for key in sorted(rooms_by_edge):
        if key in omitted_edges:
            continue
        first, second = key.split("--")
        if first not in document.points or second not in document.points:
            continue
        segments.append((key, document.points[first].domain(), document.points[second].domain()))

    findings: list[PlanFinding] = []
    for index, (key, start, end) in enumerate(segments):
        length = distance_2d(start, end)
        if length < 1:
            continue
        unit = ((end.x - start.x) / length, (end.y - start.y) / length)
        for other_key, other_start, other_end in segments[index + 1 :]:
            if related(rooms_by_edge[key], rooms_by_edge[other_key]):
                continue
            other_length = distance_2d(other_start, other_end)
            if other_length < 1:
                continue
            other_unit = ((other_end.x - other_start.x) / other_length, (other_end.y - other_start.y) / other_length)
            if abs(unit[0] * other_unit[0] + unit[1] * other_unit[1]) < COLLINEAR_COSINE:
                continue
            along = []
            across = []
            for point in (other_start, other_end):
                offset = (point.x - start.x, point.y - start.y)
                along.append(offset[0] * unit[0] + offset[1] * unit[1])
                across.append(abs(offset[0] * -unit[1] + offset[1] * unit[0]))
            overlap = min(max(along), length) - max(min(along), 0.0)
            if overlap < OVERLAP_TOLERANCE_MM or min(across) > MAX_SHARED_WALL_OFFSET_MM:
                continue
            findings.append(
                PlanFinding(
                    "overlapping_wall_edges",
                    f"Edges {key!r} and {other_key!r} run along the same wall "
                    f"{min(across):.0f} mm apart for {overlap:.0f} mm; trace one edge and share it",
                )
            )
    return findings


# Within three degrees of parallel, and close enough to be two faces of one wall.
COLLINEAR_COSINE = 0.9986
OVERLAP_TOLERANCE_MM = 200.0
MAX_SHARED_WALL_OFFSET_MM = 150.0


MIN_WALL_THICKNESS_MM = 60.0
STITCH_CAP_MM = 350.0
"""Longest corner gap the compiler closes between two wall ends.

A gap this size cannot be a passage -- the narrowest door is twice it -- so a
wall end stopping this short of another solid is a tracing gap, not a doorway.
Stitching runs along the wall's own line into the joint, never sideways, so it
cannot invent a wall where the plan drew none.
"""


def _stitch_wall_ends(
    walls: list[_Wall],
    point_map: Mapping[str, Point2D],
    points_by_edge: Mapping[str, tuple[str, str]],
    rooms_by_id: Mapping[str, RoomSpec],
    apertures: tuple[ApertureSpec, ...],
    room_point_ids: Mapping[str, tuple[str, ...]],
    log: list[tuple[str, str, float, str]] | None = None,
) -> None:
    """Extend wall ends into the corner joints they stop short of, in place.

    Room outlines are traced independently, so two walls forming one corner
    often leave a slit between their ends -- up to 300 mm where party walls
    were traced from both sides. Every end reaches for the nearest other solid
    along its own line; corner pairs meet at their lines' intersection, and a
    wall running into another's side embeds halfway through it. Openings guard
    both the extension path and the contact point, so a door at a corner keeps
    its full width. All reaches are computed from the pre-stitch geometry and
    applied together through the existing start/length overrides.
    """

    apertures_by_edge: dict[str, list[ApertureSpec]] = {}
    for aperture in apertures:
        apertures_by_edge.setdefault(_edge_key(*aperture.host_edge), []).append(aperture)

    # Two walls can only share a corner where their rooms meet: a reach across
    # distant rooms would bridge open space rather than close a joint. Room
    # outlines that never come within a wall thickness of each other are not
    # neighbours, however the rays line up.
    outlines: dict[str, list[Point2D]] = {}
    for room_id, point_ids in room_point_ids.items():
        outlines[room_id] = [point_map[point_id] for point_id in point_ids]

    def outline_gap(first: str, second: str) -> float:
        if first == second:
            return 0.0
        best = float("inf")
        for ring, other_ring in ((outlines[first], outlines[second]), (outlines[second], outlines[first])):
            for point in ring:
                best = min(best, _point_to_outline(point.x, point.y, other_ring))
        return best

    neighbours: dict[frozenset[str], bool] = {}

    def _point_to_outline(point_x: float, point_y: float, outline: list[Point2D]) -> float:
        best = float("inf")
        for index in range(len(outline)):
            base = outline[index]
            tip = outline[(index + 1) % len(outline)]
            dx, dy = tip.x - base.x, tip.y - base.y
            length_sq = dx * dx + dy * dy
            along = ((point_x - base.x) * dx + (point_y - base.y) * dy) / length_sq if length_sq else 0.0
            along = min(max(along, 0.0), 1.0)
            best = min(best, hypot(point_x - (base.x + dx * along), point_y - (base.y + dy * along)))
        return best

    def adjoining(first_rooms: tuple[str, ...], second_rooms: tuple[str, ...]) -> bool:
        for first in first_rooms:
            for second in second_rooms:
                key = frozenset((first, second))
                known = neighbours.get(key)
                if known is None:
                    known = outline_gap(first, second) <= 200
                    neighbours[key] = known
                if known:
                    return True
        return False

    class _Extent(NamedTuple):
        key: str
        start_x: float
        start_y: float
        unit_x: float
        unit_y: float
        length: float
        half_width: float
        base: float
        top: float

    extents: list[_Extent] = []
    spans: list[list[tuple[float, float]]] = []
    for wall in walls:
        first = point_map[wall.point_ids[0]]
        second = point_map[wall.point_ids[1]]
        run = hypot(second.x - first.x, second.y - first.y)
        unit_x, unit_y = (second.x - first.x) / run, (second.y - first.y) / run
        if wall.start_override_mm is not None:
            start_x, start_y = wall.start_override_mm
        else:
            start_x, start_y = first.x, first.y
        length = wall.length_override_mm if wall.length_override_mm is not None else run
        floors = [rooms_by_id[room_id].floor_elevation_mm for room_id in wall.room_ids]
        tops = [
            rooms_by_id[room_id].floor_elevation_mm + rooms_by_id[room_id].ceiling_height_mm
            for room_id in wall.room_ids
        ]
        extents.append(
            _Extent(wall.key, start_x, start_y, unit_x, unit_y, length, wall.thickness_mm / 2, min(floors), max(tops))
        )
        wall_spans: list[tuple[float, float]] = []
        for member in wall.face_keys:
            edge_first = point_map[points_by_edge[member][0]]
            edge_end = point_map[points_by_edge[member][1]]
            edge_run = hypot(edge_end.x - edge_first.x, edge_end.y - edge_first.y)
            sign = ((edge_end.x - edge_first.x) * unit_x + (edge_end.y - edge_first.y) * unit_y) / edge_run
            origin = (edge_first.x - start_x) * unit_x + (edge_first.y - start_y) * unit_y
            for aperture in apertures_by_edge.get(member, ()):
                offset = (
                    aperture.offset_mm
                    if aperture.offset_mm is not None
                    else (edge_run - aperture.width_mm) / 2
                )
                low = origin + sign * offset
                high = origin + sign * (offset + aperture.width_mm)
                wall_spans.append((min(low, high), max(low, high)))
        spans.append(wall_spans)

    def vertical_overlap(first: _Extent, second: _Extent) -> float:
        return min(first.top, second.top) - max(first.base, second.base)

    def reach(
        index: int, back: bool
    ) -> tuple[float, int, float, float] | None:
        """How far this end must grow to touch another solid, and which."""

        own = extents[index]
        direction = -1.0 if back else 1.0
        dir_x, dir_y = own.unit_x * direction, own.unit_y * direction
        origin_x = own.start_x if back else own.start_x + own.unit_x * own.length
        origin_y = own.start_y if back else own.start_y + own.unit_y * own.length

        def contact(
            other_index: int, point_x: float, point_y: float, along: float
        ) -> tuple[float, int, float, float] | None:
            other = extents[other_index]
            ahead = (point_x - origin_x) * dir_x + (point_y - origin_y) * dir_y
            if ahead <= 0 or ahead > STITCH_CAP_MM:
                return None
            dist = hypot(
                point_x - (origin_x + dir_x * ahead), point_y - (origin_y + dir_y * ahead)
            )
            if dist > own.half_width + other.half_width + 10:
                return None
            interior = 200 < along < other.length - 200
            # Into another's side: stop at its centreline, pulling back when
            # wider so our corners stay inside it. End to end: butt the point.
            touch = ahead - max(own.half_width - other.half_width, 0.0) if interior else ahead
            if touch <= 5:
                return None
            return (touch, other_index, along, ahead)

        best: tuple[float, int, float, float] | None = None
        for other_index, other in enumerate(extents):
            if other_index == index or vertical_overlap(own, other) < 500:
                continue
            if not adjoining(walls[index].room_ids, walls[other_index].room_ids):
                continue
            rel_x, rel_y = other.start_x - origin_x, other.start_y - origin_y
            denom = dir_x * other.unit_y - dir_y * other.unit_x
            if abs(denom) < 0.05:
                # Near-parallel lines never cross ahead: only a head-on end
                # meeting counts, which is the collinear party-wall gap.
                for along in (0.0, other.length):
                    end_x = other.start_x + other.unit_x * along
                    end_y = other.start_y + other.unit_y * along
                    lateral = abs((end_x - origin_x) * dir_y - (end_y - origin_y) * dir_x)
                    if lateral > own.half_width + other.half_width + 5:
                        continue
                    hit = contact(other_index, end_x, end_y, along)
                    if hit is not None and (best is None or hit[0] < best[0]):
                        best = hit
                continue
            along_raw = (rel_x * dir_y - rel_y * dir_x) / denom
            along = min(max(along_raw, 0.0), other.length)
            hit = contact(
                other_index,
                other.start_x + other.unit_x * along,
                other.start_y + other.unit_y * along,
                along,
            )
            if hit is not None and (best is None or hit[0] < best[0]):
                best = hit
        return best

    plans: dict[tuple[int, bool], tuple[float, int, float]] = {}
    for index in range(len(extents)):
        for back in (True, False):
            hit = reach(index, back)
            if hit is not None and hit[0] > 5:
                plans[(index, back)] = (hit[0], hit[1], hit[2])

    # Two ends reaching for each other meet in the middle: at their lines'
    # intersection for a corner, halfway for a collinear run. Anything else is
    # one wall running into another's side, which stops at its centreline.
    for (index, back), (_touch, other_index, along) in list(plans.items()):
        own = extents[index]
        end_at = 0.0 if back else own.length
        other = extents[other_index]
        other_end_zone = along <= 200 or along >= other.length - 200
        if not other_end_zone:
            continue
        for other_back in (True, False):
            partner = plans.get((other_index, other_back))
            if partner is None or partner[1] != index:
                continue
            partner_end = 0.0 if other_back else other.length
            if abs(partner[2] - end_at) > 250:
                continue
            own_end_x = own.start_x + own.unit_x * end_at
            own_end_y = own.start_y + own.unit_y * end_at
            other_end_x = other.start_x + other.unit_x * partner_end
            other_end_y = other.start_y + other.unit_y * partner_end
            denom = own.unit_x * other.unit_y - own.unit_y * other.unit_x
            if abs(denom) < 0.2:
                # Near-collinear runs: each covers half the gap between ends.
                half = hypot(other_end_x - own_end_x, other_end_y - own_end_y) / 2
                plans[(index, back)] = (min(half, STITCH_CAP_MM), other_index, along)
            else:
                direction = -1.0 if back else 1.0
                rel_x, rel_y = other_end_x - own_end_x, other_end_y - own_end_y
                corner = (rel_x * other.unit_y - rel_y * other.unit_x) / denom * direction
                if corner < 0:
                    continue
                plans[(index, back)] = (corner, other_index, along)
            break

    def clear(index: int, back: bool, extension: float, contact: tuple[int, float]) -> bool:
        own = extents[index]
        if extension <= 5 or extension > STITCH_CAP_MM:
            return False
        # An opening behind the wall end is unaffected by growth past it; only
        # a span reaching into the extension itself blocks the stitch.
        zone = (-extension - 10, 0.0) if back else (own.length, own.length + extension + 10)
        for low, high in spans[index]:
            if high >= zone[0] and low <= zone[1]:
                return False
        other_index, along = contact
        if not all(high < along - 150 or low > along + 150 for low, high in spans[other_index]):
            return False
        # The reach must hug the rooms' outlines all the way: a path straying
        # off the wall band is shooting across open space, not closing a joint.
        direction = -1.0 if back else 1.0
        base = 0.0 if back else own.length
        band = own.half_width + 100
        allowed = set(walls[index].room_ids) | set(walls[other_index].room_ids)
        steps = max(int(extension // 40), 1)
        for step in range(1, steps + 1):
            dist = base + direction * extension * step / steps
            point_x = own.start_x + own.unit_x * dist
            point_y = own.start_y + own.unit_y * dist
            if not any(
                _point_to_outline(point_x, point_y, outlines[room_id]) <= band for room_id in allowed
            ):
                return False
        return True

    growth = {index: [0.0, 0.0] for index in range(len(extents))}
    for (index, back), (touch, other_index, along) in plans.items():
        if clear(index, back, touch, (other_index, along)):
            growth[index][0 if back else 1] = touch
            if log is not None:
                log.append(
                    (
                        extents[index].key,
                        "back" if back else "fwd",
                        round(touch, 1),
                        extents[other_index].key,
                    )
                )

    for index, (back_grow, fwd_grow) in growth.items():
        if back_grow <= 0 and fwd_grow <= 0:
            continue
        own = extents[index]
        walls[index] = replace(
            walls[index],
            start_override_mm=(own.start_x - own.unit_x * back_grow, own.start_y - own.unit_y * back_grow),
            length_override_mm=own.length + back_grow + fwd_grow,
        )


MIN_WALL_THICKNESS_MM = 60.0


def _signed_across(start: Point2D, end: Point2D, point: Point2D) -> float:
    """How far ``point`` lies to the left of the directed line ``start`` to ``end``."""

    length = distance_2d(start, end)
    ux, uy = (end.x - start.x) / length, (end.y - start.y) / length
    return -(point.x - start.x) * uy + (point.y - start.y) * ux


def _override_thickness(override: WallOverride | None, fallback: float) -> float:
    if override is None or override.thickness_mm is None:
        return fallback
    return override.thickness_mm


def _wall_graph(
    document: PlanDocument, room_point_ids: Mapping[str, tuple[str, ...]]
) -> tuple[tuple[_Edge, ...], tuple[_Wall, ...]]:
    """Group room edges into the physical walls they are faces of."""

    rooms_by_edge: dict[str, list[str]] = {}
    points_by_edge: dict[str, tuple[str, str]] = {}
    for room_id, point_ids in room_point_ids.items():
        for index, first in enumerate(point_ids):
            second = point_ids[(index + 1) % len(point_ids)]
            key = _edge_key(first, second)
            rooms_by_edge.setdefault(key, []).append(room_id)
            points_by_edge.setdefault(key, (first, second))
    overrides = {_edge_key(*item.point_ids): item for item in document.wall_overrides}
    point_map = {key: value.domain() for key, value in document.points.items()}
    keys = sorted(rooms_by_edge)

    def ends(key: str) -> tuple[Point2D, Point2D]:
        first, second = points_by_edge[key]
        return point_map[first], point_map[second]

    rooms_by_id = {room.id: room for room in document.rooms}

    def nested(first: str, second: str) -> bool:
        """Whether one room is a sub-space of the other, at any depth."""

        for lower, upper in ((first, second), (second, first)):
            seen: set[str] = set()
            parent = rooms_by_id[lower].part_of
            while parent is not None and parent not in seen:
                if parent == upper:
                    return True
                seen.add(parent)
                parent = rooms_by_id[parent].part_of if parent in rooms_by_id else None
        return False

    outlines = {
        room_id: Polygon2D(tuple(point_map[point_id] for point_id in ids), ())
        for room_id, ids in room_point_ids.items()
    }

    def inside_probe(key: str, room_id: str) -> Point2D | None:
        """A point just inside the room, off the middle of one of its own edges."""

        start, end = ends(key)
        length = distance_2d(start, end)
        if length < 1:
            return None
        unit_x, unit_y = (end.x - start.x) / length, (end.y - start.y) / length
        middle = Point2D((start.x + end.x) / 2, (start.y + end.y) / 2)
        step = min(length / 4, 50.0)
        for sign in (1.0, -1.0):
            candidate = Point2D(middle.x - unit_y * step * sign, middle.y + unit_x * step * sign)
            if point_in_polygon(candidate, outlines[room_id]):
                return candidate
        return None

    def shares_a_side(key: str, other: str) -> Point2D | None:
        """The inside point, when both rooms lie the same side of ``key``'s line.

        Two faces of one wall look at each other, so their rooms sit on
        opposite sides of it. Rooms on the same side are instead two traces of
        one face -- the inner skin of an external wall, measured once from each
        room -- and the wall belongs outside both of them, not in the
        millimetres between the traces.
        """

        near = inside_probe(key, rooms_by_edge[key][0])
        far_inside = inside_probe(other, rooms_by_edge[other][0])
        if near is None or far_inside is None:
            return None
        start, end = ends(key)
        if _signed_across(start, end, near) * _signed_across(start, end, far_inside) <= 0:
            return None
        return near

    # Only faces belonging to different rooms pair up: a single room's own two
    # edges can run close and parallel without being one wall. A level traced
    # inside its parent at the same elevation is the same case, since both
    # faces of the shared line look the same way rather than at each other --
    # but a split level sits on another storey, so its faces across a few
    # millimetres are the two sides of one wall and pair up normally.
    paired: dict[str, str] = {}
    # Where the two traces turn out to be one face, the redundant inner one
    # maps to the trace that keeps the wall, so its room still reports a face.
    aliased: dict[str, str] = {}

    def accept(key: str, other: str) -> None:
        """Record two faces of one wall, or two traces of one face."""

        inside = shares_a_side(key, other)
        if inside is None:
            paired[key] = other
            paired[other] = key
            return
        # The trace further from the rooms keeps the wall; the nearer one is the
        # same face measured again, and would put the wall inside the room.
        outer, inner = (
            (key, other)
            if abs(_signed_across(*ends(key), inside)) >= abs(_signed_across(*ends(other), inside))
            else (other, key)
        )
        aliased[inner] = outer

    for index, key in enumerate(keys):
        if key in paired or key in aliased:
            continue
        a_start, a_end = ends(key)
        for other in keys[index + 1 :]:
            if other in paired or other in aliased or set(rooms_by_edge[other]) & set(rooms_by_edge[key]):
                continue
            if any(
                nested(near, far)
                and abs(rooms_by_id[near].floor_elevation_mm - rooms_by_id[far].floor_elevation_mm) <= 100
                for near in rooms_by_edge[key]
                for far in rooms_by_edge[other]
            ):
                continue
            b_start, b_end = ends(other)
            # Merging needs the two faces to be the same run of wall, not one
            # short edge lapping a long one: the wall would outrun the shorter
            # room's outline and its face would stop being that room's own.
            if _edges_face_each_other(a_start, a_end, b_start, b_end, overlap_fraction=0.8, of_longer=True):
                accept(key, other)
                break
            # A shorter run contained in a longer one is still one wall traced
            # with different points. Independently measured room faces can sit
            # more than the nominal 150 mm build-up apart, so allow a contained
            # face gap up to 250 mm. The 80% overlap requirement still prevents
            # a nearby parallel wall from merging merely because it is close.
            a_length = hypot(a_end.x - a_start.x, a_end.y - a_start.y)
            b_length = hypot(b_end.x - b_start.x, b_end.y - b_start.y)
            gap = (abs(_signed_across(a_start, a_end, b_start)) + abs(_signed_across(a_start, a_end, b_end))) / 2
            if (
                min(a_length, b_length) >= 500
                and gap <= 250
                and _edges_face_each_other(a_start, a_end, b_start, b_end, overlap_fraction=0.8, of_longer=False)
            ):
                accept(key, other)
                break

    aliases_by_outer: dict[str, tuple[str, ...]] = {}
    for inner, outer in aliased.items():
        aliases_by_outer[outer] = (*aliases_by_outer.get(outer, ()), inner)

    edges: list[_Edge] = []
    walls: list[_Wall] = []
    for key in keys:
        if key in aliased:
            continue
        far = paired.get(key)
        if far is not None and far < key:
            continue
        group = (key,) if far is None else (key, far)
        # A trace that turned out to be the same face joins the wall the other
        # one keeps, so its room still reports a boundary and its apertures
        # still land somewhere.
        faces = group + tuple(alias for member in group for alias in aliases_by_outer.get(member, ()))
        rooms = tuple(sorted({room for member in faces for room in rooms_by_edge[member]}))
        override = next((overrides[member] for member in faces if member in overrides), None)
        if override is not None and override.omit:
            # No wall, but the rooms still meet here: the edge stays so the
            # boundary can be reported, and reports as virtual for want of a
            # wall to relate to.
            for member in faces:
                edges.append(_Edge(member, points_by_edge[member], rooms, 0.0, ""))
            continue
        a_start, a_end = ends(key)
        length = hypot(a_end.x - a_start.x, a_end.y - a_start.y)
        span_near, span_far = 0.0, length
        if far is None:
            thickness = _override_thickness(override, document.default_wall.thickness_mm)
            reference = points_by_edge[key]
            towards_right = True
        else:
            # The wall fills the gap the two traced faces leave between them.
            b_start, b_end = ends(far)
            gap = (abs(_signed_across(a_start, a_end, b_start)) + abs(_signed_across(a_start, a_end, b_end))) / 2
            thickness = _override_thickness(override, max(gap, MIN_WALL_THICKNESS_MM))
            # Extrude towards the far face, which the placement reaches by
            # offsetting to the right of the reference direction.
            towards_right = _signed_across(a_start, a_end, b_start) < 0
            first, second = points_by_edge[key]
            reference = (first, second) if towards_right else (second, first)
            # A contained run is shorter than the wall it joins, so the solid
            # spans the union of both faces rather than the reference face
            # alone; otherwise the longer room's overhang would have no wall.
            if not _edges_face_each_other(a_start, a_end, b_start, b_end, overlap_fraction=0.8, of_longer=True):
                span_near, span_far = _union_span(a_start, a_end, b_start, b_end)
        # Same for a trace that ran past the one keeping the wall: the wall has
        # to cover every face it stands for.
        for alias in faces[len(group) :]:
            near, off = _union_span(a_start, a_end, *ends(alias))
            span_near, span_far = min(span_near, near), max(span_far, off)
        start_override: tuple[float, float] | None = None
        length_override: float | None = None
        if (span_near, span_far) != (0.0, length):
            length_override = span_far - span_near
            unit_x, unit_y = (a_end.x - a_start.x) / length, (a_end.y - a_start.y) / length
            offset = span_near if towards_right else span_far
            start_override = (a_start.x + unit_x * offset, a_start.y + unit_y * offset)
        wall_key = "+".join(sorted(faces))
        base = override.base_elevation_mm if override else None
        face_offset = (gap - thickness) / 2 if far is not None else 0.0
        walls.append(
            _Wall(wall_key, reference, rooms, thickness, faces, base, start_override, length_override, face_offset)
        )
        for member in faces:
            edges.append(_Edge(member, points_by_edge[member], rooms, thickness, wall_key))
    _stitch_wall_ends(walls, point_map, points_by_edge, rooms_by_id, document.apertures, room_point_ids)
    return tuple(sorted(edges, key=lambda item: item.key)), tuple(walls)


def _load_and_validate(path: Path) -> _ValidatedPlan:
    source_bytes = path.read_bytes()
    document = PlanDocument.model_validate(yaml.safe_load(source_bytes))
    return _validate(document, source_bytes)


def _validate(document: PlanDocument, source_bytes: bytes) -> _ValidatedPlan:
    blockers: list[PlanFinding] = []
    warnings: list[PlanFinding] = []
    polygons: dict[str, Polygon2D] = {}
    room_point_ids: dict[str, tuple[str, ...]] = {}

    for control in document.controls:
        if control.evidence is None:
            continue
        evidence = document.evidence.get(control.evidence)
        if evidence is None:
            blockers.append(
                PlanFinding(
                    "unknown_control_evidence",
                    f"Control {control.id!r} cites evidence {control.evidence!r}, which the plan does not define",
                )
            )
        elif control.tolerance_mm < evidence.uncertainty_mm:
            # Fitting the trace harder than the evidence can justify does not
            # make the building more certain, it only hides where it is not.
            warnings.append(
                PlanFinding(
                    "control_tighter_than_evidence",
                    f"Control {control.id!r} holds {control.tolerance_mm:g} mm against "
                    f"{control.evidence!r}, which is only good to {evidence.uncertainty_mm:g} mm",
                )
            )

    for evidence_id, evidence in document.evidence.items():
        if evidence.status == EvidenceStatus.UNRESOLVED:
            blockers.append(PlanFinding("unresolved_evidence", f"Evidence {evidence_id!r} is unresolved"))
        elif evidence.status in {EvidenceStatus.ASSUMED, EvidenceStatus.OWNER_REPORTED, EvidenceStatus.TRACED}:
            warnings.append(
                PlanFinding(
                    "unverified_evidence",
                    f"{evidence_id}: {evidence.status.value}, uncertainty {evidence.uncertainty_mm:g} mm",
                )
            )

    for room in document.rooms:
        ids = tuple(room.point_ids)
        points = tuple(document.points[point_id].domain() for point_id in ids)
        if len(set(ids)) != len(ids):
            blockers.append(PlanFinding("duplicate_room_point", f"Room {room.name!r} repeats a point"))
            continue
        if not _is_simple(points):
            blockers.append(PlanFinding("self_intersection", f"Room {room.name!r} polygon self-intersects"))
            continue
        if _signed_area(points) < 0:
            ids = tuple(reversed(ids))
            points = tuple(reversed(points))
        polygon = Polygon2D(points)
        area = polygon_area(polygon)
        if area < 250_000:
            blockers.append(PlanFinding("tiny_room", f"Room {room.name!r} is smaller than 0.25 m²"))
        elif area < 1_000_000:
            # An entrance landing is legitimately under a square metre.
            warnings.append(
                PlanFinding("small_room", f"Room {room.name!r} is {area / 1_000_000:.2f} m², under 1 m²")
            )
        polygons[room.id] = polygon
        room_point_ids[room.id] = ids

    for source in document.daylight_sources:
        source_points = tuple(document.points[point_id].domain() for point_id in source.point_ids)
        if not _is_simple(source_points):
            blockers.append(
                PlanFinding("daylight_source_self_intersection", f"Daylight source {source.name!r} self-intersects")
            )
            continue
        # A ventilation shaft between two wet rooms is legitimately well under a
        # square metre, so only a degenerate footprint blocks.
        area = polygon_area(Polygon2D(source_points))
        if area < 50_000:
            blockers.append(
                PlanFinding(
                    "degenerate_daylight_source",
                    f"Daylight source {source.name!r} is {area / 1_000_000:.3f} m², too small to be a shaft",
                )
            )

    rooms_by_id = {room.id: room for room in document.rooms}
    polygon_items = sorted(polygons.items())
    for index, (first_id, first) in enumerate(polygon_items):
        for second_id, second in polygon_items[index + 1 :]:
            # A level lies inside the room it is part of; that is what makes it
            # a level rather than the room next door.
            if rooms_by_id[first_id].part_of == second_id or rooms_by_id[second_id].part_of == first_id:
                continue
            if _polygons_overlap(first, second):
                blockers.append(
                    PlanFinding(
                        "room_overlap",
                        f"Rooms {rooms_by_id[first_id].name!r} and {rooms_by_id[second_id].name!r} overlap",
                    )
                )

    rooms_by_edge: dict[str, set[str]] = {}
    for room_id, point_ids in room_point_ids.items():
        for index, first in enumerate(point_ids):
            edge_key = _edge_key(first, point_ids[(index + 1) % len(point_ids)])
            rooms_by_edge.setdefault(edge_key, set()).add(room_id)
    omitted_edges = {_edge_key(*item.point_ids) for item in document.wall_overrides if item.omit}
    warnings.extend(_overlapping_wall_edges(document, rooms_by_edge, omitted_edges))
    for aperture in document.apertures:
        edge_key = _edge_key(*aperture.host_edge)
        if edge_key not in rooms_by_edge:
            blockers.append(
                PlanFinding("unknown_aperture_host", f"Aperture {aperture.name!r} does not reference a room wall edge")
            )
            continue
        if edge_key in omitted_edges:
            blockers.append(
                PlanFinding(
                    "aperture_on_omitted_wall",
                    f"Aperture {aperture.name!r} sits on an edge with no wall to open",
                )
            )
            continue
        # A level's wall is its room's wall: the front door is on the entrance
        # landing's south face and it is the open plan's front door.
        owners = set(rooms_by_edge[edge_key])
        owners.update(
            room.part_of
            for room in document.rooms
            if room.id in owners and room.part_of is not None
        )
        if not set(aperture.room_ids).issubset(owners):
            blockers.append(
                PlanFinding(
                    "aperture_room_mismatch",
                    f"Aperture {aperture.name!r} is assigned to a room that does not share its host edge",
                )
            )
        start, end = (document.points[point_id].domain() for point_id in aperture.host_edge)
        host_length = distance_2d(start, end)
        if aperture.width_mm >= host_length - 20:
            blockers.append(
                PlanFinding(
                    "aperture_too_wide",
                    f"Aperture {aperture.name!r} width {aperture.width_mm:g} mm does not fit host {host_length:.1f} mm",
                )
            )
        elif aperture.offset_mm is not None and aperture.offset_mm + aperture.width_mm > host_length - 10:
            blockers.append(
                PlanFinding(
                    "aperture_off_host",
                    f"Aperture {aperture.name!r} at offset {aperture.offset_mm:g} mm plus "
                    f"{aperture.width_mm:g} mm runs past its {host_length:.1f} mm host edge",
                )
            )
        host_height = max(rooms_by_id[room_id].ceiling_height_mm for room_id in aperture.room_ids)
        if aperture.sill_height_mm + aperture.height_mm > host_height:
            blockers.append(
                PlanFinding("aperture_too_tall", f"Aperture {aperture.name!r} extends above its host wall")
            )

    for stair in document.stairs:
        if stair.kind not in STAIR_TYPES:
            blockers.append(
                PlanFinding(
                    "unknown_stair_kind",
                    f"Stair {stair.name!r} kind {stair.kind!r} is not one of {sorted(STAIR_TYPES)}",
                )
            )
            continue
        stair_points = tuple(document.points[point_id].domain() for point_id in stair.point_ids)
        if not _is_simple(stair_points):
            blockers.append(PlanFinding("stair_self_intersection", f"Stair {stair.name!r} footprint self-intersects"))
            continue
        footprint = Polygon2D(stair_points)
        going = _flight_extent(footprint, stair.up_bearing_deg)[0]
        if going < stair.tread_depth_mm:
            blockers.append(
                PlanFinding(
                    "stair_too_short",
                    f"Stair {stair.name!r} going {going:.0f} mm is shorter than one {stair.tread_depth_mm:g} mm tread",
                )
            )
        else:
            treads = max(1, round(going / stair.tread_depth_mm))
            _, rise = _stair_vertical_extent(stair, rooms_by_id, treads)
            if stair.rise_role == "split_level" and len({room.floor_elevation_mm for room in document.rooms}) >= 2:
                levels = sorted({room.floor_elevation_mm for room in document.rooms})
                # One riser of slack, because a traced straight flight often
                # stops short of a winder or top step that is not modelled.
                slack = stair.riser_height_mm + 50
                if not any(abs((upper - lower) - rise) <= slack for lower in levels for upper in levels):
                    warnings.append(
                        PlanFinding(
                            "stair_rise_matches_no_level",
                            f"Stair {stair.name!r} rises {rise:.0f} mm but no pair of traced floor levels is "
                            f"within one riser of that",
                        )
                    )
            if not 100 <= stair.riser_height_mm <= 220:
                blockers.append(
                    PlanFinding(
                        "implausible_riser",
                        f"Stair {stair.name!r} riser {stair.riser_height_mm:g} mm is outside 100-220 mm",
                    )
                )
            if polygon_area(footprint) < 250_000:
                warnings.append(PlanFinding("small_stair", f"Stair {stair.name!r} footprint is under 0.25 m²"))
            if stair.rise_role not in STAIR_RISE_ROLES:
                blockers.append(
                    PlanFinding(
                        "unknown_stair_rise_role",
                        f"Stair {stair.name!r} rise_role {stair.rise_role!r} is not one of {sorted(STAIR_RISE_ROLES)}",
                    )
                )
            elif stair.rise_role == "storey" and rise < 2000:
                warnings.append(
                    PlanFinding(
                        "partial_stair_rise",
                        f"Stair {stair.name!r} rises {rise:.0f} mm over {treads} treads, which does not reach a "
                        f"storey; the remaining flights and landings are still untraced",
                    )
                )
            elif stair.rise_role == "split_level" and len({room.floor_elevation_mm for room in document.rooms}) < 2:
                warnings.append(
                    PlanFinding(
                        "split_level_not_modelled",
                        f"Stair {stair.name!r} steps {rise:.0f} mm between levels, but every room is traced at one "
                        f"floor elevation; openings and fixtures on the lower level would sit at the wrong height",
                    )
                )

    controls = []
    directions = []
    for control in document.controls:
        start = document.points[control.from_point].domain()
        end = document.points[control.to_point].domain()
        traced = distance_2d(start, end)
        discrepancy = abs(traced - control.expected_mm)
        controls.append(
            ControlCheck(
                control.id,
                control.expected_mm,
                traced,
                discrepancy,
                control.tolerance_mm,
                discrepancy <= control.tolerance_mm,
            )
        )
        length = max(traced, 1e-9)
        directions.append(((end.x - start.x) / length, (end.y - start.y) / length))
        if discrepancy > control.tolerance_mm:
            blockers.append(
                PlanFinding(
                    "control_failed",
                    f"{control.id}: traced {traced:.1f} mm, expected {control.expected_mm:.1f} mm",
                )
            )
    independent = any(
        abs(a[0] * b[1] - a[1] * b[0]) >= 0.1 for index, a in enumerate(directions) for b in directions[index + 1 :]
    )
    if len(controls) < 2 or not independent:
        blockers.append(PlanFinding("controls_not_independent", "At least two nonparallel controls are required"))

    # A level inside its parent is already in the parent's area; one beside it
    # adds floor. Count only the part of each level its parent does not cover.
    interior_ids = {room.id for room in document.rooms if room.exposure != "exterior" and room.id in polygons}
    traced_net_area_mm2 = 0.0
    for room in document.rooms:
        if room.id not in interior_ids:
            continue
        area = polygon_area(polygons[room.id])
        if room.part_of in interior_ids:
            area -= sum(
                polygon_area(piece)
                for triangle in triangulate_ring(polygons[room.id].outer)
                for piece in clip_convex_to_polygon(triangle, polygons[room.part_of])
            )
        traced_net_area_mm2 += area
    traced_net_area_m2 = traced_net_area_mm2 / 1_000_000
    if document.declared_internal_area_m2 is not None:
        difference = document.declared_internal_area_m2 - traced_net_area_m2
        warnings.append(
            PlanFinding(
                "net_to_declared_area",
                f"Traced clear room area is {traced_net_area_m2:.1f} m²; drawing schedule states "
                f"{document.declared_internal_area_m2:.1f} m² internal area ({difference:+.1f} m² difference)",
            )
        )

    # A room with a long external wall and no external opening is almost always
    # under-traced rather than genuinely windowless, and a missing window
    # silently removes every sun patch that room could receive.
    all_edges: dict[str, list[tuple[Point2D, Point2D]]] = {}
    for room_id, point_ids in room_point_ids.items():
        all_edges[room_id] = [
            (document.points[first].domain(), document.points[point_ids[(index + 1) % len(point_ids)]].domain())
            for index, first in enumerate(point_ids)
        ]
    exterior_by_room: dict[str, float] = {}
    for room_id, edges in all_edges.items():
        others = [edge for other_id, other in all_edges.items() if other_id != room_id for edge in other]
        for start, end in edges:
            length = distance_2d(start, end)
            if length < 1:
                continue
            # Sharing a point-id pair is not the only way two rooms meet: the
            # open plan runs along a bedroom's wall line with its own points, so
            # adjacency has to be measured rather than looked up.
            if any(_edges_face_each_other(start, end, other_start, other_end) for other_start, other_end in others):
                continue
            exterior_by_room[room_id] = exterior_by_room.get(room_id, 0.0) + length
    glazed_rooms = {
        room_id
        for aperture in document.apertures
        if aperture.exposure == "exterior"
        for room_id in aperture.room_ids
    }
    for room in document.rooms:
        exterior_mm = exterior_by_room.get(room.id, 0.0)
        if exterior_mm >= 2000 and room.id not in glazed_rooms and room.exposure != "exterior":
            warnings.append(
                PlanFinding(
                    "exterior_wall_without_opening",
                    f"Room {room.name!r} has {exterior_mm / 1000:.1f} m of external wall and no external "
                    f"opening traced; any window or door on it is still missing",
                )
            )

    # A control is verified after the build by finding its endpoints in the
    # geometry. A point nothing traces cannot be found, so the build would
    # refuse a source the review had just called publishable.
    traced_points = {
        point_id
        for room in document.rooms
        for point_id in room.point_ids
    }
    for collection in (document.daylight_sources, document.stairs, document.soffits):
        for item in collection:
            traced_points.update(item.point_ids)
    for aperture in document.apertures:
        traced_points.update(aperture.host_edge)
    for override in document.wall_overrides:
        traced_points.update(override.point_ids)
    for control in document.controls:
        dangling = sorted({control.from_point, control.to_point} - traced_points)
        if dangling:
            blockers.append(
                PlanFinding(
                    "control_endpoint_not_traced",
                    f"Control {control.id!r} measures {', '.join(dangling)}, which no room, opening, shaft, "
                    "stair or soffit uses, so the draft cannot verify it",
                )
            )

    room_by_spec_id = {room.id: room for room in document.rooms}
    for soffit in document.soffits:
        if soffit.kind not in SOFFIT_KINDS:
            blockers.append(
                PlanFinding(
                    "unknown_soffit_kind",
                    f"Soffit {soffit.name!r} has kind {soffit.kind!r}; expected one of {sorted(SOFFIT_KINDS)}",
                )
            )
        ring = tuple(document.points[point_id].domain() for point_id in soffit.point_ids)
        if not _is_simple(ring):
            blockers.append(PlanFinding("soffit_self_intersection", f"Soffit {soffit.name!r} polygon self-intersects"))
            continue
        area_m2 = abs(polygon_area(Polygon2D(ring))) / 1_000_000
        if area_m2 < 0.05:
            blockers.append(
                PlanFinding("degenerate_soffit", f"Soffit {soffit.name!r} encloses only {area_m2:.3f} m²")
            )
        host = room_by_spec_id[soffit.room_id]
        ceiling_limit = host.structural_ceiling_height_mm or host.ceiling_height_mm
        if soffit.height_mm > ceiling_limit + 1:
            blockers.append(
                PlanFinding(
                    "soffit_above_its_ceiling",
                    f"Soffit {soffit.name!r} at {soffit.height_mm:.0f} mm hangs above the "
                    f"{ceiling_limit:.0f} mm ceiling of {host.name!r}",
                )
            )
        # A patch drawn outside the room it belongs to is a tracing slip, and it
        # would obstruct light where there is no ceiling to hang it from.
        outside = [
            point
            for point in ring
            if not point_in_polygon(point, polygons[soffit.room_id])
        ]
        if outside:
            warnings.append(
                PlanFinding(
                    "soffit_outside_its_room",
                    f"Soffit {soffit.name!r} has {len(outside)} of {len(ring)} corners outside {host.name!r}",
                )
            )

    room_ids = {room.id for room in document.rooms}
    for room in document.rooms:
        if room.part_of is None:
            continue
        if room.part_of == room.id or room.part_of not in room_ids:
            blockers.append(
                PlanFinding(
                    "unknown_parent_room",
                    f"Room {room.name!r} says it is part of {room.part_of!r}, which is not a traced room",
                )
            )
            continue
        parent = next(item for item in document.rooms if item.id == room.part_of)
        if parent.part_of is not None:
            blockers.append(
                PlanFinding(
                    "nested_room_levels",
                    f"Room {room.name!r} is part of {parent.name!r}, which is itself part of another room",
                )
            )

    # A room you cannot walk into is a trace gap, not a design: the doorway was
    # measured and then lost, or never traced at all.
    # A door names the room of the face it is hosted on, but the wall it cuts
    # also serves the room traced on the far face, which the draft gives it to.
    doorway_kinds = {OpeningKind.DOOR, OpeningKind.SLIDING_DOOR, OpeningKind.UNFILLED}
    wall_edges, physical_walls = _wall_graph(document, room_point_ids)
    rooms_by_host = {edge.key: edge.room_ids for edge in wall_edges}
    reachable = {
        room_id
        for aperture in document.apertures
        if aperture.kind in doorway_kinds
        for room_id in (*aperture.room_ids, *rooms_by_host.get(_edge_key(*aperture.host_edge), ()))
    }
    for room in document.rooms:
        if room.part_of is not None:
            continue
        if room.exposure != "exterior" and room.id not in reachable:
            warnings.append(
                PlanFinding(
                    "room_without_a_doorway",
                    f"Room {room.name!r} has no door, sliding door, or cased opening, so nothing reaches it",
                )
            )

    site_located = document.site is not None and document.site.latitude_deg is not None and (
        document.site.longitude_deg is not None
    )
    if not site_located:
        warnings.append(
            PlanFinding(
                "site_unstated",
                "No site latitude, longitude, and true north are stated, so sun geometry stays unavailable",
            )
        )

    review = PlanReview(
        _source_digest(source_bytes),
        tuple(controls),
        tuple(blockers),
        tuple(warnings),
        len(document.rooms),
        # Physical walls, not room edges: a wall traced from both sides is one.
        len(physical_walls),
        traced_net_area_m2,
        document.declared_internal_area_m2,
        document.review_notes,
        len(document.apertures),
        len(document.stairs),
        site_located,
        document.underlay is not None,
    )
    return _ValidatedPlan(document, review.source_digest, review, polygons, room_point_ids)


def plan_path(project_root: Path | str | None = None, plan: Path | str | None = None) -> Path:
    """The plan source: ``plan`` when given, else the project's default.

    The default is ``model/references/plan.yaml``, falling back to the legacy
    ``m1-plan.yaml`` when only that one exists. A relative ``plan`` resolves
    against the project root.
    """

    root = Path(project_root or Path.cwd()).resolve()
    if plan is not None:
        return (root / plan).resolve()
    default = root / PLAN_RELATIVE_PATH
    legacy = root / LEGACY_PLAN_RELATIVE_PATH
    return legacy if legacy.exists() and not default.exists() else default


def _plan_prefix(path: Path) -> str:
    return path.stem.removesuffix("plan") if path.stem.endswith("plan") else f"{path.stem}-"


def underlay_stem(path: Path) -> str:
    """The underlay file stem beside a plan: ``m1-plan`` pairs with ``m1-underlay``."""

    return f"{_plan_prefix(path)}underlay"


def draft_path(project_root: Path | str | None = None, plan: Path | str | None = None) -> Path:
    """The draft IFC a plan compiles to.

    ``plan.yaml`` publishes ``model/draft.ifc``; a legacy ``m1-plan.yaml``
    keeps publishing ``model/m1-draft.ifc``.
    """

    root = Path(project_root or Path.cwd()).resolve()
    return root / "model" / f"{_plan_prefix(plan_path(root, plan))}draft.ifc"


def review_plan_file(project_root: Path | str | None = None, plan: Path | str | None = None) -> PlanReview:
    """Parse and review a plan source on disk without writing IFC."""

    return _load_and_validate(plan_path(project_root, plan)).review


def plan_revision(project_root: Path | str | None = None, plan: Path | str | None = None) -> str:
    """Return the content revision of the reviewed plan source on disk."""

    return _sha256(plan_path(project_root, plan))


def load_plan(
    project_root: Path | str | None = None, plan: Path | str | None = None
) -> tuple[PlanDocument, PlanReview, str]:
    """Return the plan source, its review, and its file revision."""

    path = plan_path(project_root, plan)
    validated = _load_and_validate(path)
    return validated.document, validated.review, _sha256(path)


def review_plan(document: PlanDocument) -> PlanReview:
    """Review a submitted plan document without writing anything."""

    return _validate(document, dump_plan(document).encode()).review


def dump_plan(document: PlanDocument) -> str:
    """Serialise a plan document back to reviewable YAML."""

    data = document.model_dump(mode="json", by_alias=True, exclude_none=True)
    return yaml.dump(
        _readable(data),
        Dumper=_PlanDumper,
        sort_keys=False,
        allow_unicode=True,
        width=120,
    )


def save_plan(
    document: PlanDocument,
    project_root: Path | str | None = None,
    *,
    expected_revision: str,
    plan: Path | str | None = None,
) -> tuple[str, PlanReview]:
    """Atomically replace the reviewed plan source under an exact revision guard.

    A document with review blockers is still saved so tracing can continue, but
    :func:`build_draft` keeps refusing to publish it. The previous source is
    copied into a ``history`` directory beside it first.
    """

    path = plan_path(project_root, plan)
    text = dump_plan(document)
    reloaded = PlanDocument.model_validate(yaml.safe_load(text))
    if reloaded != document:
        raise DraftPlanError("The plan document did not survive its own YAML round trip")
    review = _validate(reloaded, text.encode()).review

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        current = _sha256(path)
        if expected_revision != current:
            raise StaleRevision(f"Expected {expected_revision}, current plan revision is {current}")
        history = path.parent / "history"
        history.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, history / f"{path.stem}-{current.removeprefix('sha256:')[:12]}.yaml")
    elif expected_revision:
        raise StaleRevision("A plan revision was supplied but no plan source exists")

    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".yaml", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)
    return _sha256(path), review


class _PlanDumper(yaml.SafeDumper):
    """A dumper that keeps traced leaf records on one reviewable line."""

    def increase_indent(self, flow: bool = False, indentless: bool = False) -> None:
        super().increase_indent(flow, False)


class _FlowMap(dict):
    pass


class _FlowList(list):
    pass


def _represent_flow_map(dumper: yaml.SafeDumper, data: _FlowMap) -> yaml.Node:
    return dumper.represent_mapping("tag:yaml.org,2002:map", data, flow_style=True)


def _represent_flow_list(dumper: yaml.SafeDumper, data: _FlowList) -> yaml.Node:
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=True)


def _represent_float(dumper: yaml.SafeDumper, data: float) -> yaml.Node:
    """Write whole millimetres without a trailing ``.0`` so diffs stay small."""

    if data == int(data) and abs(data) < 1e15:
        return dumper.represent_int(int(data))
    return dumper.represent_float(data)


_PlanDumper.add_representer(_FlowMap, _represent_flow_map)
_PlanDumper.add_representer(_FlowList, _represent_flow_list)
_PlanDumper.add_representer(float, _represent_float)

_FLOW_MAP_KEYS = frozenset({"origin_px"})
_FLOW_MAP_PARENTS = frozenset({"points", "controls", "wall_overrides"})
_FLOW_LIST_KEYS = frozenset({"point_ids", "host_edge", "room_ids"})
_LONG_LIST_LIMIT = 8


def _readable(value: Any, *, key: str | None = None, parent: str | None = None) -> Any:
    """Keep short scalar records inline so plan diffs stay reviewable."""

    if isinstance(value, dict):
        converted = {name: _readable(item, key=name, parent=key) for name, item in value.items()}
        scalar_only = all(not isinstance(item, (dict, list)) for item in value.values())
        inline = key in _FLOW_MAP_KEYS or parent in _FLOW_MAP_PARENTS or key in _FLOW_MAP_PARENTS
        return _FlowMap(converted) if scalar_only and inline else converted
    if isinstance(value, list):
        converted = [_readable(item, key=key, parent=parent) for item in value]
        scalar_only = all(not isinstance(item, (dict, list)) for item in value)
        if scalar_only and key in _FLOW_LIST_KEYS and len(converted) <= _LONG_LIST_LIMIT:
            return _FlowList(converted)
        return converted
    return value


def _placement(x_m: float, y_m: float, z_m: float, angle: float = 0) -> np.ndarray:
    matrix = np.eye(4)
    matrix[0, 0] = np.cos(angle)
    matrix[0, 1] = -np.sin(angle)
    matrix[1, 0] = np.sin(angle)
    matrix[1, 1] = np.cos(angle)
    matrix[:3, 3] = [x_m, y_m, z_m]
    return matrix


def _create_root(model: ifcopenshell.file, plan: PlanDocument, ifc_class: str, logical_id: str, name: str) -> Any:
    entity = ifcopenshell.api.run("root.create_entity", model, ifc_class=ifc_class, name=name)
    entity.GlobalId = _ifc_guid(plan.project_id, ifc_class, logical_id)
    return entity


def _apply_site(
    model: ifcopenshell.file,
    document: PlanDocument,
    model_context: Any,
    site: Any,
) -> None:
    """Write the reviewed site facts onto native IFC site and context fields."""

    spec = document.site
    if spec is None:
        return
    if spec.latitude_deg is not None:
        site.RefLatitude = list(degrees_to_compound_angle(spec.latitude_deg))
    if spec.longitude_deg is not None:
        site.RefLongitude = list(degrees_to_compound_angle(spec.longitude_deg))
    site.RefElevation = spec.elevation_mm
    ratios = bearing_deg_to_true_north_ratios(spec.true_north_deg)
    model_context.TrueNorth = model.create_entity("IfcDirection", DirectionRatios=list(ratios))
    pset = ifcopenshell.api.run("pset.add_pset", model, product=site, name="Pset_HomeTwinSite")
    ifcopenshell.api.run(
        "pset.edit_pset",
        model,
        pset=pset,
        properties={
            "Timezone": spec.timezone or "",
            "Evidence": spec.evidence,
            "TrueNorthBearingDeg": spec.true_north_deg,
        },
    )


def _compile(plan: _ValidatedPlan) -> ifcopenshell.file:
    document = plan.document
    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = _create_root(model, document, "IfcProject", "project", f"{document.building_name} draft")
    ifcopenshell.api.run("unit.assign_unit", model)
    model_context = ifcopenshell.api.run("context.add_context", model, context_type="Model")
    body = ifcopenshell.api.run(
        "context.add_context",
        model,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=model_context,
    )
    site = _create_root(model, document, "IfcSite", "site", document.site.name if document.site else "Site")
    _apply_site(model, document, model_context, site)
    building = _create_root(model, document, "IfcBuilding", "building", document.building_name)
    storey = _create_root(model, document, "IfcBuildingStorey", "ground-floor", "Ground floor")
    for parent, child in ((project, site), (site, building), (building, storey)):
        ifcopenshell.api.run("aggregate.assign_object", model, products=[child], relating_object=parent)

    room_entities: dict[str, Any] = {}
    room_by_id = {room.id: room for room in document.rooms}
    for room in sorted(document.rooms, key=lambda value: (value.part_of is not None, value.id)):
        space = _create_root(model, document, "IfcSpace", room.id, room.name)
        space.PredefinedType = "EXTERNAL" if room.exposure == "exterior" else "INTERNAL"
        # A level of a room is a part of it, not a room in its own right. IFC says
        # so through CompositionType, not through the space's predefined type.
        space.CompositionType = "PARTIAL" if room.part_of is not None else "ELEMENT"
        polygon = plan.polygons[room.id]
        polyline = [(point.x / 1000, point.y / 1000) for point in polygon.outer]
        representation = ifcopenshell.api.run(
            "geometry.add_slab_representation",
            model,
            context=body,
            depth=room.ceiling_height_mm / 1000,
            polyline=polyline,
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=space, representation=representation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=space,
            matrix=_placement(0, 0, room.floor_elevation_mm / 1000),
            is_si=True,
        )
        ifcopenshell.api.run(
            "aggregate.assign_object",
            model,
            products=[space],
            relating_object=room_entities[room.part_of] if room.part_of is not None else storey,
        )
        if room.structural_ceiling_height_mm is not None:
            room_pset = ifcopenshell.api.run("pset.add_pset", model, product=space, name="Pset_HomeTwinRoom")
            ifcopenshell.api.run(
                "pset.edit_pset",
                model,
                pset=room_pset,
                properties={
                    "StructuralCeilingElevation": room.floor_elevation_mm + room.structural_ceiling_height_mm,
                    "CeilingBoardThicknessMm": room.ceiling_board_thickness_mm,
                    "CeilingEvidence": room.ceiling_evidence,
                },
            )
        room_entities[room.id] = space
        if room.exposure == "exterior":
            continue

        ceiling = _create_root(model, document, "IfcCovering", f"ceiling:{room.id}", f"{room.name} ceiling")
        ceiling.PredefinedType = "CEILING"
        # A finished ceiling below the slab is a gypsum soffit, and saying so is
        # what lets it be drawn or hidden separately from the structure.
        dropped = (
            room.structural_ceiling_height_mm is not None
            and room.structural_ceiling_height_mm > room.ceiling_height_mm + 1
        )
        ceiling.Description = "gypsum_soffit" if dropped else "structural_ceiling"
        covering = ifcopenshell.api.run(
            "geometry.add_slab_representation",
            model,
            context=body,
            depth=0.012,
            polyline=polyline,
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=ceiling, representation=covering)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=ceiling,
            matrix=_placement(0, 0, (room.floor_elevation_mm + room.ceiling_height_mm) / 1000 - 0.012),
            is_si=True,
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[ceiling], relating_structure=space)

    for soffit in sorted(document.soffits, key=lambda value: value.id):
        room = room_by_id[soffit.room_id]
        patch = _create_root(model, document, "IfcCovering", f"soffit:{soffit.id}", soffit.name)
        patch.PredefinedType = "CEILING"
        patch.Description = f"gypsum_{soffit.kind}"
        representation = ifcopenshell.api.run(
            "geometry.add_slab_representation",
            model,
            context=body,
            depth=0.012,
            polyline=[
                (document.points[point_id].x_mm / 1000, document.points[point_id].y_mm / 1000)
                for point_id in soffit.point_ids
            ],
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=patch, representation=representation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=patch,
            matrix=_placement(0, 0, (room.floor_elevation_mm + soffit.height_mm) / 1000 - 0.012),
            is_si=True,
        )
        ifcopenshell.api.run(
            "spatial.assign_container", model, products=[patch], relating_structure=room_entities[soffit.room_id]
        )
        pset = ifcopenshell.api.run("pset.add_pset", model, product=patch, name="Pset_HomeTwinSoffit")
        ifcopenshell.api.run(
            "pset.edit_pset",
            model,
            pset=pset,
            properties={
                "Kind": soffit.kind,
                "HeightAboveFloor": soffit.height_mm,
                "Evidence": soffit.geometry_evidence,
            },
        )

    point_map = {key: value.domain() for key, value in document.points.items()}
    edges, physical_walls = _wall_graph(document, plan.room_point_ids)
    edges_by_key = {edge.key: edge for edge in edges}
    edge_entities: dict[str, Any] = {}
    for physical in physical_walls:
        if physical.start_override_mm is not None:
            start = Point2D(physical.start_override_mm[0], physical.start_override_mm[1])
        else:
            start = point_map[physical.point_ids[0]]
        end = point_map[physical.point_ids[1]]
        dx, dy = end.x - start.x, end.y - start.y
        length_mm = physical.length_override_mm if physical.length_override_mm is not None else hypot(dx, dy)
        if not isfinite(length_mm) or length_mm <= 0:
            raise DraftBuildRejected(f"Wall {physical.key!r} has zero or invalid length")
        angle = atan2(dy, dx)
        # Unit vectors: a union wall overrides its length, so the run
        # direction still comes from the reference face, not the span.
        run_length_mm = hypot(dx, dy)
        right_x, right_y = dy / run_length_mm, -dx / run_length_mm
        push_mm = physical.thickness_mm + physical.face_offset_mm
        x = (start.x + right_x * push_mm) / 1000
        y = (start.y + right_y * push_mm) / 1000
        base_mm = (
            physical.base_elevation_mm
            if physical.base_elevation_mm is not None
            else min(room_by_id[room_id].floor_elevation_mm for room_id in physical.room_ids)
        )
        height_mm = (
            max(
                room_by_id[room_id].floor_elevation_mm + room_by_id[room_id].ceiling_height_mm
                for room_id in physical.room_ids
            )
            - base_mm
        )
        wall = _create_root(model, document, "IfcWall", f"wall:{physical.key}", f"Wall {physical.key}")
        wall_representation = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            model,
            context=body,
            length=length_mm / 1000,
            height=height_mm / 1000,
            thickness=physical.thickness_mm / 1000,
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=wall, representation=wall_representation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=wall,
            matrix=_placement(x, y, base_mm / 1000, angle),
            is_si=True,
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[wall], relating_structure=storey)
        for face_key in physical.face_keys:
            edge_entities[face_key] = wall

    for source in sorted(document.daylight_sources, key=lambda value: value.id):
        space = _create_root(model, document, "IfcSpace", f"daylight:{source.id}", source.name)
        space.PredefinedType = "EXTERNAL"
        space.ObjectType = f"DAYLIGHT_SOURCE:{source.kind}"
        polyline = [
            (document.points[point_id].x_mm / 1000, document.points[point_id].y_mm / 1000)
            for point_id in source.point_ids
        ]
        representation = ifcopenshell.api.run(
            "geometry.add_slab_representation",
            model,
            context=body,
            depth=2.7,
            polyline=polyline,
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=space, representation=representation)
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=space, matrix=np.eye(4), is_si=True)
        ifcopenshell.api.run("aggregate.assign_object", model, products=[space], relating_object=storey)
        pset = ifcopenshell.api.run("pset.add_pset", model, product=space, name="Pset_HomeTwinDaylight")
        ifcopenshell.api.run(
            "pset.edit_pset",
            model,
            pset=pset,
            properties={
                "SourceKind": source.kind,
                "Role": source.daylight_role,
                "Evidence": source.geometry_evidence,
            },
        )

    for stair in sorted(document.stairs, key=lambda value: value.id):
        footprint = Polygon2D(tuple(document.points[point_id].domain() for point_id in stair.point_ids))
        going_mm, width_mm, corner, (ux, uy) = _flight_extent(footprint, stair.up_bearing_deg)
        tread_count = max(1, round(going_mm / stair.tread_depth_mm))
        tread_depth = going_mm / tread_count
        riser = stair.riser_height_mm
        riser_count, rise_mm = _stair_vertical_extent(stair, room_by_id, tread_count)

        stair_type, flight_type = STAIR_TYPES.get(stair.kind, ("NOTDEFINED", "NOTDEFINED"))
        container = _create_root(model, document, "IfcStair", stair.id, stair.name)
        container.PredefinedType = stair_type
        flight = _create_root(model, document, "IfcStairFlight", f"flight:{stair.id}", f"{stair.name} flight")
        flight.PredefinedType = flight_type
        flight.NumberOfRisers = riser_count
        flight.NumberOfTreads = tread_count
        flight.RiserHeight = riser
        flight.TreadLength = tread_depth

        # A closed stepped profile in local (going, height), extruded across the
        # flight width, so the flight has real treads rather than a ramp block.
        # ShapeBuilder works in project units, which are millimetres here, while
        # edit_object_placement below is given an SI matrix.
        profile_points: list[tuple[float, float]] = [(0.0, 0.0)]
        landing_nose_mm = min(tread_depth / 5, 40.0) if rise_mm > tread_count * riser else 0.0
        for index in range(tread_count):
            profile_points.append((index * tread_depth, (index + 1) * riser))
            tread_end = (index + 1) * tread_depth
            if index == tread_count - 1:
                tread_end -= landing_nose_mm
            profile_points.append((tread_end, (index + 1) * riser))
        if rise_mm > tread_count * riser:
            # The upper landing is the final tread: close the stepped solid with
            # the last riser and a narrow landing nose at the known datum.  A
            # zero-depth spike is discarded by IFC tessellators.
            profile_points.append((going_mm - landing_nose_mm, rise_mm))
            profile_points.append((going_mm, rise_mm))
        profile_points.append((going_mm, 0.0))
        builder = ShapeBuilder(model)
        outline = builder.polyline([(round(x, 4), round(y, 4)) for x, y in profile_points], closed=True)
        solid = builder.extrude(
            builder.profile(outline),
            magnitude=width_mm,
            extrusion_vector=(0.0, 0.0, 1.0),
        )
        representation = builder.get_representation(body, [solid])
        ifcopenshell.api.run("geometry.assign_representation", model, product=flight, representation=representation)
        placement = np.eye(4)
        placement[:3, 0] = (ux, uy, 0.0)
        placement[:3, 1] = (0.0, 0.0, 1.0)
        placement[:3, 2] = (uy, -ux, 0.0)
        stair_base_mm = (
            min(room_by_id[room_id].floor_elevation_mm for room_id in stair.room_ids)
            if stair.room_ids
            else min((room.floor_elevation_mm for room in document.rooms), default=0.0)
        )
        placement[:3, 3] = (corner.x / 1000, corner.y / 1000, stair_base_mm / 1000)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", model, product=flight, matrix=placement, is_si=True
        )
        ifcopenshell.api.run("aggregate.assign_object", model, products=[flight], relating_object=container)
        ifcopenshell.api.run("spatial.assign_container", model, products=[container], relating_structure=storey)
        for room_id in stair.room_ids:
            model.create_entity(
                "IfcRelSpaceBoundary",
                GlobalId=_ifc_guid(document.project_id, "IfcRelSpaceBoundary", f"stair:{room_id}:{stair.id}"),
                Name=f"{stair.name} boundary",
                RelatingSpace=room_entities[room_id],
                RelatedBuildingElement=flight,
                PhysicalOrVirtualBoundary="PHYSICAL",
                InternalOrExternalBoundary="INTERNAL",
            )
        common = ifcopenshell.api.run("pset.add_pset", model, product=flight, name="Pset_StairFlightCommon")
        ifcopenshell.api.run(
            "pset.edit_pset",
            model,
            pset=common,
            properties={
                "NumberOfRiser": riser_count,
                "NumberOfTreads": tread_count,
                "RiserHeight": riser,
                "TreadLength": tread_depth,
            },
        )
        pset = ifcopenshell.api.run("pset.add_pset", model, product=flight, name="Pset_HomeTwinStair")
        ifcopenshell.api.run(
            "pset.edit_pset",
            model,
            pset=pset,
            properties={
                "FlightKind": stair.kind,
                "BaseElevation": stair_base_mm,
                "Rise": rise_mm,
                "Going": going_mm,
                "FlightWidth": width_mm,
                "UpBearingDeg": stair.up_bearing_deg,
                "RiseRole": stair.rise_role,
                "Evidence": stair.geometry_evidence,
                "RiserEvidence": stair.riser_evidence,
            },
        )

    for aperture in sorted(document.apertures, key=lambda value: value.id):
        edge = edges_by_key[_edge_key(*aperture.host_edge)]
        start = point_map[edge.point_ids[0]]
        end = point_map[edge.point_ids[1]]
        dx, dy = end.x - start.x, end.y - start.y
        length_mm = hypot(dx, dy)
        unit_x, unit_y = dx / length_mm, dy / length_mm
        right_x, right_y = dy / length_mm, -dx / length_mm
        offset_mm = (
            (length_mm - aperture.width_mm) / 2 if aperture.offset_mm is None else aperture.offset_mm
        )
        if _edge_key(*aperture.host_edge) != _edge_key(edge.point_ids[0], edge.point_ids[1]):
            raise DraftBuildRejected(f"Aperture {aperture.id!r} lost its host edge")
        if aperture.host_edge[0] != edge.point_ids[0]:
            # The shared edge is stored in a canonical order; a traced offset is
            # measured from the author's first host point, so mirror it.
            offset_mm = length_mm - offset_mm - aperture.width_mm
        segment_start = Point2D(start.x + unit_x * offset_mm, start.y + unit_y * offset_mm)
        segment_end = Point2D(
            segment_start.x + unit_x * aperture.width_mm,
            segment_start.y + unit_y * aperture.width_mm,
        )
        angle = atan2(dy, dx)

        opening = _create_root(
            model,
            document,
            "IfcOpeningElement",
            f"opening:{aperture.id}",
            f"{aperture.name} opening",
        )
        # Names are the owner's and can repeat; the logical id cannot.
        opening.Description = aperture.id
        opening_representation = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            model,
            context=body,
            length=aperture.width_mm / 1000,
            height=aperture.height_mm / 1000,
            thickness=(edge.thickness_mm + 100) / 1000,
        )
        ifcopenshell.api.run(
            "geometry.assign_representation",
            model,
            product=opening,
            representation=opening_representation,
        )
        aperture_floor_mm = min(room_by_id[room_id].floor_elevation_mm for room_id in aperture.room_ids)
        opening_origin = _placement(
            (segment_start.x + right_x * (edge.thickness_mm + 50)) / 1000,
            (segment_start.y + right_y * (edge.thickness_mm + 50)) / 1000,
            (aperture_floor_mm + aperture.sill_height_mm) / 1000,
            angle,
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=opening,
            matrix=opening_origin,
            is_si=True,
        )
        # The host edge and the face opposite it are one wall, so one void
        # carries the opening through both sides of it.
        void_relation = ifcopenshell.api.run(
            "feature.add_feature", model, feature=opening, element=edge_entities[edge.key]
        )
        void_relation.GlobalId = _ifc_guid(document.project_id, "IfcRelVoidsElement", aperture.id)

        if aperture.kind == OpeningKind.UNFILLED:
            # A cased opening: the wall is voided and nothing fills it. The plan
            # facts go on the opening element, since there is no filling to
            # carry them.
            pset = ifcopenshell.api.run("pset.add_pset", model, product=opening, name="Pset_HomeTwinDaylight")
            ifcopenshell.api.run(
                "pset.edit_pset",
                model,
                pset=pset,
                properties={
                    "Exposure": aperture.exposure,
                    "Evidence": aperture.geometry_evidence,
                    "HeightEvidence": aperture.height_evidence,
                    "PlanStartX": segment_start.x,
                    "PlanStartY": segment_start.y,
                    "PlanEndX": segment_end.x,
                    "PlanEndY": segment_end.y,
                    "SillHeight": aperture.sill_height_mm,
                    "HeadHeight": aperture.sill_height_mm + aperture.height_mm,
                    "GlazingFraction": aperture.glazing_fraction,
                    "Swing": aperture.swing,
                    "OverhangDepth": aperture.overhang_depth_mm,
                    "OverhangSoffit": aperture.overhang_soffit_mm,
                    "Unfilled": True,
                },
            )
            for room_id in aperture.room_ids:
                model.create_entity(
                    "IfcRelSpaceBoundary",
                    GlobalId=_ifc_guid(
                        document.project_id, "IfcRelSpaceBoundary", f"aperture:{room_id}:{aperture.id}"
                    ),
                    Name=f"{aperture.name} boundary",
                    RelatingSpace=room_entities[room_id],
                    RelatedBuildingElement=edge_entities[edge.key],
                    PhysicalOrVirtualBoundary="VIRTUAL",
                    InternalOrExternalBoundary="EXTERNAL" if aperture.exposure == "exterior" else "INTERNAL",
                )
            continue

        if aperture.kind == OpeningKind.WINDOW:
            filling = _create_root(model, document, "IfcWindow", aperture.id, aperture.name)
            filling.PredefinedType = "WINDOW"
            filling.PartitioningType = "SINGLE_PANEL"
        else:
            filling = _create_root(model, document, "IfcDoor", aperture.id, aperture.name)
            filling.PredefinedType = "DOOR"
            if aperture.kind == OpeningKind.SLIDING_DOOR:
                filling.OperationType = "USERDEFINED"
                filling.UserDefinedOperationType = "SLIDING"
            else:
                filling.OperationType = "NOTDEFINED"
        filling.OverallWidth = aperture.width_mm
        filling.OverallHeight = aperture.height_mm
        filling_representation = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            model,
            context=body,
            length=aperture.width_mm / 1000,
            height=aperture.height_mm / 1000,
            thickness=min(edge.thickness_mm, 60) / 1000,
        )
        ifcopenshell.api.run(
            "geometry.assign_representation",
            model,
            product=filling,
            representation=filling_representation,
        )
        filling_origin = _placement(
            (segment_start.x + right_x * (edge.thickness_mm / 2 + min(edge.thickness_mm, 60) / 2)) / 1000,
            (segment_start.y + right_y * (edge.thickness_mm / 2 + min(edge.thickness_mm, 60) / 2)) / 1000,
            (aperture_floor_mm + aperture.sill_height_mm) / 1000,
            angle,
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=filling,
            matrix=filling_origin,
            is_si=True,
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[filling], relating_structure=storey)
        fill_relation = ifcopenshell.api.run("feature.add_filling", model, opening=opening, element=filling)
        fill_relation.GlobalId = _ifc_guid(document.project_id, "IfcRelFillsElement", aperture.id)
        pset = ifcopenshell.api.run("pset.add_pset", model, product=filling, name="Pset_HomeTwinDaylight")
        ifcopenshell.api.run(
            "pset.edit_pset",
            model,
            pset=pset,
            properties={
                "Exposure": aperture.exposure,
                "Evidence": aperture.geometry_evidence,
                "HeightEvidence": aperture.height_evidence,
                "PlanStartX": segment_start.x,
                "PlanStartY": segment_start.y,
                "PlanEndX": segment_end.x,
                "PlanEndY": segment_end.y,
                "SillHeight": aperture.sill_height_mm,
                "HeadHeight": aperture.sill_height_mm + aperture.height_mm,
                "GlazingFraction": aperture.glazing_fraction,
                "Swing": aperture.swing,
                "OverhangDepth": aperture.overhang_depth_mm,
                "OverhangSoffit": aperture.overhang_soffit_mm,
            },
        )
        common_name = "Pset_WindowCommon" if aperture.kind == OpeningKind.WINDOW else "Pset_DoorCommon"
        common = ifcopenshell.api.run("pset.add_pset", model, product=filling, name=common_name)
        ifcopenshell.api.run(
            "pset.edit_pset",
            model,
            pset=common,
            properties={"IsExternal": aperture.exposure == "exterior"},
        )
        for room_id in aperture.room_ids:
            model.create_entity(
                "IfcRelSpaceBoundary",
                GlobalId=_ifc_guid(document.project_id, "IfcRelSpaceBoundary", f"aperture:{room_id}:{aperture.id}"),
                Name=f"{aperture.name} boundary",
                RelatingSpace=room_entities[room_id],
                RelatedBuildingElement=filling,
                PhysicalOrVirtualBoundary="PHYSICAL",
                InternalOrExternalBoundary="EXTERNAL" if aperture.exposure == "exterior" else "INTERNAL",
            )

    virtual_elements: dict[str, Any] = {}
    for room in sorted(document.rooms, key=lambda value: value.id):
        ids = plan.room_point_ids[room.id]
        for index, first in enumerate(ids):
            second = ids[(index + 1) % len(ids)]
            edge_key = _edge_key(first, second)
            edge = edges_by_key[edge_key]
            filling = edge_entities.get(edge_key)
            if filling is None:
                # RelatedBuildingElement is mandatory, and IfcVirtualElement is
                # what IFC provides for a boundary with no construction in it.
                filling = virtual_elements.get(edge_key)
                if filling is None:
                    filling = model.create_entity(
                        "IfcVirtualElement",
                        GlobalId=_ifc_guid(document.project_id, "IfcVirtualElement", edge_key),
                        Name=f"Open boundary {edge_key}",
                    )
                    virtual_elements[edge_key] = filling
            model.create_entity(
                "IfcRelSpaceBoundary",
                GlobalId=_ifc_guid(document.project_id, "IfcRelSpaceBoundary", f"{room.id}:{edge_key}"),
                Name=f"{room.name} boundary {index + 1}",
                RelatingSpace=room_entities[room.id],
                RelatedBuildingElement=filling,
                PhysicalOrVirtualBoundary="PHYSICAL" if filling is not None else "VIRTUAL",
                InternalOrExternalBoundary="INTERNAL" if len(edge.room_ids) > 1 else "EXTERNAL",
            )

    pset = ifcopenshell.api.run("pset.add_pset", model, product=building, name="Pset_HomeTwinDraft")
    ifcopenshell.api.run(
        "pset.edit_pset",
        model,
        pset=pset,
        properties={
            "PlanSchema": document.schema_id,
            "SourceDigest": plan.source_digest,
            "SourceDocumentDigest": document.source.sha256,
            "GeneratorVersion": GENERATOR_VERSION,
            "CoordinateFrame": "+X plan-right, +Y plan-up, +Z up; millimetres",
        },
    )
    return model


def _existing_source_digest(path: Path) -> str | None:
    try:
        model = ifcopenshell.open(path)
        building = model.by_type("IfcBuilding")[0]
        value = element_util.get_psets(building).get("Pset_HomeTwinDraft", {}).get("SourceDigest")
        return str(value) if value else None
    except (IndexError, OSError, RuntimeError):
        return None


def _verify_temp(path: Path, plan: _ValidatedPlan) -> tuple[tuple[str, ...], int]:
    reopened = ifcopenshell.open(path)
    if reopened.schema != "IFC4":
        raise DraftBuildRejected(f"Expected IFC4, reopened {reopened.schema}")
    scale = unit_util.calculate_unit_scale(reopened)
    if abs(scale - 0.001) > 1e-12:
        raise DraftBuildRejected(f"Expected millimetre IFC units, got scale {scale}")
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(reopened, logger)
    errors = [statement for statement in logger.statements if str(statement.get("level", "error")).lower() == "error"]
    if errors:
        raise DraftBuildRejected(f"Generated IFC has {len(errors)} schema validation error(s)")

    twin = HomeTwin.open(path)
    omitted_edges = {_edge_key(*item.point_ids) for item in plan.document.wall_overrides if item.omit}
    expected = {room.name: room for room in plan.document.rooms}
    actual = {room.name: room for room in twin.get_rooms()}
    if set(actual) != set(expected):
        raise DraftBuildRejected(f"Room names differ after reopen: expected {sorted(expected)}, got {sorted(actual)}")
    verified = []
    all_ceiling_points: list[Point2D] = []
    for name in sorted(expected):
        room = actual[name]
        expected_room = expected[name]
        expected_guid = _ifc_guid(plan.document.project_id, "IfcSpace", expected_room.id)
        if room.id != expected_guid:
            raise DraftBuildRejected(f"Room {name!r} identity changed during serialization")
        context = twin.get_room_context(room.id)
        expected_ceiling = expected_room.floor_elevation_mm + expected_room.ceiling_height_mm
        if abs(context.ceiling.elevation_mm - expected_ceiling) > 0.5:
            raise DraftBuildRejected(f"Room {name!r} ceiling changed during serialization")
        if abs(room.elevation_mm - expected_room.floor_elevation_mm) > 0.5:
            raise DraftBuildRejected(f"Room {name!r} floor level changed during serialization")
        # An omitted edge is an open boundary, so it resolves no wall by design.
        traced = plan.room_point_ids[expected_room.id]
        omitted = sum(
            1
            for index, first in enumerate(traced)
            if _edge_key(first, traced[(index + 1) % len(traced)]) in omitted_edges
        )
        if len(context.walls) != len(traced) - omitted:
            raise DraftBuildRejected(
                f"Room {name!r} resolves {len(context.walls)} walls for "
                f"{len(traced) - omitted} traced edges that carry one"
            )
        all_ceiling_points.extend(context.ceiling.polygon.outer)
        verified.append(room.id)

    # A control endpoint must survive as real geometry. Room controls land on a
    # ceiling polygon vertex; a stair control lands on the reopened flight
    # footprint, which is recovered from tessellated geometry and so carries a
    # looser tolerance than an authored polyline.
    derived_points: list[tuple[Point2D, float]] = []
    for room in actual.values():
        for stair in twin.get_stairs(room.id):
            derived_points.extend((point, 3.0) for point in stair.footprint.outer)
        for source in twin.get_daylight_sources(room.id):
            derived_points.extend((point, 3.0) for point in source.footprint.outer)
    verifiable = [(point, 0.5) for point in all_ceiling_points] + derived_points
    for control in plan.document.controls:
        expected_points = (
            plan.document.points[control.from_point].domain(),
            plan.document.points[control.to_point].domain(),
        )
        for expected_point in expected_points:
            if not any(distance_2d(expected_point, actual) <= tol for actual, tol in verifiable):
                raise DraftBuildRejected(f"Control {control.id!r} endpoint changed during serialization")

    reopened_openings = {
        opening.id: opening
        for room in actual.values()
        for opening in twin.get_openings(room.id)
    }
    def _aperture_guid(aperture: ApertureSpec) -> str:
        if aperture.kind == OpeningKind.UNFILLED:
            return _ifc_guid(plan.document.project_id, "IfcOpeningElement", f"opening:{aperture.id}")
        ifc_class = "IfcWindow" if aperture.kind == OpeningKind.WINDOW else "IfcDoor"
        return _ifc_guid(plan.document.project_id, ifc_class, aperture.id)

    expected_opening_ids = {_aperture_guid(aperture) for aperture in plan.document.apertures}
    if set(reopened_openings) != expected_opening_ids:
        raise DraftBuildRejected("Window or door identities changed during serialization")
    for aperture in plan.document.apertures:
        opening = reopened_openings[_aperture_guid(aperture)]
        if opening.kind != aperture.kind or abs(distance_2d(opening.start, opening.end) - aperture.width_mm) > 0.5:
            raise DraftBuildRejected(f"Aperture {aperture.name!r} changed during serialization")
        if abs(opening.sill_height_mm - aperture.sill_height_mm) > 0.5:
            raise DraftBuildRejected(f"Aperture {aperture.name!r} sill changed during serialization")
        if abs(opening.head_height_mm - aperture.sill_height_mm - aperture.height_mm) > 0.5:
            raise DraftBuildRejected(f"Aperture {aperture.name!r} head changed during serialization")

    if plan.document.stairs:
        reopened_stairs = {
            stair.id: stair
            for room in actual.values()
            for stair in twin.get_stairs(room.id)
        }
        for stair in plan.document.stairs:
            guid = _ifc_guid(plan.document.project_id, "IfcStairFlight", f"flight:{stair.id}")
            found = reopened_stairs.get(guid)
            if found is None:
                raise DraftBuildRejected(f"Stair {stair.name!r} is not queryable after serialization")
            footprint = Polygon2D(tuple(plan.document.points[pid].domain() for pid in stair.point_ids))
            going_mm, _, _, _ = _flight_extent(footprint, stair.up_bearing_deg)
            expected_treads = max(1, round(going_mm / stair.tread_depth_mm))
            expected_risers, expected_rise = _stair_vertical_extent(
                stair,
                {room.id: room for room in plan.document.rooms},
                expected_treads,
            )
            if found.tread_count != expected_treads:
                raise DraftBuildRejected(f"Stair {stair.name!r} tread count changed during serialization")
            if found.riser_count != expected_risers:
                raise DraftBuildRejected(f"Stair {stair.name!r} riser count changed during serialization")
            if abs(found.rise_mm - expected_rise) > 1.0:
                raise DraftBuildRejected(f"Stair {stair.name!r} rise changed during serialization")
            if abs(found.bounds.maximum.z - found.bounds.minimum.z - expected_rise) > 2.0:
                raise DraftBuildRejected(f"Stair {stair.name!r} geometry does not span its stated rise")
            if abs(polygon_area(found.footprint) - polygon_area(footprint)) > polygon_area(footprint) * 0.08:
                raise DraftBuildRejected(f"Stair {stair.name!r} footprint changed during serialization")

    if plan.document.site is not None:
        expected_site = plan.document.site
        reopened_site = twin.get_site()
        latitude = reopened_site.latitude_deg
        longitude = reopened_site.longitude_deg
        if expected_site.latitude_deg is None:
            if latitude is not None:
                raise DraftBuildRejected("The draft gained a latitude that the source does not state")
        elif latitude is None or abs(latitude - expected_site.latitude_deg) > 1e-6:
            raise DraftBuildRejected("Site latitude changed during serialization")
        if expected_site.longitude_deg is None:
            if longitude is not None:
                raise DraftBuildRejected("The draft gained a longitude that the source does not state")
        elif longitude is None or abs(longitude - expected_site.longitude_deg) > 1e-6:
            raise DraftBuildRejected("Site longitude changed during serialization")
        expected_bearing = expected_site.true_north_deg % 360
        if abs((reopened_site.true_north_deg - expected_bearing + 180) % 360 - 180) > 1e-6:
            raise DraftBuildRejected("Site true north changed during serialization")
        if abs(reopened_site.elevation_mm - expected_site.elevation_mm) > 0.5:
            raise DraftBuildRejected("Site elevation changed during serialization")

    reopened_sources = {
        source.id: source
        for room in actual.values()
        for source in twin.get_daylight_sources(room.id)
    }
    expected_source_ids = {
        _ifc_guid(plan.document.project_id, "IfcSpace", f"daylight:{source.id}")
        for source in plan.document.daylight_sources
    }
    if set(reopened_sources) != expected_source_ids:
        raise DraftBuildRejected("Daylight-source identities changed or are not queryable after serialization")
    for source in plan.document.daylight_sources:
        reopened_source = reopened_sources[_ifc_guid(plan.document.project_id, "IfcSpace", f"daylight:{source.id}")]
        if reopened_source.kind != source.kind or reopened_source.daylight_role != source.daylight_role:
            raise DraftBuildRejected(f"Daylight source {source.name!r} changed during serialization")
    return tuple(verified), len(logger.statements)


# Everything a furnishing or lighting script authors into the draft. A rebuild
# compiles the plan alone, and the plan carries none of it.
AUTHORED_IN_DRAFT = (
    "IfcLightFixture",
    "IfcSwitchingDevice",
    "IfcSensor",
    "IfcFurniture",
    "IfcSanitaryTerminal",
    "IfcWasteTerminal",
    "IfcValve",
    "IfcUnitaryEquipment",
    "IfcFan",
    "IfcDuctSegment",
    "IfcAirTerminal",
    "IfcPipeSegment",
)


def _draft_authored_counts(path: Path) -> dict[str, int]:
    """What an existing draft holds that a rebuild would throw away.

    Counting only luminaires understated this by a factor of four. The guard
    reported 38 lights and said nothing about 64 pieces of furniture, the wet
    rooms, the air conditioner or the yard drainage, so confirming it looked
    like losing a lighting layout rather than the whole fit-out.
    """

    try:
        model = ifcopenshell.open(str(path))
    except Exception:
        return {}
    counts = {name: len(model.by_type(name)) for name in AUTHORED_IN_DRAFT}
    return {name: count for name, count in counts.items() if count}


def build_draft(
    project_root: Path | str | None = None,
    *,
    plan: Path | str | None = None,
    replace_revision: str | None = None,
    discard_fixtures: bool = False,
) -> DraftBuildReport:
    """Validate and atomically publish only the plan's draft IFC (see :func:`draft_path`)."""

    root = Path(project_root or Path.cwd()).resolve()
    validated = _load_and_validate(plan_path(root, plan))
    if not validated.review.publishable:
        messages = "; ".join(finding.message for finding in validated.review.blockers)
        raise DraftPlanError(messages)
    draft = draft_path(root, plan)
    canonical_path = root / CANONICAL_RELATIVE_PATH
    paths_share_file = draft.exists() and canonical_path.exists() and os.path.samefile(draft, canonical_path)
    if draft.is_symlink() or draft.resolve() == canonical_path.resolve() or paths_share_file:
        raise DraftBuildRejected("The draft path cannot alias the canonical model")
    canonical_revision = _sha256(canonical_path) if canonical_path.exists() else None

    if draft.exists():
        current_revision = _sha256(draft)
        if _existing_source_digest(draft) == validated.source_digest and replace_revision is None:
            verified, issue_count = _verify_temp(draft, validated)
            return DraftBuildReport(
                draft,
                current_revision,
                validated.source_digest,
                False,
                verified,
                validated.review.controls,
                issue_count,
                validated.review.warnings,
            )
        if replace_revision is None:
            raise DraftReplacementRequired(
                f"The source changed; replace the current draft explicitly with --replace-revision {current_revision}"
            )
        if replace_revision != current_revision:
            raise StaleRevision(f"Expected {replace_revision}, current draft revision is {current_revision}")
        discarded = _draft_authored_counts(draft)
        if discarded and not discard_fixtures:
            detail = ", ".join(f"{count} {name}" for name, count in sorted(discarded.items()))
            raise DraftWouldDiscardFixtures(
                f"Rebuilding discards {sum(discarded.values())} authored product(s): {detail}. "
                "The plan source carries none of them, and re-running the furnishing and "
                "lighting scripts is what puts them back. Pass discard_fixtures to confirm"
            )
    elif replace_revision is not None:
        raise StaleRevision("A replacement revision was supplied but no draft exists")

    draft.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{draft.stem}-", suffix=".ifc", dir=draft.parent)
    os.close(descriptor)
    temp_path = Path(temp_name)
    try:
        _compile(validated).write(temp_path)
        with temp_path.open("rb") as handle:
            os.fsync(handle.fileno())
        verified, issue_count = _verify_temp(temp_path, validated)
        if canonical_revision != (_sha256(canonical_path) if canonical_path.exists() else None):
            raise DraftBuildRejected("The canonical model changed while the draft was being built")
        os.replace(temp_path, draft)
        directory_descriptor = os.open(draft.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
        return DraftBuildReport(
            draft,
            _sha256(draft),
            validated.source_digest,
            True,
            verified,
            validated.review.controls,
            issue_count,
            validated.review.warnings,
        )
    finally:
        temp_path.unlink(missing_ok=True)
