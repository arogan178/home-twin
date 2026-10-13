from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import ifcopenshell
import pytest

from home_twin.fixtures import (
    PendantSpec,
    PlannedPendant,
    PlannedRopeLight,
    PlannedWallSwitch,
    RoomLightingDesign,
    RopeLightSpec,
    RopeMounting,
    SpotlightSpec,
)
from home_twin.model import HomeTwin, ObjectKind, Point3D, Vector3D
from home_twin.validation import LayoutRejected, StaleRevision


def test_ifc_geometry_is_normalized_to_world_millimetres(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    assert room.bounds.minimum == Point3D(0, 0, 0)
    assert room.bounds.maximum == Point3D(6000, 4000, 2800)
    assert twin.get_ceiling(room.id).elevation_mm == pytest.approx(2800)
    assert twin.get_ceiling_polygon(room.id).bounds == (0, 0, 6000, 4000)
    walls = twin.get_walls(room.id)
    assert len(walls) == 4
    east = next(wall for wall in walls if wall.name == "East wall")
    assert east.bounds.minimum.x == pytest.approx(6000)
    assert east.bounds.maximum.x == pytest.approx(6100)
    assert east.bounds.maximum.y == pytest.approx(4000)
    assert twin.distance_to_wall(Point3D(3000, 1400, 2800), next(w.id for w in walls if w.name == "South wall")) == 1400


def test_room_containment_preserves_semantic_types(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    objects = twin.get_objects(room=room.id)
    kinds = {item.name: item.kind for item in objects}
    assert kinds["Tall kitchen cabinetry"] == ObjectKind.CABINET
    assert kinds["Dining table"] == ObjectKind.FURNITURE
    assert kinds["North shadow gap"] == ObjectKind.SHADOW_GAP
    assert kinds["SP01"] == ObjectKind.LIGHT_FIXTURE


def test_add_move_save_and_reload_fixture(sample_path: Path) -> None:
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    added = twin.add_spotlight(
        room.id,
        fixture_id="SP03",
        point=Point3D(1500, 2700, 2800),
        spec=SpotlightSpec(model="Test downlight", lumens=725, beam_angle_deg=40, peak_candela=1180),
        switching_group="OPEN_PLAN_MAIN",
        direction=Vector3D(1, 0, -1),
        expected_revision=twin.revision,
    )
    add_revision = twin.revision
    assert added.tag == "SP03"
    assert added.point == Point3D(1500, 2700, 2800)

    moved = twin.move_fixture("SP03", Point3D(3000, 2700, 2800), expected_revision=add_revision)
    assert moved.point == Point3D(3000, 2700, 2800)
    assert twin.revision != add_revision

    reopened = HomeTwin.open(sample_path)
    persisted = next(item for item in reopened.get_light_fixtures(room.id) if item.tag == "SP03")
    assert persisted.point == Point3D(3000, 2700, 2800)
    assert persisted.spec.model == "Test downlight"
    assert persisted.spec.lumens == 725
    # A spec field the property set does not carry is silently dropped on save,
    # and the write then fails its own verify rather than persisting a stub.
    assert persisted.spec.peak_candela == 1180
    assert persisted.direction == Vector3D(1, 0, -1)
    assert ifcopenshell.open(sample_path).by_guid(persisted.id) is not None


def test_a_straight_down_spotlight_can_be_tilted_later(sample_path: Path) -> None:
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    twin.add_spotlight(
        room.id,
        fixture_id="TILT1",
        point=Point3D(1500, 2700, 2800),
        spec=SpotlightSpec(model="Tilting holder"),
        switching_group="OPEN_PLAN_MAIN",
        expected_revision=twin.revision,
    )
    tilted = Vector3D(0.422618, 0, -0.906308)
    design = twin.get_room_lighting_design(room.id)
    luminaires = tuple(
        replace(item, direction=tilted) if item.tag == "TILT1" else item for item in design.luminaires
    )

    twin.apply_room_lighting_design(replace(design, luminaires=luminaires), expected_revision=twin.revision)

    reopened = HomeTwin.open(sample_path)
    assert next(item for item in reopened.get_light_fixtures(room.id) if item.tag == "TILT1").direction == tilted


def test_a_deleted_fixture_is_gone_from_the_reloaded_ifc(sample_path: Path) -> None:
    """The absence of the entity is what proves the delete, and absence raises.

    ``by_guid`` raises for a missing instance rather than returning None, so a
    verify written as ``if by_guid(...) is not None`` fails on exactly the case
    it is meant to accept and no fixture can ever be deleted.
    """

    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    added = twin.add_spotlight(
        room.id,
        fixture_id="SP09",
        point=Point3D(1500, 2700, 2800),
        spec=SpotlightSpec(model="Doomed downlight", lumens=575, beam_angle_deg=36),
        switching_group="OPEN_PLAN_MAIN",
        expected_revision=twin.revision,
    )

    twin.delete_fixture(added.id, expected_revision=twin.revision)

    reopened = HomeTwin.open(sample_path)
    assert all(item.tag != "SP09" for item in reopened.get_light_fixtures(room.id))
    with pytest.raises(RuntimeError):
        ifcopenshell.open(sample_path).by_guid(added.id)


def test_a_joinery_mounted_strip_survives_off_the_ceiling_plane(sample_path: Path) -> None:
    """An under-cabinet strip is fixed to joinery, so its Z is the joinery's.

    The ceiling-plane check applies to ceiling and concealed runs, which are the
    coves sitting in a ceiling reveal. A joinery run is not one of those, and
    validating it against the ceiling would reject every task strip.
    """

    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    ceiling_z = twin.get_ceiling(room.id).elevation_mm
    strip = PlannedRopeLight(
        "T9",
        room.id,
        (Point3D(1000, 2000, 2390), Point3D(3000, 2000, 2390)),
        RopeLightSpec(mounting=RopeMounting.JOINERY, dimmable=False),
        "TASK",
    )

    twin.apply_room_lighting_design(
        RoomLightingDesign(room.id, (*twin.get_luminaires(room.id), strip)),
        expected_revision=twin.revision,
    )

    reopened = HomeTwin.open(sample_path)
    saved = next(item for item in reopened.get_luminaires(room.id) if item.tag == "T9")
    assert saved.spec.mounting == RopeMounting.JOINERY
    assert saved.spec.dimmable is False
    assert saved.path[0].z == pytest.approx(2390)
    assert saved.path[0].z < ceiling_z


def test_invalid_and_stale_mutations_leave_ifc_unchanged(sample_path: Path) -> None:
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    initial_bytes = sample_path.read_bytes()
    initial_revision = twin.revision

    with pytest.raises(LayoutRejected):
        twin.add_spotlight(
            room.id,
            fixture_id="BAD",
            point=Point3D(100, 100, 2800),
            spec=SpotlightSpec(),
            switching_group="MAIN",
            expected_revision=initial_revision,
        )
    assert sample_path.read_bytes() == initial_bytes
    assert twin.revision == initial_revision

    twin.move_fixture("SP01", Point3D(1500, 1600, 2800), expected_revision=initial_revision)
    changed_bytes = sample_path.read_bytes()
    with pytest.raises(StaleRevision):
        twin.move_fixture("SP01", Point3D(1500, 1800, 2800), expected_revision=initial_revision)
    assert sample_path.read_bytes() == changed_bytes


def test_typed_lights_switch_and_control_group_survive_ifc_reload(sample_path: Path, tmp_path: Path) -> None:
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    ceiling_z = context.ceiling.elevation_mm
    north = max(context.walls, key=lambda wall: (wall.start.y + wall.end.y) / 2)
    pendant = PlannedPendant(
        "PN01",
        room.id,
        Point3D(3000, 2300, ceiling_z),
        PendantSpec(drop_mm=550),
        "OPEN_PLAN_MAIN",
    )
    rope = PlannedRopeLight(
        "RL01",
        room.id,
        (Point3D(1000, 3200, ceiling_z), Point3D(5000, 3200, ceiling_z)),
        RopeLightSpec(),
        "ACCENT",
    )
    switch = PlannedWallSwitch(
        "SW01",
        room.id,
        north.wall_id,
        3000,
        1100,
        "OPEN_PLAN_MAIN",
    )
    design = RoomLightingDesign(
        room.id,
        (*twin.get_luminaires(room.id), pendant, rope),
        (switch,),
    )

    result = twin.apply_room_lighting_design(design, expected_revision=twin.revision)

    reopened = HomeTwin.open(sample_path)
    luminaires = reopened.get_luminaires(room.id)
    switches = reopened.get_wall_switches(room.id)
    assert {item.kind for item in luminaires} == {
        "recessed_spotlight",
        "pendant_bulb",
        "rope_light",
    }
    assert {item.tag for item in luminaires} == {"SP01", "SP02", "PN01", "RL01"}
    assert [item.tag for item in switches] == ["SW01"]
    assert switches[0].host_wall_id == north.wall_id
    assert switches[0].point.z == pytest.approx(1100)
    group = next(group for group in reopened.get_control_groups() if group.label == "OPEN_PLAN_MAIN")
    assert switches[0].id in group.switch_ids
    assert {item.id for item in luminaires if item.switching_group == group.label} <= set(group.luminaire_ids)
    assert result.revision == reopened.revision

    reopened.export_lighting(directory=tmp_path)
    installation = json.loads((tmp_path / "lighting-layout.json").read_text())
    assert {item["fixture_type"] for item in installation["fixtures"]} == {
        "recessed_spotlight",
        "pendant_bulb",
        "rope_light",
    }
    assert installation["switches"][0]["tag"] == "SW01"
    assert installation["control_groups"][0]["label"] in {"ACCENT", "OPEN_PLAN_MAIN"}
    drawing = (tmp_path / "lighting-layout.svg").read_text()
    assert all(tag in drawing for tag in ("PN01", "RL01", "SW01"))


def test_empty_control_groups_are_removed_after_reassignment(sample_path: Path) -> None:
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    original = RoomLightingDesign(
        room.id,
        tuple(replace(item, switching_group="OLD_GROUP") for item in twin.get_luminaires(room.id)),
    )

    twin.apply_room_lighting_design(original, expected_revision=twin.revision)
    reassigned = RoomLightingDesign(
        room.id,
        tuple(replace(item, switching_group="NEW_GROUP") for item in twin.get_luminaires(room.id)),
    )
    twin.apply_room_lighting_design(reassigned, expected_revision=twin.revision)

    reopened = HomeTwin.open(sample_path)
    groups = {group.label: group for group in reopened.get_control_groups()}
    assert "OLD_GROUP" not in groups
    assert set(groups["NEW_GROUP"].luminaire_ids) == {item.id for item in reopened.get_luminaires(room.id)}
