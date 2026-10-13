from __future__ import annotations

from dataclasses import replace
from math import cos, radians, sin
from pathlib import Path

import ifcopenshell
import ifcopenshell.util.unit
import pytest

from home_twin.hvac import (
    CONDENSATE_FALL,
    DRAIN_MM,
    ENCLOSURE_MM,
    LineSetRun,
    SplitUnit,
    _run_hits,
    condensate_fault,
    save_split_systems,
)
from home_twin.model import Bounds3D, BuildingObject, HomeTwin, ObjectKind, Point2D, Point3D, Polygon2D

CEILING = 2800.0
BOX_Z = CEILING - ENCLOSURE_MM["gypsum_box"][1] / 2


def _room_id(path: Path) -> str:
    return HomeTwin.open(path).get_rooms()[0].id


AT_OUTDOOR_UNIT = Point3D(240, 285, 300)


def _system(room: str, *, end: Point3D = AT_OUTDOOR_UNIT) -> tuple[tuple[SplitUnit, ...], tuple[LineSetRun, ...]]:
    """A wall unit on the west wall, an outdoor unit in the south-west corner, and a boxed run between them."""
    indoor = SplitUnit("AC01", room, "indoor", Point3D(100, 2000, 2400), 880, 200, 290, rotation_deg=90)
    outdoor = SplitUnit(
        "ODU01", room, "outdoor", Point3D(700, 285, 0), 870, 370, 735, rotation_deg=180, serves=("AC01",)
    )
    route = (
        Point3D(75, 1560, 2430),
        Point3D(75, 1485, 2430),
        Point3D(75, 1485, BOX_Z),
        Point3D(75, 75, BOX_Z),
        Point3D(75, 75, 300),
        end,
    )
    run = LineSetRun(
        "LS01", room, "AC01", "ODU01", 1, route, ("gypsum_box",) * 4 + ("trunking",), 6.35, 9.52,
        condensate="pump", condensate_outlet=4,
    )
    return (indoor, outdoor), (run,)


def _run(route: tuple[Point3D, ...], legs: tuple[str, ...], **kwargs) -> LineSetRun:
    return LineSetRun("LS01", "room", "AC01", "ODU01", kwargs.pop("sequence", 1), route, legs, 6.35, 9.52, **kwargs)


def test_split_system_survives_ifc_save_and_reload(sample_path) -> None:
    room = _room_id(sample_path)
    units, runs = _system(room)

    ids = save_split_systems(sample_path, units, runs)

    model = ifcopenshell.open(str(sample_path))
    indoor, pipe = model.by_guid(ids["AC01"]), model.by_guid(ids["LS01"])
    assert indoor.is_a("IfcUnitaryEquipment") and indoor.PredefinedType == "SPLITSYSTEM"
    assert pipe.is_a("IfcPipeSegment") and pipe.PredefinedType == "RIGIDSEGMENT"
    context = HomeTwin.open(sample_path).get_room_context(room)
    obstructions = {obj.id: obj for obj in context.obstructions}
    assert obstructions[ids["AC01"]].kind == ObjectKind.AC
    assert obstructions[ids["ODU01"]].properties["Pset_HomeTwinHvac.Serves"] == "AC01"
    saved = obstructions[ids["LS01"]]
    assert saved.kind == ObjectKind.PIPE
    assert saved.properties["Pset_HomeTwinHvac.Legs"] == "gypsum_box;gypsum_box;gypsum_box;gypsum_box;trunking"
    # The body is the enclosure: the box along the ceiling reaches the ceiling and stands 150 off the wall.
    assert saved.bounds.maximum.z == pytest.approx(CEILING, abs=0.5)
    assert saved.bounds.minimum.x == pytest.approx(0.0, abs=0.5)
    assert saved.properties["Pset_HomeTwinHvac.LengthMm"] == round(runs[0].length_mm)


def test_clipped_copper_survives_ifc_save_and_reload(sample_path) -> None:
    room = _room_id(sample_path)
    units, runs = _system(room)
    clipped = replace(runs[0], legs=runs[0].legs[:-1] + ("clipped",))

    ids = save_split_systems(sample_path, units, (clipped,))

    model = ifcopenshell.open(str(sample_path))
    to_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    profiles = [
        item.SweptArea
        for representation in model.by_guid(ids["LS01"]).Representation.Representations
        for item in representation.Items
        if item.is_a("IfcExtrudedAreaSolid") and item.SweptArea.is_a("IfcRectangleProfileDef")
    ]
    last = profiles[-1]
    assert sorted((round(last.XDim * to_mm), round(last.YDim * to_mm))) == [30, 55]
    saved = {obj.id: obj for obj in HomeTwin.open(sample_path).get_room_context(room).obstructions}[ids["LS01"]]
    assert saved.properties["Pset_HomeTwinHvac.Legs"] == "gypsum_box;gypsum_box;gypsum_box;gypsum_box;clipped"


def test_a_rerun_updates_in_place_rather_than_duplicating(sample_path) -> None:
    room = _room_id(sample_path)
    first = save_split_systems(sample_path, *_system(room))
    second = save_split_systems(sample_path, *_system(room))

    assert first == second
    assert len(ifcopenshell.open(str(sample_path)).by_type("IfcPipeSegment")) == 1


def test_a_line_set_that_misses_its_outdoor_unit_leaves_the_file_unchanged(sample_path) -> None:
    room = _room_id(sample_path)
    before = sample_path.read_bytes()

    with pytest.raises(RuntimeError, match="does not end at ODU01"):
        save_split_systems(sample_path, *_system(room, end=Point3D(75, 700, 300)))

    assert sample_path.read_bytes() == before


def test_a_wall_unit_too_close_to_the_ceiling_is_refused(sample_path) -> None:
    room = _room_id(sample_path)
    unit = SplitUnit("AC01", room, "indoor", Point3D(100, 2000, CEILING - 300), 880, 200, 290, rotation_deg=90)

    with pytest.raises(RuntimeError, match="to draw air in"):
        save_split_systems(sample_path, (unit,), ())


def test_a_run_through_furniture_is_refused(sample_path) -> None:
    room = _room_id(sample_path)
    units, _ = _system(room)
    # Across the room at table height, straight through the sample's dining table.
    route = (Point3D(200, 2000, 2430), Point3D(200, 2000, 500), Point3D(3000, 2000, 495), Point3D(3000, 300, 478),
             Point3D(1100, 300, 459))
    run = LineSetRun("LS01", room, "AC01", "ODU01", 1, route, ("trunking",) * 4, 6.35, 9.52)

    with pytest.raises(RuntimeError, match="runs through Dining table"):
        save_split_systems(sample_path, units, (run,))


def test_turned_units_are_judged_on_their_hulls_not_their_boxes(sample_path) -> None:
    room = _room_id(sample_path)
    gap = 250.0
    step = 870 + gap
    turn = radians(45)
    first = SplitUnit("ODU01", room, "outdoor", Point3D(4300, 800, 0), 870, 370, 735, rotation_deg=45,
                      serves=("AC01",))
    second = SplitUnit(
        "ODU02", room, "outdoor", Point3D(4300 + step * cos(turn), 800 + step * sin(turn), 0), 870, 370, 735,
        rotation_deg=45, serves=("AC02",),
    )

    ids = save_split_systems(sample_path, (first, second), ())

    objects = {obj.id: obj for obj in HomeTwin.open(sample_path).get_room_context(room).obstructions}
    a, b = objects[ids["ODU01"]].bounds, objects[ids["ODU02"]].bounds
    assert a.maximum.x > b.minimum.x and a.maximum.y > b.minimum.y


def test_a_level_run_holds_its_drain_for_exactly_the_height_its_enclosure_spares() -> None:
    allowance = ENCLOSURE_MM["trunking"][1] - DRAIN_MM
    limit = allowance / CONDENSATE_FALL

    def level(length: float) -> LineSetRun:
        return _run((Point3D(0, 0, 2000), Point3D(length, 0, 2000), Point3D(length, 0, 500)), ("trunking",) * 2)

    assert condensate_fault((level(limit - 10),)) is None
    assert "runs out of trunking height" in condensate_fault((level(limit + 10),))


def test_only_a_pumped_line_set_may_climb_and_then_it_must_fall() -> None:
    climb = (Point3D(0, 0, 2400), Point3D(0, 0, 2700), Point3D(3000, 0, 2700), Point3D(3000, 0, 400))
    legs = ("gypsum_box",) * 3

    assert "rises above its drain" in condensate_fault((_run(climb, legs),))
    assert condensate_fault((_run(climb, legs, condensate="pump"),)) is None
    with pytest.raises(ValueError, match="only the first run can lift"):
        _run(climb, legs, condensate="pump", sequence=2)


def test_the_drain_is_walked_across_runs_not_reset_at_each_one() -> None:
    allowance = ENCLOSURE_MM["gypsum_box"][1] - DRAIN_MM
    half = allowance / CONDENSATE_FALL * 0.6
    first = _run((Point3D(0, 0, 2700), Point3D(half, 0, 2700)), ("gypsum_box",))
    second = LineSetRun(
        "LS02", "room", "AC01", "ODU01", 2, (Point3D(half, 0, 2700), Point3D(2 * half, 0, 2700)), ("gypsum_box",),
        6.35, 9.52,
    )

    assert condensate_fault((first,)) is None
    assert condensate_fault((second,)) is None
    assert "runs out of gypsum_box height" in condensate_fault((first, second))


def test_the_legs_after_the_outlet_carry_no_drain() -> None:
    route = (Point3D(0, 0, 2000), Point3D(0, 0, 400), Point3D(7000, 0, 400))

    assert condensate_fault((_run(route, ("trunking",) * 2),)) is not None
    assert condensate_fault((_run(route, ("trunking",) * 2, condensate_outlet=1),)) is None


def test_a_separately_drained_line_set_may_rise_and_carries_no_outlet() -> None:
    climb = (Point3D(0, 0, 2400), Point3D(0, 0, 2700), Point3D(3000, 0, 2700), Point3D(3000, 0, 400))

    assert condensate_fault((_run(climb, ("gypsum_box",) * 3, condensate="separate"),)) is None
    with pytest.raises(ValueError, match="no outlet"):
        _run(climb, ("gypsum_box",) * 3, condensate="separate", condensate_outlet=2)


def test_a_unit_left_out_of_a_save_is_removed(sample_path) -> None:
    room = _room_id(sample_path)
    units, runs = _system(room)
    spare = SplitUnit("ODU02", room, "outdoor", Point3D(4300, 800, 0), 800, 290, 550, serves=("AC02",))
    save_split_systems(sample_path, (*units, spare), runs)

    save_split_systems(sample_path, units, runs)

    tags = {product.Tag for product in ifcopenshell.open(str(sample_path)).by_type("IfcUnitaryEquipment")}
    assert tags == {"AC01", "ODU01"}


def test_a_run_clears_a_turned_unit_by_its_hull_not_its_box() -> None:
    diamond = BuildingObject(
        "odu", "IfcUnitaryEquipment", ObjectKind.AC, "ODU02", ("room",),
        Bounds3D(Point3D(0, 0, 0), Point3D(1000, 1000, 700)),
        plan_footprint=Polygon2D((Point2D(500, 0), Point2D(1000, 500), Point2D(500, 1000), Point2D(0, 500))),
    )

    def drop(x: float, y: float) -> LineSetRun:
        return _run((Point3D(x, y, 2000), Point3D(x, y, 300)), ("trunking",), condensate="separate")

    # The box's empty corner, 100 mm in on both axes, is 212 mm clear of the hull.
    assert not _run_hits(drop(100, 100), diamond)
    assert _run_hits(drop(500, 500), diamond)
