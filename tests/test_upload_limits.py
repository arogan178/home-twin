from __future__ import annotations

import asyncio
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette import formparsers

from home_twin.http_security import BodyLimits
from home_twin.ui_server import MAX_IFC_BYTES, MAX_UNDERLAY_BYTES, build_app

BOUNDARY = "home-twin-limit-test"
MIB = 1024 * 1024


def _underlay_parts(file_bytes: Iterator[bytes]) -> Iterator[bytes]:
    for name, value in (("width_px", "100"), ("height_px", "100")):
        yield f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    yield (
        f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode()
    yield from file_bytes
    yield f"\r\n--{BOUNDARY}--\r\n".encode()


def _no_temp_files(sample_path: Path) -> bool:
    references = sample_path.parent / "references"
    leftovers = [*sample_path.parent.glob(".incoming-*")]
    if references.exists():
        leftovers += [*references.glob(".underlay-*"), *references.glob("underlay.*")]
    return not leftovers


@pytest.mark.parametrize(
    ("path", "declared", "message"),
    [
        ("/api/imports", MAX_IFC_BYTES * 2, "IFC files must be 250 MB or smaller"),
        ("/api/trace/underlay", MAX_UNDERLAY_BYTES * 2, "Reference images must be 40 MB or smaller"),
    ],
)
def test_an_oversized_content_length_is_refused_before_the_body_is_read(
    sample_path: Path, path: str, declared: int, message: str
) -> None:
    read = False

    def body() -> Iterator[bytes]:
        nonlocal read
        read = True
        yield b"never sent"

    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.post(
        path,
        content=body(),
        headers={
            "Content-Type": f"multipart/form-data; boundary={BOUNDARY}",
            "Content-Length": str(declared),
        },
    )
    assert response.status_code == 413
    assert response.json() == {"detail": message}
    assert not read


def test_a_chunked_oversized_upload_is_cut_off_and_leaves_no_temp_file(
    sample_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    spooled = 0

    class CountingSpool(tempfile.SpooledTemporaryFile):
        def write(self, data: bytes) -> int:
            nonlocal spooled
            spooled += len(data)
            return super().write(data)

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", CountingSpool)
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    chunks = (b"\0" * MIB for _ in range(MAX_UNDERLAY_BYTES // MIB + 1))

    response = client.post(
        "/api/trace/underlay",
        content=_underlay_parts(chunks),
        headers={"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Reference images must be 40 MB or smaller"}
    assert spooled <= MAX_UNDERLAY_BYTES
    assert _no_temp_files(sample_path)


def test_an_underlay_exactly_at_the_limit_is_stored(sample_path: Path) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.post(
        "/api/trace/underlay",
        files={"file": ("scan.png", b"\0" * MAX_UNDERLAY_BYTES, "image/png")},
        data={"width_px": "100", "height_px": "100"},
    )
    assert response.status_code == 200
    assert response.json()["size_bytes"] == MAX_UNDERLAY_BYTES
    assert (sample_path.parent / "references" / "underlay.png").stat().st_size == MAX_UNDERLAY_BYTES


def test_an_underlay_one_byte_over_the_limit_is_refused(sample_path: Path) -> None:
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    response = client.post(
        "/api/trace/underlay",
        files={"file": ("scan.png", b"\0" * (MAX_UNDERLAY_BYTES + 1), "image/png")},
        data={"width_px": "100", "height_px": "100"},
    )
    assert response.status_code == 413
    assert response.json() == {"detail": "Reference images must be 40 MB or smaller"}
    assert not (sample_path.parent / "references" / "underlay.png").exists()


def test_the_limit_stops_pulling_chunks_once_it_is_crossed() -> None:
    pulled = 0
    sent: list[dict] = []

    async def app(scope, receive, send) -> None:
        while (await receive()).get("more_body"):
            pass
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"stored"})

    async def receive() -> dict:
        nonlocal pulled
        pulled += 1
        return {"type": "http.request", "body": b"x" * 10, "more_body": True}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {"type": "http", "path": "/upload", "method": "POST", "headers": []}
    asyncio.run(BodyLimits(app, {"/upload": (25, "too big")})(scope, receive, send))

    assert pulled == 3
    assert sent[0]["status"] == 413
    assert sent[1]["body"] == b'{"detail":"too big"}'
