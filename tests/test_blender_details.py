"""Exercise the actual Blender meshes derived from saved synthetic IFC models."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from home_twin.furniture import DiningFurniture, save_dining_furniture
from home_twin.kitchen import KitchenUnit, save_kitchen_units
from home_twin.model import HomeTwin, Point3D

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.export_render_scene import collect_scene, write_geometry  # noqa: E402


@pytest.mark.skipif(shutil.which("blender") is None, reason="Blender is not installed")
def test_ifc_render_details_preserve_pose_shape_and_openings(sample_path, tmp_path):
    room = HomeTwin.open(sample_path).get_rooms()[0]
    chairs = tuple(
        DiningFurniture(f"DC{i}", "chair", Point3D(x, y, 0), 500, 500, 800, bearing_deg=bearing)
        for i, (x, y, bearing) in enumerate(((1500, 1000, 0), (4500, 1000, 90),
                                            (1500, 3000, 180), (4500, 3000, 270)))
    )
    table = DiningFurniture("DT1", "table", Point3D(3000, 2000, 0), 1200, 1800, 750, shape="oval")
    stool = DiningFurniture("BS1", "stool", Point3D(3000, 500, 0), 380, 350, 1000, "east")
    save_dining_furniture(sample_path, room.id, (*chairs, table, stool))
    furniture = collect_scene(sample_path)
    (tmp_path / "furniture.json").write_text(json.dumps(furniture))
    # Units stay separate from seats so the synthetic layout has no accidental collision.
    units = (
        KitchenUnit("B1", "Sink base", "base", Point3D(700, 3700, 0), 600, 600, 870, "south"),
        KitchenUnit("W1", "Worktop", "worktop", Point3D(700, 3700, 870), 600, 600, 30, "south"),
        KitchenUnit("S1", "Sink", "appliance", Point3D(700, 3700, 700), 400, 400, 200,
                    "south", appliance="sink"),
        KitchenUnit("C1", "Coffee", "appliance", Point3D(5500, 3500, 900), 300, 400, 380,
                    "west", appliance="coffee_machine"),
        KitchenUnit("H1", "Cup shelf", "wall", Point3D(5500, 3500, 1800), 900, 400, 500,
                    "west", front="open"),
    )
    save_kitchen_units(sample_path, room.id, units)
    (tmp_path / "kitchen.json").write_text(json.dumps(collect_scene(sample_path)))
    write_geometry(sample_path, tmp_path / "kitchen.obj")
    result = subprocess.run(
        [shutil.which("blender"), "--background", "--python-exit-code", "1", "--python",
         str(ROOT / "tests" / "blender_detail_checks.py"), "--", str(tmp_path)],
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "render geometry checks passed" in result.stdout
