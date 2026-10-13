from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import ifcopenshell
import pytest

from home_twin.fixtures import SpotlightSpec
from home_twin.lighting import bake_lighting, load_layout_photometry
from home_twin.model import HomeTwin, Point3D
from home_twin.photometry import IesPhotometry


def test_object_queries_keep_properties_private(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    fixture = next(item for item in twin.get_light_fixtures(room.id) if item.tag == "SP01")
    properties = twin.get_object(fixture.id).properties
    assert isinstance(properties, dict)
    properties["Name"] = "Changed by caller"
    properties["Pset_HomeTwinLighting.Lumens"] = 0

    queried = next(item for item in twin.get_objects(room=room.id) if item.id == fixture.id)
    assert queried.name == "SP01"
    assert queried.properties["Name"] == "SP01"
    assert queried.properties["Pset_HomeTwinLighting.Lumens"] == 650
    assert twin.get_object(fixture.id).properties["Pset_HomeTwinLighting.Lumens"] == 650


def test_object_geometry_refreshes_after_durable_fixture_move(sample_path: Path) -> None:
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    fixture = next(item for item in twin.get_light_fixtures(room.id) if item.tag == "SP01")
    original = twin.get_object(fixture.id)
    assert original.bounds.minimum.x == pytest.approx(1455)
    assert original.plan_footprint is not None
    assert original.plan_footprint.bounds[0] == pytest.approx(1455)

    twin.move_fixture(fixture.id, Point3D(3000, 2700, 2800), expected_revision=twin.revision)

    for current in (twin, HomeTwin.open(sample_path)):
        moved = next(item for item in current.get_objects(room=room.id) if item.id == fixture.id)
        assert moved.bounds.minimum.x == pytest.approx(2955)
        assert moved.bounds.maximum.x == pytest.approx(3045)
        assert moved.plan_footprint is not None
        assert moved.plan_footprint.bounds[0] == pytest.approx(2955)
        assert current.get_light_fixture(fixture.id).point == Point3D(3000, 2700, 2800)
    assert original.bounds.minimum.x == pytest.approx(1455)


def test_failed_ifc_reopen_preserves_query_geometry(
    twin: HomeTwin, sample_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    room = twin.get_rooms()[0]
    fixture = next(item for item in twin.get_light_fixtures(room.id) if item.tag == "SP01")
    assert twin.get_object(fixture.id).bounds.minimum.x == pytest.approx(1455)
    initial_bytes = sample_path.read_bytes()
    initial_revision = twin.revision

    def reject(*args: object) -> None:
        raise ValueError("Temporary IFC could not be reopened")

    with monkeypatch.context() as patch:
        patch.setattr(ifcopenshell, "open", reject)
        with pytest.raises(ValueError, match="could not be reopened"):
            twin.move_fixture(fixture.id, Point3D(3000, 2700, 2800), expected_revision=initial_revision)

    assert sample_path.read_bytes() == initial_bytes
    assert twin.revision == initial_revision
    assert twin.get_object(fixture.id).bounds.minimum.x == pytest.approx(1455)
    assert twin.get_light_fixture(fixture.id).point == Point3D(1500, 1400, 2800)
    twin.move_fixture(fixture.id, Point3D(3000, 2700, 2800), expected_revision=initial_revision)
    assert twin.get_object(fixture.id).bounds.minimum.x == pytest.approx(2955)


def test_bake_preserves_visible_and_blocked_measured_light(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    fixture = next(item for item in twin.get_light_fixtures(room.id) if item.tag == "SP01")
    fixture = replace(fixture, spec=SpotlightSpec(lumens=1000, ies_path="synthetic.ies"))
    layout = replace(twin.get_lighting_layout(room.id), fixtures=(fixture,))
    photometry = IesPhotometry((0, 90), (0,), ((1000, 1000),), None, None, "synthetic")

    baked = bake_lighting(
        layout,
        twin.get_room_context(room.id),
        twin.constraints,
        step_mm=100,
        reflectances={"walls": 0, "ceiling": 0, "floor": 0},
        photometry={"synthetic.ies": photometry},
    )

    below = next(sample for sample in baked.samples if sample.point == Point3D(1500, 1400, 800))
    # 1000 cd at 2 m gives 250 lx, maintained at 0.8 gives 200 lx.
    assert below.lux == pytest.approx(200)
    assert (below.lit_by, below.shadowed_by) == (1, 0)
    behind = next(sample for sample in baked.samples if sample.point == Point3D(3000, 3700, 800))
    assert behind.lux == 0
    assert (behind.lit_by, behind.shadowed_by) == (0, 1)


def test_shared_photometry_reloads_a_changed_file(twin: HomeTwin, tmp_path: Path) -> None:
    source = tmp_path / "synthetic.ies"
    text = "IESNA:LM-63-2002\nTILT=NONE\n1 -1 1 2 1 1 2 0 0 0\n1 1 10\n0 90\n0\n1000 1000\n"
    source.write_text(text)
    room = twin.get_rooms()[0]
    layout = twin.get_lighting_layout(room.id)
    layout = replace(
        layout,
        fixtures=tuple(replace(fixture, spec=SpotlightSpec(ies_path="synthetic.ies")) for fixture in layout.fixtures),
    )

    initial = load_layout_photometry(layout, tmp_path)
    assert initial["synthetic.ies"].intensity(0, 0) == 1000
    source.write_text(text.replace("1000 1000", "2000 2000"))
    changed = load_layout_photometry(layout, tmp_path)
    assert changed["synthetic.ies"].intensity(0, 0) == 2000
    assert initial["synthetic.ies"].intensity(0, 0) == 1000
