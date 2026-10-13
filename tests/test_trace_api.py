"""In-browser plan tracing: review, save, build, and underlay handling."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from home_twin.model import HomeTwin
from home_twin.plan_draft import build_draft, load_plan, review_plan_file
from home_twin.sample import create_sample_ifc
from home_twin.ui_server import build_app

DEMO = Path(__file__).parents[1] / "examples" / "demo"


@pytest.fixture
def traced_project(tmp_path: Path) -> Path:
    reference_dir = tmp_path / "model" / "references"
    reference_dir.mkdir(parents=True)
    shutil.copy2(DEMO / "plan.yaml", reference_dir / "plan.yaml")
    shutil.copy2(DEMO / "underlay.png", reference_dir / "underlay.png")
    create_sample_ifc(tmp_path / "model" / "house.ifc", with_spotlights=False)
    assert review_plan_file(tmp_path).publishable
    build_draft(tmp_path)
    return tmp_path


@pytest.fixture
def client(traced_project: Path) -> TestClient:
    return TestClient(build_app(traced_project / "model" / "draft.ifc"), base_url="http://127.0.0.1")


def _with_site(document: dict) -> dict:
    document = dict(document)
    document["evidence"] = {
        **document["evidence"],
        "site_survey": {"source": "test", "status": "assumed", "uncertainty_mm": 0},
    }
    document["site"] = {
        "name": "Test site",
        "latitude_deg": 47.5,
        "longitude_deg": 8.5,
        "elevation_mm": 400000,
        "true_north_deg": 8.0,
        "timezone": "Europe/Zurich",
        "evidence": "site_survey",
    }
    return document


def test_the_trace_source_is_served_with_its_review_and_revision(client: TestClient) -> None:
    payload = client.get("/api/trace").json()

    assert payload["revision"].startswith("sha256:")
    assert payload["document"]["schema"] == "home-twin.plan/v3"
    assert payload["review"]["room_count"] == len(payload["document"]["rooms"])
    # Solar geometry refuses to answer at all until the plan states a site.
    assert payload["review"]["site_located"] is True
    assert payload["review"]["stair_count"] == len(payload["document"]["stairs"])
    assert payload["review"]["aperture_count"] == len(payload["document"]["apertures"])
    assert payload["underlay_url"] == "/api/trace/underlay/file"
    assert payload["draft"]["is_open_model"] is True
    assert not any(finding["code"] == "site_unstated" for finding in payload["review"]["warnings"])


def test_reviewing_an_edited_document_does_not_touch_the_working_tree(
    client: TestClient,
    traced_project: Path,
) -> None:
    trace = client.get("/api/trace").json()
    plan_bytes = (traced_project / "model" / "references" / "plan.yaml").read_bytes()
    document = _with_site(trace["document"])
    document["points"]["lv_se"]["x_mm"] = 99_999

    review = client.post("/api/trace/review", json={"document": document})

    assert review.status_code == 200
    body = review.json()["review"]
    assert body["site_located"] is True
    assert any(finding["code"] == "control_failed" for finding in body["blockers"])
    assert (traced_project / "model" / "references" / "plan.yaml").read_bytes() == plan_bytes


def test_review_rejects_a_document_that_breaks_the_schema(client: TestClient) -> None:
    trace = client.get("/api/trace").json()
    document = dict(trace["document"])
    document["rooms"][0]["point_ids"] = ["does_not_exist", "lv_se", "lv_e"]

    assert client.post("/api/trace/review", json={"document": document}).status_code == 422


def test_saving_a_trace_keeps_history_and_guards_the_revision(
    client: TestClient,
    traced_project: Path,
) -> None:
    trace = client.get("/api/trace").json()
    document = _with_site(trace["document"])

    stale = client.post(
        "/api/trace/save",
        json={"document": document, "expected_revision": "sha256:stale"},
    )
    assert stale.status_code == 409

    saved = client.post(
        "/api/trace/save",
        json={"document": document, "expected_revision": trace["revision"]},
    )
    assert saved.status_code == 200
    assert saved.json()["revision"] != trace["revision"]
    assert saved.json()["review"]["site_located"] is True

    history = list((traced_project / "model" / "references" / "history").glob("plan-*.yaml"))
    assert len(history) == 1
    # The archived copy is the source as it was before this save, so it carries
    # the site the plan already had rather than the one this save supplies.
    archived = yaml.safe_load(history[0].read_text())
    assert archived["site"] != document["site"], "the archive must predate this save"

    reloaded, review, revision = load_plan(traced_project)
    assert reloaded.site is not None
    assert reloaded.site.latitude_deg == pytest.approx(47.5)
    assert revision == saved.json()["revision"]
    assert review.site_located is True


def test_building_from_the_browser_reloads_the_open_draft_model(
    client: TestClient,
    traced_project: Path,
) -> None:
    canonical = traced_project / "model" / "house.ifc"
    canonical_bytes = canonical.read_bytes()
    trace = client.get("/api/trace").json()
    saved = client.post(
        "/api/trace/save",
        json={"document": _with_site(trace["document"]), "expected_revision": trace["revision"]},
    )
    assert saved.status_code == 200

    without_revision = client.post("/api/trace/build", json={})
    assert without_revision.status_code == 409
    assert without_revision.json()["detail"]["code"] == "draft_replacement_required"

    built = client.post(
        "/api/trace/build",
        json={"expected_draft_revision": trace["draft"]["revision"]},
    )
    assert built.status_code == 200
    body = built.json()
    assert body["report"]["published"] is True
    assert body["report"]["schema_issue_count"] == 0
    assert body["model_reloaded"] is True
    assert body["revision"] == body["report"]["revision"]
    assert canonical.read_bytes() == canonical_bytes

    site = client.get("/api/site").json()["site"]
    assert site["latitude_deg"] == pytest.approx(47.5)
    assert site["true_north_deg"] == pytest.approx(8.0)

    plan = yaml.safe_load((traced_project / "model" / "references" / "plan.yaml").read_text())
    room_name = next(item["name"] for item in plan["rooms"] if item["id"] == "living")
    room = next(item for item in client.get("/api/project").json()["rooms"] if item["name"] == room_name)
    daylight = client.get(
        f"/api/rooms/{room['id']}/daylight",
        params={"at": "2026-06-21T17:00", "plane": "floor"},
    ).json()
    assert daylight["daylight"]["patches"][0]["pieces"]
    assert daylight["daylight"]["position"]["above_horizon"] is True
    assert "illuminance_values" in daylight["daylight"]["exclusions"]
    assert daylight["sun_path"]["sunrise"] is not None


def test_a_trace_with_blockers_saves_but_refuses_to_publish(
    client: TestClient,
    traced_project: Path,
) -> None:
    draft_path = traced_project / "model" / "draft.ifc"
    draft_bytes = draft_path.read_bytes()
    trace = client.get("/api/trace").json()
    document = trace["document"]
    document["controls"][0]["expected_mm"] = 9_999

    saved = client.post(
        "/api/trace/save",
        json={"document": document, "expected_revision": trace["revision"]},
    )
    assert saved.status_code == 200
    assert any(finding["code"] == "control_failed" for finding in saved.json()["review"]["blockers"])

    rejected = client.post(
        "/api/trace/build",
        json={"expected_draft_revision": trace["draft"]["revision"]},
    )
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "plan_not_publishable"
    assert draft_path.read_bytes() == draft_bytes


def test_an_underlay_is_stored_beside_the_plan_and_served_back(
    client: TestClient,
    traced_project: Path,
) -> None:
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000a49444154789c6300010000050001"
    ) + b"\x0d\x0a\x2d\xb4\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60\x82"

    upload = client.post(
        "/api/trace/underlay",
        files={"file": ("plan-scan.png", png, "image/png")},
        data={"width_px": 2480, "height_px": 1754},
    )
    assert upload.status_code == 200
    underlay = upload.json()
    assert underlay["file_name"] == "underlay.png"
    assert (traced_project / "model" / "references" / "underlay.png").exists()

    trace = client.get("/api/trace").json()
    document = _with_site(trace["document"])
    document["underlay"] = {
        "file_name": underlay["file_name"],
        "sha256": underlay["sha256"],
        "width_px": underlay["width_px"],
        "height_px": underlay["height_px"],
        "mm_per_px": 12.5,
        "origin_px": {"x": 100.0, "y": 1600.0},
        "rotation_deg": 0.0,
        "opacity": 0.5,
        "evidence": "demo_drawing",
    }
    saved = client.post(
        "/api/trace/save",
        json={"document": document, "expected_revision": trace["revision"]},
    )
    assert saved.status_code == 200
    assert saved.json()["trace"]["underlay_url"] == "/api/trace/underlay/file"
    assert saved.json()["review"]["has_underlay"] is True

    served = client.get("/api/trace/underlay/file")
    assert served.status_code == 200
    assert served.content == png

    assert client.post(
        "/api/trace/underlay",
        files={"file": ("plan.pdf", b"%PDF", "application/pdf")},
        data={"width_px": 100, "height_px": 100},
    ).status_code == 415


def test_the_underlay_never_reaches_the_ifc_geometry(client: TestClient, traced_project: Path) -> None:
    """An underlay is a reference drawing, so it must not change the built model."""

    def room_geometry() -> dict[str, tuple[float, tuple[tuple[float, float], ...]]]:
        twin = HomeTwin.open(traced_project / "model" / "draft.ifc")
        return {
            room.name: (
                twin.get_ceiling(room.id).elevation_mm,
                tuple((point.x, point.y) for point in twin.get_ceiling_polygon(room.id).outer),
            )
            for room in twin.get_rooms()
        }

    trace = client.get("/api/trace").json()
    document = _with_site(trace["document"])
    first = client.post(
        "/api/trace/save",
        json={"document": document, "expected_revision": trace["revision"]},
    )
    built = client.post(
        "/api/trace/build",
        json={"expected_draft_revision": trace["draft"]["revision"]},
    ).json()
    before = room_geometry()

    document["underlay"] = {
        "file_name": "underlay.png",
        "sha256": "sha256:0",
        "width_px": 100,
        "height_px": 100,
        "mm_per_px": 1.0,
        "origin_px": {"x": 0.0, "y": 0.0},
        "evidence": "demo_drawing",
    }
    second = client.post(
        "/api/trace/save",
        json={"document": document, "expected_revision": first.json()["revision"]},
    )
    assert second.status_code == 200
    rebuilt = client.post(
        "/api/trace/build",
        json={"expected_draft_revision": built["report"]["revision"]},
    )

    assert rebuilt.status_code == 200
    assert rebuilt.json()["report"]["published"] is True
    assert room_geometry() == before
    assert "underlay.png" not in (traced_project / "model" / "draft.ifc").read_text()
    assert load_plan(traced_project)[0].underlay is not None


def test_unknown_api_routes_do_not_fall_through_to_the_single_page_app(
    traced_project: Path,
    tmp_path: Path,
) -> None:
    ui_dir = tmp_path / "ui-build"
    ui_dir.mkdir()
    (ui_dir / "index.html").write_text("<!doctype html><title>Home Twin</title>")
    client = TestClient(build_app(traced_project / "model" / "draft.ifc", ui_dir=ui_dir), base_url="http://127.0.0.1")

    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/rooms/anything").status_code == 200


def test_a_source_newer_than_the_server_says_to_restart(client: TestClient, traced_project: Path) -> None:
    """A plan carrying unknown fields means stale code, not a broken trace."""

    plan_path = traced_project / "model" / "references" / "plan.yaml"
    plan = yaml.safe_load(plan_path.read_text())
    for room in plan["rooms"]:
        room["a_field_from_a_later_version"] = 1
    plan_path.write_text(yaml.safe_dump(plan, sort_keys=False))

    response = client.get("/api/trace")

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "a_field_from_a_later_version" in detail
    assert "restart" in detail.lower()
    assert "extra_forbidden" not in detail


def test_a_genuinely_broken_source_still_reports_the_problem(
    client: TestClient,
    traced_project: Path,
) -> None:
    plan_path = traced_project / "model" / "references" / "plan.yaml"
    plan = yaml.safe_load(plan_path.read_text())
    plan["rooms"][0]["ceiling_height_mm"] = -5
    plan_path.write_text(yaml.safe_dump(plan, sort_keys=False))

    response = client.get("/api/trace")

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "ceiling_height_mm" in detail
    assert "restart" not in detail.lower()
