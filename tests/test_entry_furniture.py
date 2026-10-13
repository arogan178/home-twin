import ifcopenshell
import pytest

from home_twin.entry_furniture import ShoeBench, author_shoe_bench
from home_twin.model import HomeTwin, Point3D


def test_shoe_bench_native_roundtrip(sample_path):
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    model = ifcopenshell.open(str(sample_path))
    bench = ShoeBench("BEN01", Point3D(3000, 2000, 0))
    guid = author_shoe_bench(model, room.id, bench)
    model.write(str(sample_path))
    reopened = ifcopenshell.open(str(sample_path))
    entity = reopened.by_guid(guid)
    assert entity.PredefinedType == "USERDEFINED"
    assert entity.ObjectType == "shoe_bench"
    assert len(entity.Representation.Representations[0].Items) == 4
    assert entity.ContainedInStructure[0].RelatingStructure.GlobalId == room.id
    obj = next(o for o in HomeTwin.open(sample_path).get_furniture(room.id) if o.id == guid)
    assert obj.properties["Pset_HomeTwinFurniture.Role"] == "shoe_bench"
    assert obj.bounds.minimum.x == pytest.approx(2710)
    assert obj.bounds.maximum.x == pytest.approx(3290)
    assert obj.bounds.maximum.z == pytest.approx(450)
    assert author_shoe_bench(reopened, room.id, bench) == guid


def test_shoe_bench_rejects_invalid_dimensions():
    with pytest.raises(ValueError):
        ShoeBench("BEN01", Point3D(0, 0, 0), width_mm=-10)


def test_vented_shoe_cabinet_roundtrips_its_shape_and_pose(sample_path):
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    model = ifcopenshell.open(str(sample_path))
    bench = ShoeBench(
        "BEN02",
        Point3D(3000, 2000, 1050),
        rotation_deg=37,
        finish="vented_marine_aluminium",
        vented=True,
    )

    guid = author_shoe_bench(model, room.id, bench)
    model.write(str(sample_path))
    reopened = HomeTwin.open(sample_path)
    obj = next(o for o in reopened.get_furniture(room.id) if o.id == guid)

    assert obj.properties["Pset_HomeTwinFurniture.Vented"] is True
    assert obj.properties["Pset_HomeTwinFurniture.WidthMm"] == pytest.approx(580)
    assert obj.properties["Pset_HomeTwinFurniture.DepthMm"] == pytest.approx(380)
    assert obj.properties["Pset_HomeTwinFurniture.CentreXMm"] == pytest.approx(3000)
    assert obj.properties["Pset_HomeTwinFurniture.RotationDegrees"] == pytest.approx(37)
    assert obj.bounds.minimum.z == pytest.approx(1050)
    assert obj.bounds.maximum.z == pytest.approx(1500)
    entity = ifcopenshell.open(str(sample_path)).by_guid(guid)
    assert len(entity.Representation.Representations[0].Items) > 4
