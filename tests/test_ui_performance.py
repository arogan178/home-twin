from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from home_twin.model import HomeTwin, Point3D
from home_twin.ui_server import build_app


def test_saved_snapshots_refresh_after_commit_and_external_replacement(sample_path: Path) -> None:
    app = build_app(sample_path)
    client = TestClient(app, base_url="http://127.0.0.1")
    room_id = client.get("/api/project").json()["rooms"][0]["id"]
    original_bytes = sample_path.read_bytes()
    original = client.get(f"/api/rooms/{room_id}/design").json()
    original_plan = client.get("/api/plan").json()
    assert client.get(f"/api/rooms/{room_id}/design").json() == original
    assert client.get("/api/plan").json() == original_plan

    app.state.home_twin.twin.move_fixture(
        original["fixtures"][0]["id"], Point3D(2000, 1400, 2800), expected_revision=original["revision"]
    )
    changed = client.get(f"/api/rooms/{room_id}/design").json()
    changed_plan = client.get("/api/plan").json()
    assert changed["revision"] != original["revision"]
    assert changed["fixtures"][0]["point"]["x"] == 2000
    assert changed_plan["revision"] == changed["revision"]
    assert changed_plan["rooms"][0]["fixtures"][0]["point"]["x"] == 2000
    assert HomeTwin.open(sample_path).get_light_fixtures(room_id)[0].point.x == 2000

    sample_path.write_bytes(original_bytes)
    assert client.get("/api/plan").json() == original_plan
    assert client.get(f"/api/rooms/{room_id}/design").json() == original


def test_http_compression_and_asset_cache_keep_payloads_correct(sample_path: Path, tmp_path: Path) -> None:
    ui = tmp_path / "ui"
    assets = ui / "assets"
    assets.mkdir(parents=True)
    (ui / "index.html").write_text("<html>Home Twin</html>")
    javascript = "const model = 'IFC';\n" * 1000
    (assets / "index-abcdefgh.js").write_text(javascript)
    (assets / "settings.js").write_text("const settings = {};")
    client = TestClient(build_app(sample_path, ui_dir=ui), base_url="http://127.0.0.1")

    identity = client.get("/api/plan", headers={"Accept-Encoding": "identity"})
    compressed = client.get("/api/plan", headers={"Accept-Encoding": "gzip"})
    assert identity.status_code == compressed.status_code == 200
    assert json.loads(identity.content) == json.loads(compressed.content)
    assert compressed.headers["content-encoding"] == "gzip"
    assert int(compressed.headers["content-length"]) < len(identity.content) / 2
    assert "Accept-Encoding" in compressed.headers["vary"]

    asset = client.get("/assets/index-abcdefgh.js")
    assert asset.text == javascript
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert "cache-control" not in client.get("/assets/settings.js").headers
    assert client.get("/").headers["cache-control"] == "no-cache"


def test_saved_design_rereads_independent_photometry(sample_path: Path) -> None:
    twin = HomeTwin.open(sample_path)
    source = twin.project_root / "synthetic.ies"
    text = "IESNA:LM-63-2002\nTILT=NONE\n1 -1 1 2 1 1 2 0 0 0\n1 1 10\n0 90\n0\n1000 1000\n"
    source.write_text(text)
    room_id = twin.get_rooms()[0].id
    layout = twin.get_lighting_layout(room_id)
    fixtures = tuple(
        replace(fixture, spec=replace(fixture.spec, ies_path="synthetic.ies")) for fixture in layout.fixtures
    )
    twin.apply_lighting_layout(replace(layout, fixtures=fixtures), expected_revision=twin.revision)
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    original = client.get(f"/api/rooms/{room_id}/design").json()
    source.write_text(text.replace("1000 1000", "2000 2000"))
    updated = client.get(f"/api/rooms/{room_id}/design").json()
    assert updated["revision"] == original["revision"]
    before = max(sample["lux"] for sample in original["analysis"]["illuminance"]["samples"])
    after = max(sample["lux"] for sample in updated["analysis"]["illuminance"]["samples"])
    assert after == pytest.approx(before * 2)
