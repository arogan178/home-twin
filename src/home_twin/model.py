"""Public domain records and the high-level Home Twin facade."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from math import isfinite
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from datetime import datetime

    from home_twin.constraints import LightingConstraints
    from home_twin.daylight import RoomDaylight, SunPath
    from home_twin.fixtures import (
        ControlGroup,
        InstalledLuminaire,
        LightFixture,
        LightingLayout,
        RoomLightingDesign,
        SensorDevice,
        SpotlightSpec,
        WallSwitch,
    )
    from home_twin.ifc import IfcRepository
    from home_twin.lighting import (
        BakedLighting,
        DarkZone,
        ElectricLightingAnalysis,
        LayoutProposal,
        Spacing,
    )
    from home_twin.measurement import MeasurementComparison, Reading
    from home_twin.validation import ValidationReport

JsonScalar = str | int | float | bool | None


def _require_finite(*values: float) -> None:
    if not all(isfinite(value) for value in values):
        raise ValueError("Coordinates and dimensions must be finite")


@dataclass(frozen=True, slots=True)
class Point2D:
    """A point in the canonical building frame, in millimetres."""

    x: float
    y: float

    def __post_init__(self) -> None:
        _require_finite(self.x, self.y)


@dataclass(frozen=True, slots=True)
class Point3D:
    """A point in the canonical building frame, in millimetres."""

    x: float
    y: float
    z: float

    def __post_init__(self) -> None:
        _require_finite(self.x, self.y, self.z)


@dataclass(frozen=True, slots=True)
class Vector3D:
    x: float
    y: float
    z: float

    def __post_init__(self) -> None:
        _require_finite(self.x, self.y, self.z)
        if self.x == self.y == self.z == 0:
            raise ValueError("A direction vector cannot be zero")


@dataclass(frozen=True, slots=True)
class Bounds3D:
    minimum: Point3D
    maximum: Point3D

    def __post_init__(self) -> None:
        if (
            self.minimum.x > self.maximum.x
            or self.minimum.y > self.maximum.y
            or self.minimum.z > self.maximum.z
        ):
            raise ValueError("Bounds minimum must not exceed maximum")

    @property
    def center(self) -> Point3D:
        return Point3D(
            (self.minimum.x + self.maximum.x) / 2,
            (self.minimum.y + self.maximum.y) / 2,
            (self.minimum.z + self.maximum.z) / 2,
        )

    @property
    def size(self) -> Vector3D:
        return Vector3D(
            max(self.maximum.x - self.minimum.x, 1e-12),
            max(self.maximum.y - self.minimum.y, 1e-12),
            max(self.maximum.z - self.minimum.z, 1e-12),
        )


@dataclass(frozen=True, slots=True)
class Polygon2D:
    outer: tuple[Point2D, ...]
    holes: tuple[tuple[Point2D, ...], ...] = ()

    def __post_init__(self) -> None:
        if len(self.outer) < 3:
            raise ValueError("A polygon needs at least three points")

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (
            min(point.x for point in self.outer),
            min(point.y for point in self.outer),
            max(point.x for point in self.outer),
            max(point.y for point in self.outer),
        )


class ObjectKind(StrEnum):
    WALL = "wall"
    CEILING = "ceiling"
    OPENING = "opening"
    STAIR = "stair"
    FURNITURE = "furniture"
    CABINET = "cabinet"
    LIGHT_FIXTURE = "light_fixture"
    SHADOW_GAP = "shadow_gap"
    AC = "ac"
    BEAM = "beam"
    DUCT = "duct"
    PIPE = "pipe"
    SANITARY_FIXTURE = "sanitary_fixture"
    EXTRACTOR = "extractor"
    SENSOR = "sensor"
    OTHER = "other"


class OpeningKind(StrEnum):
    WINDOW = "window"
    DOOR = "door"
    SLIDING_DOOR = "sliding_door"
    UNFILLED = "unfilled"


@dataclass(frozen=True, slots=True)
class Building:
    id: str
    name: str
    schema: str
    units: str = "millimetres"
    origin: Point3D = Point3D(0, 0, 0)
    axes: str = "+X plan-right/east, +Y plan-up/north, +Z up"
    revision: str = ""


@dataclass(frozen=True, slots=True)
class Site:
    """Geographic placement of the building frame, for solar geometry only.

    ``true_north_deg`` is the bearing of the building ``+Y`` axis measured
    clockwise from true north. ``latitude_deg`` and ``longitude_deg`` are
    ``None`` when the IFC does not state them; solar geometry must then report
    that the site is unknown instead of assuming a location.
    """

    id: str
    name: str
    latitude_deg: float | None = None
    longitude_deg: float | None = None
    elevation_mm: float = 0.0
    true_north_deg: float = 0.0
    timezone: str | None = None
    evidence: str = "unstated"

    def __post_init__(self) -> None:
        latitude = self.latitude_deg
        if latitude is not None and (not isfinite(latitude) or not -90 <= latitude <= 90):
            raise ValueError("Latitude must be between -90 and 90 degrees")
        longitude = self.longitude_deg
        if longitude is not None and (not isfinite(longitude) or not -180 <= longitude <= 180):
            raise ValueError("Longitude must be between -180 and 180 degrees")
        _require_finite(self.elevation_mm, self.true_north_deg)

    @property
    def located(self) -> bool:
        return self.latitude_deg is not None and self.longitude_deg is not None


@dataclass(frozen=True, slots=True)
class Storey:
    id: str
    name: str
    elevation_mm: float


@dataclass(frozen=True, slots=True)
class Room:
    id: str
    name: str
    storey_id: str
    elevation_mm: float
    bounds: Bounds3D
    is_external: bool = False
    """Outdoor space such as a yard: no ceiling, and not internal floor area."""

    part_of: str | None = None
    """The room this one is a level of, when a room spans more than one."""

    floor_finish: str | None = None
    wall_finish: str | None = None
    """Authored finish names from ``Pset_HomeTwinFinish``; display and reflectance hints, not BIM materials."""


    feature_wall_id: str | None = None
    feature_wall: str | None = None
    feature_wall_colour: str | None = None
    """One wall of the room finished differently from the other three."""

    skirting: str | None = None
    skirting_height_mm: float | None = None
    skirting_thickness_mm: float | None = None
    """The room's skirting, or None where it is deliberately omitted.

    A face listed in ``clad_wall_ids`` carries no skirting: the joinery standing
    against it runs to its own base detail, and a skirting would sit behind it."""

    clad_wall_ids: tuple[str, ...] = ()
    clad_wall: str | None = None
    """Faces clad in something other than the room's paint, and what in.

    A feature wall is one face painted differently. This is the other case: a
    run of joinery standing against several faces, which is what the light
    actually meets. The open plan carries 35 m2 of walnut at LRV 11 against
    walls modelled at 0.72, and that is a third of the interreflected term."""



@dataclass(frozen=True, slots=True)
class BuildingObject:
    id: str
    ifc_class: str
    kind: ObjectKind
    name: str
    room_ids: tuple[str, ...]
    bounds: Bounds3D
    properties: Mapping[str, JsonScalar] = field(default_factory=dict)
    plan_footprint: Polygon2D | None = None
    """Plan outline of the solid.

    A turned element loses its shape in an axis-aligned box: the box around a
    diagonal strip covers most of the room. Clearance is measured against this
    when it is known, and against ``bounds`` when it is not.
    """


@dataclass(frozen=True, slots=True)
class WallFace:
    wall_id: str
    start: Point2D
    end: Point2D
    inward_normal: Vector3D
    thickness_mm: float
    """How far the wall extends behind this face.

    A plan reads as a plan only when its walls are drawn at their real
    thickness, so the measured depth travels with the face rather than being
    assumed by whatever draws it.
    """

    base_elevation_mm: float | None = None
    top_elevation_mm: float | None = None
    """The wall's own vertical extent, where the model carries one.

    A wall beside a stair to a lower level runs below the floor of every room it
    faces, so a view that derives its height from those floors alone draws it
    starting a storey too high.
    """

    reflectance: float | None = None
    """This face's own reflectance, where it differs from the room's walls.

    A walnut-panelled wall reflects around a fifth of what the painted walls
    beside it do, and one such wall moves the room average more than the choice
    of interreflection method does. ``None`` means the face takes the room-wide
    wall reflectance.
    """


@dataclass(frozen=True, slots=True)
class Opening:
    id: str
    name: str
    kind: OpeningKind
    room_ids: tuple[str, ...]
    host_wall_id: str
    start: Point2D
    end: Point2D
    sill_height_mm: float
    head_height_mm: float
    exposure: str
    evidence: str
    swing: Literal["inward", "outward"] | None = None
    glazing_fraction: float = 0.0
    """How much of the opening is glass, 0 to 1.

    It decides whether the leaf stops light. "Sliding" is not the same question
    and was standing in for it: the yard sliders are glazed and the en-suite and
    bathroom doors slide too, and they are solid timber.
    """

    overhang_depth_mm: float | None = None
    """How far a horizontal projection above this opening reaches out from the face.

    A balcony floor over a slider is a shading device whether anyone designed it
    as one. It is stated per opening because that is where it acts, not because
    it belongs to the opening.
    """

    overhang_soffit_mm: float | None = None
    """The underside of that projection, above this room's floor."""


@dataclass(frozen=True, slots=True)
class DaylightSource:
    id: str
    name: str
    kind: str
    footprint: Polygon2D
    bounds: Bounds3D
    daylight_role: str
    evidence: str


@dataclass(frozen=True, slots=True)
class Soffit:
    """A gypsum ceiling feature over part of a room."""

    id: str
    name: str
    kind: str
    room_id: str
    footprint: Polygon2D
    elevation_mm: float
    """The finished underside, in the model's own frame."""

    height_above_floor_mm: float
    evidence: str


@dataclass(frozen=True, slots=True)
class Stair:
    """A stair flight resolved from IFC, in canonical millimetres.

    ``footprint`` is the plan outline of the flight. ``up_bearing_deg`` is the
    clockwise bearing of the ascending direction from plan ``+Y``, so a viewer
    can draw the treads in the right order without re-deriving them.
    """

    id: str
    name: str
    kind: str
    footprint: Polygon2D
    bounds: Bounds3D
    base_elevation_mm: float
    rise_mm: float
    tread_depth_mm: float
    riser_height_mm: float
    tread_count: int
    riser_count: int
    up_bearing_deg: float
    room_ids: tuple[str, ...]
    evidence: str

    finish: str | None = None
    """What the treads and risers are made of, where it has been chosen."""

    skirting: str | None = None
    skirting_height_mm: float | None = None
    skirting_thickness_mm: float | None = None
    """The raking band against the flight's wall side. It follows the pitch, so
    its height is measured perpendicular to the nosing line, not vertically."""

    def __post_init__(self) -> None:
        _require_finite(self.base_elevation_mm, self.rise_mm, self.tread_depth_mm, self.up_bearing_deg)
        if self.tread_count < 1 or self.riser_count < 1:
            raise ValueError("A stair flight needs at least one tread and riser")


@dataclass(frozen=True, slots=True)
class Ceiling:
    room_id: str
    polygon: Polygon2D
    elevation_mm: float
    source: str
    structural_elevation_mm: float | None = None
    """The slab soffit, when the finished ceiling is a gypsum drop below it."""
    board_thickness_mm: float | None = None
    """The board hung below the slab, which a recessed fitting passes through."""


@dataclass(frozen=True, slots=True)
class RoomContext:
    room: Room
    ceiling: Ceiling
    walls: tuple[WallFace, ...]
    openings: tuple[Opening, ...]
    daylight_sources: tuple[DaylightSource, ...]
    furniture: tuple[BuildingObject, ...]
    obstructions: tuple[BuildingObject, ...]
    stairs: tuple[Stair, ...] = ()
    soffits: tuple[Soffit, ...] = ()


@dataclass(frozen=True, slots=True)
class TriangleMesh:
    vertices: tuple[Point3D, ...]
    faces: tuple[tuple[int, int, int], ...]


@dataclass(frozen=True, slots=True)
class RayHit:
    object_id: str
    point: Point3D
    distance_mm: float
    method: str


@dataclass(frozen=True, slots=True)
class Clearance:
    object_id: str
    other_id: str
    distance_mm: float
    method: str


@dataclass(frozen=True, slots=True)
class MutationResult:
    revision: str
    changed_ids: tuple[str, ...]


class HomeTwin:
    """Semantic residential operations over one canonical IFC file."""

    def __init__(
        self,
        repository: IfcRepository,
        constraints: LightingConstraints,
        export_dir: Path,
        project_root: Path | None = None,
    ) -> None:
        self._repository = repository
        self.constraints = constraints
        self.export_dir = export_dir
        self.project_root = project_root or export_dir.parent

    @classmethod
    def open(cls, path: Path | str, *, config_dir: Path | str | None = None) -> HomeTwin:
        from home_twin.constraints import load_constraints
        from home_twin.ifc import IfcRepository

        model_path = Path(path).resolve()
        project_root = model_path.parent.parent if model_path.parent.name == "model" else model_path.parent
        config_path = Path(config_dir).resolve() if config_dir else project_root / "config"
        return cls(
            IfcRepository.open(model_path),
            load_constraints(config_path),
            project_root / "exports",
            project_root,
        )

    @property
    def revision(self) -> str:
        return self._repository.revision

    @property
    def model_path(self) -> Path:
        return self._repository.path

    def get_building(self) -> Building:
        return self._repository.get_building()

    def get_site(self) -> Site:
        return self._repository.get_site()

    def get_storeys(self) -> tuple[Storey, ...]:
        return self._repository.get_storeys()

    def get_rooms(self) -> tuple[Room, ...]:
        return self._repository.get_rooms()

    def get_room(self, room_id: str) -> Room:
        return self._repository.get_room(room_id)

    def get_room_context(self, room_id: str) -> RoomContext:
        return self._repository.get_room_context(room_id)

    def get_objects(self, *, room: str | None = None, type: str | None = None) -> tuple[BuildingObject, ...]:
        kind = ObjectKind(type) if type and type in ObjectKind._value2member_map_ else None
        return self._repository.get_objects(room_id=room, kind=kind, ifc_class=None if kind else type)

    def get_object(self, object_id: str) -> BuildingObject:
        return self._repository.get_object(object_id)

    def get_walls(self, room_id: str) -> tuple[BuildingObject, ...]:
        ids = {wall.wall_id for wall in self._repository.get_room_context(room_id).walls}
        return tuple(obj for obj in self._repository.get_objects(kind=ObjectKind.WALL) if obj.id in ids)

    def get_ceiling(self, room_id: str) -> Ceiling:
        return self._repository.get_room_context(room_id).ceiling

    def get_openings(self, room_id: str) -> tuple[Opening, ...]:
        return self._repository.get_room_context(room_id).openings

    def get_daylight_sources(self, room_id: str) -> tuple[DaylightSource, ...]:
        return self._repository.get_room_context(room_id).daylight_sources

    def get_soffits(self, room_id: str) -> tuple[Soffit, ...]:
        return self._repository.get_room_context(room_id).soffits

    def get_stairs(self, room_id: str) -> tuple[Stair, ...]:
        return self._repository.get_room_context(room_id).stairs

    def get_furniture(self, room_id: str) -> tuple[BuildingObject, ...]:
        return self._repository.get_room_context(room_id).furniture

    def get_light_fixtures(self, room_id: str) -> tuple[LightFixture, ...]:
        return self._repository.get_light_fixtures(room_id)

    def get_light_fixture(self, fixture_id: str) -> LightFixture:
        return self._repository.get_light_fixture(fixture_id)

    def get_luminaires(self, room_id: str) -> tuple[InstalledLuminaire, ...]:
        return self._repository.get_luminaires(room_id)

    def get_wall_switches(self, room_id: str) -> tuple[WallSwitch, ...]:
        return self._repository.get_wall_switches(room_id)

    def get_control_groups(self) -> tuple[ControlGroup, ...]:
        return self._repository.get_control_groups()

    def get_room_lighting_design(self, room_id: str) -> RoomLightingDesign:
        from home_twin.fixtures import RoomLightingDesign

        return RoomLightingDesign(
            room_id,
            self.get_luminaires(room_id),
            self.get_wall_switches(room_id),
            self.get_control_groups(),
            self.get_sensors(room_id),
        )

    def get_sensors(self, room_id: str) -> tuple[SensorDevice, ...]:
        return self._repository.get_sensors(room_id)

    def get_object_properties(self, object_id: str) -> Mapping[str, JsonScalar]:
        return self.get_object(object_id).properties

    def get_object_bounds(self, object_id: str) -> Bounds3D:
        return self.get_object(object_id).bounds

    def get_ceiling_polygon(self, room_id: str) -> Polygon2D:
        return self.get_ceiling(room_id).polygon

    def measure_points(self, point_a: Point3D, point_b: Point3D) -> float:
        from home_twin.geometry import distance

        return distance(point_a, point_b)

    def measure_between_objects(self, a: str, b: str) -> float:
        from home_twin.geometry import bounds_distance

        return bounds_distance(self.get_object_bounds(a), self.get_object_bounds(b))

    def distance_to_wall(self, point: Point3D, wall_id: str) -> float:
        from home_twin.geometry import point_segment_distance

        for room in self.get_rooms():
            for wall in self._repository.get_room_context(room.id).walls:
                if wall.wall_id == wall_id:
                    return point_segment_distance(Point2D(point.x, point.y), wall.start, wall.end)
        raise KeyError(f"Wall {wall_id!r} was not found")

    def raycast(self, origin: Point3D, direction: Vector3D) -> RayHit | None:
        from home_twin.geometry import raycast_mesh

        nearest: RayHit | None = None
        for obj in self.get_objects():
            mesh = self._repository.get_mesh(obj.id)
            hit = raycast_mesh(origin, direction, mesh, obj.id) if mesh else None
            if hit is None:
                continue
            if nearest is None or hit.distance_mm < nearest.distance_mm:
                nearest = hit
        return nearest

    def get_clearances(self, object_id: str, *, limit: int = 8) -> tuple[Clearance, ...]:
        from home_twin.geometry import bounds_distance

        subject = self.get_object(object_id)
        values = [
            Clearance(subject.id, other.id, bounds_distance(subject.bounds, other.bounds), "aabb")
            for other in self.get_objects()
            if other.id != subject.id
        ]
        return tuple(sorted(values, key=lambda item: (item.distance_mm, item.other_id))[:limit])

    def get_lighting_layout(self, room_id: str) -> LightingLayout:
        from home_twin.fixtures import LightingLayout

        return LightingLayout(room_id, tuple(self.get_light_fixtures(room_id)))

    def calculate_spacing(self, room_id: str) -> tuple[Spacing, ...]:
        from home_twin.lighting import calculate_spacing

        return calculate_spacing(self.get_lighting_layout(room_id))

    def validate_lighting_layout(self, layout: LightingLayout) -> ValidationReport:
        return self.analyse_lighting_layout(layout).validation

    def validate_room_lighting_design(self, design: RoomLightingDesign) -> ValidationReport:
        from home_twin.lighting import validate_room_lighting

        return validate_room_lighting(
            design,
            self._repository.get_room_context(design.room_id),
            self.constraints,
        )

    def analyse_room_lighting_design(
        self,
        design: RoomLightingDesign,
        *,
        threshold_lux: float | None = None,
    ) -> ElectricLightingAnalysis:
        from dataclasses import replace

        from home_twin.fixtures import PendantFixture, PlannedPendant

        # A pendant is credited as a uniform diffuser, which its opal shade makes
        # a fair approximation and its published lumens make arithmetic. A rope
        # light is not: how much of a cove's flux reaches the room depends on the
        # cove's section and the reflectance inside it, and neither is modelled,
        # so any figure would be invented.
        diffusers = tuple(
            (luminaire.emitter_point, luminaire.spec.lumens)
            for luminaire in design.luminaires
            if isinstance(luminaire, (PlannedPendant, PendantFixture)) and luminaire.spec.lumens
        )
        analysis = self.analyse_lighting_layout(
            design.spotlight_layout,
            threshold_lux=threshold_lux,
            diffusers=diffusers,
        )
        excluded_kinds = tuple(
            sorted(
                {"rope_light_photometry"}
                & {f"{luminaire.kind}_photometry" for luminaire in design.luminaires}
            )
        )
        return replace(
            analysis,
            validation=self.validate_room_lighting_design(design),
            exclusions=(*analysis.exclusions, *excluded_kinds),
        )

    def analyse_lighting_layout(
        self,
        layout: LightingLayout,
        *,
        threshold_lux: float | None = None,
        diffusers: Sequence[tuple[Point3D, float]] = (),
    ) -> ElectricLightingAnalysis:
        from home_twin.lighting import analyse_layout, load_layout_photometry

        return analyse_layout(
            layout,
            self._repository.get_room_context(layout.room_id),
            self.constraints,
            threshold_lux=threshold_lux,
            photometry=load_layout_photometry(layout, self.project_root),
            diffusers=diffusers,
        )

    def bake_lighting(
        self,
        layout: LightingLayout,
        *,
        step_mm: float = 150.0,
        plane: str = "task",
        threshold_lux: float | None = None,
    ) -> BakedLighting:
        """Sample a room finely with shadow rays for exactly this candidate layout.

        Slower than :meth:`analyse_lighting_layout` and meant to be asked for,
        not run on every edit. It adds occlusion to the same approximation; it
        is still not a photometric simulation.
        """

        from home_twin.finishes import room_reflectances
        from home_twin.lighting import bake_lighting, load_layout_photometry

        context = self._repository.get_room_context(layout.room_id)
        return bake_lighting(
            layout,
            context,
            self.constraints,
            step_mm=step_mm,
            plane=plane,
            threshold_lux=threshold_lux,
            reflectances=room_reflectances(context.room, self.constraints.reflectances, self._repository.finishes),
            photometry=load_layout_photometry(layout, self.project_root),
        )

    def compare_measurements(self, room_id: str, readings: tuple[Reading, ...]) -> MeasurementComparison:
        """Hold meter readings against the saved layout's prediction.

        Predicts at each measured point rather than at the nearest grid
        sample, so the residual reports the model and not the bake's step.
        """

        from home_twin.finishes import room_reflectances
        from home_twin.lighting import bake_method, load_layout_photometry, predict_lux
        from home_twin.measurement import compare_measurements as compare

        layout = self.get_lighting_layout(room_id)
        photometry = load_layout_photometry(layout, self.project_root)
        context = self._repository.get_room_context(room_id)
        predicted = predict_lux(
            tuple(reading.point for reading in readings),
            layout,
            context,
            self.constraints,
            reflectances=room_reflectances(context.room, self.constraints.reflectances, self._repository.finishes),
            photometry=photometry,
        )
        return compare(room_id, readings, predicted, bake_method(layout.fixtures, photometry, True))

    def find_dark_zones(self, room_id: str, *, threshold_lux: float | None = None) -> tuple[DarkZone, ...]:
        return self.analyse_lighting_layout(
            self.get_lighting_layout(room_id),
            threshold_lux=threshold_lux,
        ).dark_zones

    def analyse_direct_sun(
        self,
        room_id: str,
        moment: datetime,
        *,
        plane_elevation_mm: float | None = None,
    ) -> RoomDaylight:
        """Return direct-sun geometry for one room, never an illuminance value."""

        from home_twin.daylight import analyse_direct_sun

        return analyse_direct_sun(
            self._repository.get_room_context(room_id),
            self.get_site(),
            moment,
            plane_elevation_mm=plane_elevation_mm,
        )

    def sun_path(self, day: datetime, *, step_minutes: int = 20) -> SunPath | None:
        """Return one local day of solar positions, or ``None`` without a site."""

        from home_twin.daylight import sun_path

        site = self.get_site()
        if site.latitude_deg is None or site.longitude_deg is None:
            return None
        return sun_path(site.latitude_deg, site.longitude_deg, day, step_minutes=step_minutes)

    def find_bad_alignment(self, room_id: str) -> ValidationReport:
        from home_twin.lighting import find_bad_alignment

        return find_bad_alignment(self.get_lighting_layout(room_id), self.constraints)

    def find_fixture_collisions(self, room_id: str) -> ValidationReport:
        from home_twin.lighting import find_fixture_collisions

        return find_fixture_collisions(
            self.get_lighting_layout(room_id), self._repository.get_room_context(room_id), self.constraints
        )

    def find_spotlights_over(self, room_id: str, kinds: frozenset[ObjectKind]) -> ValidationReport:
        from home_twin.lighting import find_spotlights_over

        return find_spotlights_over(
            self.get_lighting_layout(room_id), self._repository.get_room_context(room_id), kinds
        )

    def optimise_spotlight_layout(self, room_id: str, fixture: SpotlightSpec) -> LayoutProposal:
        from home_twin.lighting import optimise_spotlights
        from home_twin.photometry import load_photometry

        photometry = None
        if fixture.ies_path:
            photometry = {
                fixture.ies_path: load_photometry(fixture.ies_path, root=self.project_root, lumens=fixture.lumens)
            }
        return optimise_spotlights(
            self.revision,
            fixture,
            self._repository.get_room_context(room_id),
            self.constraints,
            photometry,
        )

    def add_spotlight(
        self,
        room_id: str,
        *,
        fixture_id: str,
        point: Point3D,
        spec: SpotlightSpec,
        switching_group: str,
        direction: Vector3D | None = None,
        expected_revision: str | None = None,
    ) -> LightFixture:
        from home_twin.fixtures import PlannedSpotlight

        planned = PlannedSpotlight(
            fixture_id,
            room_id,
            point,
            spec,
            switching_group=switching_group,
            direction=direction or Vector3D(0, 0, -1),
        )
        layout = self.get_lighting_layout(room_id).with_fixture(planned)
        report = self.validate_lighting_layout(layout)
        if not report.valid:
            from home_twin.validation import LayoutRejected

            raise LayoutRejected(report)
        return self._repository.add_spotlight(planned, expected_revision or self.revision)

    def move_fixture(
        self,
        fixture_id: str,
        point: Point3D,
        *,
        expected_revision: str | None = None,
    ) -> LightFixture:
        fixture = self._repository.get_light_fixture(fixture_id)
        layout = self.get_lighting_layout(fixture.room_id).replace_fixture(fixture_id, fixture.at(point))
        report = self.validate_lighting_layout(layout)
        if not report.valid:
            from home_twin.validation import LayoutRejected

            raise LayoutRejected(report)
        return self._repository.move_fixture(fixture_id, point, expected_revision or self.revision)

    def delete_fixture(self, fixture_id: str, *, expected_revision: str | None = None) -> MutationResult:
        return self._repository.delete_fixture(fixture_id, expected_revision or self.revision)

    def apply_lighting_layout(
        self,
        layout: LightingLayout,
        *,
        expected_revision: str,
    ) -> MutationResult:
        report = self.validate_lighting_layout(layout)
        if not report.valid:
            from home_twin.validation import LayoutRejected

            raise LayoutRejected(report)
        return self._repository.apply_lighting_layout(layout, expected_revision)

    def apply_room_lighting_design(
        self,
        design: RoomLightingDesign,
        *,
        expected_revision: str,
    ) -> MutationResult:
        report = self.validate_room_lighting_design(design)
        if not report.valid:
            from home_twin.validation import LayoutRejected

            raise LayoutRejected(report)
        return self._repository.apply_room_lighting_design(design, expected_revision)

    def save_model(self) -> str:
        """Return the durable revision. Mutations already save atomically."""

        return self.revision

    def export_lighting(
        self,
        *,
        room_id: str | None = None,
        formats: frozenset[str] = frozenset({"csv", "json", "svg"}),
        directory: Path | None = None,
    ) -> tuple[Path, ...]:
        from home_twin.exports import export_lighting

        designs = tuple(
            self.get_room_lighting_design(room.id)
            for room in self.get_rooms()
            if room_id is None or room.id == room_id
        )
        contexts = {design.room_id: self._repository.get_room_context(design.room_id) for design in designs}
        return export_lighting(self.revision, designs, contexts, directory or self.export_dir, formats)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self.get_building())
