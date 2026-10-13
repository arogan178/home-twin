"""Blender-side checks called by test_blender_details, with real meshes and booleans."""

import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "blender"))
from appliance_details import appliance_detail  # noqa: E402
from furniture_details import furniture_detail  # noqa: E402
from render_finishes import bounds, build_palette, import_geometry  # noqa: E402

folder = Path(sys.argv[-1])
args = SimpleNamespace(panels="walnut", stone="cloudy", paint="warm", trim="black", scene=folder / "kitchen.obj")


def endpoints(record):
    return tuple(Vector([record["bounds_mm"][side][axis]/1000 for axis in "xyz"])
                 for side in ("minimum", "maximum"))


def mesh_points(item):
    graph = bpy.context.evaluated_depsgraph_get()
    evaluated = item.evaluated_get(graph)
    mesh = evaluated.to_mesh()
    points = [evaluated.matrix_world @ v.co for v in mesh.vertices]
    evaluated.to_mesh_clear()
    return points


for record in json.loads((folder / "furniture.json").read_text())["objects"]:
    role = record.get("declared", {}).get("Role")
    if role not in {"chair", "stool", "table"}:
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    palette = build_palette(args)
    lo, hi = endpoints(record)
    assert furniture_detail(record, lo, hi, palette)
    if role in {"chair", "stool"}:
        back = bpy.data.objects["Curved upholstered backrest"]
        points = mesh_points(back)
        centre = (lo+hi)/2
        bearing = math.radians(record["declared"]["BearingDeg"])
        front = Vector((math.cos(bearing), math.sin(bearing), 0))
        depth = record["declared"]["DepthMm"]/1000
        assert all((p-centre).dot(front) <= -depth/2+0.055 for p in points), "Back exceeds IFC rear strip"
        assert max(p.z for p in points) <= hi.z + 0.001
    else:
        top = bpy.data.objects["Dining top"]
        points = [v.co for v in top.data.vertices]
        # A stadium of radius 0.6 and straight span 0.6 has no rectangular corners.
        for p in points:
            cap_y = max(abs(p.y)-0.3, 0)
            assert p.x*p.x+cap_y*cap_y <= 0.6**2+1e-6
        assert max(p.y for p in points)-min(p.y for p in points) > 1.799

meta = json.loads((folder / "kitchen.json").read_text())
for record in meta["objects"]:
    d = record.get("declared", {})
    if d.get("Appliance") != "coffee_machine" and d.get("Front") != "open":
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    palette = build_palette(args)
    lo, hi = endpoints(record)
    assert appliance_detail(record, lo, hi, palette)
    bpy.context.view_layer.update()
    for item in bpy.context.scene.objects:
        for point in mesh_points(item) if item.type in {"MESH", "CURVE"} else []:
            assert all(lo[i]-0.005 <= point[i] <= hi[i]+0.005 for i in range(3)), (item.name, point, lo, hi)
    if d.get("Front") == "open":
        low, high = bounds(bpy.data.objects["Niche back"])
        assert low.x > hi.x-0.02, "West-facing shelf back must be at its east rear face"

bpy.ops.wm.read_factory_settings(use_empty=True)
palette = build_palette(args)
import_geometry(args, meta, palette)
bpy.context.view_layer.update()
for record in meta["objects"]:
    if record.get("declared", {}).get("Role") not in {"base", "worktop"}:
        continue
    item = next(o for o in bpy.context.scene.objects if record["id"] in o.name)
    graph = bpy.context.evaluated_depsgraph_get()
    evaluated = item.evaluated_get(graph)
    hit, location, normal, index = evaluated.ray_cast(Vector((0.7, 3.7, 1.1)), Vector((0, 0, -1)))
    assert not hit or location.z < 0.71, "The cabinet or worktop still caps the sink"
assert "Arched mixer spout" in bpy.data.objects
assert "Sink bowl bottom" in bpy.data.objects
print("render geometry checks passed")
