from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from home_twin.model import HomeTwin
from home_twin.sample import create_sample_ifc
from home_twin.ui_server import build_app


def _fixture_payload(fixture: dict) -> dict:
    return {
        "tag": fixture["tag"],
        "point": fixture["point"],
        "spec": fixture["spec"],
        "switching_group": fixture["switching_group"],
        "direction": fixture["direction"],
        "notes": fixture["notes"],
    }


def test_ui_api_reads_validates_and_commits_real_ifc(sample_path: Path) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    project = client.get("/api/project")
    assert project.status_code == 200
    room_id = project.json()["rooms"][0]["id"]

    design_response = client.get(f"/api/rooms/{room_id}/design")
    assert design_response.status_code == 200
    design = design_response.json()
    assert len(design["walls"]) == 4
    assert [fixture["tag"] for fixture in design["fixtures"]] == ["SP01", "SP02"]

    fixtures = [_fixture_payload(fixture) for fixture in design["fixtures"]]
    fixtures[0]["point"]["x"] += 900
    fixtures[0]["point"]["y"] += 700
    original_bytes = sample_path.read_bytes()
    analysis = client.post(f"/api/rooms/{room_id}/analysis", json={"fixtures": fixtures})
    assert analysis.status_code == 200
    payload = analysis.json()["analysis"]
    assert all(finding["severity"] != "error" for finding in payload["validation"]["findings"])
    assert payload["method"] == "lumen_beam_cone_v1"
    assert "daylight" in payload["exclusions"]
    assert payload["dark_zones"] != design["analysis"]["dark_zones"]
    assert payload["illuminance"]["step_mm"] > 0
    assert len(payload["illuminance"]["samples"]) > len(payload["dark_zones"])
    assert sample_path.read_bytes() == original_bytes

    commit = client.post(
        f"/api/rooms/{room_id}/commit",
        json={"fixtures": fixtures, "expected_revision": design["revision"]},
    )
    assert commit.status_code == 200
    saved = HomeTwin.open(sample_path).get_light_fixtures(room_id)
    assert saved[0].point.x == fixtures[0]["point"]["x"]
    assert saved[0].point.y == fixtures[0]["point"]["y"]


def test_ifc_import_is_inspected_before_atomic_adoption(sample_path: Path, tmp_path: Path) -> None:
    candidate_path = create_sample_ifc(tmp_path / "candidate.ifc", with_spotlights=False)
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    current = client.get("/api/project").json()
    original_revision = current["building"]["revision"]

    inspected = client.post(
        "/api/imports",
        files={"file": ("candidate.ifc", candidate_path.read_bytes(), "application/x-step")},
    )
    assert inspected.status_code == 200
    summary = inspected.json()
    assert summary["can_adopt"] is True
    assert summary["ready_room_count"] == 1
    assert sample_path.read_bytes() != candidate_path.read_bytes()

    adopted = client.post(
        f"/api/imports/{summary['import_id']}/adopt",
        json={"expected_revision": original_revision},
    )
    assert adopted.status_code == 200
    assert adopted.json()["revision"] != original_revision
    reopened = HomeTwin.open(sample_path)
    assert reopened.get_building().id == summary["building"]["id"]
    assert reopened.get_light_fixtures(reopened.get_rooms()[0].id) == ()
    assert Path(adopted.json()["backup_path"]).exists()


def test_ui_rejects_non_ifc_uploads_and_serves_built_shell(sample_path: Path, tmp_path: Path) -> None:
    ui_dir = tmp_path / "ui"
    ui_dir.mkdir()
    (ui_dir / "index.html").write_text("<!doctype html><title>Home Twin test</title>")
    client = TestClient(build_app(sample_path, ui_dir=ui_dir), base_url="http://127.0.0.1")

    rejected = client.post("/api/imports", files={"file": ("plan.pdf", b"%PDF", "application/pdf")})
    assert rejected.status_code == 415
    page = client.get("/")
    assert page.status_code == 200
    assert "Home Twin test" in page.text


def test_align_pulls_spotlights_onto_a_shared_axis(sample_path: Path) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    room = client.get("/api/project").json()["rooms"][0]
    fixtures = [
        {
            "tag": "SP01",
            "point": {"x": 1000, "y": 1500, "z": room["bounds"]["maximum"]["z"]},
            "spec": {"lumens": 650, "beam_angle_deg": 36},
            "switching_group": "MAIN",
        },
        {
            "tag": "SP02",
            "point": {"x": 2000, "y": 1500, "z": room["bounds"]["maximum"]["z"]},
            "spec": {"lumens": 650, "beam_angle_deg": 36},
            "switching_group": "MAIN",
        },
        {
            "tag": "SP03",
            "point": {"x": 3000, "y": 1460, "z": room["bounds"]["maximum"]["z"]},
            "spec": {"lumens": 650, "beam_angle_deg": 36},
            "switching_group": "MAIN",
        },
    ]
    response = client.post(f"/api/rooms/{room['id']}/align", json={"fixtures": fixtures})

    assert response.status_code == 200
    payload = response.json()
    assert [fixture["point"]["y"] for fixture in payload["fixtures"]] == [1500, 1500, 1500]
    assert not any(
        finding["code"] == "bad_alignment" for finding in payload["report"]["findings"]
    )


def test_ui_commits_typed_lights_switch_and_shared_control_group(sample_path: Path) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    room_id = client.get("/api/project").json()["rooms"][0]["id"]
    design = client.get(f"/api/rooms/{room_id}/design").json()
    ceiling_z = design["ceiling"]["elevation_mm"]
    north = max(design["walls"], key=lambda wall: (wall["start"]["y"] + wall["end"]["y"]) / 2)
    fixtures = [
        {**_fixture_payload(fixture), "kind": fixture["kind"]}
        for fixture in design["fixtures"]
    ]
    fixtures.extend(
        [
            {
                "kind": "pendant_bulb",
                "tag": "PN01",
                "point": {"x": 3000, "y": 2300, "z": ceiling_z},
                "spec": {"drop_mm": 550},
                "switching_group": "OPEN_PLAN_MAIN",
            },
            {
                "kind": "rope_light",
                "tag": "RL01",
                "path": [
                    {"x": 1000, "y": 3200, "z": ceiling_z},
                    {"x": 5000, "y": 3200, "z": ceiling_z},
                ],
                "spec": {"mounting": "concealed"},
                "switching_group": "ACCENT",
            },
        ]
    )
    switches = [
        {
            "tag": "SW01",
            "host_wall_id": north["wall_id"],
            "offset_mm": 3000,
            "mounting_height_mm": 1100,
            "switching_group": "OPEN_PLAN_MAIN",
            "spec": {"kind": "dimmer"},
        }
    ]

    checked = client.post(
        f"/api/rooms/{room_id}/analysis",
        json={"fixtures": fixtures, "switches": switches},
    )
    assert checked.status_code == 200
    analysis = checked.json()["analysis"]
    # A pendant is credited now, as a uniform diffuser, and the method says so.
    # A cove is not: its output into the room depends on the cove's own section.
    assert "pendant_bulb_photometry" not in analysis["exclusions"]
    assert "rope_light_photometry" in analysis["exclusions"]
    assert analysis["method"] == "lumen_beam_cone_with_uniform_diffuser_v1"

    committed = client.post(
        f"/api/rooms/{room_id}/commit",
        json={"fixtures": fixtures, "switches": switches, "expected_revision": design["revision"]},
    )
    assert committed.status_code == 200
    saved = client.get(f"/api/rooms/{room_id}/design").json()
    assert {fixture["kind"] for fixture in saved["fixtures"]} == {
        "recessed_spotlight",
        "pendant_bulb",
        "rope_light",
    }
    assert saved["switches"][0]["tag"] == "SW01"
    main = next(group for group in saved["control_groups"] if group["label"] == "OPEN_PLAN_MAIN")
    assert len(main["luminaire_ids"]) == 3
    assert len(main["switch_ids"]) == 1


def test_the_server_reports_when_its_own_sources_moved_on(sample_path: Path, monkeypatch) -> None:
    """A fix edited after the process started is not in it, and it says so."""

    from home_twin import ui_server

    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    assert client.get("/api/project").json()["server_stale"] is False

    monkeypatch.setattr(ui_server, "_source_fingerprint", lambda: "moved on")
    assert client.get("/api/project").json()["server_stale"] is True


def test_a_browser_commit_cannot_drop_a_sensor_it_did_not_author(sample_path: Path) -> None:
    from dataclasses import replace

    from home_twin.fixtures import PlannedSensor
    from home_twin.model import Point3D

    twin = HomeTwin.open(sample_path)
    room_id = twin.get_rooms()[0].id
    ceiling_z = twin.get_room_context(room_id).ceiling.elevation_mm
    design = twin.get_room_lighting_design(room_id)
    twin.apply_room_lighting_design(
        replace(
            design,
            sensors=(
                PlannedSensor("PIR08", room_id, Point3D(2200, 1800, ceiling_z), 20, controls_tag="EF08"),
            ),
        ),
        expected_revision=twin.revision,
    )

    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    served = client.get(f"/api/rooms/{room_id}/design").json()
    assert [item["tag"] for item in served["sensors"]] == ["PIR08"], "the design serves its sensors"

    commit = client.post(
        f"/api/rooms/{room_id}/commit",
        json={
            "fixtures": [_fixture_payload(fixture) for fixture in served["fixtures"]],
            "sensors": [
                {
                    "tag": item["tag"],
                    "point": item["point"],
                    "run_on_minutes": item["run_on_minutes"],
                    "switching_group": item["switching_group"],
                    "controls_tag": item["controls_tag"],
                    "spec": item["spec"],
                    "notes": item["notes"],
                }
                for item in served["sensors"]
            ],
            "expected_revision": served["revision"],
        },
    )
    assert commit.status_code == 200
    assert [item.tag for item in HomeTwin.open(sample_path).get_sensors(room_id)] == ["PIR08"]
