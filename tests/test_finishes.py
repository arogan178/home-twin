from __future__ import annotations

import ifcopenshell
import ifcopenshell.util.element
import pytest

from home_twin.finishes import RoomFinish, save_room_finishes
from home_twin.model import HomeTwin


def test_room_finishes_are_read_back_from_the_ifc_space(sample_path) -> None:
    room = HomeTwin.open(sample_path).get_rooms()[0]
    assert (room.floor_finish, room.wall_finish) == (None, None)

    save_room_finishes(sample_path, (RoomFinish(room.id, "light_grey_tile", "grey_tile", "#B9B6B1", "#9E9B96"),))

    reopened = HomeTwin.open(sample_path).get_rooms()[0]
    assert (reopened.floor_finish, reopened.wall_finish) == ("light_grey_tile", "grey_tile")
    space = ifcopenshell.open(str(sample_path)).by_guid(room.id)
    pset = ifcopenshell.util.element.get_psets(space)["Pset_HomeTwinFinish"]
    assert (pset["FloorColour"], pset["WallColour"]) == ("#B9B6B1", "#9E9B96")

    save_room_finishes(sample_path, (RoomFinish(room.id, "walnut_parquet_tile", "grey_tile", "#6E4B34", "#9E9B96"),))
    assert HomeTwin.open(sample_path).get_rooms()[0].floor_finish == "walnut_parquet_tile", "a re-save replaces"


def test_a_finish_colour_must_be_hex_rgb() -> None:
    with pytest.raises(ValueError, match="RRGGBB"):
        RoomFinish("ROOM", "grey_tile", "grey_tile", "grey", "#9E9B96")


def test_lrv_reads_a_stated_colour_as_a_reflectance() -> None:
    from home_twin.finishes import DEFAULT_FINISH_COLOURS, lrv

    # Black and white bracket the scale; the stated tiles sit where their
    # lightness says, not where one project-wide default put them.
    assert lrv("#000000") == 0.0
    assert lrv("#FFFFFF") == pytest.approx(1.0)
    assert lrv(DEFAULT_FINISH_COLOURS["grey_tile"]) == pytest.approx(0.62, abs=0.01)
    assert lrv(DEFAULT_FINISH_COLOURS["walnut_parquet_tile"]) == pytest.approx(0.09, abs=0.01)
    with pytest.raises(ValueError):
        lrv("grey")


def test_a_room_takes_its_finish_reflectance_over_the_project_default(sample_path) -> None:
    from dataclasses import replace

    from home_twin.finishes import room_reflectances

    fallback = {"ceiling": 0.7, "walls": 0.5, "floor": 0.2}
    room = HomeTwin.open(sample_path).get_rooms()[0]

    plain = replace(room, floor_finish=None, wall_finish=None)
    assert room_reflectances(plain, fallback) == fallback, "an unfinished room keeps the project's"

    tiled = replace(room, floor_finish="walnut_parquet_tile", wall_finish="grey_tile")
    values = room_reflectances(tiled, fallback)
    assert values["walls"] == pytest.approx(0.62, abs=0.01)
    assert values["floor"] == pytest.approx(0.09, abs=0.01)
    assert values["ceiling"] == 0.7, "a surface the finish does not name is left alone"

    unknown = replace(room, wall_finish="tile_nobody_authored")
    assert room_reflectances(unknown, fallback)["walls"] == 0.5


def test_a_feature_wall_gives_its_own_face_a_reflectance(sample_path) -> None:
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    feature = twin.get_room_context(room.id).walls[0].wall_id

    save_room_finishes(
        sample_path,
        (
            RoomFinish(
                room.id,
                "walnut_board",
                "warm_off_white",
                "#6E4B34",
                "#EDE6DA",
                feature_wall_id=feature,
                feature_wall="grey_green_paint",
                feature_wall_colour="#7A827C",
            ),
        ),
    )

    reopened = HomeTwin.open(sample_path)
    assert reopened.get_rooms()[0].feature_wall == "grey_green_paint"
    faces = {wall.wall_id: wall.reflectance for wall in reopened.get_room_context(room.id).walls}
    assert faces.pop(feature) == pytest.approx(0.22, abs=0.01), "the grey-green is a fifth as bright as the room walls"
    assert set(faces.values()) == {None}, "the other faces stay on the room-wide wall finish"


def test_a_feature_wall_needs_a_wall_a_name_and_a_colour() -> None:
    with pytest.raises(ValueError, match="feature wall"):
        RoomFinish("ROOM", "walnut_board", "warm_off_white", "#6E4B34", "#EDE6DA", feature_wall="grey_green_paint")


def test_a_finishes_file_beside_the_ifc_states_a_project_finish_and_its_lrv(sample_path) -> None:
    from home_twin.finishes import DEFAULT_FINISHES, finish_reflectance, load_finishes

    assert load_finishes(sample_path.parent) is DEFAULT_FINISHES, "no file keeps the generic finishes"
    (sample_path.parent / "finishes.yaml").write_text(
        'colours:\n  sage_paint: "#9CAF88"\nlrv:\n  dark_veneer: 0.12\n  sage_paint: 0.4\n',
        encoding="utf-8",
    )
    catalogue = load_finishes(sample_path.parent)
    assert catalogue.colours["grey_tile"], "the generic finishes stay underneath"
    assert finish_reflectance("sage_paint", catalogue) == 0.4, "a stated LRV beats the colour"
    assert finish_reflectance("dark_veneer", catalogue) == 0.12, "an LRV needs no colour"

    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    clad = twin.get_room_context(room.id).walls[0].wall_id
    save_room_finishes(
        sample_path,
        (RoomFinish(room.id, None, "sage_paint", None, "#9CAF88", clad_wall_ids=(clad,), clad_wall="dark_veneer"),),
    )
    faces = {wall.wall_id: wall.reflectance for wall in HomeTwin.open(sample_path).get_room_context(room.id).walls}
    assert faces[clad] == 0.12, "a clad face takes its finish's stated LRV from the project file"


def test_a_finishes_file_rejects_a_bad_colour_or_lrv(tmp_path) -> None:
    from home_twin.finishes import load_finishes

    (tmp_path / "finishes.yaml").write_text("lrv:\n  paint: 1.5\n", encoding="utf-8")
    with pytest.raises(ValueError, match="LRV"):
        load_finishes(tmp_path)
    (tmp_path / "finishes.yaml").write_text("colours:\n  paint: grey\n", encoding="utf-8")
    with pytest.raises(ValueError, match="RRGGBB"):
        load_finishes(tmp_path)


def test_a_skirting_survives_a_save_and_reload(sample_path) -> None:
    room = HomeTwin.open(sample_path).get_rooms()[0]
    save_room_finishes(
        sample_path,
        (
            RoomFinish(
                room.id,
                None,
                "off_white_paint",
                None,
                "#E8E6E1",
                skirting="sand_tile",
                skirting_height_mm=60.0,
                skirting_thickness_mm=10.0,
            ),
        ),
    )

    reopened = HomeTwin.open(sample_path).get_rooms()[0]
    assert (reopened.skirting, reopened.skirting_height_mm, reopened.skirting_thickness_mm) == (
        "sand_tile",
        60.0,
        10.0,
    )


def test_a_skirting_needs_all_three_of_its_facts() -> None:
    with pytest.raises(ValueError, match="skirting needs"):
        RoomFinish("ROOM", None, "off_white_paint", None, "#E8E6E1", skirting="sand_tile")
    with pytest.raises(ValueError, match="must be positive"):
        RoomFinish(
            "ROOM",
            None,
            "off_white_paint",
            None,
            "#E8E6E1",
            skirting="sand_tile",
            skirting_height_mm=0.0,
            skirting_thickness_mm=10.0,
        )
