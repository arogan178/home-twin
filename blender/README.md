# Blender and Bonsai integration

Blender is a viewer and authoring environment. Bonsai edits IFC natively. Neither a `.blend` file nor a rendered mesh replaces `model/house.ifc`.

## Open the canonical model

1. Install Blender and the current [Bonsai add-on](https://bonsaibim.org/).
2. Switch to the Bonsai workspace.
3. Select **File > Open IFC Project**.
4. Open `model/house.ifc`.
5. Inspect the spatial tree, element classes, property sets, and placements.

Use **Save IFC Project** only when Bonsai is the active mutation owner. Close or pause Home Twin mutations during manual authoring. Home Twin checks the disk revision before replacement and rejects stale writes.

## Connect Bonsai MCP

[Bonsai MCP](https://github.com/Show2Instruct/bonsai-mcp) is the recommended Codex visual bridge. It supports IFC queries, viewport screenshots, code execution, targeted geometry refresh, project reload, and IFC save.

1. Clone the Bonsai MCP repository.
2. Install `blender_addon/bonsai_bridge.py` in Blender.
3. Enable **Bonsai MCP Bridge**.
4. Open the Blender sidebar, select **Bonsai MCP**, and choose **Start Bridge**.
5. Run `uv run bonsai-mcp doctor` in the cloned repository.
6. Add the stdio server to Codex as shown in the root README.

The bridge listens on `127.0.0.1:9878` and can execute Python in Blender. Keep it on the local machine.

## Agent visual review loop

1. Query room geometry and obstructions through Home Twin MCP.
2. Ask Home Twin to propose and validate a layout.
3. Apply the layout to the exact IFC revision.
4. In Bonsai MCP, call `refresh_geometry` for changed fixtures or `reload_project`.
5. Request a top-down or perspective viewport screenshot.
6. Inspect alignment, visual rhythm, pendant relationships, cabinetry, wall washing, and glare risk.
7. Move, align, distribute, or replace the layout through Home Twin.
8. Repeat the screenshot check.
9. Export installation coordinates from Home Twin.

Do not measure coordinates from the screenshot. Pixels help judge appearance; IFC geometry supplies measurements.

## Render without Bonsai

Bonsai is the authoring route. For a picture alone it is not needed, and this
path works on a stock Blender with no add-ons: tessellate in the project's own
environment, then render in Blender's.

```bash
uv run python scripts/export_render_scene.py --model model/draft.ifc
blender --background --python blender/render_scene.py -- \
  --scene exports/draft-scene.obj \
  --lights exports/draft-scene.json \
  --out exports/draft-render.png
```

The exporter writes an OBJ of every product and a JSON of room floors,
luminaires, and the stated surface reflectances. The renderer builds a cone spot
per fixture at its installation coordinate, colours it from the fixture's stated
CCT, paints surfaces at the project's reflectances, and renders one night view
in Cycles. `--frame-room OpenPlan` frames a single room; `--exposure` and
`--samples` trade brightness and noise.

Both outputs are derived and disposable. Rebuild them; do not edit them.

Three things are worth knowing before reading a render:

- The luminaires are cone spots scaled from rated lumens, not the measured IES
  distributions the photometric path uses, so relative brightness is right and
  absolute brightness is not calibrated.
- Blender spreads a spot's power over the sphere and masks it with the cone, so
  the exporter scales power up by the sphere-to-cone solid-angle ratio. Without
  that a wide downlight renders about five times too dim.
- A fixture's own housing is modelled below the ceiling plane, so it is set not
  to cast shadows. A housing is not an occluder of its own light.

A render is a picture. It is not a photometric result; see
[validating the lux figures](../docs/validation.md).

## Walk through it

```bash
uv run python scripts/export_render_scene.py --model model/draft.ifc
blender --background --python blender/render_scene.py -- \
  --scene exports/draft-scene.obj \
  --lights exports/draft-scene.json \
  --out exports/walk-preview.png \
  --walkthrough OpenPlan --save-blend exports/walkthrough.blend
blender exports/walkthrough.blend
```

`--walkthrough ROOM` differs from the still in three ways, all of which matter
once you are inside rather than above:

- the engine becomes EEVEE, because Cycles on CPU cannot keep up with someone
  moving, with screen-space GI and an extra stop of exposure to make up for the
  indirect light it does not recover;
- the ceilings become visible to the camera again, since a ceiling hidden for
  the doll's-house view is a void once you are standing under it;
- a 24 mm camera stands at eye height on the room's most open interior point,
  looking down its longest sightline. The exporter finds that point as the
  interior point furthest from any wall, because a centroid falls outside an
  L-shaped room and puts the camera inside a wall.

In the viewport, `Shift` + `` ` `` starts Blender's walk navigation: `W`/`A`/`S`/`D`
to move, mouse to look, `Q`/`E` for up and down, `Shift` to run, wheel to change
speed, `Tab` for gravity, `V` to jump, click to keep the position and `Esc` to
go back.

## Optional Unreal pipeline

Unreal remains downstream:

```text
IFC -> Blender/Bonsai -> glTF, USD, or Datasmith -> Unreal
```

Use it for walkthroughs, materials, day and night scenes, and VR. Keep changes to building semantics and fixture installation positions in IFC, then regenerate the Unreal asset.

