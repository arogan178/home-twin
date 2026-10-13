# Local browser UI

The browser UI is the normal interface for lighting work on a usable IFC model. It runs on the same computer as the model and calls the existing `HomeTwin` facade. It does not introduce a database or a second building model.

## Start it

```bash
uv sync --extra dev
npm --prefix ui ci
npm --prefix ui run build
uv run home-twin-ui --model model/house.ifc
```

Home Twin binds to `127.0.0.1:8123` and opens the browser. Use `--no-open` when another process manages the browser.

The HTTP server is unauthenticated and intended for local use. It answers only requests whose `Host` is a loopback name, which stops DNS rebinding, and it rejects a write whose browser `Origin` is not Home Twin itself or the Vite dev server, which stops a malicious page posting to it. Binding to every interface with `--host 0.0.0.0` refuses to start until `--allowed-host` names the hostname or IP clients will use; repeat the option for each one. Anyone who can reach that address can then change the model.

The server compresses large responses and caches files with build hashes in their names. Saved room and whole-floor snapshots are reused until the IFC revision changes. Room analysis that uses IES or LDT files rereads those files, because their contents can change independently of IFC.

To measure read-only API latency and transferred bytes on a running server:

```bash
uv run python scripts/benchmark_application.py --url http://127.0.0.1:8123
```

To trace a plan or review the generated draft instead of the canonical model:

```bash
uv run home-twin review-plan
uv run home-twin build-draft
uv run home-twin-ui --model model/draft.ifc --port 8124
```

This keeps `model/house.ifc` untouched. Select each room and compare its outline and ceiling elevation with the PDF before adding fixtures.

## Two workspaces and two views

The top bar switches between **Lighting** and **Trace plan**. Lighting designs
fixtures in an existing model. Tracing authors the reviewed plan source that
becomes a draft IFC; see [browser plan tracing](tracing.md).

Inside the lighting workspace, **2D** and **3D** show the same IFC-derived
geometry. The 2D ceiling plan is where point fixtures are dragged and dimensions
are read. The 3D view orbits the room shell, shows spotlight beam volumes,
pendants, rope lights, rendered light pools, and physical wall switches. It is a derived visualisation:
walls are drawn at an indicative 120 mm thickness from the exact IFC face lines,
and nothing in it is a second building model. The 3D bundle loads only when the
view is opened.

## Design a lighting layout

1. Select a room in the left rail.
2. Add a **Spot**, **Pendant**, **Rope**, or **Switch**. Point lights drag on the 2D ceiling plan; a switch drags from wall to wall in 3D. **Spot** and **Pendant** can also be dragged from the toolbar onto the 2D plan: the new light lands at the drop point, snapped to the active snap grid. A drop whose snapped point is outside the ceiling adds nothing and says so.
3. Enter exact X, Y, and Z coordinates in the fixture inspector when the installation point is known.
4. Give any number of lights and a switch the same switching-group label. Clicking the physical switch in 3D previews that complete group on or off.
5. Set the type-specific model, output, colour temperature, dimensions, and mounting data.
6. Wait for the automatic layout analysis after an edit. Blocking findings disable **Save to IFC**. **Check layout** remains available for an immediate refresh.
7. Choose **Save to IFC**. The backend validates the complete room design and performs one verified IFC transaction.
8. Choose **Export** to create and download the CSV, JSON, and SVG installation files, including typed lights, switches, paths, and control groups.

**Propose** replaces the current draft with the deterministic constrained layout. Every proposed seat already satisfies edge clearance and minimum spacing, so a proposal can be saved without hand-editing it. It does not modify IFC until you save it.

**Duplicate** (Ctrl+D, or Cmd+D on macOS, or the button in the fixture inspector) copies the selected spotlights and pendants into the unsaved draft. Each copy sits one snap-grid step east (+X) and one step south (-Y) of its original (100 mm if no grid is set), keeps the original's spec, aiming direction and switching group, takes the next `SP` or `PN` tag free across the whole home (saved rooms and other rooms' unsaved drafts), and starts with no notes. The copies become the selection, and one undo removes them all. Ctrl+D only overrides the browser's bookmark shortcut while a spotlight or pendant is selected and focus is not in a text field. Rope lights and switches are not duplicated.

**Distribute** is enabled once 3 or more spotlights are selected; its tooltip gives the count when it is not. The two selected spotlights furthest apart stay where they are. The others are ordered by their position along the line between those two, ties broken by tag, and moved onto that line at equal intervals. Equal spacing wins over the snap grid, so distributed spotlights can sit off the grid. It edits only the draft and is one undo step. The MCP `distribute_fixtures` tool uses the same ordering; the UI action equals calling it with `start` and `end` at the two extreme spotlights.

**Align** moves every spotlight in the room, not just the selection, onto the axes the others share.

Clicked, **Spot** and **Pendant** use the point furthest from every ceiling edge, not the bounding-box centre, so a concave open-plan room does not receive a mark outside itself. **Rope** starts with a short editable path around that safe point. **Switch** starts at the middle of the nearest room wall.

## When the server needs restarting

Python is loaded once. A fix edited after the process started is not in it, and
from the browser that is invisible: the answers do not change. The server
digests its own sources at startup and again on every project read, and the
header says **Server needs restarting** when the two differ. Rebuilding the UI
is enough for a page reload; changing Python is not.

## Designing a room is a sequence

The design workspace runs in stages, and each shows only the controls that
answer its own question: **Ceiling** (slab and gypsum), **Light** (place,
propose, coverage, snap grid), **Daylight** (sun patches), **Dark spots**
(under-target patches), **Publish** (check, save, export). Publishing is the
only stage that offers to write the model.

A dragged spotlight lands on the snap grid chosen in the Light stage, and the
plan draws that grid.

## Annotation is sized in screen terms

Text and symbols on a plan are sized in screen pixels, not plan millimetres, so
a dimension reads the same in a 3 m bathroom and across a 20 m floor. The
compass and the scale bar sit at a fixed size in the viewport corner rather
than scaling with the room.

Where a label will not fit what it names, it is dropped rather than allowed to
land on a neighbour: the room's tooltip still carries it. A wall's dimension
sits outside the room and an opening's label inside, so the two never overlap.

## Ceilings and the soffit under them

A home can have one structural ceiling throughout and lower finished ceilings
in some rooms. `ceiling_height_mm` is always the **finished** level, because
that is what a fixture mounts on and what a beam is measured from;
`structural_ceiling_height_mm` states the slab above it when they differ.

The 3D views carry two toggles. **Ceiling** draws the slab. **Gypsum** draws the
soffit hung below it, and is disabled when no room states one. In the
whole-floor view both start off, because a ceiling seen from above hides
everything under it.

## One room, or the whole floor

The room rail starts with **Whole floor**, which draws every traced room at once
in 2D or 3D with its name, ceiling height, committed lights, and every unsaved
room draft from the current browser session. A room above the plan datum takes
a lighter fill, so a split level reads at a glance. Clicking a room highlights
it without leaving the whole-floor view; use the room list to open it for editing.

A flight arriving at a level opens the floor it arrives at, in both the
whole-floor and the single-room 3D, so the entrance stair is visible instead of
buried under the living-room slab. The five visible treads and sixth riser meet
the upper landing at its exact 1050 mm datum.

A room's own levels are listed under it in the room rail rather than beside it:
a sunken snug is the living room's lower level, not a room of its own.

That view is deliberately geometry-read-only, although its physical switches
can preview their groups on and off. Its 3D omits beam volumes and the shadow
pass. Design work is per room because the constraints and the shadow
pass are per room; the whole floor is for judging whether the trace adds up and
for showing the proposal to someone.

Both 3D views use subtle procedural plaster, stone, paving, timber, glazing,
frames, slab thickness, and cast shadows to make depth and apertures legible.
Those finishes are display aids, not authored IFC material facts. Doors and
windows are simple review representations rather than fabrication models.

## Move around the plan

Scroll to zoom, which keeps the point under the cursor fixed. Drag with the
middle or right button, or shift and the left button, to pan; the left button
alone still drags a spotlight. The control in the top right zooms in steps,
shows the current scale, and fits the room again.

## Move around in 3D

Both 3D views share one set of controls, in `cameraControls.ts`. The left
button orbits, the middle and right buttons pan, and the wheel zooms towards
the pointer rather than the orbit centre, so reaching a corner is one gesture.
The camera stops just above the horizon, and cannot dolly inside a wall or
retreat until the home is a dot.

**Double-click anything to look at it.** The view slides until that point is
its centre, keeping the direction and distance it already had, and everything
afterwards orbits what was picked. A double-click passes through glass and
through any wall currently faded, so it reaches the room behind rather than
stopping at a surface being seen through.

**See through walls** fades the first wall between the camera and the point
the view is aimed at, and is on by default in both views. Reaching a room used
to mean zooming past the wall in front of it; a diagonal facade over a
room is the worst of them. A faded wall becomes a faint pane rather than
disappearing, so it is still clear which rooms the view is crossing, and it
stops casting a shadow, because a shadow under no visible wall reads as a
defect in the model.

Only the first wall on each probe gives way. Fading everything in line
flattens the whole depth of the home into one pane, when what was asked for is
seeing past the wall in front. Two walls can still come back together, because
near a corner each probe meets a different one first. The wall being aimed at
stays solid: the test is what interrupts the view, not what is near it.

Nothing fades once the sightline tilts more than 60 degrees from the
horizontal. From a near-plan view the camera already looks over the wall
heads, the ceiling and gypsum toggles are the controls for seeing in from
above, and fading there dissolves walls that were being read as walls.

The test runs only when the camera or its target moves, and once more whenever
the scene is rebuilt, so clicking a wall switch does not flash every wall
solid before settling again. It is off in the whole-plan walk mode, where the
camera is inside the room and the wall it faces is the view. The toggle turns
it off when a massing picture of solid walls is what is wanted.

## 3D tools

A rail at the top right of both 3D views holds the tools, and each has a key.
Press **?** for the list.

- **Plan view (T)** looks straight down with plan +Y up the screen.
  **Eye level (E)** stands in the room's deepest interior point, facing its
  longest clear run, which is where glare and the height of a pool of light are
  judged. In the whole floor, **E** walks instead. Both views take the eye from
  one height: 1.65 m, the household's average standing height, less 11 cm to the
  eyes.
- **Measure (M)** picks two points on the displayed surfaces and reports the
  distance with its X, Y and Z parts. Hold Shift on the second point to lock to
  the dominant axis. The points are wherever a ray met a drawn surface: exact
  for wall faces, floors and IFC bounds, illustrative for detailed joinery.
- **Section (C)** cuts horizontally, like a plan cut at 1.2 m, or across X or
  Y. The cut is display only. The shadow pass ignores it, so the hidden side
  still casts and the lighting does not change.
- **Snapshot** saves a PNG with the view's disclaimer drawn into it, so a
  forwarded picture carries the same method label as the numbers behind it.
- **Copy link** copies the address, which holds the view, scope, room and
  camera (`cam`). A reload, a link, or a trip to 2D and back returns to the same
  angle. Moving to another room or to the whole floor drops the camera.
- **Full screen (F)**, **R** to reset, and **X** to toggle see-through walls.

**Click a building element to read it.** In the room view a still click on a
cabinet, appliance, wall, window, door frame or stair opens a card with its
Tag, GlobalId, IFC bounds and property sets. Hover outlines what a click would
pick. A drag still orbits, and lights and switches keep their own click.

**Switch groups** in the right rail switch each group on or off and preview it
dimmed. The level scales rated output in the 3D views only. It is not a dimmer
curve, the coverage surface and every check stay at full output, and a fitting
whose spec says it cannot dim stays at full output, as it would on site.

**Walk mode** in the whole floor rides at that eye height above the floors and
treads it draws, so a flight lifts the eye one riser at a time, and walls stop
the body. Each room's floor stops at its own wall face, so a doorway is a
floorless strip the wall's thickness wide; walking crosses it when the next
room's floor is within 0.6 m. It starts in the highlighted room, or the largest
one.

**Switching off goes dark.** The standing bounce, fill and reflections scale
with the share of rated output that is switched on and at its preview level,
because interreflection is proportional to the flux put into a room. A room
keeps 3% of its bounce with everything off so its geometry still reads, and 35%
while the sun is up, because daylight's own diffuse is not modelled. The
whole-floor night sky scales the same way. These are display floors, not lux.

Both views draw a frame only when something changed. The camera moving, a
door swinging, or a scene edit asks for one; a still room costs nothing.
Selecting a light, dimming a group and highlighting a room recolour what is
already built instead of rebuilding the scene.

## Layers

| Layer | What it draws | Method |
|---|---|---|
| **Light** | rendered task-plane coverage and a glow under each spotlight | `lumen_beam_cone_v1` |
| **Sun** | direct-beam patches, the plan compass sun, and the 3D sun | `direct_sun_patch_geometry_v1` |
| **Dark zones** | task-plane samples below the target | `lumen_beam_cone_v1` |

**Light** shades every task-plane sample from unlit to the brightest sample in
the room and prints the peak value with its method in the legend. It is a
reading aid for a labelled approximation, not a calibrated false-colour scale
and not a photometric simulation.

**Sun** needs a site. When the model states no latitude, longitude, and true
north, the panel says so and links to the tracing workspace instead of guessing
a location. With a site, the right rail shows solar altitude and azimuth, the
patch count and lit area, the day's sun path with sunrise, solar noon and
sunset, and the full exclusion list. Sun patches are geometry: they carry no
illuminance value. See [the daylight boundary](daylight.md).

**Dark zones** follows the current unsaved spotlight positions. Pendants and
rope lights are deliberately excluded until their photometric methods are tested;
the validation response names those exclusions.

**Run shadow pass**, in the right rail whenever **Light** is on, samples the
room at 150 mm and tests every fixture-to-point line against the room's solids:
cabinetry, services, stair masses, and walls with their openings cut out. It
reports the peak, the mean, the fraction at target, the fraction shadowed, and
what it considered. The plan and the 3D floor then shade with that result
instead of the coarse live grid. It is labelled `direct_occluded_v1` and takes a
few hundred milliseconds on a large room, so it runs when asked rather than on
every drag. See [the lighting design model](lighting-design.md).

Stair flights that serve or adjoin the room are drawn with their tread nosings
and an ascending arrow in plan, and as real steps in 3D. They are also
occluders: a stair mass blocks light.

The plan labels resolved wall-face lengths in millimetres. Rotated rooms do not use their larger axis-aligned bounding box as a displayed room size. Each spotlight also draws its geometric beam footprint at the configured task-plane elevation, following its stored aiming direction rather than assuming vertical. Windows, glazed sliding doors, and nearby shaft or light-court context use blue plan marks. They remain excluded from the electric-light estimate. The footprint, coverage image, and dark-zone grid do not include IES intensity, reflections, materials, or daylight.

## Replace the IFC

Choose **Replace IFC** and select a local `.ifc` file. The UI uploads it only to the loopback service on the same computer.

Home Twin first writes a hidden sibling temporary file and checks:

- IfcOpenShell can reopen it;
- it has an `IfcBuilding` and at least one `IfcSpace`;
- each usable room has ceiling geometry;
- room walls can be resolved;
- IFC schema validation results.

The review screen separates blockers from warnings. **Use this IFC** requires the current model revision, saves a recovery copy under `model/backups/`, atomically replaces the canonical file, reopens it, and verifies building and room identities.

## Current boundary

The UI removes Blender and Bonsai from supported lighting design, validation, installation export, and plan tracing. The tracing workspace authors points, room outlines, printed controls, rectangular openings, the site, and a calibrated underlay, and builds the verified draft IFC without leaving the browser.

It is still a dimension-led tracing tool. It does not recognise plan symbols, read dimensions out of a PDF, repair arbitrary BIM geometry, or model curved walls or sloped ceilings. Stairs are in the plan source, and the compiler builds them as `IfcStair` with a stepped `IfcStairFlight`, but the tracing workspace cannot draw or edit them yet. It preserves them when it saves.

Use Bonsai for those expert authoring tasks and for final 3D BIM inspection, then return to the browser UI.

## Develop the UI

Run the API and Vite development server in separate terminals:

```bash
uv run home-twin-ui --model model/house.ifc --no-open
npm --prefix ui run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` requests to port 8123.

Run all checks:

```bash
uv run --extra dev ruff check .
uv run --extra dev pytest
npm --prefix ui run build
npm --prefix ui test
```
