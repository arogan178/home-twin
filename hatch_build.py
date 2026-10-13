"""Bundle a prebuilt browser UI without requiring it for Python development."""

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class UIBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        ui = Path(self.root) / "ui" / "dist"
        if version == "editable" or not (ui / "index.html").is_file():
            return
        destination = "home_twin/ui_dist" if self.target_name == "wheel" else "ui/dist"
        build_data["force_include"][str(ui)] = destination
