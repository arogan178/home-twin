"""Solar geometry and direct-sun patch behaviour."""

from __future__ import annotations

from datetime import datetime, timedelta
from math import cos, radians, sin, tan
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from home_twin.daylight import (
    analyse_direct_sun,
    clip_convex_to_polygon,
    project_sun_patch,
    solar_position,
    sun_direction,
    sun_path,
)
from home_twin.geometry import polygon_area
from home_twin.model import (
    Bounds3D,
    Ceiling,
    HomeTwin,
    Opening,
    OpeningKind,
    Point2D,
    Point3D,
    Polygon2D,
    Room,
    RoomContext,
    Site,
    Vector3D,
    WallFace,
)

# A fictional test site on its zone's meridian, so solar noon falls near 13:00 summer time.
ZONE = ZoneInfo("Europe/Berlin")
LATITUDE = 40.0
LONGITUDE = 15.0


def _south_facing_room() -> RoomContext:
    """A 4 m by 3 m room whose south wall carries a 2 m by 2 m glazed opening."""

    polygon = Polygon2D(
        (Point2D(0, 0), Point2D(4000, 0), Point2D(4000, 3000), Point2D(0, 3000))
    )
    room = Room(
        "ROOM",
        "South room",
        "STOREY",
        0.0,
        Bounds3D(Point3D(0, 0, 0), Point3D(4000, 3000, 2600)),
    )
    wall = WallFace("WALL_SOUTH", Point2D(0, 0), Point2D(4000, 0), Vector3D(0, 1, 0), 150.0)
    opening = Opening(
        id="WINDOW",
        name="South window",
        kind=OpeningKind.WINDOW,
        room_ids=("ROOM",),
        host_wall_id="WALL_SOUTH",
        start=Point2D(1000, 0),
        end=Point2D(3000, 0),
        sill_height_mm=0,
        head_height_mm=2000,
        exposure="exterior",
        evidence="test",
    )
    return RoomContext(room, Ceiling("ROOM", polygon, 2600, "test"), (wall,), (opening,), (), (), ())


def test_solar_altitude_matches_the_solstice_identity() -> None:
    """At solar noon the altitude is 90 - |latitude - declination|."""

    for day, declination in ((datetime(2026, 6, 21), 23.44), (datetime(2026, 12, 21), -23.44)):
        expected = 90 - abs(LATITUDE - declination)
        path = sun_path(LATITUDE, LONGITUDE, day.replace(tzinfo=ZONE), step_minutes=20)
        assert path.solar_noon is not None
        assert path.max_altitude_deg == pytest.approx(expected, abs=0.1)
        noon = solar_position(LATITUDE, LONGITUDE, datetime.fromisoformat(path.solar_noon))
        assert abs(noon.hour_angle_deg) < 0.02
        assert noon.azimuth_deg == pytest.approx(180, abs=0.5)


def test_sun_path_brackets_a_symmetric_day_around_solar_noon() -> None:
    path = sun_path(LATITUDE, LONGITUDE, datetime(2026, 3, 20, tzinfo=ZONE), step_minutes=10)
    assert path.sunrise is not None and path.sunset is not None and path.solar_noon is not None
    sunrise = datetime.fromisoformat(path.sunrise)
    sunset = datetime.fromisoformat(path.sunset)
    noon = datetime.fromisoformat(path.solar_noon)
    assert sunrise < noon < sunset
    assert abs((noon - sunrise) - (sunset - noon)) < timedelta(minutes=1)
    assert all(sample.altitude_deg <= path.max_altitude_deg + 1e-9 for sample in path.samples)
    assert solar_position(LATITUDE, LONGITUDE, sunrise - timedelta(minutes=2)).above_horizon is False
    assert solar_position(LATITUDE, LONGITUDE, sunrise + timedelta(minutes=2)).above_horizon is True


def test_sun_direction_rotates_with_the_building_frame() -> None:
    position = solar_position(LATITUDE, LONGITUDE, datetime(2026, 6, 21, 13, 4, tzinfo=ZONE))
    aligned = sun_direction(position, 0.0)
    rotated = sun_direction(position, 90.0)
    assert aligned.z == pytest.approx(sin(radians(position.altitude_deg)))
    assert aligned.y == pytest.approx(cos(radians(position.altitude_deg)) * cos(radians(position.azimuth_deg)))
    # With plan +Y pointing east, plan +X points south, so a southerly sun lands on +X.
    assert rotated.x == pytest.approx(cos(radians(position.altitude_deg)), abs=0.02)
    assert rotated.z == pytest.approx(aligned.z)


def test_naive_instants_are_rejected() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        solar_position(LATITUDE, LONGITUDE, datetime(2026, 6, 21, 12, 0))
    with pytest.raises(ValueError, match="divide 1440"):
        sun_path(LATITUDE, LONGITUDE, datetime(2026, 6, 21, tzinfo=ZONE), step_minutes=7)


def test_a_lower_sun_throws_a_deeper_patch_from_the_same_opening() -> None:
    context = _south_facing_room()
    opening = context.openings[0]
    depths = []
    for altitude in (60.0, 30.0):
        towards_sun = Vector3D(0.0, -cos(radians(altitude)), sin(radians(altitude)))
        patch = project_sun_patch(opening, context, towards_sun, 0.0)
        assert patch is not None
        depths.append(max(point.y for piece in patch.pieces for point in piece.outer))
        # The glazing normal is horizontal, so the incidence angle is the solar altitude.
        assert patch.incidence_deg == pytest.approx(altitude, abs=1e-6)
    assert depths[1] > depths[0]
    assert depths[0] == pytest.approx(2000 / tan(radians(60)), abs=1)


def test_a_patch_is_clipped_to_the_room_and_reports_it() -> None:
    context = _south_facing_room()
    towards_sun = Vector3D(0.0, -cos(radians(20)), sin(radians(20)))
    patch = project_sun_patch(context.openings[0], context, towards_sun, 0.0)
    assert patch is not None
    assert patch.fully_inside_room is False
    assert max(point.y for piece in patch.pieces for point in piece.outer) == pytest.approx(3000, abs=1)
    assert patch.area_m2 == pytest.approx(2 * 3, abs=0.01)
    assert patch.projected_area_m2 > patch.area_m2


def test_no_patch_when_the_sun_is_behind_the_wall_or_below_the_horizon() -> None:
    context = _south_facing_room()
    opening = context.openings[0]
    from_inside = Vector3D(0.0, cos(radians(40)), sin(radians(40)))
    below = Vector3D(0.0, -cos(radians(10)), -sin(radians(10)))
    assert project_sun_patch(opening, context, from_inside, 0.0) is None
    assert project_sun_patch(opening, context, below, 0.0) is None


def test_clipping_a_beam_against_a_concave_room_returns_disjoint_pieces() -> None:
    """A beam crossing a re-entrant corner must come back as separate regions."""

    room = Polygon2D(
        (
            Point2D(0, 0),
            Point2D(3000, 0),
            Point2D(3000, 3000),
            Point2D(2000, 3000),
            Point2D(2000, 1000),
            Point2D(1000, 1000),
            Point2D(1000, 3000),
            Point2D(0, 3000),
        )
    )
    band = (Point2D(0, 2000), Point2D(3000, 2000), Point2D(3000, 4000), Point2D(0, 4000))
    pieces = clip_convex_to_polygon(band, room)

    assert len(pieces) >= 2
    assert sum(polygon_area(piece) for piece in pieces) == pytest.approx(2_000_000, rel=1e-9)
    # No piece may reach into the notch between the two arms.
    assert all(
        max(point.x for point in piece.outer) <= 1000 or min(point.x for point in piece.outer) >= 2000
        for piece in pieces
    )
    outside = (Point2D(9000, 9000), Point2D(9500, 9000), Point2D(9500, 9500))
    assert clip_convex_to_polygon(outside, room) == ()


def test_an_unlocated_site_reports_itself_instead_of_guessing() -> None:
    context = _south_facing_room()
    result = analyse_direct_sun(
        context,
        Site("SITE", "Unstated site"),
        datetime(2026, 6, 21, 13, 0, tzinfo=ZONE),
    )
    assert result.position is None
    assert result.patches == ()
    assert any("site_unknown" in note for note in result.notes)
    assert "illuminance_values" in result.exclusions


def test_analysis_never_claims_illuminance_and_follows_the_task_plane() -> None:
    context = _south_facing_room()
    site = Site("SITE", "Test site", LATITUDE, LONGITUDE, 0.0, 0.0, ZONE.key, "assumed")
    moment = datetime(2026, 12, 21, 12, 0, tzinfo=ZONE)
    floor = analyse_direct_sun(context, site, moment)
    task = analyse_direct_sun(context, site, moment, plane_elevation_mm=800)
    assert floor.patches and task.patches
    assert floor.patches[0].area_m2 > task.patches[0].area_m2
    assert task.patches[0].plane_elevation_mm == 800
    assert "sky_diffuse" in floor.exclusions
    assert not hasattr(floor.patches[0], "lux")
    assert "illuminance_values" in floor.exclusions


def test_a_compiled_draft_carries_its_site_into_solar_geometry(tmp_path: Path) -> None:
    import yaml

    from home_twin.plan_draft import build_draft
    from home_twin.sample import create_sample_ifc

    reference_dir = tmp_path / "model" / "references"
    reference_dir.mkdir(parents=True)
    demo = Path(__file__).parents[1] / "examples" / "demo" / "plan.yaml"
    plan = yaml.safe_load(demo.read_text())
    plan["site"] = {**plan["site"], "latitude_deg": LATITUDE, "longitude_deg": LONGITUDE}
    plan["site"].update(true_north_deg=15.0, timezone=ZONE.key)
    (reference_dir / "plan.yaml").write_text(yaml.safe_dump(plan, sort_keys=False))
    create_sample_ifc(tmp_path / "model" / "house.ifc", with_spotlights=False)

    report = build_draft(tmp_path)
    twin = HomeTwin.open(report.path)
    site = twin.get_site()
    assert site.latitude_deg == pytest.approx(LATITUDE, abs=1e-6)
    assert site.longitude_deg == pytest.approx(LONGITUDE, abs=1e-6)
    assert site.true_north_deg == pytest.approx(15.0, abs=1e-6)
    assert site.timezone == ZONE.key

    living_name = next(room["name"] for room in plan["rooms"] if room["id"] == "living")
    living = next(room for room in twin.get_rooms() if room.name == living_name)
    afternoon = datetime(2026, 6, 21, 17, 0, tzinfo=ZONE)
    result = twin.analyse_direct_sun(living.id, afternoon)
    assert result.position is not None and result.position.above_horizon
    assert result.patches and all(patch.area_m2 > 0 for patch in result.patches)
    night = twin.analyse_direct_sun(living.id, datetime(2026, 12, 21, 2, 0, tzinfo=ZONE))
    assert night.patches == ()
    assert any("below the horizon" in note for note in night.notes)


def test_an_overhang_shades_the_near_floor_and_leaves_a_strip_beyond_it() -> None:
    """A balcony over a slider shades the wrong half, and by a lot.

    Its soffit sits barely above the head, so a ray leaving a point near the
    glass exits low and meets the balcony's underside; only rays from deep in
    the room see sky under its edge. What survives is a strip several metres in,
    and in a shallow room at a low sun there is nothing left at all.
    """
    from dataclasses import replace
    from math import cos, radians, sin

    from home_twin.daylight import project_sun_patch

    context = _south_facing_room()
    bare_opening = context.openings[0]
    overhung = replace(bare_opening, overhang_depth_mm=1000.0, overhang_soffit_mm=2700.0)

    # High sun: the strip starts 1.7 m in and the room is 3 m deep, so some of
    # it survives -- but only a fraction of the bare patch.
    high = Vector3D(0.0, -cos(radians(45)), sin(radians(45)))
    bare = project_sun_patch(bare_opening, context, high, 0.0)
    shaded = project_sun_patch(overhung, context, high, 0.0)
    assert bare is not None and shaded is not None
    assert shaded.area_m2 < bare.area_m2 * 0.35, (
        f"the overhang must remove most of it: {shaded.area_m2:.2f} against {bare.area_m2:.2f}"
    )

    def nearest(patch):
        return min(min(point.y for point in piece.outer) for piece in patch.pieces)

    assert nearest(shaded) > nearest(bare), "what survives is the strip deeper in the room"

    # Low winter sun into a 3 m room: the lit strip would start 4.8 m in, past
    # the back wall, so the balcony takes all of it. That is the real case.
    low = Vector3D(0.0, -cos(radians(25)), sin(radians(25)))
    assert project_sun_patch(bare_opening, context, low, 0.0) is not None
    assert project_sun_patch(overhung, context, low, 0.0) is None

    # A projection that reaches nowhere changes nothing.
    unshaded = project_sun_patch(replace(bare_opening, overhang_depth_mm=None), context, high, 0.0)
    assert unshaded is not None and unshaded.area_m2 == pytest.approx(bare.area_m2)
