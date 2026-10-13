"""Record the browser UI's server reads on the demo home, for the static demo.

Builds the lit demo model, runs the real FastAPI app in process, and saves every
GET the UI makes as a static file under ``<output>/api``. The read-only demo
build of the UI resolves its requests to these files instead of a server. The
saved layout's analysis is recorded too, so the demo can show it until the
visitor edits the layout.

    uv run python scripts/record_demo.py ui/dist-demo
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_demo_model import build  # noqa: E402

from home_twin.ui_server import build_app  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PRESETS = json.loads((ROOT / "ui" / "src" / "demoPresets.json").read_text())
UNDERLAY_URL = "/api/trace/underlay/file"


def demo_file(url: str, suffix: str = ".json") -> str:
    """Map a UI request URL to its recorded file; mirrors demoFile in ui/src/demo.ts."""

    path, _, query = url.partition("?")
    key = unquote(path.removeprefix("/api/")) + (f"/{unquote(query)}" if query else "")
    return "api/" + re.sub(r"[^A-Za-z0-9/._-]", lambda match: f"~{ord(match.group()):02x}", key) + suffix


def _layout_body(design: dict[str, Any]) -> dict[str, Any]:
    """The analysis request the UI sends for an unedited room, as api.ts builds it."""

    fixture_keys = ("kind", "tag", "point", "spec", "switching_group", "direction", "notes")
    switch_keys = (
        "tag", "host_wall_id", "offset_mm", "mounting_height_mm", "switching_group", "spec", "mounting_face", "notes"
    )
    for fixture in design["fixtures"]:
        if fixture["kind"] != "recessed_spotlight":
            raise ValueError(f"The demo recorder only replays spotlights, not {fixture['kind']}")
    return {
        "fixtures": [{key: fixture[key] for key in fixture_keys} for fixture in design["fixtures"]],
        "switches": [{key: switch[key] for key in switch_keys} for switch in design["switches"]],
    }


def record(output: Path, project_root: Path) -> list[str]:
    """Write every recording under ``output`` and return the URLs recorded."""

    model = build(project_root)
    client = TestClient(build_app(model), base_url="http://127.0.0.1")
    prefix = f"{project_root}/"
    written: list[str] = []

    def save(url: str, payload: Any) -> Any:
        text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        # The recording machine's temporary paths mean nothing to a visitor.
        text = text.replace(prefix, "")
        target = output / demo_file(url)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        written.append(url)
        return json.loads(text)

    def get(url: str) -> Any:
        response = client.get(url)
        response.raise_for_status()
        return save(url, response.json())

    project = get("/api/project")
    get("/api/site")
    get("/api/plan")
    trace = client.get("/api/trace").json()
    if trace["underlay_url"] is not None:
        underlay = client.get(UNDERLAY_URL)
        underlay.raise_for_status()
        target = output / demo_file(UNDERLAY_URL, ".png")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(underlay.content)
        written.append(UNDERLAY_URL)
        # Relative to the demo page, so it resolves under any Pages base path.
        trace["underlay_url"] = demo_file(UNDERLAY_URL, ".png")
    save("/api/trace", trace)

    for room in project["rooms"]:
        room_path = f"/api/rooms/{quote(room['id'], safe='')}"
        design = get(f"{room_path}/design")
        analysis = client.post(f"{room_path}/analysis", json=_layout_body(design))
        analysis.raise_for_status()
        save(f"{room_path}/analysis", analysis.json())
        for date in PRESETS["dates"]:
            for time in PRESETS["times"]:
                for plane in PRESETS["planes"]:
                    get(f"{room_path}/daylight?at={quote(f'{date}T{time}:00', safe='')}&plane={plane}")
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output", type=Path, help="Demo build directory; recordings go under its api/ folder")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="home-twin-demo-") as project:
        written = record(args.output.resolve(), Path(project).resolve())
    files = list((args.output / "api").rglob("*"))
    size = sum(path.stat().st_size for path in files if path.is_file())
    print(f"Recorded {len(written)} responses, {size / 1024:.0f} KiB, under {args.output / 'api'}")


if __name__ == "__main__":
    main()
