"""Render a frozen Home Twin scene in Blender, headless.

Runs inside Blender's own Python, so it imports only ``bpy`` and the standard
library. Feed it what ``scripts/export_render_scene.py`` wrote:

    blender --background --python blender/render_scene.py -- \
        --scene exports/draft-scene.obj \
        --lights exports/draft-scene.json \
        --out exports/draft-render.png

This is a picture, not a measurement. Cycles solves light transport, but the
luminaires here are cone spots scaled from rated lumens rather than measured IES
distributions, and the surfaces carry the stated reflectances rather than
measured ones. A render never substitutes for the photometric calculation; see
docs/validation.md.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import mathutils

# Peak photopic efficacy. Converting rated lumens to Blender's radiometric watts
# through it keeps the fixtures right relative to each other; it is not a
# calibrated absolute brightness.
LUMENS_PER_WATT = 683.0

# A recessed fixture sits on the finished ceiling plane, and the covering rises
# from that same plane, so a light left exactly there is inside the solid and
# lights nothing. occlusion.RAY_START_DROP_MM does the same for shadow rays.
FIXTURE_DROP_M = 0.05

# The default wall colour. Walls are shared between
# rooms and the OBJ does not say which room a face belongs to, so only a wall the
# model names as a feature takes a room's own colour; the rest take this.
# NCS S 1002-Y, the house paint. The ceilings are brilliant white over it.
HOUSE_WHITE = "#E8E4D9"
CEILING_WHITE = "#F6F6F4"

CEILING_CLASS = "IfcCovering"
# Furniture belongs here, not with the walls. A floor-to-ceiling wardrobe painted
# at the wall reflectance is invisible against the wall it stands on: it reads as
# the wall having moved 620 mm into the room. It is also darker than a wall in
# fact, this house being walnut-led, so the bounce is truer for the change.
JOINERY_CLASSES = frozenset(
    {"IfcDoor", "IfcWindow", "IfcSwitchingDevice", "IfcLightFixture", "IfcFurniture"}
)
# A luminaire's body is modelled hanging below the ceiling plane, so it sits
# between its own source and the room and absorbs the whole beam. A housing is
# not an occluder of its own light.
TRANSPARENT_TO_LIGHT = frozenset({"IfcLightFixture"})


def parse_arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="render_scene")
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--lights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=96)
    # A 0.2-albedo floor at a domestic 150 lx renders near 0.014 in linear
    # radiance once lumens are scaled by 683, so it needs about five stops.
    parser.add_argument("--exposure", type=float, default=4.0)
    parser.add_argument("--resolution", type=int, default=1600)
    parser.add_argument("--elevation-deg", type=float, default=52.0)
    parser.add_argument("--azimuth-deg", type=float, default=235.0)
    parser.add_argument("--margin", type=float, default=1.04)
    # A plan is wide and shallow on screen, so 16:10 leaves the frame half empty.
    parser.add_argument("--aspect", type=float, default=0.44)
    parser.add_argument("--frame-room", default=None, help="Frame one room instead of the whole floor")
    parser.add_argument(
        "--interior",
        default=None,
        metavar="ROOM",
        help="Stand the camera inside this room and keep its ceiling, instead of the cutaway",
    )
    parser.add_argument("--eye-mm", default=None, help="Where to stand for --interior, as X,Y in the building frame")
    parser.add_argument("--target-mm", default=None, help="What to look at for --interior, as X,Y")
    parser.add_argument("--eye-height-mm", type=float, default=1550.0, help="Camera height above the room floor")
    parser.add_argument("--save-blend", type=Path, default=None, help="Write the assembled scene")
    parser.add_argument(
        "--walkthrough",
        default=None,
        metavar="ROOM",
        help="Set up for first-person navigation standing in this room",
    )
    parser.add_argument("--skip-render", action="store_true", help="Assemble and save without rendering")
    return parser.parse_args(argv)


def blackbody_rgb(kelvin: float) -> tuple[float, float, float]:
    """Approximate the Planckian locus as linear RGB, for lamp colour only."""

    t = max(1000.0, min(40000.0, kelvin)) / 100.0
    if t <= 66:
        red = 255.0
        green = 99.4708025861 * math.log(t) - 161.1195681661
    else:
        red = 329.698727446 * (t - 60) ** -0.1332047592
        green = 288.1221695283 * (t - 60) ** -0.0755148492
    if t >= 66:
        blue = 255.0
    elif t <= 19:
        blue = 0.0
    else:
        blue = 138.5177312231 * math.log(t - 10) - 305.0447927307
    channels = (red, green, blue)
    return tuple(max(0.0, min(255.0, value)) / 255.0 for value in channels)


def srgb_to_linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def hex_to_linear(colour: str) -> tuple[float, float, float]:
    """A #RRGGBB display colour as linear RGB, which is what a shader wants."""

    value = colour.lstrip("#")
    return tuple(srgb_to_linear(int(value[index : index + 2], 16) / 255) for index in (0, 2, 4))


def _principled(name: str) -> tuple[bpy.types.Material, bpy.types.Node]:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    return material, material.node_tree.nodes["Principled BSDF"]


def _texture_coordinates(material: bpy.types.Material) -> bpy.types.Node:
    """Object-space coordinates, so a texture does not need the OBJ to carry a UV map."""

    return material.node_tree.nodes.new("ShaderNodeTexCoord")


def grey_material(name: str, reflectance: float) -> bpy.types.Material:
    """A near-Lambertian surface whose albedo is the reflectance the model assumes."""

    material, principled = _principled(name)
    principled.inputs["Base Color"].default_value = (reflectance, reflectance, reflectance, 1.0)
    principled.inputs["Roughness"].default_value = 0.85
    if "Specular IOR Level" in principled.inputs:
        principled.inputs["Specular IOR Level"].default_value = 0.2
    return material


def painted_material(name: str, colour: str, reflectance: float | None = None) -> bpy.types.Material:
    """Matt emulsion: the stated colour, with enough tooth to catch a grazing beam.

    ``reflectance`` holds the surface to the albedo the lux estimate assumes,
    keeping the picture and docs/validation.md on one set of numbers, while the
    hue comes from the authored finish. Without it the colour decides both.
    """

    material, principled = _principled(name)
    red, green, blue = hex_to_linear(colour)
    if reflectance is not None:
        luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        scale = reflectance / luminance if luminance > 1e-6 else 1.0
        red, green, blue = (min(1.0, channel * scale) for channel in (red, green, blue))
    principled.inputs["Base Color"].default_value = (red, green, blue, 1.0)
    principled.inputs["Roughness"].default_value = 0.92
    if "Specular IOR Level" in principled.inputs:
        principled.inputs["Specular IOR Level"].default_value = 0.15
    tree = material.node_tree
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 240.0
    noise.inputs["Detail"].default_value = 2.0
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.06
    tree.links.new(_texture_coordinates(material).outputs["Object"], noise.inputs["Vector"])
    tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    return material


def timber_material(name: str, colour: str) -> bpy.types.Material:
    """Walnut: stretched noise for the grain, a second band for the figure."""

    material, principled = _principled(name)
    red, green, blue = hex_to_linear(colour)
    principled.inputs["Roughness"].default_value = 0.42
    tree = material.node_tree
    mapping = tree.nodes.new("ShaderNodeMapping")
    # Grain runs in long lines, so the noise is fine across the board and smooth
    # along it. Compressing Z and stretching the plan axes puts those lines
    # upright on a wardrobe door, which is how a veneered panel is set out.
    mapping.inputs["Scale"].default_value = (26.0, 26.0, 2.2)
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.5
    noise.inputs["Detail"].default_value = 8.0
    noise.inputs["Roughness"].default_value = 0.55
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.44
    ramp.color_ramp.elements[0].color = (red * 0.7, green * 0.66, blue * 0.64, 1.0)
    ramp.color_ramp.elements[1].position = 0.58
    ramp.color_ramp.elements[1].color = (red * 1.06, green * 1.03, blue * 1.0, 1.0)
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.08
    tree.links.new(_texture_coordinates(material).outputs["Object"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    tree.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], principled.inputs["Base Color"])
    tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    return material


def textile_material(name: str, colour: str, roughness: float = 0.95) -> bpy.types.Material:
    """Linen, wool or velvet: a woven tooth and a sheen that never reads as plastic."""

    material, principled = _principled(name)
    red, green, blue = hex_to_linear(colour)
    principled.inputs["Base Color"].default_value = (red, green, blue, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    if "Sheen Weight" in principled.inputs:
        principled.inputs["Sheen Weight"].default_value = 0.5
    if "Specular IOR Level" in principled.inputs:
        principled.inputs["Specular IOR Level"].default_value = 0.1
    tree = material.node_tree
    weave = tree.nodes.new("ShaderNodeTexNoise")
    weave.inputs["Scale"].default_value = 420.0
    weave.inputs["Detail"].default_value = 3.0
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.3
    tree.links.new(_texture_coordinates(material).outputs["Object"], weave.inputs["Vector"])
    tree.links.new(weave.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    return material


def stone_material(name: str, colour: str) -> bpy.types.Material:
    """Tile or marble: a clouded body under a low-gloss surface."""

    material, principled = _principled(name)
    red, green, blue = hex_to_linear(colour)
    principled.inputs["Roughness"].default_value = 0.28
    tree = material.node_tree
    veins = tree.nodes.new("ShaderNodeTexNoise")
    veins.inputs["Scale"].default_value = 9.0
    veins.inputs["Detail"].default_value = 6.0
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.4
    ramp.color_ramp.elements[0].color = (red * 0.88, green * 0.88, blue * 0.9, 1.0)
    ramp.color_ramp.elements[1].position = 0.62
    ramp.color_ramp.elements[1].color = (min(1.0, red * 1.1), min(1.0, green * 1.1), min(1.0, blue * 1.12), 1.0)
    tree.links.new(_texture_coordinates(material).outputs["Object"], veins.inputs["Vector"])
    tree.links.new(veins.outputs["Fac"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], principled.inputs["Base Color"])
    return material


# What each authored finish name is made of. A name the model does not state
# falls back to the joinery grey, so a new finish is dull rather than wrong.
def mirror_material(name: str, colour: str) -> bpy.types.Material:
    """Silvered glass. Nearly a perfect specular, which is what makes it read as a mirror.

    Without this a mirror takes the joinery grey and renders as a flat panel on
    the wall, and nothing in the picture says the room has one.
    """

    material, principled = _principled(name)
    principled.inputs["Base Color"].default_value = (*hex_to_linear(colour), 1.0)
    principled.inputs["Metallic"].default_value = 1.0
    principled.inputs["Roughness"].default_value = 0.02
    return material


FINISH_MATERIALS = {
    "walnut": ("timber", "#6E4B34"),
    "walnut_veneer": ("timber", "#6E4B34"),
    "walnut_board": ("timber", "#6E4B34"),
    "walnut_parquet_tile": ("timber", "#6E4B34"),
    "walnut_linen": ("textile", "#D9CFBE"),
    "wool_oatmeal": ("textile", "#C4B49C"),
    "olive_velvet": ("textile", "#5C6144"),
    "grey_marble": ("stone", "#9C9C9A"),
    "grey_stone_marble": ("stone", "#9C9C9A"),
    "travertine_marble": ("stone", "#D6C1A1"),
    "pale_yellow_marble": ("stone", "#E9DCB9"),
    "lit_mirror_3000k_cri90": ("mirror", "#E8EAEA"),
    "ncs_s_1002_y": ("paint", "#E8E4D9"),
    "brilliant_white": ("paint", "#F6F6F4"),
    "grey_tile": ("stone", "#CECFCA"),
    "light_grey_tile": ("stone", "#D1D1CF"),
    "yellow_stone_tile": ("stone", "#DBD3C1"),
}
_BUILDERS = {
    "timber": timber_material,
    "textile": textile_material,
    "stone": stone_material,
    "mirror": mirror_material,
    "paint": painted_material,
}


def material_for_finish(finish: str, cache: dict) -> bpy.types.Material | None:
    """One shared material per authored finish name, built the first time it is asked for."""

    recipe = FINISH_MATERIALS.get(finish)
    if recipe is None:
        return None
    if finish not in cache:
        kind, colour = recipe
        cache[finish] = _BUILDERS[kind](finish, colour)
    return cache[finish]


def import_geometry(obj_path: Path, scene: dict) -> None:
    """Import the frozen geometry and give each product the finish the model states.

    A product with no authored finish keeps the grey it always had, so nothing
    here invents a material the IFC does not carry.
    """

    bpy.ops.wm.obj_import(filepath=str(obj_path), forward_axis="Y", up_axis="Z")

    reflectances = scene.get("reflectances", {})
    wall_reflectance = reflectances.get("walls", 0.5)
    # Warm off-white, held at the albedo the lux estimate assumes: the picture
    # gets the hue and the tooth of emulsion without moving the numbers.
    walls = painted_material("walls", HOUSE_WHITE, wall_reflectance)
    ceiling = painted_material("ceiling", CEILING_WHITE, reflectances.get("ceiling", 0.885))
    joinery = grey_material("joinery", 0.35)
    finishes: dict[str, bpy.types.Material] = {}
    products = {entry["id"]: entry for entry in scene.get("objects", [])}

    # A feature wall is painted at its own colour, which is also the reflectance
    # the lux estimate gives that face. The rest keep the project's wall figure.
    feature_walls: dict[str, bpy.types.Material] = {}
    for floor in scene.get("floors", []):
        guid, colour = floor.get("feature_wall_id"), floor.get("feature_wall_colour")
        if guid and colour and guid not in feature_walls:
            feature_walls[guid] = painted_material(f"feature_{floor['name']}", colour)

    for item in [entry for entry in bpy.context.scene.objects if entry.type == "MESH"]:
        klass, _, guid = item.name.partition("__")
        item.data.materials.clear()
        product = products.get(guid, {})
        authored = material_for_finish(product.get("finish") or "", finishes)
        if klass == CEILING_CLASS:
            item.data.materials.append(ceiling)
            # Still bounces light and still blocks a beam, but the camera looks
            # straight through it into the flat.
            item.visible_camera = False
        elif guid in feature_walls:
            item.data.materials.append(feature_walls[guid])
        elif authored is not None:
            item.data.materials.append(authored)
        elif klass in JOINERY_CLASSES:
            item.data.materials.append(joinery)
        else:
            item.data.materials.append(walls)
        if klass in TRANSPARENT_TO_LIGHT:
            item.visible_shadow = False
        shade_curves_smooth(item)


def shade_curves_smooth(item: bpy.types.Object, angle_deg: float = 40.0) -> None:
    """Smooth a tessellated curve without rounding a joinery corner.

    A sphere or a cylinder reaches the renderer already broken into flat facets,
    so a pendant globe reads as a golf ball and a stool as a bollard. Smoothing
    only across edges gentler than this angle recovers the curve and leaves
    every carcass edge sharp.
    """

    mesh = item.data
    if not mesh.polygons:
        return
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    limit = math.radians(angle_deg)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    for edge in bm.edges:
        edge.smooth = len(edge.link_faces) == 2 and edge.calc_face_angle(math.pi) <= limit
    bm.to_mesh(mesh)
    bm.free()
    # Blender 4.1 dropped the mesh-level flag; sharp edges alone do the work there.
    if hasattr(mesh, "use_auto_smooth"):
        mesh.use_auto_smooth = True


def build_floors(floors: list[dict], reflectance: float) -> None:
    """One n-gon per room, so a concave plan stays concave without triangulating."""

    default = grey_material("floor", reflectance)
    finishes: dict[str, bpy.types.Material] = {}
    for floor in floors:
        material = material_for_finish(floor.get("floor_finish") or "", finishes) or default
        ring = floor["ring_mm"]
        if len(ring) < 3:
            continue
        z = floor["elevation_mm"] / 1000.0
        vertices = [(x / 1000.0, y / 1000.0, z) for x, y in ring]
        mesh = bpy.data.meshes.new(f"floor_{floor['name']}")
        mesh.from_pydata(vertices, [], [list(range(len(vertices)))])
        mesh.validate()
        mesh.materials.append(material)
        bpy.context.collection.objects.link(bpy.data.objects.new(f"floor_{floor['name']}", mesh))


def build_omnidirectional_light(entry: dict, lumens: float) -> int:
    """A pendant, which throws its rated lumens over the whole sphere.

    Its shade diameter is the emitter's size, so the shadows it casts are as
    soft as the fitting makes them rather than point-sharp.
    """

    data = bpy.data.lights.new(name=entry["tag"], type="POINT")
    data.energy = lumens / LUMENS_PER_WATT
    data.shadow_soft_size = float(entry.get("shade_diameter_mm") or 100.0) / 2000.0
    data.color = blackbody_rgb(float(entry.get("cct_kelvin") or 3000))
    item = bpy.data.objects.new(name=entry["tag"], object_data=data)
    point = entry["point_mm"]
    item.location = (point["x"] / 1000.0, point["y"] / 1000.0, point["z"] / 1000.0)
    bpy.context.collection.objects.link(item)
    return 1


# Close enough that the chain reads as a line rather than as beads on a string.
# 150 was not: a strip 40 mm off the carcass threw a row of separate pools.
STRIP_EMITTER_PITCH_MM = 60.0


def build_strip_light(entry: dict) -> int:
    """A concealed strip, as a chain of small point sources along its path.

    The model records a strip's output per metre and no aim at all, so a chain
    that throws in every direction claims no more than the model knows. What it
    does claim is where the light comes from, which is the thing a picture of a
    lit wardrobe has to get right.
    """

    path = [(p["x"] / 1000.0, p["y"] / 1000.0, p["z"] / 1000.0) for p in entry["path_mm"]]
    colour = blackbody_rgb(float(entry.get("cct_kelvin") or 3000))
    radius = float(entry.get("diameter_mm") or 12.0) / 2000.0
    pitch = STRIP_EMITTER_PITCH_MM / 1000.0
    made = 0
    for index, (start, end) in enumerate(zip(path, path[1:], strict=False)):
        span = mathutils.Vector(end) - mathutils.Vector(start)
        length = span.length
        if length <= 0:
            continue
        count = max(1, round(length / pitch))
        lumens = float(entry["lumens_per_m"]) * length / count
        for step in range(count):
            data = bpy.data.lights.new(name=f"{entry['tag']}_{index}_{step}", type="POINT")
            data.energy = lumens / LUMENS_PER_WATT
            # Each emitter stands in for its whole segment, so it is that long
            # rather than the strip's own 12 mm. A point source here reads as a
            # bead; a source the length of its share of the run reads as a line.
            data.shadow_soft_size = max(radius, pitch / 2)
            data.color = colour
            item = bpy.data.objects.new(name=data.name, object_data=data)
            item.location = mathutils.Vector(start) + span * ((step + 0.5) / count)
            bpy.context.collection.objects.link(item)
            made += 1
    return made


def build_lights(lights: list[dict]) -> int:
    """A cone spot per fixture, at its installation coordinate and aiming direction."""

    made = 0
    for entry in lights:
        if entry.get("path_mm"):
            made += build_strip_light(entry)
            continue
        lumens = entry.get("lumens")
        if not lumens:
            continue
        if entry.get("beam_angle_deg") is None:
            made += build_omnidirectional_light(entry, lumens)
            continue
        data = bpy.data.lights.new(name=entry["tag"], type="SPOT")
        beam_deg = min(179.0, float(entry["beam_angle_deg"]))
        data.spot_size = math.radians(beam_deg)
        # Blender spreads a spot's power over the whole sphere and then masks it
        # with the cone, so narrowing the beam does not brighten it. A real
        # downlight puts its rated lumens into the cone instead, so scale the
        # power up by the ratio of the sphere to that solid angle.
        cone_sr = 2 * math.pi * (1 - math.cos(math.radians(beam_deg / 2)))
        concentration = (4 * math.pi / cone_sr) if cone_sr > 0 else 1.0
        data.energy = lumens / LUMENS_PER_WATT * concentration
        data.spot_blend = 0.25
        data.shadow_soft_size = 0.04
        data.color = blackbody_rgb(float(entry.get("cct_kelvin") or 3000))

        item = bpy.data.objects.new(name=entry["tag"], object_data=data)
        point = entry["point_mm"]
        item.location = (
            point["x"] / 1000.0,
            point["y"] / 1000.0,
            point["z"] / 1000.0 - FIXTURE_DROP_M,
        )
        direction = entry["direction"]
        # A spot points down its own -Z, which is already the aim of a
        # downlight, so only a tilted fixture needs rotating.
        item.rotation_euler = (
            math.atan2(math.hypot(direction["x"], direction["y"]), -direction["z"]),
            0.0,
            math.atan2(direction["y"], direction["x"]) + math.pi / 2,
        )
        bpy.context.collection.objects.link(item)
        made += 1
    return made


def setup_walkthrough(room: str, floors: list[dict]) -> None:
    """Stand a camera in a room at eye height and make the scene walkable.

    Cycles on CPU cannot keep up with someone moving, and a ceiling hidden from
    the camera leaves a void overhead once you are underneath it. Both are right
    for a still and wrong for a walkthrough.
    """

    floor = next((entry for entry in floors if entry["name"] == room), None)
    if floor is None:
        raise SystemExit(f"no room called {room!r}: try one of {[e['name'] for e in floors]}")
    standing = floor.get("standing_point_mm")
    if standing is None:
        raise SystemExit(f"{room!r} has no interior point to stand on")

    for item in bpy.context.scene.objects:
        if item.type == "MESH" and item.name.startswith(CEILING_CLASS):
            item.visible_camera = True

    scene = bpy.context.scene
    # The EEVEE identifier has been BLENDER_EEVEE and BLENDER_EEVEE_NEXT in
    # different releases, so take whichever this build offers.
    engines = scene.render.bl_rna.properties["engine"].enum_items.keys()
    realtime = next((name for name in engines if name.startswith("BLENDER_EEVEE")), None)
    if realtime is None:
        raise SystemExit(f"no EEVEE engine in this build: {list(engines)}")
    scene.render.engine = realtime
    # Screen-space GI is cheap enough to walk through and needs the extra rays
    # to stop the bounce breaking up. Property names move between releases, so
    # set only what this build actually has.
    for attribute, value in (
        ("use_shadows", True),
        ("use_fast_gi", True),
        ("fast_gi_quality", 0.5),
        ("fast_gi_ray_count", 4),
        ("fast_gi_step_count", 16),
        ("gi_diffuse_bounces", 4),
        ("taa_samples", 8),
    ):
        if hasattr(scene.eevee, attribute):
            setattr(scene.eevee, attribute, value)

    # Screen-space GI recovers less indirect light than Cycles does, so the
    # exposure that suits the still leaves the walkthrough about a stop down.
    scene.view_settings.exposure += 1.0

    eye = mathutils.Vector(
        (
            standing[0] / 1000.0,
            standing[1] / 1000.0,
            (floor["elevation_mm"] + floor.get("eye_height_mm", 1600.0)) / 1000.0,
        )
    )
    # Look along the longest sightline from where we are standing, which is the
    # most of the room you can see without turning.
    ring = [mathutils.Vector((x / 1000.0, y / 1000.0, eye.z)) for x, y in floor["ring_mm"]]
    target = max(ring, key=lambda corner: (corner - eye).length)
    heading = target - eye

    camera_data = bpy.data.cameras.new("walkthrough")
    camera_data.lens = 24.0
    camera_data.clip_start = 0.05
    camera_data.clip_end = 200.0
    camera = bpy.data.objects.new("walkthrough", camera_data)
    camera.location = eye
    camera.rotation_euler = (math.pi / 2, 0.0, math.atan2(heading.y, heading.x) - math.pi / 2)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    print(
        f"standing in {room} at {tuple(round(v, 2) for v in eye)} on {realtime}, "
        f"exposure {scene.view_settings.exposure:.1f}"
    )


def group_into_collections() -> None:
    """Sort objects into collections so the viewport can toggle them.

    The ceiling is invisible to the camera for the render, which does nothing
    for someone orbiting in the viewport. In its own collection it hides with
    one click.
    """

    groups = {
        "Ceilings": lambda item: item.name.startswith(CEILING_CLASS),
        "Floors": lambda item: item.name.startswith("floor_"),
        "Luminaires": lambda item: item.type == "LIGHT",
        "Joinery": lambda item: item.name.split("__")[0] in JOINERY_CLASSES,
    }
    scene_collection = bpy.context.scene.collection
    made = {name: bpy.data.collections.new(name) for name in groups}
    shell = bpy.data.collections.new("Shell")
    for collection in (*made.values(), shell):
        scene_collection.children.link(collection)

    for item in list(scene_collection.objects):
        target = next((made[name] for name, test in groups.items() if test(item)), shell)
        target.objects.link(item)
        scene_collection.objects.unlink(item)


def scene_corners(room: str | None = None) -> list[mathutils.Vector]:
    """World-space bounding corners, optionally just one room's floor.

    Framing on a single floor and lifting it by the storey height puts the
    camera on that room rather than on the whole flat's centroid.
    """

    if room is not None:
        floor = bpy.context.scene.objects.get(f"floor_{room}")
        if floor is None:
            raise SystemExit(f"no room called {room!r} in this scene")
        base = [floor.matrix_world @ mathutils.Vector(point) for point in floor.bound_box]
        return base + [corner + mathutils.Vector((0.0, 0.0, 2.6)) for corner in base]
    return [
        item.matrix_world @ mathutils.Vector(point)
        for item in bpy.context.scene.objects
        if item.type == "MESH"
        for point in item.bound_box
    ]


def _plan_point(value: str | None, fallback: tuple[float, float]) -> tuple[float, float]:
    if value is None:
        return fallback
    parts = value.split(",")
    if len(parts) != 2:
        raise SystemExit(f"expected X,Y in millimetres, not {value!r}")
    return (float(parts[0]), float(parts[1]))


def place_interior_camera(
    room: str,
    floors: list[dict],
    eye: str | None,
    target: str | None,
    eye_height_mm: float,
) -> None:
    """Stand in the room and look across it, which is how a room is actually seen.

    The cutaway answers where things are; it cannot answer what the room looks
    like from the door. A wide lens because a 4 m room on a 35 mm lens shows one
    wall, and the ceiling comes back because from underneath its absence is a
    hole in the sky rather than a convenience.
    """

    floor = next((entry for entry in floors if entry["name"] == room), None)
    if floor is None:
        raise SystemExit(f"no room called {room!r}: try one of {[entry['name'] for entry in floors]}")
    ring = floor["ring_mm"]
    centroid = (
        sum(point[0] for point in ring) / len(ring),
        sum(point[1] for point in ring) / len(ring),
    )
    standing = floor.get("standing_point_mm") or centroid
    eye_x, eye_y = _plan_point(eye, (standing[0], standing[1]))
    look_x, look_y = _plan_point(target, centroid)

    for item in bpy.context.scene.objects:
        if item.type == "MESH" and item.name.startswith(CEILING_CLASS):
            item.visible_camera = True

    camera_data = bpy.data.cameras.new("camera")
    camera_data.lens = 22.0
    camera = bpy.data.objects.new("camera", camera_data)
    bpy.context.collection.objects.link(camera)
    base = floor["elevation_mm"]
    camera.location = ((eye_x) / 1000.0, (eye_y) / 1000.0, (base + eye_height_mm) / 1000.0)
    direction = mathutils.Vector(
        (
            (look_x - eye_x) / 1000.0,
            (look_y - eye_y) / 1000.0,
            (base + eye_height_mm * 0.72 - (base + eye_height_mm)) / 1000.0,
        )
    )
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = camera


def place_camera(
    elevation_deg: float, azimuth_deg: float, margin: float, room: str | None = None
) -> None:
    """Frame every corner exactly, rather than a sphere that wastes the frame.

    A flat is wide and thin, so a bounding sphere sized off the diagonal leaves
    most of the picture empty. Projecting the corners onto the camera's own axes
    gives the distance at which the furthest one just fits.
    """

    corners = scene_corners(room)
    if not corners:
        raise SystemExit("nothing to frame: the scene imported no geometry")
    low = [min(corner[axis] for corner in corners) for axis in range(3)]
    high = [max(corner[axis] for corner in corners) for axis in range(3)]
    centre = mathutils.Vector([(low[axis] + high[axis]) / 2 for axis in range(3)])

    camera_data = bpy.data.cameras.new("camera")
    camera_data.lens = 35.0
    camera = bpy.data.objects.new("camera", camera_data)
    bpy.context.collection.objects.link(camera)

    elevation = math.radians(elevation_deg)
    azimuth = math.radians(azimuth_deg)
    offset = mathutils.Vector(
        (
            math.cos(elevation) * math.cos(azimuth),
            math.cos(elevation) * math.sin(azimuth),
            math.sin(elevation),
        )
    )
    forward = -offset
    right = forward.cross(mathutils.Vector((0.0, 0.0, 1.0)))
    right.normalize()
    up = right.cross(forward)

    scene = bpy.context.scene
    aspect = scene.render.resolution_y / scene.render.resolution_x
    half_h = math.atan(camera_data.sensor_width / 2 / camera_data.lens)
    half_v = math.atan(camera_data.sensor_width * aspect / 2 / camera_data.lens)
    distance = 1.0
    for corner in corners:
        local = corner - centre
        along = local.dot(forward)
        distance = max(
            distance,
            abs(local.dot(right)) / math.tan(half_h) - along,
            abs(local.dot(up)) / math.tan(half_v) - along,
        )
    distance *= margin
    print(f"framing {len(corners)} corners from {distance:.2f} m")
    camera.location = centre + offset * distance

    target = bpy.data.objects.new("aim", None)
    target.location = centre

    bpy.context.collection.objects.link(target)
    constraint = camera.constraints.new(type="TRACK_TO")
    constraint.target = target
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    bpy.context.scene.camera = camera


def configure_render(
    out_path: Path, samples: int, exposure: float, resolution: int, aspect: float
) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 6
    # A near-specular surface next to a small bright source throws single bright
    # pixels with no light behind them. Clamping the indirect contribution costs
    # a little energy in the brightest bounces and removes them.
    scene.cycles.sample_clamp_indirect = 10.0
    scene.render.resolution_x = resolution
    scene.render.resolution_y = max(2, int(resolution * aspect))
    scene.render.film_transparent = False
    scene.view_settings.exposure = exposure
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(out_path)

    # Night, so the fixtures are the only source. Daylight is not in the model.
    world = bpy.data.worlds.new("night")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.005, 0.008, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.15
    scene.world = world


def write_review_copy(master: Path) -> Path:
    """A JPEG beside the PNG at the same resolution, for reading by eye.

    Around a twentieth of the bytes and identical for anything judged by eye.
    The PNG stays the honest artifact for light accuracy, because JPEG bands the
    smooth gradients a beam falloff and a cove wash are read from.
    """

    review = master.with_suffix(".jpg")
    settings = bpy.context.scene.render.image_settings
    settings.file_format = "JPEG"
    settings.quality = 88
    bpy.data.images["Render Result"].save_render(str(review.resolve()))
    settings.file_format = "PNG"
    return review


def main() -> None:
    args = parse_arguments()
    scene = json.loads(args.lights.read_text(encoding="utf-8"))
    reflectances = scene.get("reflectances", {})

    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_geometry(args.scene, scene)
    build_floors(scene.get("floors", []), reflectances.get("floor", 0.2))
    count = build_lights(scene.get("lights", []))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    configure_render(args.out, args.samples, args.exposure, args.resolution, args.aspect)
    if args.walkthrough is not None:
        setup_walkthrough(args.walkthrough, scene.get("floors", []))
    elif args.interior is not None:
        place_interior_camera(
            args.interior, scene.get("floors", []), args.eye_mm, args.target_mm, args.eye_height_mm
        )
    else:
        place_camera(args.elevation_deg, args.azimuth_deg, args.margin, args.frame_room)
    meshes = [item for item in bpy.context.scene.objects if item.type == "MESH"]
    floors = [item for item in meshes if item.name.startswith("floor_")]
    watts = sum(item.data.energy for item in bpy.context.scene.objects if item.type == "LIGHT")
    print(f"{len(meshes)} meshes, {len(floors)} floors, {count} lights, {watts:.2f} W total")

    print(f"assembled {scene.get('model')} at revision {scene.get('revision')} with {count} lights")

    if args.save_blend is not None:
        group_into_collections()
        args.save_blend.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(args.save_blend.resolve()))
        print(f"wrote {args.save_blend}")

    if args.skip_render:
        return
    bpy.ops.render.render(write_still=True)
    print(f"wrote {args.out}")
    print(f"wrote {write_review_copy(args.out)}")


if __name__ == "__main__":
    main()
