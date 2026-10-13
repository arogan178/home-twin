"""Shadow rays against a room's solids, and the baked surface built from them."""

from __future__ import annotations

import pytest

from home_twin.constraints import LightingConstraints
from home_twin.fixtures import LightingLayout, PlannedSpotlight, SpotlightSpec
from home_twin.lighting import bake_lighting, sample_illuminance
from home_twin.model import (
    Bounds3D,
    BuildingObject,
    Ceiling,
    HomeTwin,
    ObjectKind,
    Opening,
    OpeningKind,
    Point2D,
    Point3D,
    Polygon2D,
    Room,
    RoomContext,
    Soffit,
    Vector3D,
    WallFace,
)
from home_twin.occlusion import (
    collect_occluders,
    is_shadowed,
    shadow_ray_origin,
)

SPEC = SpotlightSpec(lumens=800, beam_angle_deg=60)


def _room(
    objects: tuple[BuildingObject, ...] = (),
    openings: tuple[Opening, ...] = (),
    soffits: tuple[Soffit, ...] = (),
) -> RoomContext:
    """A 4 m by 4 m room with a 2.6 m ceiling."""

    polygon = Polygon2D((Point2D(0, 0), Point2D(4000, 0), Point2D(4000, 4000), Point2D(0, 4000)))
    room = Room("ROOM", "Test room", "STOREY", 0.0, Bounds3D(Point3D(0, 0, 0), Point3D(4000, 4000, 2600)))
    walls = (
        WallFace("W_S", Point2D(0, 0), Point2D(4000, 0), Vector3D(0, 1, 0), 150.0),
        WallFace("W_E", Point2D(4000, 0), Point2D(4000, 4000), Vector3D(-1, 0, 0), 150.0),
        WallFace("W_N", Point2D(4000, 4000), Point2D(0, 4000), Vector3D(0, -1, 0), 150.0),
        WallFace("W_W", Point2D(0, 4000), Point2D(0, 0), Vector3D(1, 0, 0), 150.0),
    )
    return RoomContext(
        room,
        Ceiling("ROOM", polygon, 2600, "test", 2700),
        walls,
        openings,
        (),
        objects,
        objects,
        (),
        soffits,
    )


def _cabinet(
    height_mm: float,
    *,
    x0: float = 1800,
    y0: float = 1800,
    x1: float = 2200,
    y1: float = 2200,
) -> BuildingObject:
    return BuildingObject(
        "CAB",
        "IfcFurniture",
        ObjectKind.CABINET,
        "Tall cabinetry",
        ("ROOM",),
        Bounds3D(Point3D(x0, y0, 0), Point3D(x1, y1, height_mm)),
    )


def test_a_tall_solid_shadows_the_point_behind_it() -> None:
    context = _room((_cabinet(2200),))
    occluders = collect_occluders(context, minimum_height_mm=800)
    assert [box.kind for box in occluders.boxes] == ["cabinet"]

    fixture = Point3D(1000, 1000, 2600)
    behind = Point3D(3000, 3000, 800)
    beside = Point3D(1000, 3000, 800)

    assert is_shadowed(shadow_ray_origin(fixture), behind, occluders) is True
    assert is_shadowed(shadow_ray_origin(fixture), beside, occluders) is False


def test_a_low_object_cannot_shadow_the_plane_above_it() -> None:
    """A 750 mm dining table must not shade an 800 mm task plane."""

    context = _room((_cabinet(750),))
    assert collect_occluders(context, minimum_height_mm=800).boxes == ()
    assert collect_occluders(context, minimum_height_mm=0).boxes != ()


def test_a_shadow_gap_is_not_a_solid_in_the_light_path() -> None:
    gap = BuildingObject(
        "GAP",
        "IfcBuildingElementProxy",
        ObjectKind.SHADOW_GAP,
        "Ceiling shadow gap",
        ("ROOM",),
        Bounds3D(Point3D(0, 3800, 2500), Point3D(4000, 4000, 2600)),
    )
    assert collect_occluders(_room((gap,)), minimum_height_mm=0).boxes == ()


def test_a_doorway_lets_a_ray_through_but_the_wall_does_not() -> None:
    door = Opening(
        id="DOOR",
        name="Doorway",
        kind=OpeningKind.DOOR,
        room_ids=("ROOM",),
        host_wall_id="W_S",
        start=Point2D(1500, 0),
        end=Point2D(2400, 0),
        sill_height_mm=0,
        head_height_mm=2100,
        exposure="interior",
        evidence="test",
    )
    occluders = collect_occluders(_room(openings=(door,)))
    inside = Point3D(2000, 1000, 2000)

    through_gap = Point3D(2000, -1000, 1000)
    through_wall = Point3D(500, -1000, 1000)
    over_the_head = Point3D(2000, -1000, 2400)

    assert is_shadowed(inside, through_gap, occluders) is False
    assert is_shadowed(inside, through_wall, occluders) is True
    assert is_shadowed(inside, over_the_head, occluders) is True


def test_occlusion_lowers_the_estimate_only_where_something_blocks() -> None:
    constraints = LightingConstraints(grid_step_mm=200, task_plane_height_mm=800)
    # A wide beam so the cabinet stands inside the lit footprint rather than
    # beyond it, which is the case that actually exercises occlusion.
    wide = SpotlightSpec(lumens=800, beam_angle_deg=110)
    layout = LightingLayout(
        "ROOM", (PlannedSpotlight("SP01", "ROOM", Point3D(1000, 1000, 2600), wide, "MAIN"),)
    )
    blocker = _cabinet(2200, x0=1400, y0=1400, x1=1800, y1=1800)
    open_room = _room()
    blocked_room = _room((blocker,))

    open_bake = bake_lighting(layout, open_room, constraints, step_mm=200)
    blocked_bake = bake_lighting(layout, blocked_room, constraints, step_mm=200)

    assert open_bake.shadowed_fraction == 0.0
    assert blocked_bake.shadowed_fraction > 0.05
    assert blocked_bake.mean_lux < open_bake.mean_lux
    # The peak sits under the fixture, which nothing blocks, so it is unchanged.
    assert blocked_bake.maximum_lux == pytest.approx(open_bake.maximum_lux, rel=1e-9)
    # A shadowed sample keeps only the room's bounce, and nothing else moves.
    bounce = blocked_bake.interreflection
    assert bounce is not None and bounce.lux > 0
    by_point = {(s.point.x, s.point.y): s.lux for s in open_bake.samples}
    for sample in blocked_bake.samples:
        original = by_point[(sample.point.x, sample.point.y)]
        expected = original if sample.shadowed_by == 0 else bounce.lux
        assert sample.lux == pytest.approx(expected, abs=1e-9)


def test_the_bake_labels_its_method_and_never_claims_simulation() -> None:
    constraints = LightingConstraints(grid_step_mm=200)
    layout = LightingLayout(
        "ROOM", (PlannedSpotlight("SP01", "ROOM", Point3D(2000, 2000, 2600), SPEC, "MAIN"),)
    )
    baked = bake_lighting(layout, _room((_cabinet(2200),)), constraints, step_mm=250)

    # The bounce is included, so the method says so and stops excluding it.
    assert baked.method == "direct_occluded_plus_room_interreflection_v1"
    assert "inter_reflection" not in baked.exclusions
    assert "daylight" in baked.exclusions
    assert "simulation" not in baked.method
    assert baked.interreflection is not None
    assert baked.interreflection.method == "direct_occluded_plus_room_interreflection_v1"
    # It is a room average, and says as much rather than claiming a direction.
    assert "directional_bounce" in baked.interreflection.exclusions
    assert 0 < baked.interreflection.average_reflectance < 1
    assert baked.fixture_count == 1
    assert any("cabinet" in item for item in baked.occluders)
    assert all(sample.lit_by + sample.shadowed_by == 1 for sample in baked.samples)


def test_the_bake_is_finer_than_the_interactive_grid(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    layout = twin.get_lighting_layout(room.id)
    context = twin.get_room_context(room.id)

    grid = sample_illuminance(layout, context, twin.constraints)[0]
    baked = twin.bake_lighting(layout, step_mm=150)

    assert baked.step_mm < grid.step_mm
    assert len(baked.samples) > len(grid.samples) * 4
    assert baked.plane_elevation_mm == grid.plane_elevation_mm
    assert twin.model_path.read_bytes() == twin.model_path.read_bytes()


def test_baking_the_floor_plane_uses_the_floor(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    layout = twin.get_lighting_layout(room.id)

    floor = twin.bake_lighting(layout, step_mm=300, plane="floor")
    task = twin.bake_lighting(layout, step_mm=300, plane="task")

    assert floor.plane_elevation_mm == room.elevation_mm
    assert task.plane_elevation_mm == room.elevation_mm + twin.constraints.task_plane_height_mm
    # Further from the fixture, so dimmer at the brightest point.
    assert floor.maximum_lux < task.maximum_lux


def test_a_bake_step_must_be_positive(twin: HomeTwin) -> None:
    layout = twin.get_lighting_layout(twin.get_rooms()[0].id)
    with pytest.raises(ValueError, match="positive"):
        twin.bake_lighting(layout, step_mm=0)


def test_a_bulkhead_blocks_a_beam_that_crosses_it() -> None:
    """Gypsum is a prism, not a surface: crossing it blocks the ray."""

    footprint = Polygon2D(
        (
            Point2D(1500, 0),
            Point2D(2500, 0),
            Point2D(2500, 4000),
            Point2D(1500, 4000),
        )
    )
    bulkhead = Soffit("SOF1", "Service bulkhead", "bulkhead", "ROOM", footprint, 2200, 2200, "owner")
    context = _room((), soffits=(bulkhead,))
    occluders = collect_occluders(context, minimum_height_mm=800)
    assert occluders.slabs
    assert any("gypsum" in item for item in occluders.summary)

    # A bulkhead blocks light crossing the room, not light dropping under it.
    close = shadow_ray_origin(Point3D(1400, 2000, 2600))
    assert is_shadowed(close, Point3D(3500, 2000, 800), occluders)
    assert not is_shadowed(close, Point3D(1000, 2000, 800), occluders)
    # From far enough back the ray is already below the 2,200 mm underside by
    # the time it reaches the bulkhead, and passes beneath it.
    far = shadow_ray_origin(Point3D(200, 2000, 2600))
    assert not is_shadowed(far, Point3D(3500, 2000, 800), occluders)


def test_dark_regions_group_the_shadow_rather_than_listing_points() -> None:
    constraints = LightingConstraints(grid_step_mm=200, target_lux=200)
    layout = LightingLayout(
        "ROOM", (PlannedSpotlight("SP01", "ROOM", Point3D(600, 600, 2600), SPEC, "MAIN"),)
    )
    baked = bake_lighting(layout, _room(()), constraints, step_mm=200)

    assert baked.dark_regions
    largest = baked.dark_regions[0]
    assert largest.area_m2 > 1
    assert largest.minimum_lux < baked.threshold_lux
    assert largest.sample_count > 1
    # Sorted worst-first by area, so the biggest problem reads first.
    assert [region.area_m2 for region in baked.dark_regions] == sorted(
        (region.area_m2 for region in baked.dark_regions), reverse=True
    )


def test_a_shower_enclosure_shades_only_as_its_tray() -> None:
    """Glass screens cast no shadow worth modelling; a 2 m box over the tray
    would hide the fitting above it from the whole room."""
    shower = BuildingObject(
        "SH",
        "IfcSanitaryTerminal",
        ObjectKind.SANITARY_FIXTURE,
        "Shower SH01",
        ("ROOM",),
        Bounds3D(Point3D(1000, 3000, 0), Point3D(2500, 3800, 2000)),
        properties={"Pset_HomeTwinWetRoom.Role": "shower"},
    )
    on_task_plane = collect_occluders(_room((shower,)), minimum_height_mm=800).boxes
    assert on_task_plane == (), "a 70 mm tray is below the task plane"
    at_floor = collect_occluders(_room((shower,)), minimum_height_mm=0).boxes
    assert len(at_floor) == 1
    assert at_floor[0].bounds.maximum.z == 70, "the tray, not the screens"
