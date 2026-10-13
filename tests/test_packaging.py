"""Check real package archives with and without a prebuilt browser UI."""

from __future__ import annotations

import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is required to build package archives")
@pytest.mark.parametrize("with_ui", [False, True])
def test_package_build_preserves_optional_ui(tmp_path: Path, with_ui: bool) -> None:
    root = Path(__file__).resolve().parents[1]
    project = tmp_path / "project"
    project.mkdir()
    for name in ("pyproject.toml", "hatch_build.py", "README.md", "LICENSE", ".gitignore"):
        shutil.copy2(root / name, project / name)
    shutil.copytree(root / "src", project / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if with_ui:
        ui = project / "ui" / "dist"
        (ui / "assets").mkdir(parents=True)
        (ui / "index.html").write_text("<!doctype html><title>Packaged Home Twin</title>")
        (ui / "assets" / "app.js").write_text("document.title = 'Packaged Home Twin';")

    result = subprocess.run(
        ["uv", "build", "--out-dir", str(tmp_path / "dist")],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    with zipfile.ZipFile(next((tmp_path / "dist").glob("*.whl"))) as wheel:
        assert ("home_twin/ui_dist/index.html" in wheel.namelist()) is with_ui
        if with_ui:
            assert wheel.read("home_twin/ui_dist/assets/app.js") == b"document.title = 'Packaged Home Twin';"
    with tarfile.open(next((tmp_path / "dist").glob("*.tar.gz"))) as source:
        names = source.getnames()
        assert any(name.endswith("/hatch_build.py") for name in names)
        assert any(name.endswith("/ui/dist/index.html") for name in names) is with_ui
