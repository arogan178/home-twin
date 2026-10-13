"""Freeze an IFC model into geometry and lights a renderer can read.

Blender ships its own Python and has no IfcOpenShell, so tessellation happens
here and the renderer reads plain files. The output is a derived view: it is
disposable, it is rebuilt from IFC, and nothing reads it back.

Wavefront OBJ is metres, which is what both IfcOpenShell and Blender use, so no
coordinate is rescaled on the way through. Lights stay in millimetres to match
the installation exports and are converted once, in the renderer.

    uv run python scripts/export_render_scene.py --model model/draft.ifc
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
from dataclasses import asdict
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom

from home_twin.finishes import load_finishes
from home_twin.fixtures import PendantFixture, RopeLightFixture
from home_twin.geometry import point_in_polygon, polygon_edge_distance
from home_twin.model import HomeTwin, Point2D, Polygon2D

# A space is a volume and an opening is a void. Rendering either as a solid
# fills the flat with blocks.
SKIPPED = frozenset({"IfcSpace", "IfcOpeningElement", "IfcSite", "IfcAnnotation"})


# Each domain writes its own finish name into its own property set. The renderer
# only wants the name, so it is read from whichever one this product carries.
_FINISH_KEYS = (
    "Pset_HomeTwinKitchen.Finish",
    "Pset_HomeTwinBedroom.Finish",
    "Pset_HomeTwinWetRoom.Finish",
)


def _finish_of(obj) -> str | None:
    return next((value for key in _FINISH_KEYS if (value := obj.properties.get(key))), None)


def write_geometry(model_path: Path, obj_path: Path) -> dict[str, int]:
    """Tessellate every product into one OBJ, one named object per IFC product."""

    model = ifcopenshell.open(str(model_path))
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    iterator = ifcopenshell.geom.iterator(settings, model, multiprocessing.cpu_count())

    counts: dict[str, int] = {}
    offset = 1
    with obj_path.open("w", encoding="utf-8") as handle:
        handle.write(f"# derived from {model_path.name}; rebuild rather than edit\n")
        if not iterator.initialize():
            return counts
        while True:
            shape = iterator.get()
            kind = model.by_guid(shape.guid).is_a()
            if kind in SKIPPED:
                if not iterator.next():
                    break
                continue
            vertices = shape.geometry.verts
            faces = shape.geometry.faces
            handle.write(f"o {kind}__{shape.guid}\n")
            for index in range(0, len(vertices), 3):
                handle.write(
                    f"v {vertices[index]:.6f} {vertices[index + 1]:.6f} {vertices[index + 2]:.6f}\n"
                )
            for index in range(0, len(faces), 3):
                handle.write(
                    f"f {faces[index] + offset} {faces[index + 1] + offset} {faces[index + 2] + offset}\n"
                )
            offset += len(vertices) // 3
            counts[kind] = counts.get(kind, 0) + 1
            if not iterator.next():
                break
    return counts


EYE_HEIGHT_MM = 1600.0


def standing_point(polygon: Polygon2D, step_mm: float = 250.0) -> list[float] | None:
    """The interior point furthest from any wall, for a walkthrough to start at.

    A centroid falls outside an L-shaped room and lands the camera inside a
    wall. The most open point never does, and it is also the most useful place
    to stand and look around from.
    """

    min_x, min_y, max_x, max_y = polygon.bounds
    best: tuple[float, Point2D] | None = None
    y = min_y
    while y <= max_y:
        x = min_x
        while x <= max_x:
            candidate = Point2D(x, y)
            if point_in_polygon(candidate, polygon):
                clearance = polygon_edge_distance(candidate, polygon)
                if best is None or clearance > best[0]:
                    best = (clearance, candidate)
            x += step_mm
        y += step_mm
    return [best[1].x, best[1].y] if best is not None else None


def collect_scene(model_path: Path) -> dict:
    """Room floors, luminaires and switches, straight from the domain facade.

    The draft carries no floor slab, so a room's own polygon is the only thing
    light can land on. The ring is passed through in order and closed by the
    renderer as one face, which keeps a concave room concave.
    """

    twin = HomeTwin.open(model_path)
    colours = load_finishes(Path(model_path).parent).colours
    floors = []
    lights = []
    # The OBJ names a product by GlobalId alone, so a renderer that wants to
    # finish a surface by what it is has no way back to the name without this.
    objects = [
        {
            "id": obj.id,
            "name": obj.name,
            "kind": str(obj.kind),
            "finish": _finish_of(obj),
            # A renderer that only knows a box and a colour draws a fridge as a
            # dark slab. The declared role, front and appliance are what let it
            # draw the thing instead, from the same properties the browser reads
            # rather than a second copy of the schedule.
            "declared": {
                key.split(".", 1)[1]: value
                for key, value in obj.properties.items()
                if key.startswith(("Pset_HomeTwinKitchen.", "Pset_HomeTwinFurniture."))
                and value is not None
            },
            "bounds_mm": {
                "minimum": asdict(obj.bounds.minimum),
                "maximum": asdict(obj.bounds.maximum),
            },
        }
        for obj in twin.get_objects()
    ]
    for room in twin.get_rooms():
        try:
            polygon = twin.get_ceiling_polygon(room.id)
        except (KeyError, ValueError):
            continue
        floors.append(
            {
                "room_id": room.id,
                "name": room.name,
                "elevation_mm": room.elevation_mm,
                "ring_mm": [[point.x, point.y] for point in polygon.outer],
                "standing_point_mm": standing_point(polygon),
                "eye_height_mm": EYE_HEIGHT_MM,
                "floor_finish": room.floor_finish,
                "floor_colour": colours.get(room.floor_finish or ""),
                "wall_finish": room.wall_finish,
                "wall_colour": colours.get(room.wall_finish or ""),
                "feature_wall_id": room.feature_wall_id,
                "feature_wall_colour": room.feature_wall_colour,
            }
        )
        for fixture in twin.get_light_fixtures(room.id):
            lights.append(
                {
                    "tag": fixture.tag,
                    "kind": fixture.kind,
                    "room": room.name,
                    "point_mm": asdict(fixture.point),
                    "direction": asdict(fixture.direction),
                    "lumens": fixture.spec.lumens,
                    "beam_angle_deg": fixture.spec.beam_angle_deg,
                    "cct_kelvin": fixture.spec.cct_kelvin,
                }
            )
        # A pendant emits from the bottom of its drop in every direction, so it
        # carries no beam. Leaving it out renders a room lit only by a pendant
        # black, which is what the main bedroom is.
        for pendant in twin.get_luminaires(room.id):
            if not isinstance(pendant, PendantFixture):
                continue
            lights.append(
                {
                    "tag": pendant.tag,
                    "kind": pendant.kind,
                    "room": room.name,
                    "point_mm": asdict(pendant.emitter_point),
                    "direction": {"x": 0.0, "y": 0.0, "z": -1.0},
                    "lumens": pendant.spec.lumens,
                    "beam_angle_deg": None,
                    "cct_kelvin": pendant.spec.cct_kelvin,
                    "shade_diameter_mm": pendant.spec.bulb_diameter_mm,
                }
            )
        # A strip is a line source with no aim recorded, so it exports as its
        # path and the renderer spaces emitters along it. Leaving it out renders
        # the whole concealed layer dark: every wardrobe LED, every cove.
        for strip in twin.get_luminaires(room.id):
            if not isinstance(strip, RopeLightFixture) or not strip.spec.lumens_per_m:
                continue
            lights.append(
                {
                    "tag": strip.tag,
                    "kind": strip.kind,
                    "room": room.name,
                    "path_mm": [asdict(point) for point in strip.path],
                    "lumens_per_m": strip.spec.lumens_per_m,
                    "diameter_mm": strip.spec.diameter_mm,
                    "cct_kelvin": strip.spec.cct_kelvin,
                }
            )
    # The renderer paints surfaces at these values, so the picture and the
    # interreflection term in docs/validation.md share one set of numbers.
    return {
        "model": model_path.name,
        "revision": twin.revision,
        "reflectances": twin.constraints.reflectances,
        "maintenance_factor": twin.constraints.maintenance_factor,
        "floors": floors,
        "lights": lights,
        "objects": objects,
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="export-render-scene")
    parser.add_argument("--model", type=Path, default=Path("model/house.ifc"))
    parser.add_argument("--out-dir", type=Path, default=Path("exports"))
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.model.stem
    obj_path = args.out_dir / f"{stem}-scene.obj"
    scene_path = args.out_dir / f"{stem}-scene.json"

    counts = write_geometry(args.model, obj_path)
    scene = collect_scene(args.model)
    scene_path.write_text(json.dumps(scene, indent=2), encoding="utf-8")

    print(f"{obj_path}: " + ", ".join(f"{n} {kind}" for kind, n in sorted(counts.items())))
    print(f"{scene_path}: {len(scene['floors'])} floors, {len(scene['lights'])} lights")


if __name__ == "__main__":
    main()
