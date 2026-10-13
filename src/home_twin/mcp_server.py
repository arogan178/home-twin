"""FastMCP adapter for semantic residential building operations."""

from __future__ import annotations

import argparse
from dataclasses import asdict, is_dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import BaseModel, ConfigDict

from home_twin.fixtures import (
    LightingLayout,
    PendantSpec,
    PlannedPendant,
    PlannedRopeLight,
    PlannedWallSwitch,
    RoomLightingDesign,
    RopeLightSpec,
    RopeMounting,
    SpotlightSpec,
    WallSwitchKind,
    WallSwitchSpec,
)
from home_twin.model import HomeTwin, ObjectKind, Point3D, Vector3D

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
DELETE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PointInput(StrictInput):
    x: float
    y: float
    z: float


class VectorInput(StrictInput):
    x: float
    y: float
    z: float


class SpotlightInput(StrictInput):
    model: str | None = None
    lumens: float | None = 650
    beam_angle_deg: float = 36
    cct_kelvin: int | None = 3000
    cri: float | None = 90
    dimmable: bool = True
    diameter_mm: float = 82
    cutout_diameter_mm: float = 68
    mounting_depth_mm: float = 60
    ies_path: str | None = None
    peak_candela: float | None = None
    ip_rating: str | None = None


class PendantInput(StrictInput):
    model: str | None = None
    lumens: float | None = 800
    cct_kelvin: int | None = 2700
    cri: float | None = 90
    dimmable: bool = True
    drop_mm: float = 600
    canopy_diameter_mm: float = 100
    canopy_depth_mm: float = 30
    bulb_diameter_mm: float = 120
    ies_path: str | None = None


class RopeLightInput(StrictInput):
    model: str | None = None
    lumens_per_m: float | None = 900
    cct_kelvin: int | None = 3000
    cri: float | None = 90
    dimmable: bool = True
    diameter_mm: float = 16
    minimum_bend_radius_mm: float = 60
    mounting: Literal["ceiling", "wall", "concealed", "joinery"] = "ceiling"


class WallSwitchInput(StrictInput):
    kind: Literal["toggle", "dimmer", "momentary"] = "toggle"
    width_mm: float = 86
    height_mm: float = 86
    depth_mm: float = 10


def _jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list, set, frozenset)):
        return [_jsonable(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


def _point(value: PointInput) -> Point3D:
    return Point3D(value.x, value.y, value.z)


def _vector(value: VectorInput) -> Vector3D:
    return Vector3D(value.x, value.y, value.z)


def _spec(value: SpotlightInput) -> SpotlightSpec:
    return SpotlightSpec(**value.model_dump())


def _pendant_spec(value: PendantInput) -> PendantSpec:
    return PendantSpec(**value.model_dump())


def _rope_spec(value: RopeLightInput) -> RopeLightSpec:
    payload = value.model_dump()
    payload["mounting"] = RopeMounting(payload["mounting"])
    return RopeLightSpec(**payload)


def _switch_spec(value: WallSwitchInput) -> WallSwitchSpec:
    payload = value.model_dump()
    payload["kind"] = WallSwitchKind(payload["kind"])
    return WallSwitchSpec(**payload)


def _device_matches(device: object, identity: str) -> bool:
    return getattr(device, "id", None) == identity or getattr(device, "tag", None) == identity


def build_server(
    model_path: Path | str = Path("model/house.ifc"),
    *,
    config_dir: Path | str | None = None,
    export_dir: Path | str | None = None,
) -> FastMCP:
    twin = HomeTwin.open(model_path, config_dir=config_dir)
    if export_dir is not None:
        twin.export_dir = Path(export_dir).resolve()
    server = FastMCP(
        name="home-twin",
        instructions=(
            "Semantic residential IFC tools. All coordinates are canonical building millimetres: +X plan-right/east, "
            "+Y plan-up/north, +Z up. Read room context before designing. Validate or optimise before mutation. "
            "Fixture mutations are durable, reopened, verified IFC transactions. Lumen grids are approximations, not "
            "photometric simulation. Use official IfcMCP for generic IFC queries/renders and Bonsai MCP for "
            "screenshots."
        ),
    )

    @server.tool(annotations=READ)
    def get_building() -> dict[str, Any]:
        """Return building identity, IFC schema, coordinate frame, units, and current revision."""

        return _jsonable(twin.get_building())

    @server.tool(annotations=READ)
    def get_storeys() -> list[dict[str, Any]]:
        """List storeys with absolute elevations in canonical millimetres."""

        return _jsonable(twin.get_storeys())

    @server.tool(annotations=READ)
    def get_rooms() -> list[dict[str, Any]]:
        """List IFC spaces in stable storey and name order."""

        return _jsonable(twin.get_rooms())

    @server.tool(annotations=READ)
    def get_room(room_id: str) -> dict[str, Any]:
        """Return one room by its stable IFC GlobalId."""

        return _jsonable(twin.get_room(room_id))

    @server.tool(annotations=READ)
    def get_objects(room: str | None = None, type: str | None = None) -> list[dict[str, Any]]:
        """List semantic building objects, optionally filtered by room and object kind or IFC class."""

        return _jsonable(twin.get_objects(room=room, type=type))

    @server.tool(annotations=READ)
    def get_walls(room_id: str) -> list[dict[str, Any]]:
        """Return walls that explicitly bound, or geometrically adjoin, a room."""

        return _jsonable(twin.get_walls(room_id))

    @server.tool(annotations=READ)
    def get_ceiling(room_id: str) -> dict[str, Any]:
        """Return the room ceiling polygon, elevation, and geometry source."""

        return _jsonable(twin.get_ceiling(room_id))

    @server.tool(annotations=READ)
    def get_openings(room_id: str) -> list[dict[str, Any]]:
        """Return doors, windows, and opening elements associated with a room."""

        return _jsonable(twin.get_openings(room_id))

    @server.tool(annotations=READ)
    def get_furniture(room_id: str) -> list[dict[str, Any]]:
        """Return furniture and cabinetry spatially contained in a room."""

        return _jsonable(twin.get_furniture(room_id))

    @server.tool(annotations=READ)
    def get_light_fixtures(room_id: str) -> list[dict[str, Any]]:
        """Return Home Twin recessed spotlights in a room."""

        return _jsonable(twin.get_light_fixtures(room_id))

    @server.tool(annotations=READ)
    def get_luminaires(room_id: str) -> list[dict[str, Any]]:
        """Return all typed IFC luminaires in a room: recessed spots, pendants, and rope lights."""

        return _jsonable(twin.get_luminaires(room_id))

    @server.tool(annotations=READ)
    def get_wall_switches(room_id: str) -> list[dict[str, Any]]:
        """Return physical IFC switches with host wall, offset, mounting height, and control group."""

        return _jsonable(twin.get_wall_switches(room_id))

    @server.tool(annotations=READ)
    def get_control_groups() -> list[dict[str, Any]]:
        """Return durable IFC control groups and their switch and luminaire GlobalIds."""

        return _jsonable(twin.get_control_groups())

    @server.tool(annotations=READ)
    def get_room_lighting_design(room_id: str) -> dict[str, Any]:
        """Return one room's typed luminaires, physical switches, and shared IFC control groups."""

        return _jsonable(twin.get_room_lighting_design(room_id))

    @server.tool(annotations=READ)
    def get_object_properties(object_id: str) -> dict[str, Any]:
        """Return normalized IFC attributes and property-set values for an object."""

        return _jsonable(twin.get_object_properties(object_id))

    @server.tool(annotations=READ)
    def get_object_bounds(object_id: str) -> dict[str, Any]:
        """Return world-space object bounds in canonical millimetres."""

        return _jsonable(twin.get_object_bounds(object_id))

    @server.tool(annotations=READ)
    def measure_between_objects(a: str, b: str) -> dict[str, Any]:
        """Return the minimum axis-aligned bounds distance between two objects in millimetres."""

        return {"distance_mm": twin.measure_between_objects(a, b), "method": "aabb"}

    @server.tool(annotations=READ)
    def measure_points(point_a: PointInput, point_b: PointInput) -> dict[str, float]:
        """Return Euclidean distance between two canonical millimetre points."""

        return {"distance_mm": twin.measure_points(_point(point_a), _point(point_b))}

    @server.tool(annotations=READ)
    def distance_to_wall(point: PointInput, wall_id: str) -> dict[str, Any]:
        """Return perpendicular plan distance from a point to a room-facing wall segment."""

        return {"distance_mm": twin.distance_to_wall(_point(point), wall_id), "method": "wall_face_segment"}

    @server.tool(annotations=READ)
    def raycast(origin: PointInput, direction: VectorInput) -> dict[str, Any] | None:
        """Cast a ray through world-space IFC triangles and return the nearest hit."""

        return _jsonable(twin.raycast(_point(origin), _vector(direction)))

    @server.tool(annotations=READ)
    def get_clearances(object_id: str, limit: int = 8) -> list[dict[str, Any]]:
        """Return nearest object clearances using explicit axis-aligned-bounds methodology."""

        return _jsonable(twin.get_clearances(object_id, limit=limit))

    @server.tool(annotations=READ)
    def get_ceiling_polygon(room_id: str) -> dict[str, Any]:
        """Return a room ceiling outline in canonical X/Y millimetres."""

        return _jsonable(twin.get_ceiling_polygon(room_id))

    @server.tool(annotations=READ)
    def get_lighting_layout(room_id: str) -> dict[str, Any]:
        """Return the committed recessed-spotlight layout for a room."""

        return _jsonable(twin.get_lighting_layout(room_id))

    @server.tool(annotations=READ)
    def calculate_spacing(room_id: str) -> list[dict[str, Any]]:
        """Return every pairwise spotlight spacing in stable nearest-first order."""

        return _jsonable(twin.calculate_spacing(room_id))

    @server.tool(annotations=READ)
    def find_dark_zones(room_id: str, threshold_lux: float | None = None) -> list[dict[str, Any]]:
        """Find task-plane grid points below a lumen/beam approximation threshold; this is not simulation."""

        return _jsonable(twin.find_dark_zones(room_id, threshold_lux=threshold_lux))

    @server.tool(annotations=READ)
    def bake_room_lighting(room_id: str, step_mm: float = 200.0, plane: str = "task") -> dict[str, Any]:
        """Sample a room finely with shadow rays against its cabinetry, services, stairs, and walls.

        Adds occlusion to the lumen and beam-cone approximation for the layout
        currently saved in IFC. Reports the lit fraction, the shadowed fraction,
        and which solids were considered. Still not a photometric simulation.

        Illuminance is maintained rather than initial. Quote ``task_area``
        rather than ``mean_lux``: the whole-room mean includes the strip against
        the wall, so it is a function of the room's shape. ``task_area`` is null
        in a room narrower than twice its border.
        """

        if plane not in {"floor", "task"}:
            raise ValueError("plane must be 'floor' or 'task'")
        baked = twin.bake_lighting(twin.get_lighting_layout(room_id), step_mm=step_mm, plane=plane)
        return {
            "room_id": baked.room_id,
            "method": baked.method,
            "exclusions": list(baked.exclusions),
            "plane_elevation_mm": baked.plane_elevation_mm,
            "step_mm": baked.step_mm,
            "sample_count": len(baked.samples),
            "threshold_lux": baked.threshold_lux,
            "maximum_lux": baked.maximum_lux,
            "mean_lux": baked.mean_lux,
            "covered_fraction": baked.covered_fraction,
            "shadowed_fraction": baked.shadowed_fraction,
            "maintenance_factor": baked.maintenance_factor,
            "task_area": _jsonable(baked.task_area),
            "occluders": list(baked.occluders),
            "fixture_count": baked.fixture_count,
        }

    @server.tool(annotations=READ)
    def get_stairs(room_id: str) -> list[dict[str, Any]]:
        """Return stair flights that serve or adjoin a room, with treads and rise."""

        return _jsonable(twin.get_stairs(room_id))

    @server.tool(annotations=READ)
    def get_site() -> dict[str, Any]:
        """Return the site latitude, longitude, elevation, and true-north bearing from IFC.

        Latitude and longitude are ``null`` when the model does not state them.
        Solar geometry is unavailable in that case; do not substitute a guess.
        """

        return _jsonable(twin.get_site())

    @server.tool(annotations=READ)
    def analyse_direct_sun(
        room_id: str,
        at: str,
        plane: str = "floor",
    ) -> dict[str, Any]:
        """Return direct-sun geometry for one room at one ISO 8601 instant.

        The result reports the solar position, the sun direction in the building
        frame, and the beam footprints that reach the ``floor`` or ``task``
        plane through exterior glazed openings. It is geometry only: it contains
        no illuminance value and excludes sky, reflection, obstruction, and
        glazing transmittance effects.
        """

        from datetime import UTC, datetime
        from zoneinfo import ZoneInfo

        if plane not in {"floor", "task"}:
            raise ValueError("plane must be 'floor' or 'task'")
        site = twin.get_site()
        moment = datetime.fromisoformat(at)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=ZoneInfo(site.timezone) if site.timezone else UTC)
        room = twin.get_room(room_id)
        elevation = (
            room.elevation_mm + twin.constraints.task_plane_height_mm if plane == "task" else room.elevation_mm
        )
        return _jsonable(twin.analyse_direct_sun(room_id, moment, plane_elevation_mm=elevation))

    @server.tool(annotations=READ)
    def get_sun_path(day: str, step_minutes: int = 20) -> dict[str, Any] | None:
        """Return one local day of solar positions, or ``null`` when the site is unstated."""

        from datetime import UTC, datetime
        from zoneinfo import ZoneInfo

        site = twin.get_site()
        moment = datetime.fromisoformat(day)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=ZoneInfo(site.timezone) if site.timezone else UTC)
        return _jsonable(twin.sun_path(moment, step_minutes=step_minutes))

    @server.tool(annotations=READ)
    def find_bad_alignment(room_id: str) -> dict[str, Any]:
        """Find near-miss fixture axes using the configured alignment tolerance."""

        return _jsonable(twin.find_bad_alignment(room_id))

    @server.tool(annotations=READ)
    def find_fixture_collisions(room_id: str) -> dict[str, Any]:
        """Find overlapping fixtures and configured ceiling obstructions."""

        return _jsonable(twin.find_fixture_collisions(room_id))

    @server.tool(annotations=READ)
    def find_spotlights_over_furniture(room_id: str) -> dict[str, Any]:
        """Find spotlights whose plan position lies directly above furniture."""

        return _jsonable(twin.find_spotlights_over(room_id, frozenset({ObjectKind.FURNITURE})))

    @server.tool(annotations=READ)
    def find_spotlights_over_cabinetry(room_id: str) -> dict[str, Any]:
        """Find spotlights whose plan position lies directly above cabinetry."""

        return _jsonable(twin.find_spotlights_over(room_id, frozenset({ObjectKind.CABINET})))

    @server.tool(annotations=READ)
    def find_spotlights_inside_shadow_gap(room_id: str) -> dict[str, Any]:
        """Find spotlights inside a modeled shadow-gap footprint."""

        return _jsonable(twin.find_spotlights_over(room_id, frozenset({ObjectKind.SHADOW_GAP})))

    @server.tool(annotations=READ)
    def validate_lighting_layout(room_id: str) -> dict[str, Any]:
        """Validate the committed room layout against configured geometric constraints."""

        return _jsonable(twin.validate_lighting_layout(twin.get_lighting_layout(room_id)))

    @server.tool(annotations=READ)
    def validate_room_lighting_design(room_id: str) -> dict[str, Any]:
        """Validate all typed luminaires and physical switches in the committed room design."""

        return _jsonable(twin.validate_room_lighting_design(twin.get_room_lighting_design(room_id)))

    @server.tool(annotations=READ)
    def optimise_spotlight_layout(room_id: str, fixture: SpotlightInput) -> dict[str, Any]:
        """Propose a deterministic constrained grid with labelled lumen approximations; does not mutate IFC."""

        return _jsonable(twin.optimise_spotlight_layout(room_id, _spec(fixture)))

    @server.tool(annotations=WRITE)
    def add_spotlight(
        room_id: str,
        fixture_id: str,
        point: PointInput,
        fixture: SpotlightInput,
        switching_group: str,
        expected_revision: str,
        direction: VectorInput | None = None,
    ) -> dict[str, Any]:
        """Validate and durably add one IFC recessed spotlight. The exact expected model revision is required."""

        return _jsonable(
            twin.add_spotlight(
                room_id,
                fixture_id=fixture_id,
                point=_point(point),
                spec=_spec(fixture),
                switching_group=switching_group,
                direction=_vector(direction) if direction else Vector3D(0, 0, -1),
                expected_revision=expected_revision,
            )
        )

    @server.tool(annotations=WRITE)
    def add_pendant(
        room_id: str,
        fixture_id: str,
        ceiling_point: PointInput,
        fixture: PendantInput,
        switching_group: str,
        expected_revision: str,
    ) -> dict[str, Any]:
        """Validate and durably add a pendant bulb anchored at an exact ceiling coordinate."""

        design = twin.get_room_lighting_design(room_id)
        updated = RoomLightingDesign(
            room_id,
            (*design.luminaires, PlannedPendant(
                fixture_id,
                room_id,
                _point(ceiling_point),
                _pendant_spec(fixture),
                switching_group,
            )),
            design.switches,
            design.control_groups,
        )
        return _jsonable(twin.apply_room_lighting_design(updated, expected_revision=expected_revision))

    @server.tool(annotations=WRITE)
    def add_rope_light(
        room_id: str,
        fixture_id: str,
        path: list[PointInput],
        fixture: RopeLightInput,
        switching_group: str,
        expected_revision: str,
    ) -> dict[str, Any]:
        """Validate and durably add a rope light along an exact building-coordinate path."""

        design = twin.get_room_lighting_design(room_id)
        updated = RoomLightingDesign(
            room_id,
            (*design.luminaires, PlannedRopeLight(
                fixture_id,
                room_id,
                tuple(_point(point) for point in path),
                _rope_spec(fixture),
                switching_group,
            )),
            design.switches,
            design.control_groups,
        )
        return _jsonable(twin.apply_room_lighting_design(updated, expected_revision=expected_revision))

    @server.tool(annotations=WRITE)
    def add_wall_switch(
        room_id: str,
        switch_id: str,
        host_wall_id: str,
        offset_mm: float,
        mounting_height_mm: float,
        switching_group: str,
        switch: WallSwitchInput,
        expected_revision: str,
    ) -> dict[str, Any]:
        """Validate and durably add a physical switch using wall-relative installation coordinates."""

        design = twin.get_room_lighting_design(room_id)
        updated = RoomLightingDesign(
            room_id,
            design.luminaires,
            (*design.switches, PlannedWallSwitch(
                switch_id,
                room_id,
                host_wall_id,
                offset_mm,
                mounting_height_mm,
                switching_group,
                _switch_spec(switch),
            )),
            design.control_groups,
        )
        return _jsonable(twin.apply_room_lighting_design(updated, expected_revision=expected_revision))

    @server.tool(annotations=WRITE)
    def move_wall_switch(
        room_id: str,
        switch_id: str,
        host_wall_id: str,
        offset_mm: float,
        mounting_height_mm: float,
        expected_revision: str,
    ) -> dict[str, Any]:
        """Move a physical switch along or onto a wall and durably validate the room design."""

        design = twin.get_room_lighting_design(room_id)
        if not any(_device_matches(device, switch_id) for device in design.switches):
            raise KeyError(f"Switch {switch_id!r} was not found in room {room_id!r}")
        switches = tuple(
            replace(
                device,
                host_wall_id=host_wall_id,
                offset_mm=offset_mm,
                mounting_height_mm=mounting_height_mm,
            )
            if _device_matches(device, switch_id)
            else device
            for device in design.switches
        )
        updated = RoomLightingDesign(room_id, design.luminaires, switches, design.control_groups)
        return _jsonable(twin.apply_room_lighting_design(updated, expected_revision=expected_revision))

    @server.tool(annotations=WRITE)
    def assign_lighting_group(
        room_id: str,
        device_ids: list[str],
        switching_group: str,
        expected_revision: str,
    ) -> dict[str, Any]:
        """Assign any number of room luminaires and switches to one durable IFC control group."""

        design = twin.get_room_lighting_design(room_id)
        requested = set(device_ids)
        matched = {
            identity
            for identity in requested
            if any(
                _device_matches(device, identity)
                for device in (*design.luminaires, *design.switches)
            )
        }
        if matched != requested:
            raise KeyError(f"Lighting devices were not found: {sorted(requested - matched)}")
        luminaires = tuple(
            replace(device, switching_group=switching_group)
            if any(_device_matches(device, identity) for identity in requested)
            else device
            for device in design.luminaires
        )
        switches = tuple(
            replace(device, switching_group=switching_group)
            if any(_device_matches(device, identity) for identity in requested)
            else device
            for device in design.switches
        )
        updated = RoomLightingDesign(room_id, luminaires, switches, design.control_groups)
        return _jsonable(twin.apply_room_lighting_design(updated, expected_revision=expected_revision))

    @server.tool(annotations=DELETE)
    def delete_lighting_device(room_id: str, device_id: str, expected_revision: str) -> dict[str, Any]:
        """Durably delete a typed luminaire or physical switch from one validated room design."""

        design = twin.get_room_lighting_design(room_id)
        luminaires = tuple(item for item in design.luminaires if not _device_matches(item, device_id))
        switches = tuple(item for item in design.switches if not _device_matches(item, device_id))
        if len(luminaires) == len(design.luminaires) and len(switches) == len(design.switches):
            raise KeyError(f"Lighting device {device_id!r} was not found in room {room_id!r}")
        updated = RoomLightingDesign(room_id, luminaires, switches, design.control_groups)
        return _jsonable(twin.apply_room_lighting_design(updated, expected_revision=expected_revision))

    @server.tool(annotations=WRITE)
    def move_fixture(fixture_id: str, point: PointInput, expected_revision: str) -> dict[str, Any]:
        """Validate and durably move one Home Twin fixture. The exact expected model revision is required."""

        return _jsonable(twin.move_fixture(fixture_id, _point(point), expected_revision=expected_revision))

    @server.tool(annotations=DELETE)
    def delete_fixture(fixture_id: str, expected_revision: str) -> dict[str, Any]:
        """Durably remove one Home Twin fixture after checking the exact expected model revision."""

        return _jsonable(twin.delete_fixture(fixture_id, expected_revision=expected_revision))

    @server.tool(annotations=WRITE)
    def align_fixtures(fixture_ids: list[str], axis: str, expected_revision: str) -> dict[str, Any]:
        """Align selected fixtures along canonical X or Y and commit the validated layout as one IFC transaction."""

        if axis not in {"x", "y"}:
            raise ValueError("axis must be 'x' or 'y'")
        fixtures = [twin.get_light_fixture(fixture_id) for fixture_id in fixture_ids]
        if not fixtures or len({fixture.room_id for fixture in fixtures}) != 1:
            raise ValueError("Fixtures must be a non-empty set from one room")
        aligned_value = sum(getattr(fixture.point, "y" if axis == "x" else "x") for fixture in fixtures) / len(fixtures)
        aligned = tuple(
            replace(
                fixture,
                point=Point3D(
                    fixture.point.x if axis == "x" else aligned_value,
                    aligned_value if axis == "x" else fixture.point.y,
                    fixture.point.z,
                ),
            )
            for fixture in fixtures
        )
        layout = twin.get_lighting_layout(fixtures[0].room_id)
        for fixture in aligned:
            layout = layout.replace_fixture(fixture.id, fixture)
        return _jsonable(twin.apply_lighting_layout(layout, expected_revision=expected_revision))

    @server.tool(annotations=WRITE)
    def distribute_fixtures(
        fixture_ids: list[str],
        start: PointInput,
        end: PointInput,
        expected_revision: str,
    ) -> dict[str, Any]:
        """Evenly distribute selected fixtures between two canonical points and commit one validated transaction.

        Fixtures are ordered by the projection of their current plan position onto the
        start-to-end line, ties broken by tag, so no fixture crosses another. The first
        lands on start, the last on end, and the rest at equal intervals between them.
        The UI's Distribute is this call with start and end at the two selected fixtures
        that are furthest apart.
        """

        first = _point(start)
        last = _point(end)
        fixtures = sorted(
            (twin.get_light_fixture(item) for item in fixture_ids),
            key=lambda item: (
                (item.point.x - first.x) * (last.x - first.x) + (item.point.y - first.y) * (last.y - first.y),
                item.tag,
            ),
        )
        if len(fixtures) < 2 or len({fixture.room_id for fixture in fixtures}) != 1:
            raise ValueError("At least two fixtures from one room are required")
        layout: LightingLayout = twin.get_lighting_layout(fixtures[0].room_id)
        for index, fixture in enumerate(fixtures):
            t = index / (len(fixtures) - 1)
            moved = replace(
                fixture,
                point=Point3D(
                    first.x + (last.x - first.x) * t,
                    first.y + (last.y - first.y) * t,
                    first.z + (last.z - first.z) * t,
                ),
            )
            layout = layout.replace_fixture(fixture.id, moved)
        return _jsonable(twin.apply_lighting_layout(layout, expected_revision=expected_revision))

    @server.tool(annotations=READ)
    def save_model() -> dict[str, Any]:
        """Return the current durable IFC revision. Home Twin has no hidden pending edits."""

        return {"revision": twin.save_model(), "pending_edits": False}

    @server.tool(
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    def export_lighting_layout(
        room_id: str | None = None,
        formats: list[str] | None = None,
    ) -> dict[str, Any]:
        """Write deterministic trade-ready CSV, JSON, and SVG files derived from the committed IFC revision."""

        paths = twin.export_lighting(room_id=room_id, formats=frozenset(formats or ["csv", "json", "svg"]))
        return {"revision": twin.revision, "paths": [str(path) for path in paths]}

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Home Twin semantic MCP server")
    parser.add_argument("--model", type=Path, default=Path("model/house.ifc"))
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--exports", type=Path, default=None)
    args = parser.parse_args()
    build_server(args.model, config_dir=args.config, export_dir=args.exports).run(transport="stdio")


if __name__ == "__main__":
    main()
