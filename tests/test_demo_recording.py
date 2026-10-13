"""The static demo's recordings cover every server read the browser UI makes."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import unquote

import pytest
from starlette.routing import Route

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from record_demo import demo_file, record  # noqa: E402

from home_twin.ui_server import build_app  # noqa: E402

# GET routes the browser UI never calls. A new read the UI uses must be recorded, not listed here.
NOT_USED_BY_UI = {"/api/health", "/api/model.ifc", "/api/exports/{file_name}"}


@pytest.fixture(scope="module")
def recording(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, list[str], Path]:
    output = tmp_path_factory.mktemp("demo")
    project = tmp_path_factory.mktemp("project")
    return output, record(output, project), project


def test_file_mapping_matches_the_ui() -> None:
    # The same vectors are asserted against ui/src/demo.ts in demo.test.ts.
    assert demo_file("/api/project") == "api/project.json"
    assert (
        demo_file("/api/rooms/1iK%24u5yiLN%249MWFffEjU2s/daylight?at=2026-06-21T09%3A00%3A00&plane=floor")
        == "api/rooms/1iK~24u5yiLN~249MWFffEjU2s/daylight/at~3d2026-06-21T09~3a00~3a00~26plane~3dfloor.json"
    )
    assert demo_file("/api/trace/underlay/file", ".png") == "api/trace/underlay/file.png"


def test_every_ui_read_route_is_recorded(recording: tuple[Path, list[str], Path]) -> None:
    _output, urls, project = recording
    routes = [
        route
        for route in build_app(project / "model" / "draft.ifc").routes
        if isinstance(route, Route)
        and route.path.startswith("/api/")
        and "GET" in (route.methods or set())
        and route.path not in NOT_USED_BY_UI
    ]
    assert routes
    for route in routes:
        assert any(route.path_regex.match(unquote(url.partition("?")[0])) for url in urls), route.path


def test_every_recording_is_on_disk_and_paths_are_project_relative(recording: tuple[Path, list[str], Path]) -> None:
    output, urls, _project = recording
    for url in urls:
        suffix = ".png" if url == "/api/trace/underlay/file" else ".json"
        assert (output / demo_file(url, suffix)).is_file(), url
    project = json.loads((output / demo_file("/api/project")).read_text())
    assert project["model_path"] == "model/draft.ifc"
    trace = json.loads((output / demo_file("/api/trace")).read_text())
    assert trace["underlay_url"] == "api/trace/underlay/file.png"


def test_recorded_analysis_is_the_saved_layout(recording: tuple[Path, list[str], Path]) -> None:
    output, _urls, _project = recording
    project = json.loads((output / demo_file("/api/project")).read_text())
    lit = 0
    for room in project["rooms"]:
        base = f"/api/rooms/{room['id']}"
        design = json.loads((output / demo_file(f"{base}/design")).read_text())
        analysis = json.loads((output / demo_file(f"{base}/analysis")).read_text())
        assert analysis["analysis"] == design["analysis"]
        lit += bool(design["fixtures"])
    assert lit == 3

