# Convert a residential plan into IFC

## Recommended general workflow

For a straight-walled residential plan, trace it in the browser. The **Trace
plan** workspace calibrates a reference drawing, records points, room outlines,
printed controls, openings, and the site, and compiles a verified draft IFC. See
[browser plan tracing](tracing.md). Bonsai is still the right tool for curved
walls, sloped ceilings, stairs, and repairing broken relationships.

Whichever tool authors the model, the same rules apply. Enter dimensions
numerically, record independent printed controls, and give each wall, space,
opening, slab, ceiling, and fixed obstruction the IFC identity that later
geometry checks need.

The manual Bonsai route, for a plan the browser workspace cannot express:

1. Collect the highest-quality source. Prefer the architect's IFC, then DWG or DXF, then a vector PDF, and use a raster scan only as a last resort.
2. Record one or more trustworthy dimensions and the drawing revision in `model/measurements.yaml`.
3. Clean DWG or DXF linework in a 2D CAD tool. [LibreCAD](https://github.com/LibreCAD/LibreCAD) can read DXF and DWG and export DXF, PDF, PNG, or SVG.
4. Convert a vector PDF or cleaned CAD view to SVG or a high-resolution image for use as a reference. Keep the original in `model/references/`.
5. Create a new IFC4 metric project in Bonsai. Use millimetres or metres consistently.
6. Import the reference into Blender as non-canonical underlay geometry. Scale it from a known dimension. Do not save the underlay as the building model.
7. Create native IFC walls, slabs, spaces, doors, windows, ceilings, cabinetry, beams, and fixed services. Bonsai's own guide stresses that a 3D object needs an IFC category and spatial location before it is a BIM model.
8. Enter dimensions numerically where possible. Do not rely on cursor tracing for final wall lengths.
9. Create one `IfcSpace` per room and give it a usable solid or ceiling boundary. Home Twin derives ceiling polygons from this geometry.
10. Open the IFC through Home Twin and compare room bounds, wall lengths, openings, and reference distances against the source dimensions.

The relevant primary documentation is [Bonsai's native IFC model tutorial](https://docs.bonsaibim.org/quickstart/create_model.html), [representation editing guide](https://docs.bonsaibim.org/guides/authoring/understanding_ifc/working_with_representations.html), and [IfcOpenShell geometry creation API](https://docs.ifcopenshell.org/ifcopenshell-python/geometry_creation.html).

## Plan workflow

A traced plan lives in one reviewable source, `model/references/plan.yaml`: points, room loops, dimension controls, evidence status, and uncertainty. This is an audited trace, not a general PDF recogniser. The source is editable in the browser or by hand.

`examples/demo/` holds a synthetic example: a living room with a diagonal wall, a sunken snug, a bedroom, a bathroom with a lowered ceiling and rooflight, a terrace, a stair, and a fictional site. Copy `plan.yaml` and `underlay.png` from it into `model/references/` to try the commands below.

Run the read-only review and generate the separate draft:

```bash
uv run home-twin review-plan
uv run home-twin build-draft
uv run home-twin-ui --model model/draft.ifc --port 8124
```

`--plan` selects another source. A project that only has the older `m1-plan.yaml` still works, and `review-m1-plan` and `build-m1-draft` remain as aliases.

The compiler creates native IFC4 spaces, ceilings, walls, and complete room-to-wall boundaries. It verifies the reopened model through `HomeTwin` and never writes `model/house.ifc`. The draft omits services, cabinetry, and detailed ceiling geometry until they can be reviewed.

## Check a trace against the drawing it came from

A trace can pass every printed control and still be wrong, because controls
check distances between traced points, not whether those points sit on drawn
walls. Registering the trace against the drawing's own linework checks the other
half, and it is how a trace is corrected.

The method, using only poppler and an SVG rasteriser:

1. Export the sheet's vectors: `pdftocairo -svg sheet.pdf sheet.svg`. Note the
   per-path `transform="matrix(0.12, 0, 0, -0.12, 0, 2384)"` that pdftocairo
   emits; path coordinates are in its own space, not the viewBox.
2. Rasterise the traced room outlines as a template and the sheet region as an
   image at the same scale, then cross-correlate them to find the plan origin.
   Try both Y directions: the wrong one scores near 0.5 and the right one near
   0.85, so the peak is unambiguous.
3. Record the recovered origin in `coordinate_frame.trace_transform`.
4. Classify drawn lines as wall faces by looking for a parallel partner 80 to
   420 mm away with real overlap. This separates walls from dimension lines and
   hatching without relying on colour, which matters because existing walls are
   drawn black like the dimensions.
5. Sample each traced room edge and measure how much of it has a wall face
   within tolerance. An edge below about 40 percent has no wall behind it.
6. Read the unsupported runs on the remaining edges as openings: their offset
   and width are the doorway or window.

On a real sheet this found a recorded transform with the wrong Y sign and
offset, missing interior doorways and windows, a missing common stair, and an
edge that doubled back along a wall.

The registered drawing is committed as `model/references/underlay.png` with
its calibration in the plan source, so the tracing workspace shows it behind the
traced points and any remaining disagreement is visible.

## Source-specific notes

### Existing IFC

Open it directly in Bonsai and run Home Twin's geometry checks. Inspect the project unit, building placement, storey elevations, `IfcSpace` geometry, spatial containment, and whether walls expose useful space boundaries. Do not normalize a working model only for stylistic consistency.

### DWG or DXF

Use the CAD file as an underlay, not as automatic BIM. Separate wall centerlines, faces, openings, grids, furniture, and dimensions into clean layers before tracing. DWG support varies between open libraries; converting to a clean DXF often reduces surprises.

### Vector PDF

Preserve vectors when possible. Remove title blocks, hatches, furniture symbols, and repeated dimension graphics from the tracing layer. Establish scale from a written dimension, never from page size alone.

### Raster or photographed plan

Correct perspective first. Use at least two independent dimensions to detect unequal X and Y scaling. Treat automatic line detection and OCR as drafting aids. Verify every wall and opening numerically.

## Semi-automatic path worth building later

The browser tracing workspace covers the dimension-led, reviewable half of this:
a calibrated underlay, snapped points, room topology, live control checks, and a
verified compile. What remains automatic is the part that needs recognition
rather than review: importing cleaned 2D wall lines, resolving ambiguous joins,
and reading printed dimensions off the drawing.

General plan recognition is a separate, high-difficulty project. It needs symbol classification, topology repair, dimension conflict handling, confidence reporting, and a human review UI. The [gap analysis](gap-analysis.md#dimensioned-plan-to-ifc) treats it as a possible separate repository or service, not part of this MVP.

## Acceptance checklist

Before lighting work starts, verify:

- project units and the building origin;
- absolute storey elevation;
- every room's name, height, and ceiling polygon;
- internal wall-face dimensions;
- opening widths, heights, and offsets from corners;
- fixed cabinetry and full-height furniture;
- shadow gaps and ceiling features;
- beams, ducts, AC units, and other spotlight obstructions;
- at least two independent whole-plan dimensions;
- the site latitude, longitude, and the bearing of plan `+Y` from true north, if any sun geometry will be used;
- a save, reopen, and query round trip in both Home Twin and Bonsai.
