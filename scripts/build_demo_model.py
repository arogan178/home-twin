"""Compile the synthetic demo home and light it, for the static browser demo.

The plan compiler turns ``examples/demo/plan.yaml`` into a verified draft IFC,
then each room's lighting is applied through the same validated, reopened IFC
transaction the MCP tools and the browser use. The layout follows the design
brief: 3000 K CRI 90 downlights in pools over the places people use, not a grid,
one switch per lit room by its door, and a separate kitchen circuit.

The bathroom stays unlit on purpose: in a 2 m square room the 600 mm ceiling-edge
clearance leaves only the rooflight's own footprint, and a downlight does not go
in a rooflight.

    uv run python scripts/build_demo_model.py build/demo-project
"""

from __future__ import annotations

import argparse
import itertools
import math
import shutil
from pathlib import Path
from unittest import mock

import ifcopenshell.guid

from home_twin.fixtures import PlannedSpotlight, PlannedWallSwitch, RoomLightingDesign, SpotlightSpec
from home_twin.geometry import Point3D
from home_twin.model import HomeTwin
from home_twin.plan_draft import build_draft

DEMO = Path(__file__).resolve().parents[1] / "examples" / "demo"

SPOT = SpotlightSpec(beam_angle_deg=36)
SWITCH_HEIGHT_MM = 1050

Spot = tuple[str, float, float, SpotlightSpec, str, str]  # tag, x, y, spec, group, note
Switch = tuple[str, float, float, str]  # tag, a point on the host wall face, group

LAYOUT: dict[str, tuple[tuple[Spot, ...], tuple[Switch, ...]]] = {
    "Living and kitchen": (
        (
            ("SP01", 3800, 5300, SPOT, "KITCHEN", "Worktop pool along the north wall"),
            ("SP02", 5000, 5300, SPOT, "KITCHEN", "Worktop pool along the north wall"),
            ("SP03", 800, 1100, SPOT, "LIVING", "Landing light inside the front door"),
            ("SP04", 2400, 2000, SPOT, "LIVING", "Seating pool by the terrace slider"),
            ("SP05", 3600, 2000, SPOT, "LIVING", "Seating pool by the terrace slider"),
        ),
        (
            ("SW01", 0, 1900, "LIVING"),
            ("SW02", 6000, 4400, "KITCHEN"),
        ),
    ),
    "Sunken snug": (
        (
            ("SP06", 8100, 1000, SPOT, "SNUG", "Reading pool beside the window"),
            ("SP07", 8100, 2000, SPOT, "SNUG", "Reading pool beside the window"),
        ),
        (("SW03", 7000, 3000, "SNUG"),),
    ),
    "Bedroom": (
        (
            ("SP08", 7000, 4000, SPOT, "BEDROOM", "Dressing pool inside the door"),
            ("SP09", 8300, 4500, SPOT, "BEDROOM", "Window-side pool"),
        ),
        (("SW04", 6000, 4400, "BEDROOM"),),
    ),
}


def _deterministic_guids():
    """IfcOpenShell mints random GlobalIds; a seeded counter makes rebuilds identical."""

    counter = itertools.count(1)
    return mock.patch.object(
        ifcopenshell.guid,
        "new",
        lambda: ifcopenshell.guid.compress(f"{0xD3E0:08x}{next(counter):024x}"),
    )


def _switch(twin: HomeTwin, room_id: str, tag: str, x: float, y: float, group: str) -> PlannedWallSwitch:
    """Host a switch on the room's wall face nearest (x, y), measured from that face's start."""

    def gap(wall) -> float:
        dx, dy = wall.end.x - wall.start.x, wall.end.y - wall.start.y
        length = math.hypot(dx, dy)
        along = ((x - wall.start.x) * dx + (y - wall.start.y) * dy) / length
        if not 0 <= along <= length:
            return math.inf
        return abs((x - wall.start.x) * dy - (y - wall.start.y) * dx) / length

    wall = min(twin.get_room_context(room_id).walls, key=gap)
    offset = math.hypot(x - wall.start.x, y - wall.start.y)
    return PlannedWallSwitch(tag, room_id, wall.wall_id, round(offset), SWITCH_HEIGHT_MM, group)


def build(project_root: Path) -> Path:
    references = project_root / "model" / "references"
    references.mkdir(parents=True, exist_ok=True)
    for name in ("plan.yaml", "underlay.png"):
        shutil.copy2(DEMO / name, references / name)
    draft = project_root / "model" / "draft.ifc"
    draft.unlink(missing_ok=True)
    with _deterministic_guids():
        path = build_draft(project_root).path
        twin = HomeTwin.open(path)
        rooms = {room.name: room for room in twin.get_rooms()}
        for name, (spots, switches) in LAYOUT.items():
            room = rooms[name]
            ceiling_z = twin.get_room_context(room.id).ceiling.elevation_mm
            design = RoomLightingDesign(
                room.id,
                tuple(
                    PlannedSpotlight(tag, room.id, Point3D(x, y, ceiling_z), spec, group, notes=(note,))
                    for tag, x, y, spec, group, note in spots
                ),
                tuple(_switch(twin, room.id, tag, x, y, group) for tag, x, y, group in switches),
            )
            twin.apply_room_lighting_design(design, expected_revision=twin.revision)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("project_root", type=Path, help="Directory to create the demo project in")
    path = build(parser.parse_args().project_root.resolve())
    print(path)


if __name__ == "__main__":
    main()
