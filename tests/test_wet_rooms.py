from __future__ import annotations

from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import pytest

from home_twin.geometry import polygon_area
from home_twin.model import HomeTwin, ObjectKind, Point3D
from home_twin.wet_rooms import WetRoomFixture, save_wet_room_fixtures

FLOOR, CEILING, SLAB = 0.0, 2800.0, 3100.0


def _with_void(sample_path: Path) -> Path:
    """Give the sample room a slab 300 mm above its finished ceiling, like a typical wet room."""
    model = ifcopenshell.open(str(sample_path))
    space = model.by_type("IfcSpace")[0]
    pset = ifcopenshell.api.run("pset.add_pset", model, product=space, name="Pset_HomeTwinRoom")
    ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties={"StructuralCeilingElevation": SLAB})
    model.write(str(sample_path))
    return sample_path


def _room_id(path: Path) -> str:
    return HomeTwin.open(path).get_rooms()[0].id


def _objects(path: Path, room_id: str):
    context = HomeTwin.open(path).get_room_context(room_id)
    return {obj.id: obj for obj in (*context.furniture, *context.obstructions)}


def _wet_room_set(room: str) -> tuple[WetRoomFixture, ...]:
    """A vanity run on the west wall, a turned cupboard in the corner, and an extract run to the north wall."""
    route = (Point3D(1000, 3000, CEILING + 100), Point3D(1000, 3000, CEILING + 150), Point3D(1000, 4000, CEILING + 150))
    return (
        WetRoomFixture(
            "VAN01", room, "vanity", Point3D(250, 2000, FLOOR), 900, 500, 850, rotation_deg=90, finish="walnut"
        ),
        WetRoomFixture("BSN01", room, "basin", Point3D(300, 2000, 850), 370, 370, 140, finish="grey_marble"),
        WetRoomFixture(
            "TAP01", room, "tap", Point3D(58, 2000, 850), 45, 170, 320, rotation_deg=90,
            product="GROHE Euroeco XL 24273001",
        ),
        WetRoomFixture(
            "MIR01", room, "mirror", Point3D(15, 2000, 1200), 700, 30, 700, rotation_deg=90, backlight_cct_kelvin=3000
        ),
        WetRoomFixture("LEDGE01", room, "ledge", Point3D(700, 50, FLOOR), 1400, 100, 1200, finish="grey_tile"),
        WetRoomFixture("CUP01", room, "tall_cupboard", Point3D(5400, 600, FLOOR), 600, 350, 2100, rotation_deg=45),
        WetRoomFixture("EF01", room, "extractor", Point3D(1000, 3000, CEILING - 25), 180, 180, 125, 15),
        WetRoomFixture("DUCT01", room, "duct", route[0], 100, 100, 100, route_mm=route, finish="flexible_white_pvc"),
        WetRoomFixture("EX01", room, "exhaust_terminal", Point3D(1000, 4000, CEILING + 87.5), 125, 100, 125),
    )


def test_wet_room_fixtures_survive_ifc_save_and_reload(sample_path) -> None:
    room = HomeTwin.open(sample_path).get_rooms()[0]
    fixtures = (
        WetRoomFixture("BATH01", room.id, "bath", Point3D(1500, 700, 0), 1600, 700, 550),
        WetRoomFixture("EF01", room.id, "extractor", Point3D(1500, 700, 2720), 180, 180, 80, 15),
    )

    ids = save_wet_room_fixtures(sample_path, fixtures)
    reopened = HomeTwin.open(sample_path)
    objects = {obj.id: obj for obj in reopened.get_room_context(room.id).furniture}

    assert objects[ids["BATH01"]].kind == ObjectKind.SANITARY_FIXTURE
    assert objects[ids["EF01"]].kind == ObjectKind.EXTRACTOR
    model = ifcopenshell.open(sample_path)
    fan = model.by_guid(ids["EF01"])
    assert fan.is_a("IfcFan")
    assert fan.Tag == "EF01"


def test_joinery_ducting_and_the_wall_core_reopen_as_their_ifc_classes(sample_path) -> None:
    room = _room_id(_with_void(sample_path))
    fixtures = _wet_room_set(room)

    ids = save_wet_room_fixtures(sample_path, fixtures)

    assert save_wet_room_fixtures(sample_path, fixtures) == ids, "re-running upserts by tag"
    model = ifcopenshell.open(str(sample_path))
    expected = {
        "VAN01": ("IfcFurniture", "USERDEFINED", "wet_room_vanity"),
        "BSN01": ("IfcSanitaryTerminal", "WASHHANDBASIN", None),
        "TAP01": ("IfcValve", "FAUCET", None),
        "MIR01": ("IfcFurniture", "USERDEFINED", "wet_room_mirror"),
        "LEDGE01": ("IfcBuildingElementProxy", "USERDEFINED", "wet_room_ledge"),
        "CUP01": ("IfcFurniture", "USERDEFINED", "wet_room_tall_cupboard"),
        "DUCT01": ("IfcDuctSegment", "FLEXIBLESEGMENT", None),
        "EX01": ("IfcAirTerminal", "GRILLE", None),
    }
    for tag, (ifc_class, predefined, object_type) in expected.items():
        product = model.by_guid(ids[tag])
        assert product.is_a(ifc_class), tag
        assert product.PredefinedType == predefined, tag
        assert product.ObjectType == object_type, tag
        assert product.ContainedInStructure[0].RelatingStructure.GlobalId == room

    objects = _objects(sample_path, room)
    kinds = {tag: objects[ids[tag]].kind for tag in ids}
    assert kinds["LEDGE01"] == kinds["CUP01"] == ObjectKind.CABINET
    assert kinds["BSN01"] == kinds["TAP01"] == ObjectKind.SANITARY_FIXTURE
    # A vanity is furniture, not a cabinet: a spotlight may sit over the bowl.
    assert kinds["VAN01"] == kinds["MIR01"] == ObjectKind.FURNITURE
    assert kinds["DUCT01"] == ObjectKind.DUCT
    assert kinds["EX01"] == kinds["EF01"] == ObjectKind.EXTRACTOR

    vanity = objects[ids["VAN01"]].bounds
    assert (vanity.minimum.x, vanity.maximum.x) == (0, 500), "a 90 degree turn puts the depth across x"
    assert (vanity.minimum.y, vanity.maximum.y) == (1550, 2450)
    mirror = objects[ids["MIR01"]].bounds
    assert (round(mirror.maximum.x - mirror.minimum.x), round(mirror.maximum.z - mirror.minimum.z)) == (30, 700)
    assert (round(mirror.minimum.z), round(mirror.maximum.z)) == (1200, 1900)
    assert objects[ids["MIR01"]].properties["Pset_HomeTwinWetRoom.BacklightCctKelvin"] == 3000
    tap = objects[ids["TAP01"]].properties
    assert tap["Pset_HomeTwinWetRoom.Product"] == "GROHE Euroeco XL 24273001"
    assert tap["Pset_HomeTwinWetRoom.RepresentationMethod"] == "design_envelope", "a product name is not a dimension"

    turned = objects[ids["CUP01"]]
    box_area = (turned.bounds.maximum.x - turned.bounds.minimum.x) * (turned.bounds.maximum.y - turned.bounds.minimum.y)
    assert turned.plan_footprint is not None
    assert abs(polygon_area(turned.plan_footprint) - 600 * 350) < 1, "the footprint is the true outline"
    assert polygon_area(turned.plan_footprint) < box_area * 0.6, "and not the axis-aligned box"

    duct = objects[ids["DUCT01"]]
    assert duct.bounds.minimum.z >= CEILING and duct.bounds.maximum.z <= SLAB
    assert duct.properties["Pset_HomeTwinWetRoom.RouteMm"] == "1000,3000,2900;1000,3000,2950;1000,4000,2950"
    core = objects[ids["EX01"]].bounds
    assert (core.minimum.y, core.maximum.y) == (4000, 4100), "the core runs from the wall face into the wall"
    fan = objects[ids["EF01"]].bounds
    assert fan.minimum.z < CEILING < fan.maximum.z, "the fan body straddles the gypsum"


def test_extractor_requires_a_design_airflow() -> None:
    with pytest.raises(ValueError, match="design airflow"):
        WetRoomFixture("EF01", "ROOM", "extractor", Point3D(0, 0, 0), 180, 180, 80)


def test_only_a_duct_has_a_route_and_only_a_mirror_a_backlight() -> None:
    with pytest.raises(ValueError, match="route"):
        WetRoomFixture("DUCT01", "ROOM", "duct", Point3D(0, 0, 0), 100, 100, 100)
    with pytest.raises(ValueError, match="route"):
        WetRoomFixture(
            "BSN01", "ROOM", "basin", Point3D(0, 0, 0), 370, 370, 140, route_mm=(Point3D(0, 0, 0), Point3D(1, 0, 0))
        )
    with pytest.raises(ValueError, match="first point"):
        WetRoomFixture(
            "DUCT01", "ROOM", "duct", Point3D(0, 0, 0), 100, 100, 100, route_mm=(Point3D(1, 0, 0), Point3D(2, 0, 0))
        )
    with pytest.raises(ValueError, match="backlight"):
        WetRoomFixture("BSN01", "ROOM", "basin", Point3D(0, 0, 0), 370, 370, 140, backlight_cct_kelvin=3000)
    with pytest.raises(ValueError, match="product"):
        WetRoomFixture("TAP01", "ROOM", "tap", Point3D(0, 0, 0), 45, 170, 320, product="  ")


def test_save_rejects_a_fixture_whose_footprint_crosses_the_room_boundary(sample_path) -> None:
    room = HomeTwin.open(sample_path).get_rooms()[0]
    fixture = WetRoomFixture("BATH01", room.id, "bath", Point3D(100, 700, 0), 1600, 700, 550)

    with pytest.raises(RuntimeError, match="footprint is outside"):
        save_wet_room_fixtures(sample_path, (fixture,))


def test_void_items_need_a_stated_slab_and_must_stay_in_the_void(sample_path) -> None:
    room = _room_id(sample_path)
    route = (Point3D(1000, 3000, CEILING + 100), Point3D(1000, 4000, CEILING + 100))
    duct = WetRoomFixture("DUCT01", room, "duct", route[0], 100, 100, 100, route_mm=route)

    with pytest.raises(RuntimeError, match="structural ceiling"):
        save_wet_room_fixtures(sample_path, (duct,))

    _with_void(sample_path)
    low = (Point3D(1000, 3000, CEILING - 200), Point3D(1000, 4000, CEILING - 200))
    with pytest.raises(RuntimeError, match="outside the void"):
        save_wet_room_fixtures(
            sample_path, (WetRoomFixture("DUCT01", room, "duct", low[0], 100, 100, 100, route_mm=low),)
        )
    with pytest.raises(RuntimeError, match="wall face"):
        save_wet_room_fixtures(
            sample_path,
            (WetRoomFixture("EX01", room, "exhaust_terminal", Point3D(1000, 3900, CEILING + 87.5), 125, 100, 125),),
        )


def test_joinery_may_not_collide_with_what_is_already_in_the_room(sample_path) -> None:
    room = _room_id(sample_path)
    over_the_table = WetRoomFixture("VAN01", room, "vanity", Point3D(3000, 2000, FLOOR), 900, 500, 850)

    with pytest.raises(RuntimeError, match="collides with Dining table"):
        save_wet_room_fixtures(sample_path, (over_the_table,))


def test_revised_wet_room_heights_and_shower_entry_survive_reload(sample_path) -> None:
    room = _room_id(sample_path)
    fixtures = (
        WetRoomFixture("BATH01", room, "bath", Point3D(1000, 500, 0), 1800, 800, 400),
        WetRoomFixture("LEDGE01", room, "ledge", Point3D(1000, 50, 0), 1800, 100, 800),
        WetRoomFixture("VAN01", room, "vanity", Point3D(250, 1800, 300), 900, 500, 550, rotation_deg=90),
        WetRoomFixture("CUP01", room, "tall_cupboard", Point3D(300, 2700, 200), 600, 500, 1900),
        WetRoomFixture("SH01", room, "shower", Point3D(4000, 3000, 0), 1500, 800, 2000),
    )
    ids = save_wet_room_fixtures(sample_path, fixtures)
    objects = _objects(sample_path, room)
    for tag, bottom, top in (("BATH01", 0, 400), ("LEDGE01", 0, 800), ("VAN01", 300, 850), ("CUP01", 200, 2100)):
        assert objects[ids[tag]].bounds.minimum.z == pytest.approx(bottom)
        assert objects[ids[tag]].bounds.maximum.z == pytest.approx(top)
    model = ifcopenshell.open(str(sample_path))
    shower = model.by_guid(ids["SH01"])
    solids = shower.Representation.Representations[0].Items
    # Both panes span half the 1500 mm entrance, with 12 mm sliding-track separation.
    first, second = solids[1:3]
    assert first.Depth == pytest.approx(1930)
    assert second.Position.Location.Coordinates[1] - first.Position.Location.Coordinates[1] == pytest.approx(12)
    assert objects[ids["SH01"]].bounds.maximum.z == pytest.approx(2000)


def test_back_to_wall_toilet_models_floor_standing_pan_cistern_seat_and_button(sample_path) -> None:
    room = _room_id(sample_path)
    toilet = WetRoomFixture("WC01", room, "toilet", Point3D(1000, 500, 0), 380, 700, 760, rotation_deg=180)
    ids = save_wet_room_fixtures(sample_path, (toilet,))
    objects = _objects(sample_path, room)
    wc = objects[ids["WC01"]]
    assert wc.bounds.minimum.z == pytest.approx(0)
    assert wc.bounds.maximum.z == pytest.approx(764), "760 mm cistern + 4 mm dual-flush button"
    model = ifcopenshell.open(str(sample_path))
    product = model.by_guid(ids["WC01"])
    solids = product.Representation.Representations[0].Items
    assert len(solids) == 5, "pan rear, pan bowl, seat/lid, cistern, dual-flush button"


def test_a_wet_room_tag_that_another_room_already_uses_is_refused(sample_path) -> None:
    """The check that saved the bathroom's mirror is wired into this save too.

    A tag is an installation label. Authoring matches on it and reuses what it
    finds, so a tag another room already holds does not add a fitting - it takes
    that room's fitting away, and nothing reports it.
    """
    model = ifcopenshell.open(sample_path)
    room = model.by_type("IfcSpace")[0].GlobalId
    storey = model.by_type("IfcBuildingStorey")[0]
    stranger = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcFurniture", name="Bedroom mirror")
    stranger.Tag = "MIR01"
    ifcopenshell.api.run("spatial.assign_container", model, products=[stranger], relating_structure=storey)
    model.write(str(sample_path))

    mirror = WetRoomFixture("MIR01", room, "mirror", Point3D(1000, 900, 2050), 600, 30, 800)

    before = sample_path.read_bytes()
    with pytest.raises(RuntimeError, match="already labels"):
        save_wet_room_fixtures(sample_path, (mirror,))
    assert sample_path.read_bytes() == before, "a refused save must leave the model untouched"


def test_a_gully_is_recessed_into_the_floor_and_read_back_as_a_sanitary_fixture(sample_path) -> None:
    """A drain sits below the finished level, which is not a fault to reject.

    Judging one against the room's floor rejects every correct gully, and
    falling through to the wall-core geometry stands it 120 mm proud of the
    paving instead of flush in it.
    """
    model = ifcopenshell.open(sample_path)
    room = model.by_type("IfcSpace")[0].GlobalId
    floor = HomeTwin.open(sample_path).get_rooms()[0].elevation_mm

    gully = WetRoomFixture("GUL01", room, "gully", Point3D(1000, 900, floor - 40), 200, 200, 40)
    ids = save_wet_room_fixtures(sample_path, (gully,))

    twin = HomeTwin.open(sample_path)
    context = twin.get_room_context(room)
    saved = next(o for o in (*context.obstructions, *context.furniture) if o.id == ids["GUL01"])
    assert saved.kind is ObjectKind.SANITARY_FIXTURE
    assert saved.bounds.maximum.z == pytest.approx(floor), "the grate must finish flush with the paving"
    assert saved.bounds.minimum.z == pytest.approx(floor - 40), "and its body must sit below it"

    standing = WetRoomFixture("GUL02", room, "gully", Point3D(1500, 900, floor + 10), 200, 200, 40)
    with pytest.raises(RuntimeError, match="must not stand above the floor"):
        save_wet_room_fixtures(sample_path, (gully, standing))
