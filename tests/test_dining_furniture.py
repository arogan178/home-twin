from dataclasses import replace

import ifcopenshell
import ifcopenshell.util.unit
import pytest

from home_twin.furniture import DiningFurniture, save_dining_furniture
from home_twin.model import HomeTwin, Point3D


def test_dining_set_roundtrip_preserves_ids_and_real_solids(sample_path):
    twin = HomeTwin.open(sample_path)
    room = next(r for r in twin.get_rooms() if r.name == "Open plan")
    items = (
        DiningFurniture("DT01", "table", Point3D(3000, 2000, 0), 1400, 800, 750),
        DiningFurniture("DC01", "chair", Point3D(2000, 2000, 0), 500, 500, 800, "east"),
        DiningFurniture("DC02", "chair", Point3D(4000, 2000, 0), 500, 500, 800, "west"),
        DiningFurniture("DC03", "chair", Point3D(3000, 1100, 0), 500, 500, 800),
        DiningFurniture("DC04", "chair", Point3D(3000, 3000, 0), 500, 500, 800, "south"),
    )
    ids = save_dining_furniture(sample_path, room.id, items)
    assert len(ids) == 5
    assert save_dining_furniture(sample_path, room.id, items) == ids
    reopened = ifcopenshell.open(str(sample_path))
    for item in items:
        product = reopened.by_guid(ids[item.tag])
        assert product.PredefinedType == item.role.upper()
        assert len(product.Representation.Representations[0].Items) >= 5
        assert product.ContainedInStructure[0].RelatingStructure.GlobalId == room.id
    furniture = {f.id: f for f in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert furniture[ids["DC02"]].properties["Pset_HomeTwinFurniture.Facing"] == "west"


def test_invalid_furniture_keeps_ifc_unchanged(sample_path):
    room = next(r for r in HomeTwin.open(sample_path).get_rooms() if r.name == "Open plan")
    before = sample_path.read_bytes()
    item = DiningFurniture("DT01", "table", Point3D(-5000, -5000, 0), 1400, 800, 750)
    with pytest.raises(ValueError, match="outside"):
        save_dining_furniture(sample_path, room.id, (item,))
    assert sample_path.read_bytes() == before
    with pytest.raises(ValueError, match="floor"):
        save_dining_furniture(sample_path, room.id, (replace(item, centre_mm=Point3D(3000, 2000, 100)),))
    assert sample_path.read_bytes() == before


def test_furniture_resolves_building_placement(sample_path):
    import ifcopenshell.api
    import numpy as np

    model = ifcopenshell.open(str(sample_path))
    building = model.by_type("IfcBuilding")[0]
    matrix = np.array([[0.0, -1.0, 0.0, 12.0], [1.0, 0.0, 0.0, -7.0], [0.0, 0.0, 1.0, 2.0], [0.0, 0.0, 0.0, 1.0]])
    ifcopenshell.api.run(
        "geometry.edit_object_placement",
        model,
        product=building,
        matrix=matrix,
        is_si=True,
    )
    model.by_type("IfcSpace")[0].ObjectPlacement.PlacementRelTo = building.ObjectPlacement
    model.write(str(sample_path))
    room = HomeTwin.open(sample_path).get_rooms()[0]
    item = DiningFurniture("DT01", "table", Point3D(3000, 2000, 0), 1400, 800, 750)
    ids = save_dining_furniture(sample_path, room.id, (item,))
    table = next(f for f in HomeTwin.open(sample_path).get_furniture(room.id) if f.id == ids["DT01"])
    assert table.bounds.minimum.x == pytest.approx(9600)
    assert table.bounds.minimum.y == pytest.approx(-4700)


def test_failed_replace_keeps_previous_ifc(sample_path, monkeypatch):
    import home_twin.furniture as furniture

    room = HomeTwin.open(sample_path).get_rooms()[0]
    before = sample_path.read_bytes()
    item = DiningFurniture("DT01", "table", Point3D(3000, 2000, 0), 1400, 800, 750)

    def fail_replace(*args):
        raise OSError("injected replace failure")

    monkeypatch.setattr(furniture.os, "replace", fail_replace)
    with pytest.raises(OSError, match="replace failure"):
        save_dining_furniture(sample_path, room.id, (item,))
    assert sample_path.read_bytes() == before


def test_round_table_native_profile_and_extension_survive(sample_path):
    room = HomeTwin.open(sample_path).get_rooms()[0]
    item = DiningFurniture(
        "DT01", "table", Point3D(3000, 2000, 0), 1100, 1100, 750, shape="round", extended_depth_mm=1550
    )
    ids = save_dining_furniture(sample_path, room.id, (item,))
    model = ifcopenshell.open(str(sample_path))
    table = model.by_guid(ids["DT01"])
    profile = table.Representation.Representations[0].Items[0].SweptArea
    assert profile.is_a("IfcCircleProfileDef")
    result = next(f for f in HomeTwin.open(sample_path).get_furniture(room.id) if f.id == table.GlobalId)
    assert result.properties["Pset_HomeTwinFurniture.Shape"] == "round"
    assert float(result.properties["Pset_HomeTwinFurniture.ExtendedDepthMm"]) == 1550
    assert save_dining_furniture(sample_path, room.id, (item,)) == ids


def test_storage_native_save_reload_and_stable_identity(sample_path):
    from home_twin.furniture import StorageFurniture, author_storage_furniture

    room = HomeTwin.open(sample_path).get_rooms()[0]
    model = ifcopenshell.open(str(sample_path))
    items = (
        StorageFurniture("TVU01", "media_unit", Point3D(3000, 2000, 230), 2000, 350, 320),
        StorageFurniture("BAR01", "drinks_unit", Point3D(4700, 2000, 0), 700, 400, 1200),
    )
    ids = author_storage_furniture(model, room.id, items)
    model.write(str(sample_path))
    reopened = ifcopenshell.open(str(sample_path))
    assert author_storage_furniture(reopened, room.id, items) == ids
    for item in items:
        product = reopened.by_guid(ids[item.tag])
        assert product.PredefinedType == "USERDEFINED"
        assert product.ObjectType == item.role
        assert product.ContainedInStructure[0].RelatingStructure.GlobalId == room.id
    objects = {f.id: f for f in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert objects[ids["TVU01"]].bounds.minimum.z == pytest.approx(230)
    assert objects[ids["BAR01"]].bounds.maximum.z == pytest.approx(1200)


def test_a_stool_is_the_chair_model_at_counter_height(sample_path):
    room = next(r for r in HomeTwin.open(sample_path).get_rooms() if r.name == "Open plan")
    chair = DiningFurniture("DC01", "chair", Point3D(2000, 2000, 0), 500, 500, 800, "east")
    stool = DiningFurniture("BS01", "stool", Point3D(4000, 2000, 0), 400, 400, 1000, "east")
    ids = save_dining_furniture(sample_path, room.id, (chair, stool))

    reopened = ifcopenshell.open(str(sample_path))
    product = reopened.by_guid(ids["BS01"])
    # IfcFurnitureType has no STOOL; the role carries the distinction.
    assert product.PredefinedType == "CHAIR"
    assert product.Name == "Breakfast bar stool BS01"

    def seat_top(tag: str) -> float:
        pad = reopened.by_guid(ids[tag]).Representation.Representations[0].Items[0]
        return pad.Position.Location.Coordinates[2] + pad.Depth

    assert seat_top("BS01") == pytest.approx(645)
    assert seat_top("DC01") == pytest.approx(465)

    furniture = {obj.id: obj for obj in HomeTwin.open(sample_path).get_furniture(room.id)}
    assert furniture[ids["BS01"]].properties["Pset_HomeTwinFurniture.Role"] == "stool"
    bounds = furniture[ids["BS01"]].bounds
    assert bounds.maximum.z - bounds.minimum.z == pytest.approx(1000)


def test_an_unknown_seat_role_is_rejected():
    with pytest.raises(ValueError, match="table/chair/stool"):
        DiningFurniture("BS01", "bench", Point3D(0, 0, 0), 400, 400, 1000)


def test_oval_table_on_a_free_bearing_survives_save_and_reload(sample_path):
    room = HomeTwin.open(sample_path).get_rooms()[0]
    item = DiningFurniture(
        "DT01",
        "table",
        Point3D(3000, 2000, 0),
        1200,
        2000,
        750,
        shape="oval",
        closed_depth_mm=1200,
        bearing_deg=138,
    )
    ids = save_dining_furniture(sample_path, room.id, (item,))
    model = ifcopenshell.open(str(sample_path))
    table = model.by_guid(ids["DT01"])
    profiles = {i.SweptArea.is_a() for i in table.Representation.Representations[0].Items}
    assert "IfcCircleProfileDef" in profiles and "IfcRectangleProfileDef" in profiles
    result = next(f for f in HomeTwin.open(sample_path).get_furniture(room.id) if f.id == table.GlobalId)
    assert result.properties["Pset_HomeTwinFurniture.Shape"] == "oval"
    assert float(result.properties["Pset_HomeTwinFurniture.BearingDeg"]) == 138
    assert float(result.properties["Pset_HomeTwinFurniture.ClosedDepthMm"]) == 1200
    # A bearing replaces facing outright, so no stale cardinal is left to mislead.
    assert "Pset_HomeTwinFurniture.Facing" not in result.properties
    # A stadium turned 138 deg spans its length along that axis and its width across,
    # so neither world extent is the raw 1200 or 2000.
    a, b = result.bounds.minimum, result.bounds.maximum
    assert (b.x - a.x) == pytest.approx(1794, abs=3)
    assert (b.y - a.y) == pytest.approx(1735, abs=3)
    assert (b.z - a.z) == pytest.approx(750, abs=0.5)
    assert save_dining_furniture(sample_path, room.id, (item,)) == ids


def test_a_bearing_and_a_cardinal_facing_agree(sample_path):
    room = HomeTwin.open(sample_path).get_rooms()[0]
    cardinal = DiningFurniture("DC01", "chair", Point3D(3000, 2000, 0), 500, 600, 800, "east")
    ids = save_dining_furniture(sample_path, room.id, (cardinal,))
    by_facing = next(f for f in HomeTwin.open(sample_path).get_furniture(room.id) if f.id == ids["DC01"]).bounds
    ids = save_dining_furniture(sample_path, room.id, (replace(cardinal, facing="north", bearing_deg=0),))
    by_bearing = next(f for f in HomeTwin.open(sample_path).get_furniture(room.id) if f.id == ids["DC01"]).bounds
    for axis in ("x", "y", "z"):
        assert getattr(by_bearing.minimum, axis) == pytest.approx(getattr(by_facing.minimum, axis), abs=0.5)
        assert getattr(by_bearing.maximum, axis) == pytest.approx(getattr(by_facing.maximum, axis), abs=0.5)


def test_contradictory_or_degenerate_shapes_are_rejected():
    with pytest.raises(ValueError, match="leave facing at its default"):
        DiningFurniture("DT01", "table", Point3D(0, 0, 0), 1200, 2000, 750, "east", bearing_deg=138)
    with pytest.raises(ValueError, match="long axis along depth"):
        DiningFurniture("DT01", "table", Point3D(0, 0, 0), 2000, 1200, 750, shape="oval")
    with pytest.raises(ValueError, match="shorter than the table as drawn"):
        DiningFurniture("DT01", "table", Point3D(0, 0, 0), 1200, 2000, 750, shape="oval", closed_depth_mm=2400)
    with pytest.raises(ValueError, match="shorter than the table as drawn"):
        DiningFurniture(
            "DT01", "table", Point3D(0, 0, 0), 1200, 2000, 750, shape="oval",
            closed_depth_mm=1200, extended_depth_mm=2400,
        )


def test_a_table_you_sit_round_stands_on_a_pedestal(sample_path):
    """A corner post stands where a chair tucks, so a round or oval table has none."""
    room = HomeTwin.open(sample_path).get_rooms()[0]
    oval = DiningFurniture(
        "DT01", "table", Point3D(3000, 2000, 0), 1200, 2000, 750, shape="oval", bearing_deg=90
    )
    ids = save_dining_furniture(sample_path, room.id, (oval,))
    model = ifcopenshell.open(str(sample_path))
    items = model.by_guid(ids["DT01"]).Representation.Representations[0].Items
    # Top slab, two end discs, then a foot and a column at each spine end.
    assert len(items) == 7
    top_z = max(item.Position.Location.Coordinates[2] for item in items)
    supports = [
        item
        for item in items
        if item.SweptArea.is_a("IfcCircleProfileDef") and item.Position.Location.Coordinates[2] < top_z
    ]
    assert len(supports) == 4
    scale = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    reach = max(abs(item.Position.Location.Coordinates[1]) + item.SweptArea.Radius for item in supports) * scale
    # Every support stays clear of the 250 mm a pushed-in chair needs under the top.
    assert reach < (2000 / 2 - 250)

    round_table = DiningFurniture("DT02", "table", Point3D(3000, 2000, 0), 1200, 1200, 750, shape="round")
    ids = save_dining_furniture(sample_path, room.id, (round_table,))
    model = ifcopenshell.open(str(sample_path))
    items = model.by_guid(ids["DT02"]).Representation.Representations[0].Items
    # A round table collapses to a single central pedestal: top, foot, column.
    assert len(items) == 3
