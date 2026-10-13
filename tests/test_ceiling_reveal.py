from dataclasses import replace
from math import hypot
from pathlib import Path

import pytest

from home_twin.ceiling import CeilingReveal, save_ceiling_reveals
from home_twin.geometry import convex_hull_2d, polygon_clearance
from home_twin.model import HomeTwin, ObjectKind, Point2D, Polygon2D, Vector3D

NORTH = Vector3D(0.0, -1.0, 0.0)


def open_plan(path):
    return next(room for room in HomeTwin.open(path).get_rooms() if room.name == "Open plan")


@pytest.fixture
def plenum_path(sample_path):
    """A reveal needs somewhere to rise into, so give the sample a 100 mm plenum."""
    import ifcopenshell
    import ifcopenshell.api

    model = ifcopenshell.open(str(sample_path))
    space = model.by_type("IfcSpace")[0]
    pset = ifcopenshell.api.run("pset.add_pset", model, product=space, name="Pset_HomeTwinRoom")
    ifcopenshell.api.run(
        "pset.edit_pset", model, pset=pset, properties={"StructuralCeilingElevation": 2900.0}
    )
    model.write(str(sample_path))
    return sample_path


def turned_reveal() -> CeilingReveal:
    """A run across the sample room at roughly 32 degrees off plan east."""
    start, end = Point2D(200.0, 3800.0), Point2D(5700.0, 300.0)
    run = hypot(end.x - start.x, end.y - start.y)
    inward = Vector3D((end.y - start.y) / run, -(end.x - start.x) / run, 0.0)
    return CeilingReveal("CRV-D", "Diagonal reveal", start, end, inward)


def north_reveal(**overrides) -> CeilingReveal:
    base = dict(
        tag="CRV-N",
        name="North wall gypsum reveal",
        start_mm=Point2D(0.0, 4000.0),
        end_mm=Point2D(6000.0, 4000.0),
        inward_normal=NORTH,
        width_mm=70.0,
        depth_mm=80.0,
    )
    return CeilingReveal(**{**base, **overrides})


def test_a_reveal_roundtrips_as_a_shadow_gap_at_the_gypsum_plane(plenum_path):
    sample_path = plenum_path
    room = open_plan(sample_path)
    reveal = north_reveal()
    ids = save_ceiling_reveals(sample_path, room.id, (reveal,))
    assert save_ceiling_reveals(sample_path, room.id, (reveal,)) == ids

    context = HomeTwin.open(sample_path).get_room_context(room.id)
    obj = next(o for o in context.obstructions if o.id == ids["CRV-N"])
    assert obj.kind is ObjectKind.SHADOW_GAP
    assert obj.properties["Pset_HomeTwinReveal.WidthMm"] == pytest.approx(70)
    assert obj.properties["Pset_HomeTwinReveal.HasLedLip"] is True
    a, b = obj.bounds.minimum, obj.bounds.maximum
    assert a.z == pytest.approx(context.ceiling.elevation_mm)
    assert b.z - a.z == pytest.approx(80)
    # 70 mm deep off the north wall, running the full 6 m of it.
    assert (b.y - a.y, b.x - a.x) == (pytest.approx(70), pytest.approx(6000))
    assert b.y == pytest.approx(4000)


def test_a_reveal_outside_the_ceiling_keeps_the_previous_ifc(plenum_path):
    sample_path = plenum_path
    room = open_plan(sample_path)
    before = sample_path.read_bytes()
    with pytest.raises(ValueError, match="leaves the ceiling"):
        save_ceiling_reveals(sample_path, room.id, (north_reveal(inward_normal=Vector3D(0.0, 1.0, 0.0)),))
    assert sample_path.read_bytes() == before


def test_a_reveal_may_not_rise_past_the_structural_ceiling(plenum_path):
    sample_path = plenum_path
    room = open_plan(sample_path)
    before = sample_path.read_bytes()
    with pytest.raises(ValueError, match="structural ceiling"):
        save_ceiling_reveals(sample_path, room.id, (north_reveal(depth_mm=900.0),))
    assert sample_path.read_bytes() == before


def test_a_malformed_reveal_is_rejected_before_any_ifc_work():
    with pytest.raises(ValueError, match="unit vector"):
        north_reveal(inward_normal=Vector3D(0.0, -2.0, 0.0))
    with pytest.raises(ValueError, match="positive and finite"):
        north_reveal(width_mm=0.0)
    with pytest.raises(ValueError, match="needs a run"):
        north_reveal(end_mm=Point2D(0.0, 4000.0))
    with pytest.raises(ValueError, match="tag and a name"):
        north_reveal(tag="")


def test_a_turned_reveal_keeps_its_own_footprint(plenum_path):
    """A diagonal strip's box covers most of the room; its footprint does not."""
    sample_path = plenum_path
    room = open_plan(sample_path)
    diagonal = turned_reveal()
    ids = save_ceiling_reveals(sample_path, room.id, (diagonal,))
    obj = next(
        o for o in HomeTwin.open(sample_path).get_room_context(room.id).obstructions if o.id == ids["CRV-D"]
    )
    assert obj.plan_footprint is not None
    a, b = obj.bounds.minimum, obj.bounds.maximum
    # The box around a 70 mm strip spans 5.5 m by 3.6 m; the strip is 6.5 m by 70 mm.
    assert (b.x - a.x, b.y - a.y) == (pytest.approx(5538, abs=2), pytest.approx(3559, abs=2))
    # A point well off the strip is inside that box but clear of the real solid.
    corner = Point2D(500.0, 500.0)
    assert a.x <= corner.x <= b.x and a.y <= corner.y <= b.y
    assert polygon_clearance(corner, obj.plan_footprint) == pytest.approx(2553, abs=5)


def test_a_hull_of_two_points_is_not_a_polygon():
    assert len(convex_hull_2d([Point2D(0, 0), Point2D(1, 1)])) == 2
    hull = convex_hull_2d([Point2D(0, 0), Point2D(2, 0), Point2D(2, 2), Point2D(0, 2), Point2D(1, 1)])
    assert len(hull) == 4, "an interior point is not on the hull"
    assert polygon_clearance(Point2D(1, 1), Polygon2D(hull)) == 0


def test_dropped_reveals_are_removed(plenum_path):
    sample_path = plenum_path
    room = open_plan(sample_path)
    save_ceiling_reveals(sample_path, room.id, (north_reveal(), north_reveal(tag="CRV-N2", name="Second")))
    save_ceiling_reveals(sample_path, room.id, (north_reveal(),))
    tags = {o.properties.get("Tag") for o in HomeTwin.open(sample_path).get_room_context(room.id).obstructions}
    assert "CRV-N" in tags
    assert "CRV-N2" not in tags


def test_duplicate_reveal_tags_are_rejected(plenum_path):
    sample_path = plenum_path
    room = open_plan(sample_path)
    with pytest.raises(ValueError, match="unique"):
        save_ceiling_reveals(sample_path, room.id, (north_reveal(), replace(north_reveal(), name="Other")))


def test_a_room_with_no_plenum_cannot_take_a_reveal(sample_path):
    room = open_plan(sample_path)
    before = sample_path.read_bytes()
    with pytest.raises(ValueError, match="no structural ceiling"):
        save_ceiling_reveals(sample_path, room.id, (north_reveal(),))
    assert sample_path.read_bytes() == before


def test_a_turned_reveal_does_not_flag_a_fixture_it_is_nowhere_near(plenum_path):
    """The box around a diagonal strip covers fixtures the strip clears by metres."""
    sample_path = plenum_path
    twin = HomeTwin.open(sample_path, config_dir=Path("config"))
    room = next(r for r in twin.get_rooms() if r.name == "Open plan")
    before = twin.validate_room_lighting_design(twin.get_room_lighting_design(room.id))

    # A corner-to-corner run: its box holds both sample spotlights, the strip
    # itself clears the nearer of them by 283 mm against a 200 mm rule.
    ids = save_ceiling_reveals(sample_path, room.id, (turned_reveal(),))

    after = HomeTwin.open(sample_path, config_dir=Path("config"))
    context = after.get_room_context(room.id)
    strip = next(o for o in context.obstructions if o.id == ids["CRV-D"])
    for fixture in after.get_light_fixtures(room.id):
        a, b = strip.bounds.minimum, strip.bounds.maximum
        assert a.x <= fixture.point.x <= b.x and a.y <= fixture.point.y <= b.y, "the box must cover them"

    report = after.validate_room_lighting_design(after.get_room_lighting_design(room.id))
    gap_findings = [f for f in report.findings if f.code == "fixture_over_shadow_gap"]
    assert gap_findings == [], "a fixture clear of the strip must not be flagged by its bounding box"
    assert len(report.findings) == len(before.findings)
