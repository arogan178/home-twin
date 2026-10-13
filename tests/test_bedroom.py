from __future__ import annotations

import ifcopenshell
import pytest

from home_twin.bedroom import BedroomFurniture, WardrobeBay, save_bedroom_furniture
from home_twin.geometry import polygon_area
from home_twin.model import HomeTwin, ObjectKind, Point2D, Point3D

FLOOR, CEILING = 0.0, 2800.0
# The sample room is 6 m by 4 m with kitchen joinery along y 3400-4000 and a
# dining table at x 2100-3900, so the bedroom set is laid out clear of both.
TAPERED_OUTLINE = (
    Point2D(4700, 200),
    Point2D(5300, 200),
    Point2D(5300, 2600),
    Point2D(4700, 2300),
)


def _room_id(path) -> str:
    return HomeTwin.open(path).get_rooms()[0].id


def _objects(path, room_id: str) -> dict[str, object]:
    context = HomeTwin.open(path).get_room_context(room_id)
    return {obj.id: obj for obj in (*context.furniture, *context.obstructions)}


def _bed(room: str) -> BedroomFurniture:
    return BedroomFurniture("BD01", room, "bed", Point3D(750, 1000, FLOOR), 1400, 2000, 1100, rotation_deg=180)


def _wardrobe(room: str) -> BedroomFurniture:
    return BedroomFurniture(
        "WR01",
        room,
        "wardrobe",
        Point3D(5000, 1400, FLOOR),
        600,
        2400,
        2200,
        finish="walnut_veneer",
        outline_mm=TAPERED_OUTLINE,
    )


def test_bedroom_furniture_survives_ifc_save_and_reload(sample_path) -> None:
    room = _room_id(sample_path)
    items = (_bed(room), _wardrobe(room))

    ids = save_bedroom_furniture(sample_path, items)
    objects = _objects(sample_path, room)

    assert objects[ids["BD01"]].kind == ObjectKind.FURNITURE
    assert objects[ids["WR01"]].kind == ObjectKind.CABINET, "a wardrobe is joinery a downlight must clear"
    model = ifcopenshell.open(sample_path)
    bed = model.by_guid(ids["BD01"])
    assert (bed.is_a(), bed.PredefinedType, bed.Tag) == ("IfcFurniture", "BED", "BD01")
    assert model.by_guid(ids["WR01"]).ObjectType == "bedroom_wardrobe", "IFC4 names no wardrobe type"


def test_a_scribed_wardrobe_reopens_with_its_taper(sample_path) -> None:
    room = _room_id(sample_path)

    ids = save_bedroom_furniture(sample_path, (_wardrobe(room),))
    saved = _objects(sample_path, room)[ids["WR01"]]

    assert polygon_area(saved.plan_footprint) == pytest.approx(600 * (2400 + 2100) / 2, rel=1e-3)
    assert saved.bounds.maximum.y - saved.bounds.minimum.y == pytest.approx(2400), "the envelope is still the box"
    assert (saved.bounds.minimum.z, saved.bounds.maximum.z) == (FLOOR, FLOOR + 2200)


def test_a_re_run_replaces_the_piece_it_already_authored(sample_path) -> None:
    room = _room_id(sample_path)
    first = save_bedroom_furniture(sample_path, (_bed(room),))

    second = save_bedroom_furniture(sample_path, (_bed(room),))

    assert first == second
    beds = [item for item in ifcopenshell.open(sample_path).by_type("IfcFurniture") if item.Tag == "BD01"]
    assert len(beds) == 1, "a re-run upserts by tag rather than stacking a second bed on the first"


def test_the_bed_stands_on_its_rug_rather_than_colliding_with_it(sample_path) -> None:
    room = _room_id(sample_path)
    rug = BedroomFurniture("RG01", room, "rug", Point3D(750, 1000, FLOOR), 1400, 2000, 12)

    ids = save_bedroom_furniture(sample_path, (_bed(room), rug))

    objects = _objects(sample_path, room)
    assert objects[ids["RG01"]].bounds.maximum.z == pytest.approx(FLOOR + 12)


def test_furniture_that_collides_with_the_room_s_own_joinery_is_rejected(sample_path) -> None:
    room = _room_id(sample_path)
    # The sample's tall kitchen run stands at x 1500-4500, y 3400-4000, floor to 2200.
    clash = BedroomFurniture("BT01", room, "bedside_table", Point3D(3000, 3600, 400), 400, 320, 180, wall_mounted=True)

    with pytest.raises(RuntimeError, match="collides"):
        save_bedroom_furniture(sample_path, (clash,))


def test_furniture_outside_the_room_is_rejected(sample_path) -> None:
    room = _room_id(sample_path)
    outside = BedroomFurniture("BD01", room, "bed", Point3D(5800, 1000, FLOOR), 1400, 2000, 1100)

    with pytest.raises(RuntimeError, match="outside its room"):
        save_bedroom_furniture(sample_path, (outside,))


def test_joinery_taller_than_the_room_is_rejected(sample_path) -> None:
    room = _room_id(sample_path)
    too_tall = BedroomFurniture(
        "WR01", room, "wardrobe", Point3D(5000, 1400, FLOOR), 600, 2400, CEILING + 100, outline_mm=TAPERED_OUTLINE
    )

    with pytest.raises(RuntimeError, match="vertical extent"):
        save_bedroom_furniture(sample_path, (too_tall,))


def test_a_floating_unit_that_reaches_the_floor_is_rejected(sample_path) -> None:
    room = _room_id(sample_path)
    grounded = BedroomFurniture(
        "BT01", room, "bedside_table", Point3D(1700, 160, FLOOR), 400, 320, 180, wall_mounted=True
    )

    with pytest.raises(RuntimeError, match="wall-mounted"):
        save_bedroom_furniture(sample_path, (grounded,))


def test_a_floating_bedside_table_keeps_the_floor_under_it_clear(sample_path) -> None:
    room = _room_id(sample_path)
    floating = BedroomFurniture(
        "BT01", room, "bedside_table", Point3D(1700, 160, 400), 400, 320, 180, rotation_deg=180, wall_mounted=True
    )

    ids = save_bedroom_furniture(sample_path, (floating,))

    saved = _objects(sample_path, room)[ids["BT01"]]
    assert saved.bounds.minimum.z == pytest.approx(400)
    assert saved.properties["Pset_HomeTwinBedroom.WallMounted"] is True


def test_an_outline_must_agree_with_the_envelope_it_states() -> None:
    with pytest.raises(ValueError, match="bounding box"):
        BedroomFurniture(
            "WR01", "ROOM", "wardrobe", Point3D(5000, 1400, 0), 900, 2400, 2200, outline_mm=TAPERED_OUTLINE
        )
    with pytest.raises(ValueError, match="cannot also be rotated"):
        BedroomFurniture(
            "WR01", "ROOM", "wardrobe", Point3D(5000, 1400, 0), 600, 2400, 2200, 90, outline_mm=TAPERED_OUTLINE
        )


def test_a_role_that_is_not_scribed_to_a_wall_takes_no_outline() -> None:
    with pytest.raises(ValueError, match="outline"):
        BedroomFurniture("RG01", "ROOM", "rug", Point3D(750, 1000, 0), 1400, 2000, 12, outline_mm=TAPERED_OUTLINE)
    with pytest.raises(ValueError, match="outline"):
        BedroomFurniture("WR01", "ROOM", "wardrobe", Point3D(750, 1000, 0), 1400, 2000, 2200)


def test_a_stool_is_round_and_a_bed_is_longer_than_its_own_headboard() -> None:
    with pytest.raises(ValueError, match="round"):
        BedroomFurniture("ST01", "ROOM", "stool", Point3D(0, 0, 0), 420, 500, 460)
    with pytest.raises(ValueError, match="headboard"):
        BedroomFurniture("BD01", "ROOM", "bed", Point3D(0, 0, 0), 1400, 300, 1100)


def test_a_wardrobe_that_states_its_fit_out_is_drawn_open(sample_path) -> None:
    room = _room_id(sample_path)
    fitted = BedroomFurniture(
        "WR01",
        room,
        "wardrobe",
        Point3D(5000, 1400, FLOOR),
        600,
        2400,
        2200,
        outline_mm=TAPERED_OUTLINE,
        shelf_heights_mm=(1570, 2110, 2180),
        rail_heights_mm=(1470,),
        front_bearing_deg=180,
    )

    ids = save_bedroom_furniture(sample_path, (fitted,))

    saved = _objects(sample_path, room)[ids["WR01"]]
    assert saved.properties["Pset_HomeTwinBedroom.RailHeightsMm"] == "1470"
    assert saved.properties["Pset_HomeTwinBedroom.ShelfHeightsMm"] == "1570;2110;2180"
    # Three carcass boards for a four-sided outline with its doors off, a base,
    # three shelves and the rail. A closed run is one solid.
    items = ifcopenshell.open(sample_path).by_guid(ids["WR01"]).Representation.Representations[0].Items
    assert len(items) == 8
    assert sum(1 for item in items if item.SweptArea.is_a("IfcCircleProfileDef")) == 1, "the rail is round"
    assert saved.bounds.maximum.z == pytest.approx(FLOOR + 2200), "the sides still run full height"


def test_a_closed_run_still_reopens_on_its_outline(sample_path) -> None:
    room = _room_id(sample_path)

    ids = save_bedroom_furniture(sample_path, (_wardrobe(room),))

    saved = _objects(sample_path, room)[ids["WR01"]]
    assert saved.bounds.minimum.x == pytest.approx(4700), "no fit-out means the envelope, not the boards"
    assert saved.properties.get("Pset_HomeTwinBedroom.ShelfHeightsMm") is None
    items = ifcopenshell.open(sample_path).by_guid(ids["WR01"]).Representation.Representations[0].Items
    assert len(items) == 1


def test_an_open_run_must_say_which_way_its_doors_face() -> None:
    with pytest.raises(ValueError, match="doors face"):
        BedroomFurniture(
            "WR01", "ROOM", "wardrobe", Point3D(5000, 1400, 0), 600, 2400, 2200,
            outline_mm=TAPERED_OUTLINE, shelf_heights_mm=(1000,),
        )
    with pytest.raises(ValueError, match="no open face"):
        BedroomFurniture(
            "WR01", "ROOM", "wardrobe", Point3D(5000, 1400, 0), 600, 2400, 2200,
            outline_mm=TAPERED_OUTLINE, front_bearing_deg=180,
        )


def test_a_shelf_outside_its_own_unit_is_rejected() -> None:
    with pytest.raises(ValueError, match="inside the unit"):
        BedroomFurniture(
            "WR01", "ROOM", "wardrobe", Point3D(5000, 1400, 0), 600, 2400, 2200,
            outline_mm=TAPERED_OUTLINE, shelf_heights_mm=(2400,), front_bearing_deg=180,
        )
    with pytest.raises(ValueError, match="only a wardrobe|Only a wardrobe"):
        BedroomFurniture("RG01", "ROOM", "rug", Point3D(750, 1000, 0), 1400, 2000, 12, shelf_heights_mm=(6,))


def test_each_bay_gets_its_own_boards_within_its_slice_of_the_run(sample_path) -> None:
    room = _room_id(sample_path)
    run = BedroomFurniture(
        "WR01",
        room,
        "wardrobe",
        Point3D(5000, 1400, FLOOR),
        600,
        2400,
        2200,
        outline_mm=TAPERED_OUTLINE,
        front_bearing_deg=180,
        plinth_height_mm=80,
        bays=(
            WardrobeBay(0, 1200, rail_heights_mm=(1450,), role="long_hang"),
            WardrobeBay(1200, 1200, shelf_heights_mm=(600, 1200), drawer_heights_mm=(200,), role="shoes"),
        ),
    )

    ids = save_bedroom_furniture(sample_path, (run,))

    saved = _objects(sample_path, room)[ids["WR01"]]
    # The fit-out travels with the bay: the browser draws the run from this, and
    # a role and a width alone leave it no choice but one solid extrusion.
    assert saved.properties["Pset_HomeTwinBedroom.Bays"] == (
        "long_hang@0+1200|r=1450;shoes@1200+1200|s=600,1200|d=200"
    )
    assert saved.properties["Pset_HomeTwinBedroom.PlinthHeightMm"] == 80
    items = ifcopenshell.open(sample_path).by_guid(ids["WR01"]).Representation.Representations[0].Items
    # Plinth, three carcass boards, base, a divider, one rail, two shelves, and a
    # drawer's division and its front.
    assert len(items) == 11
    assert sum(1 for item in items if item.SweptArea.is_a("IfcCircleProfileDef")) == 1


def test_a_rail_keeps_the_parent_run_axis_when_a_bay_is_nearly_square(sample_path) -> None:
    room = _room_id(sample_path)
    run = BedroomFurniture(
        "WR01",
        room,
        "wardrobe",
        Point3D(5000, 1400, FLOOR),
        600,
        2400,
        2200,
        outline_mm=TAPERED_OUTLINE,
        front_bearing_deg=180,
        bays=(WardrobeBay(0, 500, rail_heights_mm=(1450,), role="long_hang"),),
    )

    ids = save_bedroom_furniture(sample_path, (run,))

    items = ifcopenshell.open(sample_path).by_guid(ids["WR01"]).Representation.Representations[0].Items
    rails = [item for item in items if item.SweptArea.is_a("IfcCircleProfileDef")]
    assert len(rails) == 1
    assert rails[0].Position.Axis.DirectionRatios == pytest.approx((0.0, 1.0, 0.0))


def test_a_bay_outside_the_run_is_rejected(sample_path) -> None:
    room = _room_id(sample_path)
    run = BedroomFurniture(
        "WR01", room, "wardrobe", Point3D(5000, 1400, FLOOR), 600, 2400, 2200,
        outline_mm=TAPERED_OUTLINE, front_bearing_deg=180,
        bays=(WardrobeBay(2600, 400, shelf_heights_mm=(600,)),),
    )

    with pytest.raises(ValueError, match="outside the run"):
        save_bedroom_furniture(sample_path, (run,))


def test_bays_cannot_overlap_or_state_a_second_fit_out() -> None:
    with pytest.raises(ValueError, match="cannot overlap"):
        BedroomFurniture(
            "WR01", "ROOM", "wardrobe", Point3D(5000, 1400, 0), 600, 2400, 2200,
            outline_mm=TAPERED_OUTLINE, front_bearing_deg=180,
            bays=(WardrobeBay(0, 1300, shelf_heights_mm=(600,)), WardrobeBay(1200, 1200, shelf_heights_mm=(600,))),
        )
    with pytest.raises(ValueError, match="not both"):
        BedroomFurniture(
            "WR01", "ROOM", "wardrobe", Point3D(5000, 1400, 0), 600, 2400, 2200,
            outline_mm=TAPERED_OUTLINE, front_bearing_deg=180, shelf_heights_mm=(600,),
            bays=(WardrobeBay(0, 1200, shelf_heights_mm=(600,)),),
        )


# A run 2400 long whose back slopes 100 mm, so a rail taken from each bay's own
# outline lands at a different depth in each as well as stopping short of the joint.
SLOPING_RUN = (Point2D(200, 200), Point2D(2600, 200), Point2D(2600, 900), Point2D(200, 800))


def test_a_rail_runs_unbroken_across_the_bays_that_share_it(sample_path) -> None:
    room = _room_id(sample_path)
    run = BedroomFurniture(
        "WR02",
        room,
        "wardrobe",
        Point3D(1400, 550, FLOOR),
        2400,
        700,
        2200,
        outline_mm=SLOPING_RUN,
        front_bearing_deg=270,
        bays=(
            WardrobeBay(0, 1200, rail_heights_mm=(1450,), role="hang"),
            # No front of its own: it is reached by sliding along the rail, which
            # only works if the rail is one line.
            WardrobeBay(1200, 1200, rail_heights_mm=(1450,), divider_height_mm=700, role="corner"),
        ),
    )

    ids = save_bedroom_furniture(sample_path, (run,))

    model = ifcopenshell.open(sample_path)
    entity = model.by_guid(ids["WR02"])
    origin = entity.ObjectPlacement.RelativePlacement.Location.Coordinates
    rails = []
    for item in entity.Representation.Representations[0].Items:
        if not item.SweptArea.is_a("IfcCircleProfileDef"):
            continue
        local = item.Position.Location.Coordinates
        axis = item.Position.Axis.DirectionRatios
        start = origin[0] + local[0]
        rails.append((start, start + axis[0] * item.Depth, origin[1] + local[1], origin[2] + local[2]))
    rails.sort()

    assert len(rails) == 2
    first, second = rails
    assert second[0] == pytest.approx(first[1]), "the segments must meet, not leave a gap at the bay joint"
    assert second[2] == pytest.approx(first[2]), "and meet at one depth, whatever the back behind them does"
    assert second[3] == pytest.approx(first[3])
    assert second[1] - first[0] == pytest.approx(2400 - 2 * 18), "one rail, the run's length less its end boards"


def test_a_piece_taken_out_of_the_design_is_taken_out_of_the_model(sample_path) -> None:
    room = _room_id(sample_path)
    rug = BedroomFurniture("RG01", room, "rug", Point3D(750, 1000, FLOOR), 1400, 2000, 12)

    save_bedroom_furniture(sample_path, (_bed(room), rug))
    assert {"BD01", "RG01"} <= {obj.properties.get("Tag") for obj in _objects(sample_path, room).values()}

    # The design is the end state, not a list of things to add. Upserting alone
    # leaves a deleted run standing in the model with nothing to say so.
    save_bedroom_furniture(sample_path, (_bed(room),))

    tags = {obj.properties.get("Tag") for obj in _objects(sample_path, room).values()}
    assert "BD01" in tags
    assert "RG01" not in tags


def test_a_worktop_over_a_part_height_divider_is_a_single_board(sample_path) -> None:
    """A worktop across two bays is one board, not two that abut at the divider.

    Insetting each bay's boards from its own edges leaves 18 mm of nothing at
    every internal joint; abutting them closes the gap but still renders a seam
    down the middle of a slab someone is meant to put things on. Where the
    divider stops short, the board over it is one solid.
    """
    room = _room_id(sample_path)
    top = 700.0
    run = BedroomFurniture(
        "WR01",
        room,
        "wardrobe",
        Point3D(1400, 550, FLOOR),
        2400,
        700,
        900,
        outline_mm=SLOPING_RUN,
        front_bearing_deg=270,
        bays=(
            WardrobeBay(0, 1200, shelf_heights_mm=(top,), role="left"),
            # Its divider stops under the top, so the top runs over it.
            WardrobeBay(1200, 1200, shelf_heights_mm=(top,), divider_height_mm=top - 18, role="right"),
        ),
    )

    ids = save_bedroom_furniture(sample_path, (run,))

    entity = ifcopenshell.open(sample_path).by_guid(ids["WR01"])
    origin = entity.ObjectPlacement.RelativePlacement.Location.Coordinates
    spans = []
    for item in entity.Representation.Representations[0].Items:
        if not item.SweptArea.is_a("IfcArbitraryClosedProfileDef"):
            continue
        if round(origin[2] + item.Position.Location.Coordinates[2]) != round(FLOOR + top - 18):
            continue
        xs = [origin[0] + point.Coordinates[0] for point in item.SweptArea.OuterCurve.Points[:-1]]
        spans.append((min(xs), max(xs)))
    spans.sort()

    assert len(spans) == 1, "the worktop must be one board, not two abutting at the divider"
    assert spans[0][1] - spans[0][0] == pytest.approx(2400 - 2 * 18), "it must span the whole run"


def test_a_tag_that_already_labels_another_fitting_is_refused(sample_path) -> None:
    """A second MIR01 is not a second mirror; it takes the first one's place.

    The bedroom mirror was authored as MIR01, which is the bathroom's. The
    bathroom lost its mirror from the model and nothing reported it, because
    tag uniqueness was only ever checked inside one room.
    """
    room = _room_id(sample_path)
    model = ifcopenshell.open(sample_path)
    storey = model.by_type("IfcBuildingStorey")[0]
    stranger = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcFurniture", name="Bathroom mirror")
    stranger.Tag = "MIR01"
    ifcopenshell.api.run("spatial.assign_container", model, products=[stranger], relating_structure=storey)
    model.write(str(sample_path))

    mirror = BedroomFurniture(
        "MIR01", room, "mirror", Point3D(1400, 900, FLOOR + 1000), 600, 30, 800, wall_mounted=True
    )

    before = sample_path.read_bytes()
    with pytest.raises(RuntimeError, match="already labels"):
        save_bedroom_furniture(sample_path, (mirror,))
    assert sample_path.read_bytes() == before, "a refused save must leave the model untouched"
