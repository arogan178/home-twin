"""Render a Home Twin scene with illustrative finishes, headless, in Cycles.

This is a materials picture, not a measurement, and it is deliberately kept
apart from ``blender/render_scene.py``. That renderer paints every surface at
the reflectance the lighting model assumes, and it stays that way: a coloured
render must never be mistaken for the photometric one. Nothing here feeds a lux
number. See docs/validation.md.

Feed it what ``scripts/export_render_scene.py`` wrote. The OBJ names products by
GlobalId only, so the scene JSON's ``objects`` list is what maps a surface back
to the thing it is:

    blender --background --python blender/render_finishes.py -- \
        --scene exports/draft-scene.obj \
        --meta exports/draft-scene.json \
        --camera 21.5,1.0,3.4 --target 18.8,7.2,2.0 \
        --out exports/kitchen-study/walnut.png
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import mathutils

sys.path.insert(0, str(Path(__file__).resolve().parent))
from appliance_details import appliance_detail, cut_sink_apertures  # noqa: E402
from furniture_details import furniture_detail, lounge_detail  # noqa: E402

LUMENS_PER_WATT = 683.0
FIXTURE_DROP_M = 0.05
CEILING_CLASS = "IfcCovering"
LIGHT_CLASS = "IfcLightFixture"

PANEL_BATTEN_M = 0.018
PANEL_FACE_M = 0.019
PANEL_GAP_M = 0.006
PANEL_TARGET_M = 1.0
# Egger boards are 2800 long with the grain running the length, so a taller
# run cannot be one vertical-grain piece.
PANEL_BOARD_M = 2.8
# The panel hangs clear of what is under it; the dark ground runs on down past
# it, or the reveal shows pale wall and reads as a gap rather than a shadow.
PANEL_REVEAL_M = 0.012
# A body this shallow is a recessed can; a pendant carries its drop.
DOWNLIGHT_PLAN_LIMIT_M = 0.25
"""Widest a recessed downlight gets on plan; a 68-75 mm cut-out plus its trim."""
RECESSED_BODY_LIMIT_M = 0.15
TRIM_THICKNESS_M = 0.006
# The ceiling covering hangs below the fixture point, so a trim placed at that
# point is buried in the board and never renders.
CEILING_BOARD_M = 0.012


def parse_arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="render_finishes")
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--meta", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--camera", default=None, help="x,y,z in metres")
    parser.add_argument("--views", type=Path, help="JSON list of named camera/target review views")
    parser.add_argument("--target", default=None, help="x,y,z in metres")
    parser.add_argument("--panels", choices=("walnut", "black"), default="walnut")
    parser.add_argument("--stone", choices=("warm", "cool", "viola", "cloudy"), default="cool")
    parser.add_argument("--paint", choices=("cool", "warm"), default="cool")
    parser.add_argument("--trim", choices=("black", "white"), default="black")
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument(
        "--device", default="auto", help="auto, cpu, or a backend name such as hip"
    )
    parser.add_argument("--review-quality", type=int, default=85, help="JPEG quality of the review copy")
    parser.add_argument("--exposure", type=float, default=3.4)
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--height", type=int, default=1100)
    parser.add_argument("--focal", type=float, default=24.0)
    parser.add_argument("--ortho-width", type=float, default=0.0, help="metres; 0 keeps perspective")
    args = parser.parse_args(argv)
    if not args.views and not (args.camera and args.target):
        parser.error("provide --views or both --camera and --target")
    return args


def vector(text: str) -> mathutils.Vector:
    return mathutils.Vector([float(part) for part in text.split(",")])


# --- material helpers -------------------------------------------------------


def new_material(name: str) -> tuple[bpy.types.Material, object, object]:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    principled = tree.nodes["Principled BSDF"]
    # World position, not object space: a generated box is a scaled unit cube,
    # so its object coordinates span +/-0.5 whatever its real size, and every
    # procedural texture collapses to a single flat value on it.
    coordinate = tree.nodes.new("ShaderNodeNewGeometry")
    return material, tree, (principled, coordinate)


def set_specular(principled, value: float) -> None:
    if "Specular IOR Level" in principled.inputs:
        principled.inputs["Specular IOR Level"].default_value = value


def ramp(tree, stops: list[tuple[float, tuple[float, float, float]]]):
    node = tree.nodes.new("ShaderNodeValToRGB")
    elements = node.color_ramp.elements
    while len(elements) > 1:
        elements.remove(elements[-1])
    elements[0].position = stops[0][0]
    elements[0].color = (*stops[0][1], 1.0)
    for position, colour in stops[1:]:
        element = elements.new(position)
        element.color = (*colour, 1.0)
    return node


def timber_material(name: str, stops, roughness: float, grain_scale: float = 18.0):
    """Noise stretched hard along the board reads as grain; wave bands read as tiger stripe."""

    material, tree, (principled, coordinate) = new_material(name)
    mapping = tree.nodes.new("ShaderNodeMapping")
    # Fast variation across the board, slow along it, so the figure runs long.
    mapping.inputs["Scale"].default_value = (grain_scale, grain_scale, 1.0)
    tree.links.new(coordinate.outputs["Position"], mapping.inputs["Vector"])

    figure = tree.nodes.new("ShaderNodeTexNoise")
    figure.inputs["Scale"].default_value = 2.2
    figure.inputs["Detail"].default_value = 7.0
    figure.inputs["Roughness"].default_value = 0.55
    tree.links.new(mapping.outputs["Vector"], figure.inputs["Vector"])

    colour = ramp(tree, stops)
    tree.links.new(figure.outputs["Fac"], colour.inputs["Fac"])
    tree.links.new(colour.outputs["Color"], principled.inputs["Base Color"])

    pores = tree.nodes.new("ShaderNodeTexNoise")
    pores.inputs["Scale"].default_value = 26.0
    pores.inputs["Detail"].default_value = 4.0
    tree.links.new(mapping.outputs["Vector"], pores.inputs["Vector"])

    rough = tree.nodes.new("ShaderNodeMapRange")
    rough.inputs["To Min"].default_value = roughness - 0.05
    rough.inputs["To Max"].default_value = roughness + 0.05
    tree.links.new(pores.outputs["Fac"], rough.inputs["Value"])
    tree.links.new(rough.outputs["Result"], principled.inputs["Roughness"])

    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.06
    bump.inputs["Distance"].default_value = 0.00025
    tree.links.new(pores.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    set_specular(principled, 0.45)
    return material


def stone_material(name: str, base, vein, roughness: float = 0.20, halo=None):
    """Noise warped by noise gives soft branching veins; bands give contour lines."""

    material, tree, (principled, coordinate) = new_material(name)
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.0, 1.0, 1.0)
    tree.links.new(coordinate.outputs["Position"], mapping.inputs["Vector"])

    warp = tree.nodes.new("ShaderNodeTexNoise")
    warp.inputs["Scale"].default_value = 0.9
    warp.inputs["Detail"].default_value = 4.0
    tree.links.new(mapping.outputs["Vector"], warp.inputs["Vector"])

    displace = tree.nodes.new("ShaderNodeVectorMath")
    displace.operation = "ADD"
    tree.links.new(mapping.outputs["Vector"], displace.inputs[0])
    tree.links.new(warp.outputs["Color"], displace.inputs[1])

    veins = tree.nodes.new("ShaderNodeTexNoise")
    veins.inputs["Scale"].default_value = 1.4
    veins.inputs["Detail"].default_value = 6.0
    veins.inputs["Roughness"].default_value = 0.45
    tree.links.new(displace.outputs["Vector"], veins.inputs["Vector"])

    # Noise Fac clusters tightly around 0.5, so a band even a few hundredths
    # wide veins most of the slab. Keep it thin or the stone reads as solid grey.
    stops = (
        [(0.0, base), (0.492, base), (0.5, vein), (0.508, base), (1.0, base)]
        if halo is None
        # Viola's veins carry an amber margin; without it the purple reads as ink.
        else [
            (0.0, base),
            (0.484, base),
            (0.491, halo),
            (0.4945, vein),
            (0.5055, vein),
            (0.509, halo),
            (0.516, base),
            (1.0, base),
        ]
    )
    colour = ramp(tree, stops)
    tree.links.new(veins.outputs["Fac"], colour.inputs["Fac"])
    tree.links.new(colour.outputs["Color"], principled.inputs["Base Color"])
    principled.inputs["Roughness"].default_value = roughness
    set_specular(principled, 0.6)
    return material


def clouded_material(name: str, base, cloud, roughness: float = 0.22):
    """Soft marble-effect porcelain: broad mottling, no vein line.

    A vein needs a narrow band on the ramp. Clouding is the opposite — a wide,
    gentle transition across most of the noise range.
    """

    material, tree, (principled, coordinate) = new_material(name)
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (0.9, 0.9, 0.9)
    tree.links.new(coordinate.outputs["Position"], mapping.inputs["Vector"])

    broad = tree.nodes.new("ShaderNodeTexNoise")
    broad.inputs["Scale"].default_value = 0.7
    broad.inputs["Detail"].default_value = 5.0
    broad.inputs["Roughness"].default_value = 0.6
    tree.links.new(mapping.outputs["Vector"], broad.inputs["Vector"])

    colour = ramp(tree, [(0.36, base), (0.5, cloud), (0.66, base)])
    tree.links.new(broad.outputs["Fac"], colour.inputs["Fac"])
    tree.links.new(colour.outputs["Color"], principled.inputs["Base Color"])
    principled.inputs["Roughness"].default_value = roughness
    set_specular(principled, 0.6)
    return material


def tile_material(name: str, face, grout):
    material, tree, (principled, coordinate) = new_material(name)
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.65, 1.65, 1.65)
    tree.links.new(coordinate.outputs["Position"], mapping.inputs["Vector"])

    brick = tree.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.0
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Mortar Size"].default_value = 0.006
    brick.inputs["Brick Width"].default_value = 1.0
    brick.inputs["Row Height"].default_value = 1.0
    brick.inputs["Color1"].default_value = (*face, 1.0)
    brick.inputs["Color2"].default_value = (*[c * 0.96 for c in face], 1.0)
    brick.inputs["Mortar"].default_value = (*grout, 1.0)
    tree.links.new(mapping.outputs["Vector"], brick.inputs["Vector"])
    tree.links.new(brick.outputs["Color"], principled.inputs["Base Color"])

    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 24.0
    tree.links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    rough = tree.nodes.new("ShaderNodeMapRange")
    rough.inputs["To Min"].default_value = 0.28
    rough.inputs["To Max"].default_value = 0.40
    tree.links.new(noise.outputs["Fac"], rough.inputs["Value"])
    tree.links.new(rough.outputs["Result"], principled.inputs["Roughness"])
    set_specular(principled, 0.5)
    return material


def flat_material(name: str, colour, roughness: float, metallic: float = 0.0):
    material, tree, (principled, _coordinate) = new_material(name)
    principled.inputs["Base Color"].default_value = (*colour, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    set_specular(principled, 0.5)
    return material


def glass_material(name: str):
    material, tree, (principled, _coordinate) = new_material(name)
    principled.inputs["Base Color"].default_value = (0.86, 0.91, 0.92, 1.0)
    principled.inputs["Roughness"].default_value = 0.05
    principled.inputs["Transmission Weight"].default_value = 0.92
    principled.inputs["IOR"].default_value = 1.45
    return material


def textile_material(name, colour):
    material, tree, (principled, coordinate) = new_material(name)
    principled.inputs["Base Color"].default_value = (*colour, 1)
    principled.inputs["Roughness"].default_value = 0.90
    principled.inputs["Sheen Weight"].default_value = 0.30
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 950
    noise.inputs["Detail"].default_value = 2
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.22
    bump.inputs["Distance"].default_value = 0.00035
    tree.links.new(coordinate.outputs["Position"], noise.inputs["Vector"])
    tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    return material


def build_palette(args: argparse.Namespace) -> dict:
    walnut = timber_material(
        "walnut",
        [(0.0, (0.0150, 0.0082, 0.0050)), (0.45, (0.0400, 0.0218, 0.0128)), (1.0, (0.0820, 0.0462, 0.0272))],
        0.42,
    )
    if args.panels == "black":
        panel = timber_material(
            "panel_black",
            [(0.0, (0.0035, 0.0035, 0.0040)), (0.5, (0.0090, 0.0088, 0.0090)), (1.0, (0.0200, 0.0192, 0.0185))],
            0.42,
        )
    else:
        panel = timber_material(
            "panel_walnut",
            [(0.0, (0.0140, 0.0076, 0.0046)), (0.45, (0.0375, 0.0204, 0.0120)), (1.0, (0.0770, 0.0434, 0.0256))],
            0.32,
        )
    if args.stone == "warm":
        stone = stone_material("stone_taj", (0.800, 0.735, 0.578), (0.487, 0.330, 0.152))
    elif args.stone == "viola":
        stone = stone_material(
            "stone_viola",
            (0.865, 0.858, 0.845),
            (0.115, 0.028, 0.052),
            halo=(0.330, 0.190, 0.095),
        )
    elif args.stone == "cloudy":
        stone = clouded_material("stone_cloudy", (0.878, 0.872, 0.858), (0.560, 0.560, 0.556))
    else:
        stone = stone_material("stone_calacatta", (0.878, 0.878, 0.865), (0.318, 0.334, 0.350))
    paint = (
        flat_material("paint_cool", (0.831, 0.855, 0.896), 0.92)
        if args.paint == "cool"
        else flat_material("paint_warm", (0.876, 0.855, 0.812), 0.92)
    )
    return {
        "walnut": walnut,
        "panel": panel,
        "panel_reveal": flat_material("panel_reveal", (0.012, 0.012, 0.013), 0.96),
        "stone": stone,
        "floor": tile_material("floor_sand", (0.735, 0.688, 0.600), (0.560, 0.520, 0.450)),
        # Crema di Roccia: the stair treads, the landing, and the head border.
        "crema": clouded_material("crema_di_roccia", (0.775, 0.712, 0.598), (0.610, 0.545, 0.440)),
        "paint": paint,
        "ceiling": flat_material("ceiling_white", (0.925, 0.925, 0.925), 0.95),
        "gola": flat_material("gola_black", (0.017, 0.019, 0.022), 0.45),
        "gunmetal": flat_material("gunmetal", (0.115, 0.125, 0.135), 0.30, metallic=1.0),
        "grey_glass": flat_material("grey_glass", (0.052, 0.055, 0.058), 0.07),
        "upholstery": textile_material("oatmeal upholstery", (0.40, 0.33, 0.24)),
        "sofa": textile_material("olive upholstery", (0.17, 0.20, 0.105)),
        "rug": textile_material("woven wool", (0.38, 0.32, 0.235)),
        "nickel": flat_material("brushed nickel", (0.46, 0.49, 0.51), 0.26, metallic=0.9),
        "zone": flat_material("ceramic markings", (0.15, 0.15, 0.14), 0.38),
        "display": flat_material("unlit display", (0.026, 0.036, 0.040), 0.2),
        "coffee": flat_material("coffee beans", (0.038, 0.017, 0.009), 0.75),
        "appliance": flat_material("appliance", (0.020, 0.022, 0.025), 0.12),
        "glass": glass_material("glazing"),
        "fixture": flat_material("fixture_body", (0.035, 0.035, 0.037), 0.35),
        "trim": (
            flat_material("trim_black", (0.020, 0.021, 0.023), 0.55)
            if args.trim == "black"
            else flat_material("trim_white", (0.780, 0.780, 0.775), 0.70)
        ),
    }


# Kitchen units declare their finish, so the picture does not have to read a name.
DECLARED_FINISH = {
    "stone": "stone",
    "walnut": "walnut",
    "grey_glass": "grey_glass",
    "stainless": "gunmetal",
    "gunmetal": "gunmetal",
    "glass": "appliance",
}


def finish_for(name: str, kind: str, palette: dict, declared: str | None = None):
    if declared in DECLARED_FINISH:
        return palette[DECLARED_FINISH[declared]]
    lowered = name.lower()
    if "panel wall" in lowered:
        return palette["panel"]
    if "crema di roccia" in lowered:
        return palette["crema"]
    if "splashback" in lowered or "worktop" in lowered:
        return palette["stone"]
    if "sink" in lowered or "tap" in lowered:
        return palette["gunmetal"]
    # A freestanding appliance wears its own finish; an integrated one wears a door.
    if "freestanding fridge" in lowered:
        return palette["grey_glass"]
    # An integrated fridge or oven tower wears a cabinet front, so only the
    # exposed appliance surface is dark.
    if "cooktop" in lowered or "induction" in lowered or "television" in lowered:
        return palette["appliance"]
    if "sofa" in lowered:
        return palette["upholstery"]
    if kind in {"cabinet", "furniture"}:
        return palette["walnut"]
    return None


# --- geometry ---------------------------------------------------------------


def _panel_spans(span: float, target: float) -> list[tuple[float, float]]:
    """Equal panels with a shadow gap between, never a sliver at the end."""
    count = max(round(span / target), 1)
    width = (span - PANEL_GAP_M * (count - 1)) / count
    if width <= 0:
        return [(0.0, span)]
    return [(index * (width + PANEL_GAP_M), index * (width + PANEL_GAP_M) + width) for index in range(count)]


def _panel_courses(height: float) -> list[tuple[float, float]]:
    if height <= PANEL_BOARD_M:
        return [(0.0, height)]
    return _panel_spans(height, height / math.ceil(height / PANEL_BOARD_M))


def panel_run(name: str, minimum, maximum, palette: dict) -> None:
    """Replace a panel wall's solid box with faced panels over a dark reveal.

    The IFC carries the run as its build-up envelope, which is the right level
    of detail for a building model and the wrong one for a picture: the shadow
    gap between panels and the reveal at the base are the whole reason the
    finish reads as joinery rather than as sheet goods.
    """

    runs_along_y = (maximum.y - minimum.y) > (maximum.x - minimum.x)
    height = maximum.z - minimum.z
    ground = height + PANEL_REVEAL_M
    ground_z = minimum.z - PANEL_REVEAL_M + ground / 2
    face_x, face_y = maximum.x, maximum.y

    if runs_along_y:
        board_size = (PANEL_BATTEN_M, maximum.y - minimum.y, ground)
        board_at = (face_x - PANEL_BATTEN_M / 2, (minimum.y + maximum.y) / 2, ground_z)
        run = maximum.y - minimum.y
    else:
        board_size = (maximum.x - minimum.x, PANEL_BATTEN_M, ground)
        board_at = ((minimum.x + maximum.x) / 2, face_y - PANEL_BATTEN_M / 2, ground_z)
        run = maximum.x - minimum.x

    bpy.ops.mesh.primitive_cube_add(size=1, location=board_at)
    board = bpy.context.active_object
    board.name = f"{name}__reveal"
    board.scale = board_size
    board.data.materials.append(palette["panel_reveal"])

    index = 0
    for low, high in _panel_courses(height):
        course = high - low
        for start, end in _panel_spans(run, PANEL_TARGET_M):
            width = end - start
            centre_z = minimum.z + low + course / 2
            if runs_along_y:
                location = (face_x - PANEL_BATTEN_M - PANEL_FACE_M / 2, minimum.y + start + width / 2, centre_z)
                scale = (PANEL_FACE_M, width, course)
            else:
                location = (minimum.x + start + width / 2, face_y - PANEL_BATTEN_M - PANEL_FACE_M / 2, centre_z)
                scale = (width, PANEL_FACE_M, course)
            bpy.ops.mesh.primitive_cube_add(size=1, location=location)
            panel = bpy.context.active_object
            panel.name = f"{name}__panel_{index:03d}"
            panel.scale = scale
            panel.data.materials.append(palette["panel"])
            index += 1


def downlight_trim(name: str, minimum, maximum, palette: dict) -> None:
    """A recessed downlight shows a trim ring, not the can.

    ``IfcRepository._fixture_representation`` extrudes the 95 mm body downward
    from the fixture point, and that point sits on the finished ceiling, so the
    can hangs into the room. That is a model bug, not a finish: the void above
    the OpenPlan ceiling is 100 mm and the can belongs in it. Drawing the trim
    here keeps the picture honest while the model is still wrong.
    """

    radius = max((maximum.x - minimum.x) / 2, 0.01)
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius,
        depth=TRIM_THICKNESS_M,
        location=(
            (minimum.x + maximum.x) / 2,
            (minimum.y + maximum.y) / 2,
            maximum.z - CEILING_BOARD_M - 0.001 + TRIM_THICKNESS_M / 2,
        ),
    )
    trim = bpy.context.active_object
    trim.name = f"{name}__trim"
    trim.data.materials.append(palette["trim"])
    trim.visible_shadow = False


def bounds(item):
    corners = [item.matrix_world @ mathutils.Vector(v) for v in item.bound_box]
    minimum = mathutils.Vector([min(v[i] for v in corners) for i in range(3)])
    maximum = mathutils.Vector([max(v[i] for v in corners) for i in range(3)])
    return minimum, maximum


PANEL_M = 0.022
"""Front thickness. A front stands proud of the carcass by this much."""
GOLA_M = 0.057
PLINTH_M = 0.112


def _slab(name, palette, key, cx, cy, cz, sx, sy, sz, shadow=True, bevel=0.002):
    """One box in world metres, named so a render can be read back."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, cz))
    item = bpy.context.active_object
    item.name = name
    item.scale = (max(sx, 0.001), max(sy, 0.001), max(sz, 0.001))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        modifier = item.modifiers.new(name="edge", type="BEVEL")
        modifier.width = min(bevel, max(sx, sy, sz) / 3)
        modifier.segments = 4
        modifier.limit_method = "ANGLE"
    item.data.materials.append(palette[key])
    item.visible_shadow = shadow
    return item


def _facing_axis(facing: str):
    """Outward normal of the front face, as a signed axis."""
    return {"north": (1, 1.0), "south": (1, -1.0), "east": (0, 1.0), "west": (0, -1.0)}.get(facing, (1, -1.0))


def kitchen_detail(record: dict, minimum, maximum, palette: dict) -> str | None:
    """Draw a unit's declared front rather than leaving it a coloured box.

    The browser draws this from the same properties; Cycles only ever saw the
    envelope, which is why a fridge rendered as a dark slab. Returns "drop" when
    detail replaces the envelope, "keep" for a front over its carcass, or None
    when the imported mesh needs only a finish.
    """
    declared = record.get("declared") or {}
    role = declared.get("Role")
    if role is None:
        return None
    if appliance_detail(record, minimum, maximum, palette):
        return "drop"
    front = declared.get("Front", "doors")
    appliance = declared.get("Appliance")
    facing = declared.get("Facing", "south")
    axis, sign = _facing_axis(facing)

    lo = [minimum.x, minimum.y, minimum.z]
    hi = [maximum.x, maximum.y, maximum.z]
    centre = [(a + b) / 2 for a, b in zip(lo, hi, strict=True)]
    span = [b - a for a, b in zip(lo, hi, strict=True)]
    across = 1 - axis
    width, depth, height = span[across], span[axis], span[2]
    face = hi[axis] if sign > 0 else lo[axis]

    def at(offset_across, offset_up, w, h, thickness, key, name, proud=0.0):
        pos = [0.0, 0.0, 0.0]
        pos[across] = centre[across] + offset_across
        pos[axis] = face + sign * (proud - thickness / 2)
        pos[2] = lo[2] + offset_up
        size = [0.0, 0.0, 0.0]
        size[across] = w
        size[axis] = thickness
        size[2] = h
        return _slab(name, palette, key, pos[0], pos[1], pos[2], size[0], size[1], size[2])

    if role in {"worktop", "shelf", "gable", "filler"} and appliance is None:
        return None
    plinth = PLINTH_M if role in {"base", "tall", "island"} else 0.0
    if plinth:
        at(0.0, plinth / 2, width, plinth, depth * 0.88, "gola", "plinth recess")

    # Heights below are local to the carcass base, because ``at`` adds them to it.
    if appliance == "fridge":
        split = plinth + (height - plinth) * 0.39
        for low, high in ((plinth, split - 0.007), (split + 0.007, height - 0.004)):
            for side in (-1, 1):
                at(side * width / 4, (low + high) / 2, width / 2 - 0.007, high - low,
                   PANEL_M, "grey_glass", "fridge door")
        at(0.0, split, width - 0.07, 0.016, PANEL_M + 0.014, "gunmetal", "fridge grip", proud=0.012)
        return "keep"

    if appliance == "oven":
        cavity_low = 0.9
        cavity_high = min(1.5, height - 0.15)
        bank_top = cavity_low - 0.02 - GOLA_M
        at(0.0, (plinth + bank_top) / 2, width - 0.006, bank_top - plinth,
           PANEL_M, "walnut", "oven drawer front")
        at(0.0, bank_top + GOLA_M / 2, width, GOLA_M, 0.026, "gola", "gola channel")
        at(0.0, (cavity_low + cavity_high) / 2, width - 0.03, cavity_high - cavity_low,
           PANEL_M, "appliance", "oven glass")
        at(0.0, cavity_high - 0.045, width - 0.04, 0.075, PANEL_M + 0.006,
           "gunmetal", "oven control strip", proud=0.001)
        at(0.0, cavity_high - 0.048, 0.105, 0.028, 0.006, "display", "oven display", proud=0.004)
        for side in (-1, 1):
            at(side * (width * 0.33), cavity_high - 0.048, 0.030, 0.030, 0.015,
               "gunmetal", "oven control dial", proud=0.013)
            at(side * (width * 0.36), cavity_high - 0.15, 0.020, 0.023, 0.040,
               "gunmetal", "oven handle mount", proud=0.040)
        at(0.0, cavity_high - 0.15, width * 0.76, 0.020, 0.022,
           "gunmetal", "oven handle", proud=0.051)
        at(0.0, (cavity_high + 0.012 + height) / 2, width - 0.006, height - cavity_high - 0.012,
           PANEL_M, "walnut", "oven upper door")
        return "keep"

    if front in {"none", "open", "integrated"} and appliance is None:
        if front == "integrated":
            at(0.0, (lo[2] + plinth + hi[2]) / 2 - lo[2], width - 0.006, height - plinth - 0.01,
               PANEL_M, "walnut", "integrated front")
            at(0.0, height - GOLA_M / 2 - 0.015, width, GOLA_M, 0.026, "gola", "gola channel")
            return "keep"
        return None

    top = hi[2] - lo[2] - (GOLA_M if role != "wall" else 0.0) - (0.015 if role in {"base", "island"} else 0.0)
    bottom = plinth
    if front == "drawers":
        levels = [bottom, bottom + (top - bottom) * 0.40, bottom + (top - bottom) * 0.78, top]
        for low, high in zip(levels, levels[1:], strict=False):
            at(0.0, (low + high) / 2, width - 0.006, high - low - 0.018, PANEL_M, "walnut", "drawer front")
    else:
        leaves = max(1, round(width / 0.6))
        for index in range(leaves):
            offset = -width / 2 + (index + 0.5) * width / leaves
            at(offset, (bottom + top) / 2, width / leaves - 0.006, top - bottom, PANEL_M, "walnut", "door front")
        if role == "tall":
            for index in range(leaves):
                edge = -width / 2 + (index + 1) * width / leaves
                at(edge - 0.013, (bottom + top) / 2, 0.026, top - bottom, 0.026, "gola", "gola edge channel")
    if role != "wall" and front in {"doors", "drawers"}:
        at(0.0, top + GOLA_M / 2, width, GOLA_M, 0.026, "gola", "gola channel")
    return "keep"


def named_detail(name: str, minimum, maximum, palette: dict) -> bool:
    """Lounge pieces predate the furniture type and state nothing, so they are
    matched by name. Anything not listed stays the box it was."""
    lowered = name.lower()
    lo, hi = [minimum.x, minimum.y, minimum.z], [maximum.x, maximum.y, maximum.z]
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    w, d, h = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]

    if lounge_detail(name, minimum, maximum, palette):
        return True
    if "drinks cabinet" in lowered or "media console" in lowered:
        top = 0.036
        _slab("top", palette, "walnut", cx, cy, hi[2] - top / 2, w, d, top)
        _slab("carcass", palette, "walnut", cx, cy, lo[2] + (h - top) / 2 + 0.06, w - 0.05, d - 0.04, h - top - 0.12)
        for sx in (-1, 1):
            for sy in (-1, 1):
                _slab("leg", palette, "gola", cx + sx * (w / 2 - 0.05), cy + sy * (d / 2 - 0.05),
                      lo[2] + 0.03, 0.045, 0.045, 0.06)
        return True
    if "television" in lowered:
        _slab("screen", palette, "appliance", cx, cy, lo[2] + h / 2, w - 0.02, 0.012, h - 0.02)
        _slab("screen frame", palette, "gola", cx, cy + 0.008, lo[2] + h / 2, w, 0.014, h)
        return True
    return False


def import_geometry(args: argparse.Namespace, meta: dict, palette: dict) -> None:
    bpy.ops.wm.obj_import(filepath=str(args.scene), forward_axis="Y", up_axis="Z")
    identity = {entry["id"]: entry for entry in meta.get("objects", [])}

    items = [entry for entry in bpy.context.scene.objects if entry.type == "MESH"]
    cut_sink_apertures(items, identity, palette)
    for item in items:
        klass, _, guid = item.name.partition("__")
        guid = guid.split(".")[0]
        record = identity.get(guid, {})
        name = record.get("name") or ""
        kind = record.get("kind") or ""

        lowered = name.lower()
        if "panel wall" in lowered:
            minimum, maximum = bounds(item)
            panel_run(name, minimum, maximum, palette)
            bpy.data.objects.remove(item, do_unlink=True)
            continue

        if record.get("declared") or name:
            minimum, maximum = bounds(item)
            if not record.get("declared") and named_detail(name, minimum, maximum, palette):
                bpy.data.objects.remove(item, do_unlink=True)
                continue
            if furniture_detail(record, minimum, maximum, palette):
                bpy.data.objects.remove(item, do_unlink=True)
                continue
            disposition = kitchen_detail(record, minimum, maximum, palette)
            if disposition == "drop":
                bpy.data.objects.remove(item, do_unlink=True)
                continue
            if disposition == "keep":
                # Inset the backing behind the front skin, keeping the authored rear face.
                axis, sign = _facing_axis(record["declared"].get("Facing", "south"))
                face = maximum[axis] if sign > 0 else minimum[axis]
                inverse = item.matrix_world.inverted()
                for vertex in item.data.vertices:
                    point = item.matrix_world @ vertex.co
                    if abs(point[axis] - face) < 0.00001:
                        point[axis] -= sign * 0.032
                        vertex.co = inverse @ point
                item.data.materials.clear()
                item.data.materials.append(finish_for(name, kind, palette, record.get("finish")) or palette["walnut"])
                continue

        item.data.materials.clear()
        chosen = finish_for(name, kind, palette, record.get("finish"))
        if chosen is not None:
            item.data.materials.append(chosen)
        elif klass == CEILING_CLASS:
            item.data.materials.append(palette["ceiling"])
        elif klass == "IfcWindow":
            item.data.materials.append(palette["glass"])
        elif klass == LIGHT_CLASS:
            minimum, maximum = bounds(item)
            # A strip is thin too, and it is not round: sizing a trim ring off a
            # run's bounding box drew the LED under the display shelf as a 1.7 m
            # disc and the cove as an 8.6 m one. A downlight is thin AND small on
            # plan, so both tests have to pass.
            round_on_plan = (
                max(maximum.x - minimum.x, maximum.y - minimum.y) <= DOWNLIGHT_PLAN_LIMIT_M
            )
            if (maximum.z - minimum.z) <= RECESSED_BODY_LIMIT_M and round_on_plan:
                downlight_trim(item.name, minimum, maximum, palette)
                bpy.data.objects.remove(item, do_unlink=True)
                continue
            item.data.materials.append(palette["fixture"])
            for polygon in item.data.polygons:
                polygon.use_smooth = True
            item.visible_shadow = False
        elif klass == "IfcDoor":
            # A flush door painted out to the wall, not a black slab.
            item.data.materials.append(palette["paint"])
        elif klass == "IfcSwitchingDevice":
            item.data.materials.append(palette["gola"])
        else:
            item.data.materials.append(palette["paint"])


def build_floors(floors: list[dict], palette: dict) -> None:
    for floor in floors:
        ring = floor["ring_mm"]
        if len(ring) < 3:
            continue
        z = floor["elevation_mm"] / 1000.0
        vertices = [(x / 1000.0, y / 1000.0, z) for x, y in ring]
        mesh = bpy.data.meshes.new(f"floor_{floor['name']}")
        mesh.from_pydata(vertices, [], [list(range(len(vertices)))])
        mesh.validate()
        mesh.materials.append(palette["floor"])
        bpy.context.collection.objects.link(bpy.data.objects.new(f"floor_{floor['name']}", mesh))


def blackbody_rgb(kelvin: float) -> tuple[float, float, float, float]:
    temperature = max(1000.0, min(12000.0, kelvin)) / 100.0
    if temperature <= 66:
        red = 1.0
        green = min(1.0, max(0.0, (99.4708025861 * math.log(temperature) - 161.1195681661) / 255.0))
        blue = (
            0.0
            if temperature <= 19
            else min(1.0, max(0.0, (138.5177312231 * math.log(temperature - 10) - 305.0447927307) / 255.0))
        )
    else:
        red = min(1.0, max(0.0, (329.698727446 * (temperature - 60) ** -0.1332047592) / 255.0))
        green = min(1.0, max(0.0, (288.1221695283 * (temperature - 60) ** -0.0755148492) / 255.0))
        blue = 1.0
    return (red, green, blue, 1.0)


def build_rope(entry: dict) -> None:
    """Space emitters along a strip's path and give each its share of the run.

    A strip states lumens per metre and a polyline, not a point and a total, so
    ``build_lights`` skipped every one of them: all thirteen coves and task
    strips contributed nothing, which is why concealed light never showed.
    """
    path = [(p["x"] / 1000.0, p["y"] / 1000.0, p["z"] / 1000.0) for p in entry.get("path_mm", [])]
    per_m = float(entry.get("lumens_per_m") or 0)
    if len(path) < 2 or per_m <= 0:
        return
    colour = blackbody_rgb(float(entry.get("cct_kelvin") or 3000))[:3]
    for index, (start, end) in enumerate(zip(path, path[1:], strict=False)):
        span = math.dist(start, end)
        if span <= 0:
            continue
        steps = max(1, int(span / 0.2))
        for step in range(steps):
            fraction = (step + 0.5) / steps
            data = bpy.data.lights.new(name=f"{entry['tag']}_{index}_{step}", type="POINT")
            data.energy = per_m * (span / steps) / LUMENS_PER_WATT
            data.shadow_soft_size = 0.02
            data.color = colour
            item = bpy.data.objects.new(name=f"{entry['tag']}_{index}_{step}", object_data=data)
            item.location = tuple(a + (b - a) * fraction for a, b in zip(start, end, strict=True))
            bpy.context.collection.objects.link(item)


def build_lights(lights: list[dict]) -> None:
    for entry in lights:
        lumens = entry.get("lumens")
        if not lumens:
            build_rope(entry)
            continue
        # A bare pendant bulb states no beam angle because it has none: it throws
        # in every direction, so it is a point light and its lumens are not
        # concentrated into a cone. Treating it as a spot crashed the render.
        beam = entry.get("beam_angle_deg")
        if beam is None:
            data = bpy.data.lights.new(name=entry["tag"], type="POINT")
            data.energy = lumens / LUMENS_PER_WATT
            data.shadow_soft_size = 0.04
        else:
            data = bpy.data.lights.new(name=entry["tag"], type="SPOT")
            beam_deg = min(179.0, float(beam))
            data.spot_size = math.radians(beam_deg)
            cone_sr = 2 * math.pi * (1 - math.cos(math.radians(beam_deg / 2)))
            concentration = (4 * math.pi / cone_sr) if cone_sr > 0 else 1.0
            data.energy = lumens / LUMENS_PER_WATT * concentration
            data.spot_blend = 0.3
            data.shadow_soft_size = 0.05
        data.color = blackbody_rgb(float(entry.get("cct_kelvin") or 3000))[:3]

        item = bpy.data.objects.new(name=entry["tag"], object_data=data)
        point = entry["point_mm"]
        item.location = (point["x"] / 1000.0, point["y"] / 1000.0, point["z"] / 1000.0 - FIXTURE_DROP_M)
        direction = entry["direction"]
        aim = mathutils.Vector((direction["x"], direction["y"], direction["z"]))
        if aim.length == 0:
            aim = mathutils.Vector((0.0, 0.0, -1.0))
        item.rotation_euler = aim.normalized().to_track_quat("-Z", "Y").to_euler()
        bpy.context.collection.objects.link(item)


def select_device(preference: str) -> str:
    """Turn on the first GPU backend that reports a device, else stay on CPU.

    Cycles silently renders on CPU when the backend is set but no device is
    enabled, so this enables them explicitly and falls back rather than leaving
    a machine with a GPU grinding through frames on its cores.
    """
    if preference == "cpu":
        return "CPU"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    wanted = ("HIP", "OPTIX", "CUDA", "ONEAPI") if preference == "auto" else (preference.upper(),)
    for backend in wanted:
        try:
            preferences.compute_device_type = backend
        except TypeError:
            continue
        preferences.get_devices()
        usable = [d for d in preferences.devices if d.type == backend]
        if not usable:
            continue
        for device in preferences.devices:
            device.use = device.type in (backend, "CPU")
        print(f"cycles: rendering on {backend} ({', '.join(d.name for d in usable)})")
        return "GPU"
    print("cycles: no GPU backend reported a device, rendering on CPU")
    return "CPU"


def build_camera(args: argparse.Namespace) -> None:
    data = bpy.data.cameras.new("view")
    data.lens = args.focal
    data.sensor_width = 36.0
    if args.ortho_width > 0:
        # A 1 m aisle cannot frame a 2.4 m run in perspective at any sane focal
        # length. An elevation wants parallel projection anyway.
        data.type = "ORTHO"
        data.ortho_scale = args.ortho_width
    camera = bpy.data.objects.new("view", data)
    camera.location = vector(args.camera)
    direction = vector(args.target) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera


def configure(args: argparse.Namespace) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = select_device(args.device)
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 6
    scene.cycles.transmission_bounces = 6
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(args.out)
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = args.exposure
    scene.view_settings.look = "AgX - Base Contrast"
    # A little sky so glazing is not a black hole; the luminaires do the work.
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.62, 0.72, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    scene.world = world


def write_review_copy(out: Path, quality: int) -> Path:
    """Save the render again as JPEG, same resolution, from the result in memory.

    The PNG stays the master because JPEG bands the smooth gradients a beam
    falloff is judged on. This copy is for the phone and for reading the render
    back, where a twentieth of the bytes looks the same.
    """
    image_settings = bpy.context.scene.render.image_settings
    image_settings.file_format = "JPEG"
    image_settings.quality = quality
    review = out.with_suffix(".jpg")
    bpy.data.images["Render Result"].save_render(str(review))
    return review


def main() -> None:
    args = parse_arguments()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    meta = json.loads(args.meta.read_text(encoding="utf-8"))
    palette = build_palette(args)
    import_geometry(args, meta, palette)
    build_floors(meta.get("floors", []), palette)
    build_lights(meta.get("lights", []))
    configure(args)
    views = json.loads(args.views.read_text()) if args.views else [
        {"name": args.out.stem, "camera": args.camera, "target": args.target}
    ]
    out = args.out
    focal = args.focal
    manifest = {
        "method": "illustrative Cycles finishes; not a lux simulation or manufacturer CAD",
        "model": meta.get("model"),
        "revision": meta.get("revision"),
        "parameters": {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
        "views": views,
    }
    for view in views:
        args.camera, args.target = view["camera"], view["target"]
        args.focal = view.get("focal", focal)
        args.out = out.parent / (view["name"] + ".png") if args.views else out
        build_camera(args)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.scene.render.image_settings.file_format = "PNG"
        bpy.context.scene.render.filepath = str(args.out)
        bpy.ops.render.render(write_still=True)
        review = write_review_copy(args.out, args.review_quality)
        print(f"wrote {args.out}")
        print(f"wrote {review}")
        bpy.data.objects.remove(bpy.context.scene.camera, do_unlink=True)
    manifest_path = out.parent / ("review.json" if args.views else out.stem + ".json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")



if __name__ == "__main__":
    main()
