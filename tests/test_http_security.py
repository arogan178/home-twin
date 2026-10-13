from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from home_twin.ui_server import build_app, main


def test_unknown_hosts_cannot_read_ifc(sample_path: Path) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.get("/api/model.ifc", headers={"Host": "untrusted.example"})
    assert response.status_code == 400
    assert client.get("/api/model.ifc").content == sample_path.read_bytes()


@pytest.mark.parametrize("host", ["[::1]:8123", "localhost:8123", "127.0.0.1:8123"])
def test_loopback_hosts_can_read_ifc(sample_path: Path, host: str) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.get("/api/model.ifc", headers={"Host": host})
    assert response.status_code == 200
    assert response.content == sample_path.read_bytes()


def test_explicit_lan_host_can_read_ifc(sample_path: Path) -> None:
    client = TestClient(build_app(sample_path, allowed_hosts=("192.0.2.10",)), base_url="http://127.0.0.1")
    assert client.get("/api/model.ifc", headers={"Host": "192.0.2.10:8123"}).content == sample_path.read_bytes()
    assert client.get("/api/model.ifc", headers={"Host": "192.0.2.11:8123"}).status_code == 400


@pytest.mark.parametrize(
    "host",
    [
        "localhost:bad",
        "localhost@untrusted.example",
        "localhost/path",
        "[::1",
        "localhost.",
        "0.0.0.0:8123",
        "testserver",
        "",
    ],
)
def test_malformed_hosts_are_rejected(sample_path: Path, host: str) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.get("/api/model.ifc", headers={"Host": host})
    assert response.status_code == 400


@pytest.mark.parametrize(
    "origin",
    [
        "https://untrusted.example",
        "null",
        "http://localhost:8137.untrusted.example",
        "http://127.0.0.1:9999",
        "https://127.0.0.1",
    ],
)
def test_cross_origin_upload_cannot_write_underlay(sample_path: Path, origin: str) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.post(
        "/api/trace/underlay",
        headers={"Origin": origin},
        files={"file": ("underlay.png", b"untrusted", "image/png")},
        data={"width_px": "100", "height_px": "100"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "untrusted_origin"
    assert not (sample_path.parent / "references" / "underlay.png").exists()


@pytest.mark.parametrize("origin", [None, "http://127.0.0.1", "http://127.0.0.1:5173", "http://localhost:5173"])
def test_local_writes_reach_the_api(sample_path: Path, origin: str | None) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.post("/api/imports", headers={"Origin": origin} if origin else {})
    assert response.status_code == 422


def test_cross_origin_delete_cannot_remove_underlay(sample_path: Path) -> None:
    underlay = sample_path.parent / "references" / "underlay.png"
    underlay.parent.mkdir(parents=True, exist_ok=True)
    underlay.write_bytes(b"kept")
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.delete("/api/trace/underlay", headers={"Origin": "https://untrusted.example"})
    assert response.status_code == 403
    assert underlay.read_bytes() == b"kept"


@pytest.mark.parametrize("host", ["0.0.0.0", "::"])
def test_wildcard_bind_requires_an_allowed_host(
    sample_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], host: str
) -> None:
    monkeypatch.setattr(sys, "argv", ["home-twin-ui", "--model", str(sample_path), "--host", host, "--no-open"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2
    assert "--allowed-host" in capsys.readouterr().err
