from dataclasses import replace

import ifcopenshell
import pytest

from home_twin.furniture import DiningFurniture, save_dining_furniture
from home_twin.kitchen import KitchenUnit, save_kitchen_units
from home_twin.model import HomeTwin, ObjectKind, Point3D


def open_plan(path):
    return next(room for room in HomeTwin.open(path).get_rooms() if room.name == "Open plan")


BASE = KitchenUnit("K1", "Sink base cabinet", "base", Point3D(700, 3700, 0), 600, 600, 870, "south")
WORKTOP = KitchenUnit(
    "K2", "Stone worktop", "worktop", Point3D(700, 3700, 870), 600, 600, 30, "south", front="none", finish="stone"
)
SINK = KitchenUnit(
    "K3", "Undermount sink", "appliance", Point3D(700, 3700, 700), 400, 400, 200, "south",
    front="none", appliance="sink",
)
TOWER = KitchenUnit("K4", "Oven tower", "tall", Point3D(5700, 2000, 0), 1000, 600, 2200, "west", appliance="oven")
RUN = (BASE, WORKTOP, SINK, TOWER)


def test_kitchen_run_roundtrips_with_typed_units_and_stable_ids(sample_path):
    room = open_plan(sample_path)
    ids = save_kitchen_units(sample_path, room.id, RUN)
    assert save_kitchen_units(sample_path, room.id, RUN) == ids

    reopened = ifcopenshell.open(str(sample_path))
    for unit in RUN:
        product = reopened.by_guid(ids[unit.tag])
        assert (product.Tag, product.PredefinedType, product.ObjectType) == (
            unit.tag,
            "USERDEFINED",
            f"kitchen_{unit.role}",
        )
        assert product.ContainedInStructure[0].RelatingStructure.GlobalId == room.id

    units = {obj.properties["Tag"]: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert units["K1"].properties["Pset_HomeTwinKitchen.Role"] == "base"
    assert units["K1"].properties["Pset_HomeTwinKitchen.RepresentationMethod"] == "design_envelope"
    assert units["K3"].properties["Pset_HomeTwinKitchen.Appliance"] == "sink"


def test_a_facing_turns_the_unit_onto_its_wall(sample_path):
    room = open_plan(sample_path)
    ids = save_kitchen_units(sample_path, room.id, RUN)
    units = {obj.id: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}

    front = units[ids["K1"]].bounds
    assert (front.maximum.x - front.minimum.x, front.maximum.y - front.minimum.y) == pytest.approx((600, 600))

    # K4 faces west, so its 1000 mm front runs north-south and its 600 mm depth runs east-west.
    turned = units[ids["K4"]].bounds
    assert (turned.maximum.x - turned.minimum.x, turned.maximum.y - turned.minimum.y) == pytest.approx((600, 1000))
    assert (turned.minimum.x, turned.minimum.y) == pytest.approx((5400, 1500))


def test_a_worktop_is_a_task_surface_not_an_obstruction(sample_path):
    room = open_plan(sample_path)
    ids = save_kitchen_units(sample_path, room.id, RUN)
    units = {obj.id: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert units[ids["K1"]].kind is ObjectKind.CABINET
    assert units[ids["K2"]].kind is ObjectKind.FURNITURE
    obstructions = HomeTwin.open(sample_path).get_room_context(room.id).obstructions
    assert ids["K2"] not in {obj.id for obj in obstructions}


def test_superseded_elements_leave_in_the_same_transaction(sample_path):
    room = open_plan(sample_path)
    save_kitchen_units(sample_path, room.id, RUN, frozenset({"Tall kitchen cabinetry"}))
    names = {obj.name for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert "Tall kitchen cabinetry" not in names
    assert "Sink base cabinet" in names


def test_units_dropped_from_the_schedule_are_removed(sample_path):
    room = open_plan(sample_path)
    save_kitchen_units(sample_path, room.id, RUN)
    save_kitchen_units(sample_path, room.id, (BASE, WORKTOP))
    tags = {obj.properties["Tag"] for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert {"K1", "K2"} <= tags
    assert not {"K3", "K4"} & tags


@pytest.mark.parametrize(
    ("unit", "message"),
    [
        (replace(BASE, centre_mm=Point3D(-700, 3700, 0)), "outside"),
        (replace(BASE, centre_mm=Point3D(700, 3700, 200)), "stand on the floor"),
        (replace(TOWER, height_mm=3000), "ceiling"),
        (replace(BASE, tag="K9", centre_mm=Point3D(1100, 3700, 0)), "collides"),
    ],
)
def test_a_rejected_unit_keeps_the_previous_ifc(sample_path, unit, message):
    room = open_plan(sample_path)
    save_kitchen_units(sample_path, room.id, RUN)
    before = sample_path.read_bytes()
    with pytest.raises(ValueError, match=message):
        save_kitchen_units(sample_path, room.id, (*RUN, unit) if unit.tag == "K9" else (unit,))
    assert sample_path.read_bytes() == before


def test_an_appliance_may_share_the_envelope_of_its_joinery(sample_path):
    room = open_plan(sample_path)
    ids = save_kitchen_units(sample_path, room.id, RUN)
    units = {obj.id: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    basin = units[ids["K3"]].bounds
    carcass = units[ids["K1"]].bounds
    assert basin.minimum.z < carcass.maximum.z, "the test only proves the exemption if the basin is inside"


def test_a_malformed_unit_is_rejected_before_any_ifc_work():
    with pytest.raises(ValueError, match="Unknown kitchen role"):
        replace(BASE, role="sideboard")
    with pytest.raises(ValueError, match="Unknown kitchen facing"):
        replace(BASE, facing="up")
    with pytest.raises(ValueError, match="dimensions must be positive"):
        replace(BASE, width_mm=0)
    with pytest.raises(ValueError, match="needs a tag and a name"):
        replace(BASE, tag="")


def test_duplicate_tags_are_rejected(sample_path):
    room = open_plan(sample_path)
    with pytest.raises(ValueError, match="unique"):
        save_kitchen_units(sample_path, room.id, (BASE, replace(BASE, name="Other")))


# A 1200 mm island: a 600 mm carcass fronting south, and a 900 mm top whose last
# 300 mm overhangs north as knee space for the stools.
ISLAND = KitchenUnit("K5", "Island", "island", Point3D(5200, 850, 0), 1200, 600, 870, "south", front="drawers")
ISLAND_TOP = KitchenUnit(
    "K6", "Island worktop", "worktop", Point3D(5200, 1000, 870), 1200, 900, 30, "south", front="none", finish="stone"
)


def test_a_gable_is_floor_standing_cabinet_joinery(sample_path):
    room = open_plan(sample_path)
    gable = KitchenUnit(
        "K7", "Support gable", "gable", Point3D(5200, 1300, 0), 300, 18, 870, "north", front="none"
    )
    ids = save_kitchen_units(sample_path, room.id, (ISLAND, ISLAND_TOP, gable))
    obj = next(o for o in HomeTwin.open(sample_path).get_furniture(room.id) if o.id == ids["K7"])
    assert obj.kind is ObjectKind.CABINET
    assert obj.bounds.minimum.z == pytest.approx(0), "a gable stands on the floor"
    with pytest.raises(ValueError, match="must stand on the floor"):
        save_kitchen_units(sample_path, room.id, (replace(gable, centre_mm=Point3D(5200, 1300, 300)),))


def test_a_stool_may_tuck_under_a_worktop_overhang(sample_path):
    room = open_plan(sample_path)
    stool = DiningFurniture("BS01", "stool", Point3D(5200, 1400, 0), 400, 400, 1000, "south")
    save_dining_furniture(sample_path, room.id, (stool,))

    ids = save_kitchen_units(sample_path, room.id, (ISLAND, ISLAND_TOP))
    objects = {obj.id: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    seat = next(obj for obj in objects.values() if obj.properties.get("Tag") == "BS01")
    top = objects[ids["K6"]]
    assert seat.bounds.minimum.y < top.bounds.maximum.y, "the test only proves the exemption if the seat tucks in"
    assert seat.bounds.maximum.z > top.bounds.minimum.z


def test_a_stool_pushed_into_the_carcass_is_still_a_collision(sample_path):
    room = open_plan(sample_path)
    stool = DiningFurniture("BS01", "stool", Point3D(5200, 1200, 0), 400, 400, 1000, "south")
    save_dining_furniture(sample_path, room.id, (stool,))
    before = sample_path.read_bytes()
    with pytest.raises(ValueError, match="collides"):
        save_kitchen_units(sample_path, room.id, (ISLAND, ISLAND_TOP))
    assert sample_path.read_bytes() == before

def test_a_built_up_worktop_edge_records_the_rim_without_thickening_the_slab(sample_path):
    room = open_plan(sample_path)
    island = replace(ISLAND_TOP, edge_depth_mm=60)
    ids = save_kitchen_units(sample_path, room.id, (ISLAND, island))
    obj = next(o for o in HomeTwin.open(sample_path).get_furniture(room.id) if o.id == ids["K6"])

    # The stone stays 30 mm; only the visible edge reads 60, so nobody orders a
    # 60 mm slab off the back of this model.
    assert obj.bounds.maximum.z - obj.bounds.minimum.z == pytest.approx(30)
    assert obj.properties["Pset_HomeTwinKitchen.EdgeDepth"] == pytest.approx(60)

    with pytest.raises(ValueError, match="not deeper than its 30 mm slab"):
        replace(ISLAND_TOP, edge_depth_mm=30)
    with pytest.raises(ValueError, match="no worktop edge to build up"):
        replace(ISLAND, edge_depth_mm=60)


def test_a_hinge_survives_a_save_and_reload(sample_path):
    room = open_plan(sample_path)
    run = (
        replace(BASE, hinge="pair"),
        WORKTOP,
        SINK,
        replace(TOWER, hinge="right"),
        KitchenUnit(
            "K5", "Toaster garage", "wall", Point3D(700, 3700, 1500), 600, 600, 450, "south",
            front="lift", hinge="top",
        ),
    )
    save_kitchen_units(sample_path, room.id, run)

    units = {obj.properties["Tag"]: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert units["K1"].properties["Pset_HomeTwinKitchen.Hinge"] == "pair"
    assert units["K4"].properties["Pset_HomeTwinKitchen.Hinge"] == "right"
    assert units["K5"].properties["Pset_HomeTwinKitchen.Hinge"] == "top"
    # A front that does not swing says so, rather than leaving the reader to guess.
    assert units["K2"].properties["Pset_HomeTwinKitchen.Hinge"] == "none"


def test_a_hinge_that_contradicts_its_front_is_rejected():
    with pytest.raises(ValueError, match="Unknown kitchen hinge"):
        replace(BASE, hinge="sideways")
    # A worktop has no leaf, so it cannot be hung on one.
    with pytest.raises(ValueError, match="no leaf to hang"):
        replace(WORKTOP, hinge="left")
    with pytest.raises(ValueError, match="not a lift-up flap"):
        replace(BASE, hinge="top")
    with pytest.raises(ValueError, match="hangs on its top edge"):
        KitchenUnit(
            "K6", "Flap", "wall", Point3D(700, 3700, 1500), 600, 600, 450, "south", front="lift", hinge="left"
        )


def test_a_carcass_is_declared_and_survives_a_save(sample_path):
    room = open_plan(sample_path)
    run = (
        BASE,
        WORKTOP,
        SINK,
        # Integrated: stands in its own opening, so the role says base but no one builds a box.
        replace(TOWER, tag="K7", name="Integrated dishwasher", carcass=False),
    )
    save_kitchen_units(sample_path, room.id, run)

    units = {obj.properties["Tag"]: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert units["K1"].properties["Pset_HomeTwinKitchen.Carcass"] == "yes"
    assert units["K7"].properties["Pset_HomeTwinKitchen.Carcass"] == "no"
    # A slab is never a carcass, and nothing has to say so.
    assert units["K2"].properties["Pset_HomeTwinKitchen.Carcass"] == "no"


def test_a_role_that_is_never_a_carcass_cannot_claim_one():
    assert BASE.has_carcass and not WORKTOP.has_carcass and not SINK.has_carcass
    with pytest.raises(ValueError, match="never a carcass"):
        replace(WORKTOP, carcass=True)
    with pytest.raises(ValueError, match="never a carcass"):
        replace(SINK, carcass=True)
