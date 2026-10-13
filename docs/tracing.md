# Trace a plan in the browser

## What this replaces

Tracing a plan used to mean Blender and Bonsai, or hand-editing
`model/references/plan.yaml`. The **Trace plan** workspace does the same work
in the browser: place points over a calibrated reference drawing, close rooms,
record printed dimensions as controls, add openings, state the site, then build
the verified draft IFC.

Bonsai is still the right tool for expert BIM authoring, curved walls, sloped
ceilings, stairs, and repairing broken relationships. It is no longer needed for
tracing a straight-walled residential plan or positioning spotlights.

## What it edits

The workspace edits exactly one file: the reviewed plan source at
`model/references/plan.yaml`. There is no browser-side session, no database,
and no second building model. The pipeline is unchanged:

```text
model/references/plan.yaml        reviewed facts, evidence, controls
        |  POST /api/trace/save   atomic write under a revision guard
        v
src/home_twin/plan_draft.py         deterministic compile and reopen verification
        |  POST /api/trace/build
        v
model/draft.ifc                   verified draft, never the canonical model
```

The serialiser reproduces the reviewed source byte for byte when nothing
changed, so a save produces a small reviewable diff instead of a reformatted
file. The previous source is copied into `model/references/history/` before
every overwrite.

## Workflow

### 1. Load a reference drawing

Choose **Drawing setup**, then **Choose plan image**, and pick a PNG, JPEG,
WebP, or SVG of the plan. Convert a vector PDF to SVG or a high-resolution
image first and keep the original in `model/references/`. The image is stored beside the plan source as
`underlay.<ext>` and recorded in the source's `underlay` block. It is a
drawing to trace over. It never becomes geometry, and no IFC entity references
it.

### 2. Calibrate it

In **Drawing setup**, click both ends of a printed dimension. In the
inspector, enter that dimension in millimetres and choose whether the run is
along plan `+X`, along plan `+Y`, or should keep its drawn angle. **Apply scale**
sets `mm_per_px` and `rotation_deg`. **Point 1 becomes plan 0,0** moves the plan
origin to the first click.

Never establish scale from page size alone. Use a written dimension, then check
a second, non-parallel one with a control.

### 3. Correct or draw rooms

- **Edit rooms** keeps the floor clean until you select a room. It then shows
  only that room's corners. Drag a corner to move it, or choose **Add a corner**
  and click the relevant edge. Choose **Done** when its outline matches the
  drawing.
- **Draw a room** places corners in order. **Finish room** turns three or more
  corners into a room polygon. Trace connected circulation as part of the same
  room when no wall separates it.

Corners snap to the 10 mm grid, nearby traced corners, and existing wall lines.
A point used by a room, dimension check, opening, or wall override cannot be
deleted until it is released.

A room the review reports as `room_without_a_doorway` has no door, sliding
door, or cased opening: nothing reaches it. That is a trace gap rather than a
design, so trace the doorway.

**Draw a soffit** traces gypsum: a dropped patch, a bulkhead carrying services
along a wall, or a cove. It hangs in whichever room you draw it in, its
underside is measured from that room's floor, and it obstructs light there like
any other ceiling. A room's `ceiling_height_mm` stays the finished plane; a
soffit is the local feature below it.

**Draw a shaft** traces a ventilation shaft or light court. It is daylight
context, not a room: never internal floor area, and its contribution is not
calculated. Traced shafts are drawn under the room outlines so they read as
context, and clicking one opens its inspector.

Set **Kind** to *Outdoor space* for a yard, garden, or terrace. It is still traced and
still bounds walls, but it is not internal floor area and it is not reported as
missing a window. It compiles to an `IfcSpace` with `PredefinedType=EXTERNAL`
and no ceiling covering.

Trace each room from inside it. Where two rooms meet, both outlines run along
the same physical wall with their own points; the compiler pairs those two faces
and builds **one** wall filling the gap between them, so the model never shows a
double partition. The two faces have to cover at least 80% of the longer one for
that to happen; a short edge lapping a long one is a different run of wall. Its thickness is the gap you traced, not an assumption. A wall
traced from one side only takes `default_wall.thickness_mm`, or a
`wall_overrides` entry.

Room outlines may be concave. They must not self-intersect and must not overlap
another room by a positive area; the review reports both as blockers.

### 4. Record printed controls

**Check a dimension** asks for the two ends of a printed dimension and creates a
control with the traced length as its starting expectation. Replace it with the
number printed on the drawing. Existing controls remain hidden until selected,
so they do not cover the plan.

At least two non-parallel controls are required before the draft can be built.
This is what stops a uniformly wrong scale from passing.

When a check fails, either the trace is wrong there or the check is on the wrong
two corners, which is what happens after a corner is re-identified further along
its wall. **Move onto other corners** re-anchors it and leaves the printed
number alone. Never edit the printed number to make a check pass: it is the
check.

### 5. Add openings

**Add an opening** first asks for its room, then highlights only that room's
edges. Click the host wall, then set the width, sill, and head. Choose `unfilled` for a cased opening with no
door in it, such as the threshold at the top of a flight; it compiles to an
`IfcOpeningElement` with no filling. Only exterior glazed openings can cast a
direct-sun patch. Sill and head heights are assumptions
until they are confirmed on site, and the inspector says so.

### 6. State the site

**Site and true north** records latitude, longitude, ground level, the bearing
of plan `+Y` from true north, and a timezone. These compile into native
`IfcSite` fields and the model `TrueNorth`, which is what makes sun geometry
possible. Without them the review carries a `site_unstated` warning and the
sunlight panel stays unavailable. See [the daylight boundary](daylight.md).

### 7. Save, then build

**Save plan source** writes the reviewed source under its exact current
revision. A stale revision is rejected rather than merged. A source with review
blockers still saves, so tracing can continue across sessions.

**Build draft IFC** runs the same compiler the CLI runs. It refuses to publish a
source with blockers, requires the exact current draft revision when the source
changed, writes a temporary file, reopens it, verifies rooms, ceilings, walls,
openings, daylight context, the site, and the IFC schema, then atomically
replaces only `model/draft.ifc`. When the served model *is* that draft, the
service reloads it and the lighting workspace picks up the new geometry.

`model/house.ifc` is never written by this path. Adopting the draft over the
canonical model stays a separate, explicit **Replace IFC** transaction with a
backup.

## Canvas controls

| Action | Input |
|---|---|
| Pan | drag empty canvas space; shift-drag and middle-drag also work |
| Zoom | scroll, or use the visible zoom buttons |
| Fit the whole plan | use the fit button beside zoom |
| Correct a room | **Edit rooms**, select the room, then drag a corner |
| Move a whole wall | **Edit rooms**, select the room, then drag an edge between corners |
| Draw a rectangle | in **Draw a room**, **Draw a shaft**, or **Draw a soffit**, press, drag and release before placing any corner |
| Place a corner at an exact length | after the first corner, type the length in millimetres, then Enter (toward the cursor) or an arrow key (along plan ±X or ±Y) |
| Lock to plan X or Y | hold Shift while moving or clicking |
| Edit the typed length | Backspace removes a digit; Escape clears it |
| Slide an opening | select it, then drag it along its wall, or press an arrow key to move it 10 mm (Shift: 100 mm) |
| Nudge a point | select it, then press an arrow key to move it 10 mm along plan X or Y (Shift: 100 mm) |
| Add a corner to a room | select the room, choose **Add a corner**, then click its edge |
| Delete the selection | press Delete or Backspace, when no length is being typed |
| Finish a room | use **Finish room**, click its first corner again, or press Enter with no length typed; double-click also works |
| Cancel the current task | use its visible **Cancel** action, or press Escape when no length is being typed |
| Undo | **Undo** or Ctrl+Z, up to 50 steps |
| Redo | **Redo**, Ctrl+Shift+Z or Ctrl+Y; any new edit clears it |
| Save | **Save plan source** or Ctrl+S |
| Act on the selection | use the small toolbar beside it; the inspector on the right keeps every field |
| Hide the reference underlay | the eye button beside zoom, or U; view only, never saved |
| List every shortcut | **Shortcuts**, or ? |

A selected room being edited, point, opening, or dimension check shows a
floating toolbar beside it, above unless there is no room, and hidden while
anything is dragged. It carries the selection's main actions: **Add a corner**
and **Done** for a room, Delete for a point (disabled, with the reason, while a
room, control, or opening uses it), width, sill and height for an opening, and
**Move onto other corners** for a check. Each toolbar is named for what it acts
on by plan id, for example "Opening window_1". They call the same actions as the
inspector and write the same plan-source fields.

Hiding the underlay is a view setting. It does not touch `underlay.opacity` or
anything else in the plan source, so it never shows up as a change to save.

Undo and redo hold up to 50 steps each and are cleared by a save. A held arrow
key is one undo step; separate presses are one step each. Undo and redo shortcuts
are ignored while a text field has focus, so they never fight the field's own
undo. The browser warns before leaving the page with unsaved changes.

A click selects; it never moves anything. A drag has to travel 40 mm in plan
terms before it counts, and it keeps the grab point under the cursor rather than
re-centring the thing on the pointer. Without both of those, selecting an
opening slid it to wherever it was clicked.

A dragged point will not snap onto its own neighbours in a room outline, because
that collapses an edge to nothing.

A dragged wall moves both of its corners by the part of the drag square to the
wall, so it stays parallel and never slides along itself. The moved line lands on
a parallel traced wall within line-snap reach, otherwise on a 10 mm grid line (an
oblique wall moves in whole 10 mm steps). Corners are shared ids, so a
neighbouring room that uses them moves with it. The whole drag is one undo step.

### Shortcuts

Letter shortcuts work only when no text field has focus and no Ctrl, Cmd or Alt
is held. The **Shortcuts** dialog shows this same table.

| Keys | Action |
|---|---|
| V | Edit rooms |
| R | Draw a room |
| H | Draw a shaft |
| F | Draw a soffit |
| O | Add an opening |
| D | Check a dimension |
| G | Drawing setup |
| U | Hide or show the reference underlay; view only, never saved |
| ? | Show this list of shortcuts |
| Ctrl+Z or Cmd+Z | Undo, up to 50 steps |
| Ctrl+Shift+Z, Cmd+Shift+Z or Ctrl+Y | Redo |
| Ctrl+S or Cmd+S | Save the plan source |
| Arrow keys | Move the selected point 10 mm along plan X or Y, or slide the selected opening 10 mm along its wall |
| Shift+arrow keys | Move or slide the selection 100 mm |
| Shift held | Lock the next corner to plan X or Y through the last corner |
| Digits, then Enter | Place the next corner at that length in millimetres, toward the cursor |
| Digits, then an arrow key | Place the next corner at that length along plan X or Y |
| Backspace while typing a length | Remove the last digit |
| Press, drag and release | Draw a rectangular room, shaft or soffit before placing any corner |
| Drag a wall | Move a whole wall of the room being edited, keeping it parallel |
| Enter | Finish the room, shaft or soffit being drawn |
| Escape | Clear a typed length; otherwise cancel the current task and selection, or close this list |
| Delete or Backspace | Delete the selection |
| Space+drag | Pan; middle-drag, and dragging empty space in Edit rooms, also pan |
| Scroll | Zoom |

### Drawing preview

While drawing a room, shaft, or soffit, checking a dimension, or calibrating, the
canvas shows where a click would land. The marker is a ring on a traced point, a
diamond on a traced wall line, or a cross on the grid. After the first corner a
dashed line runs from the last corner to that spot, labelled with its length in
millimetres. With three or more corners, pointing at the first corner shows
"click to close", and clicking it finishes the shape. Calibration shows the line
and length only: its clicks do not snap.

The preview runs the same snap a click does, so it is what a click will place.
The same readout is written as text in the instruction bar, in a status line
named "Drawing readout", for example `Length 3000 mm · locked to plan X · snaps to
point p4 at x 3000, y 0 mm · click to close`. A typed length shows in a status
field named "Typed length".

A typed length is placed from the last corner toward the cursor, or along the
axis of the arrow key pressed, rounded to 0.1 mm. If an existing traced point
sits within 0.5 mm of the result, the corner reuses it. Typed lengths work in
the drawing tools and **Check a dimension**, not in calibration.

Shift locks the next corner to plan X or Y through the last corner, whichever
the cursor is nearer. Under Shift a traced point is still picked if it lies on
that axis; otherwise the free coordinate snaps to the 10 mm grid and traced wall
lines are ignored.

A press that travels 40 mm before release with no corners placed draws an
axis-aligned rectangle. Both ends snap as clicks do, and the room, shaft, or
soffit is finished at once as one undo step. A shorter press is a click.

A point snaps in three stages: onto a traced point if one is within reach, then
onto a traced wall line, then to the 10 mm grid. Points win over lines because a
shared corner matters more than a shared face, and sliding onto a line is what
puts a new point exactly on a wall that is already traced. **Add a corner** adds a
vertex on the edge nearest the click rather than at the end of the outline,
which would fold the room over itself.

Deleting a point that a room, control, or opening still uses is refused with a
message naming what needs releasing first.

Grab targets and strokes are sized in screen pixels, not millimetres, so a point
stays the same size to aim at whether the whole flat or one corner is in view.
Dragging snaps onto another traced point within about 250 mm so shared corners
stay shared; picking is more forgiving so a loop can be closed back onto its
first point.

## Review output

The dock reports rooms, passing controls, and traced net area. **Plan checks**
keeps the detailed list collapsed until it is needed, and uses the same blocker
and warning codes as the CLI:

- `control_failed`, `controls_not_independent`, `room_overlap`,
  `self_intersection`, `small_room`, `duplicate_room_point`,
  `unknown_aperture_host`, `aperture_room_mismatch`, `aperture_too_wide`,
  `aperture_too_tall`, `invalid_daylight_source`, `unresolved_evidence` are
  blockers.
- `unverified_evidence`, `net_to_declared_area`, and `site_unstated` are
  warnings.

Reviewing an edited document never touches the working tree. Only **Save plan
source** writes.

## What a save can and cannot lose

The editor fetches the whole plan document and saves the whole plan document, so
it has to carry fields it does not itself edit. The boundary schema preserves
unknown keys for exactly that reason. Before it did, saving from the browser
silently deleted the stairs, reset every room to the plan datum, and dropped
every door's offset so each one jumped to the centre of its wall.

If you add a field to the plan model, add it to `ui/src/types.ts` as well when
the editor should show or change it. The round-trip test in `types.test.ts`
proves an unknown field survives regardless.

## If the trace will not load

`This server does not know the plan fields ...` means the running service is
older than the plan source. That happens whenever the plan schema gains a field
while a server is left running: the process holds the old model class in memory
and rejects the file. Restart it and reload.

```bash
uv run home-twin-ui --model model/draft.ifc --port 8124
```

Any other validation message names the field and the problem, and needs an edit
to the source rather than a restart.

## Limits

This is a dimension-led tracing tool for straight walls, flat ceilings, and
rectangular openings. It does not recognise plan symbols, read dimensions from a
PDF, repair arbitrary BIM geometry, or model curved walls, sloped ceilings, or
stairs. Treat the result as a reviewed design trace, not an as-built survey,
until it is checked on site. See [the plan import notes](plan-import.md).
