# Architecture

## Problem

Home Twin must let an agent reason about a house without turning IFC into an arbitrary mesh or exposing raw IfcOpenShell calls. The first release needs exact room and fixture coordinates, safe spotlight edits, geometric checks, and installation outputs. IFC remains the only durable model.

The difficult boundary is mutation. A successful fixture operation must mean that the canonical IFC file on disk already contains the verified edit. There is no public pending-edit state.

## Usage from a caller

```python
from pathlib import Path

from home_twin import HomeTwin, SpotlightSpec

twin = HomeTwin.open(Path("model/house.ifc"))

room = twin.get_rooms()[0]
print(twin.get_ceiling_polygon(room.id))
print(twin.get_walls(room.id))

proposal = twin.optimise_spotlight_layout(
    room.id,
    fixture=SpotlightSpec(
        model="Example 8 W",
        lumens=650,
        beam_angle_deg=36,
        cct_kelvin=3000,
        cri=90,
        dimmable=True,
        diameter_mm=82,
        cutout_diameter_mm=68,
        mounting_depth_mm=95,
    ),
)

if proposal.validation.valid:
    twin.apply_lighting_layout(
        proposal.layout,
        expected_revision=proposal.model_revision,
    )
print(twin.revision)
```

Every returned coordinate uses the canonical building frame in millimetres. A fixture mutation validates, writes a sibling temporary IFC, reopens it, verifies the intended result, and atomically replaces the canonical file before it returns.

## System shape

```text
Codex or another MCP client          Local browser
        |                                  |
        v                                  v
home-twin FastMCP adapter            FastAPI UI adapter
        |                                  |
        +----------------+-----------------+
                         v
HomeTwin facade
   |          |             |
   |          |             +--> installation plan -> CSV, JSON, and SVG
   |          +--> pure geometry, constraints, and lighting heuristics
   v
IfcRepository
   |
   +--> IfcOpenShell semantics, placements, geometry, and mutation API
   +--> validate -> temp write -> reopen -> verify -> atomic replace
   v
model/house.ifc                 canonical source of truth

Reviewed plan facts
        |
        v
plan compiler -> validate -> reopen -> model/draft.ifc
                                      separate review candidate

Optional companions:
  IfcMCP       generic IFC query, schema, clash, plot, and render tools
  Bonsai MCP   live Blender/Bonsai inspection and screenshots
```

The direct facade is intentionally small. It avoids a generic repository framework, event log, command hierarchy, database, and normalized copy of the model.

## Domain values and signatures

Framework types stop at the adapters. Domain code uses frozen dataclasses.

```python
@dataclass(frozen=True, slots=True)
class Point3D:
    x: float  # mm
    y: float  # mm
    z: float  # mm

@dataclass(frozen=True, slots=True)
class Bounds3D:
    minimum: Point3D
    maximum: Point3D

@dataclass(frozen=True, slots=True)
class Room:
    id: str               # IFC GlobalId
    name: str
    storey_id: str
    elevation_mm: float
    bounds: Bounds3D

@dataclass(frozen=True, slots=True)
class BuildingObject:
    id: str               # IFC GlobalId
    ifc_class: str
    kind: ObjectKind
    room_ids: tuple[str, ...]
    bounds: Bounds3D
    properties: Mapping[str, JsonScalar]

class HomeTwin:
    @classmethod
    def open(cls, path: Path, *, config_dir: Path | None = None) -> HomeTwin: ...

    def get_building(self) -> Building: ...
    def get_storeys(self) -> tuple[Storey, ...]: ...
    def get_rooms(self) -> tuple[Room, ...]: ...
    def get_objects(self, *, room: str | None, kind: ObjectKind | None) -> tuple[BuildingObject, ...]: ...
    def get_room_context(self, room_id: str) -> RoomContext: ...
    def measure_points(self, a: Point3D, b: Point3D) -> float: ...
    def raycast(self, origin: Point3D, direction: Vector3D) -> RayHit | None: ...

    def validate_lighting_layout(self, layout: LightingLayout) -> ValidationReport: ...
    def optimise_spotlight_layout(self, room_id: str, fixture: SpotlightSpec) -> LayoutProposal: ...
    def add_spotlight(...) -> LightFixture: ...
    def move_fixture(...) -> LightFixture: ...
    def delete_fixture(...) -> MutationResult: ...
    def apply_lighting_layout(...) -> MutationResult: ...
```

IFC `GlobalId` values are the public object IDs. Numeric STEP IDs never cross the repository boundary. Fixture `Tag` values such as `SP07` are the trade-facing labels and must be unique.

## Module ownership

```text
src/home_twin/
  model.py           HomeTwin facade and domain records
  ifc.py             sole IfcOpenShell boundary and durable transactions
  geometry.py        pure millimetre geometry
  fixtures.py        fixture specifications and IFC property convention
  lighting.py        deterministic candidates and lumen/beam heuristics
  daylight.py        solar position and direct-sun patch geometry
  occlusion.py       shadow rays against a room's solids
  constraints.py     typed project rules
  validation.py      stable finding codes and mutation gates
  exports.py         one installation plan rendered to CSV, JSON, and SVG
  mcp_server.py      FastMCP schemas, annotations, and domain projection
  ui_server.py       local HTTP adapter, IFC intake, and static UI host
  plan_draft.py        reviewed plan source: parse, review, serialise, compile, publish

ui/
  src/plan.ts             pure plan-frame maths shared by every view
  src/useViewport.ts      pan and zoom for an SVG plan, in millimetres
  src/CeilingPlan.tsx     2D plan, rendered light, sun patches, compass
  src/RoomView3D.tsx      derived WebGL room view, loaded on demand
  src/TraceWorkspace.tsx  plan tracing over a calibrated underlay
  src/DaylightPanel.tsx   site, instant, solar readout, sun path
  src/BakePanel.tsx       the on-demand shadow pass and its result
  src/App.tsx             workspace and view switching, draft/version policy
```

The facade completes each use case. `ifc.py` protects all IFC knowledge. The other modules are pure or read-only. The MCP adapter does not contain business logic.

The browser UI edits a draft fixture layout in memory. Validation and commit requests cross a closed HTTP schema. The Python service reconstructs domain values and calls `HomeTwin`; browser code never writes IFC. IFC intake is two-step: inspect a sibling temporary file, then explicitly adopt it against the current revision. Adoption saves a recovery copy, atomically replaces the model, reopens it, and verifies building and room identities.

The plan authoring path is intentionally separate from ordinary fixture mutation. Strict YAML records source provenance, traced facts, uncertainty, control dimensions, the site, and a calibrated underlay reference. The compiler builds `model/draft.ifc` with deterministic IFC identities, validates the reopened geometry, and requires the exact current draft revision when source facts change. It cannot write `model/house.ifc`; adopting the candidate remains an explicit UI transaction with a backup.

Browser tracing edits that same YAML and nothing else. `POST /api/trace/review` reviews a submitted document without touching the working tree, `POST /api/trace/save` writes it atomically under an exact revision guard after copying the previous source into `model/references/history/`, and `POST /api/trace/build` runs the identical compiler the CLI runs. The serialiser round-trips the reviewed source byte for byte, so browser edits produce reviewable diffs. There is no server-side tracing session and no second building model. An underlay image is stored beside the source as a reference and is never referenced by any IFC entity.

The 3D view is a derived visualisation built from the same `RoomContext` the plan uses. It is disposable and reproducible from IFC, so it stays out of the canonical path. That Open Components remains the choice if a general IFC browser viewer is ever needed; it is not, because the view exists to show the lighting design rather than arbitrary IFC geometry.

## Canonical coordinate system

Home Twin uses one right-handed building frame:

- `+X` points east or right on the project plan.
- `+Y` points north or up on the project plan.
- `+Z` points upward.
- `(0, 0, 0)` is the IFC building origin after the full IFC placement chain is resolved.
- Storey elevations are absolute `Z` values in this frame.
- All public positions, lengths, bounds, polygons, and export dimensions use millimetres.

IfcOpenShell geometry is evaluated in world coordinates and converted from SI metres to millimetres. Fixture authoring applies the inverse conversion through `ifcopenshell.api.geometry.edit_object_placement`. Blender coordinates never enter domain code. Project configuration can add labels and classification overrides, but it cannot redefine geometry or the canonical transform.

Coordinates remain floating-point millimetres because rotated IFC placements can produce sub-millimetre values. Installation exports use one documented half-away-from-zero rounding rule and state their precision.

## Room and object geometry

The repository prefers explicit IFC relationships:

1. `IfcRelSpaceBoundary` for room-bound walls and openings.
2. `IfcRelContainedInSpatialStructure` for furniture, fixtures, and coverings.
3. World-coordinate tessellation for bounds, ceiling outlines, collisions, and ray hits.
4. A documented proximity fallback when a model lacks space boundaries.

Ceiling polygons come from the top boundary of the `IfcSpace` solid or an explicitly related ceiling covering. If neither source produces a valid polygon, the tool returns a geometry-unavailable error. It does not silently substitute an unrelated mesh.

The first raycast and clearance implementation uses exact world-space triangle data where practical. A result that falls back to axis-aligned bounds includes `method: "aabb"` so an agent does not mistake an approximation for exact geometry.

## Durable fixture transactions

All public fixture mutations use this transaction:

```text
read canonical bytes and hash
        |
compare expected revision, when supplied
        |
clone the in-memory IFC through STEP serialization
        |
apply one whitelisted fixture operation to the clone
        |
run domain validation and IFC validation
        |
write a sibling temporary IFC
        |
reopen the temporary IFC with IfcOpenShell
        |
verify fixture identity, placement, containment, properties, and intended delta
        |
atomically replace the canonical IFC
        |
refresh the in-memory model and return the new revision
```

On failure, disk and memory both retain the previous revision. `save_model()` reports the already-durable revision. It does not commit hidden pending edits. Saving to a different path is an explicit export operation.

The first release supports only whitelisted typed `IfcLightFixture` and
`IfcSwitchingDevice` creation, movement, grouping, and deletion. It does not
expose arbitrary `set_property` or `ifcopenshell.api` execution. Official IfcMCP remains the expert tool for generic work.

## IFC lighting convention

Recessed spotlights, pendant bulbs, and rope lights use `IfcLightFixture` with
`PredefinedType=LIGHTEMITTINGDIODE`. `Name` and `Tag` contain the installation
label. Spatial containment associates the fixture with its `IfcSpace` where
supported, or its storey with an explicit room reference property.

`Pset_HomeTwinLighting` stores:

- `FixtureKind`
- `Model`
- `Lumens`
- `BeamAngleDegrees`
- `CCTKelvin`
- `CRI`
- `Dimmable`
- `SwitchingGroup`
- `DiameterMm`
- `CutOutDiameterMm`
- `MountingDepthMm`
- `DirectionX`, `DirectionY`, and `DirectionZ`
- `IESPath`, when present
- `PeakCandela`, when the lamp publishes an on-axis peak; this feeds the
  declared peak-candela beam-falloff estimate and is not a full photometric
  distribution
- `IPRating`, when the fitting has to be sealed

Pendant properties additionally store `DropMm`, canopy dimensions, and
`BulbDiameterMm`. Rope properties store `LumensPerMetre`, `PathPointsMm`,
`MinimumBendRadiusMm`, `Mounting`, and `IPRating`.

Physical switches use `IfcSwitchingDevice` and `Pset_HomeTwinSwitch` with
`HostWallId`, `OffsetMm`, `MountingHeightMm`, `MountingFace`, device and plate dimensions,
`RoomId`, and `SwitchingGroup`. Each switching-group label resolves to one
`IfcGroup` carrying `Pset_HomeTwinControl.Label`; `IfcRelAssignsToGroup` holds
the switch and luminaire GlobalIds.

New fixture types need a domain type, IFC mapping, validation, export projection, and save/reload test. No type is added only as a string in MCP.

## Lighting fidelity

Lighting results always state one method:

- `geometric` covers beam cones, alignment, collision, and coverage footprints.
- `lumen_approximation` estimates a task-plane grid from lumens, beam angle, distance, and explicit assumptions. It does not include inter-reflection or material response. `direct_occluded_v1` adds shadow rays against the room's solids within the same tier; it is a fidelity step, not a new claim.
- `photometric` covers a measured IES candela distribution evaluated as a point source. `ies_lm63_point_v1` is Type C LM-63; `ies_lm63_occluded_v1` and `ies_lm63_occluded_plus_room_interreflection_v1` are the same distribution through the bake tiers. An EULUMDAT (LDT) file is read into the same Type C distribution and reports the same labels; its intensities are relative, so they are scaled to the fixture's rated lumens.
- `simulation` is reserved for a validated engine such as Radiance.

The MVP implements every method except `simulation`. It never labels an approximate grid as a simulation, and a layout mixing measured and unmeasured fixtures is labelled by its weakest tier. A rendered coverage image is the same `lumen_approximation` grid drawn in colour, and says so in the legend.

Daylight is a separate axis with its own labels. `noaa_solar_position_v1` gives the solar position and `direct_sun_patch_geometry_v1` gives the beam footprint. Neither produces an illuminance value, and both list their exclusions in every response. Site latitude, longitude, and true north come from native `IfcSite` and `TrueNorth` fields; when the model does not state them, the result says `site_unknown` instead of assuming a location. See [the daylight boundary](daylight.md).

The optimiser has a deterministic ordering key:

```text
hard violation count
soft penalty
fixture count
fixture coordinate tuple
fixture tag tuple
```

The same IFC revision and configuration produce the same proposal and export.

## Reuse boundary

Home Twin depends on IfcOpenShell for parsing, semantics, geometry, mutation, and serialization. It does not copy or wrap every IfcMCP tool.

Run official IfcMCP beside Home Twin for generic IFC summaries, relationships, schema documentation, clash checks, validation, 2D plots, and off-screen renders. Use Bonsai for unsupported BIM authoring and model repair. The local UI replaces it for supported IFC lighting work and for dimension-led plan tracing. Avoid concurrent writers to the canonical file; Home Twin detects an external revision change before replacement.

The browser 3D view uses three.js directly rather than a BIM viewer stack, because it renders derived lighting design geometry that no IFC viewer knows about: beam cones, task-plane coverage, sun patches, and light shafts. It is loaded on demand so the 2D path does not pay for it.

## Synthesis decision

Two architecture candidates were compared. Candidate 1 used immutable snapshots, commands, planners, replay journals, repository protocols, and multiple adapter layers. Candidate 2 used one facade, one concrete IFC repository, and pure domain functions. Both scored 20/25 in the cross-judge review.

Candidate 2 is the base because it has shorter call chains and a credible first-release size. The final design grafts Candidate 1's strongest properties:

- a fixture mutation is durable before it returns;
- the temporary IFC is reopened and checked before atomic replacement;
- stale file revisions reject rather than overwrite external Bonsai edits;
- validation uses stable finding codes;
- lighting modes and deterministic score ties are explicit;
- all installation formats render from one plan and one committed revision.

The design rejects Candidate 1's snapshot framework, command hierarchy, replay journal, generic repository protocol, broad fixture family, and photometric backend interface until real use requires them.

## Tradeoffs and risks

- We accept serializing a residential IFC during each mutation in exchange for failure atomicity and a simple public API.
- We accept one mutation owner at a time. The file revision check detects, but does not merge, concurrent external edits.
- We accept room-boundary fallbacks for imperfect source models, but every fallback is labelled and tested.
- We accept geometric and lumen approximations in the MVP. Accurate photometry remains an optional later adapter.
- We accept direct-sun geometry without a daylight number. A sky model, glazing transmittance, and external obstructions are not available from a reviewed plan trace, and a fabricated daylight factor would be worse than none.
- We accept a hand-built derived 3D view instead of a BIM viewer dependency, because the value is in rendering the lighting design rather than arbitrary IFC geometry.
- We accept boxes and vertical panels as the occluder model instead of the tessellated meshes IFC already carries. A cabinet is a box; the error that matters is a missing shadow, not a chamfered corner, and the cheap model runs while a person is looking at it.
- We accept that shadows and bounce in the 3D view are appearance only. The numbers stay direct-only, because a rendered picture that looks physically plausible is the easiest way to over-trust a labelled approximation.
- We keep configuration outside IFC for policy and classification overrides only. Canonical geometry and fixture state remain in IFC.

The first implementation must test an actual create, save, reopen, query, move, save, and reopen sequence against a small synthetic IFC before the architecture expands.

### Dining furniture convention

`home_twin.furniture.DiningFurniture` describes a table or chair by its IFC
installation tag, building-frame centre in millimetres, width, depth, height and
cardinal facing. Centre Z is the floor contact elevation. The table and four
chairs are separate `IfcFurniture` products, contained in the selected
`IfcSpace`, with native `TABLE` / `CHAIR` predefined types and swept-solid Body
representations. Table tops, seats, backs and legs remain geometry in IFC.

`Pset_HomeTwin.ObjectKind = furniture` reuses the existing building-object
boundary. The project-specific `Pset_HomeTwinFurniture` records `Role` as `table`
or `chair`, `Facing` as `north/east/south/west` in the building frame, and `Finish`
as the illustrative `oak_linen` palette. These property names and finish label
are Home Twin conventions, not buildingSMART classifications. A chair's local
front is +Y; placement resolves the complete building frame. The browser reads
these properties through the existing unknown-preserving property map.

A furnishing script authors a dining set and centres its pendant.
It saves through a private IFC, reopens the result, and replaces the file only
after validation and a current-file check. Repeating the operation retains the
furniture GlobalIds. Furniture appears in room/whole-floor context and the
existing OBJ scene export; the lighting installation export continues to list
lighting devices rather than furniture.

The browser's `furnitureRendering.ts` adds softened upholstery and finish details
inside the IFC envelopes. These are disposable display details, not a substitute
for IFC geometry or a surveyed furniture specification. Room views have Dining
and Lounge focus buttons. Beam volumes appear only for the selected spotlight;
lighting surfaces remain explicitly labelled approximations. A pendant's point
light uses isotropic flux divided by 4π and inverse-square falloff; this does not
supply measured pendant photometry or reflected-light simulation.

The round dining option uses a native `IfcCircleProfileDef`. `Shape=round` and
`ExtendedDepthMm` describe the closed top and the optional oval extension along
building Y. Only the closed geometry is authored; extension is a purchasing
allowance, not a claim that extra occupied chairs have passed clearance checks.
Circle bounds from IfcOpenShell tessellation are checked to 1 mm.

`StorageFurniture` authors native `IfcFurniture/USERDEFINED` with `ObjectType`
`media_unit` or `drinks_unit`, spatial containment and `ObjectKind=cabinet`.
`Pset_HomeTwinFurniture` records Role, Finish and
`RepresentationMethod=design_envelope`. IFC boxes carry the design dimensions;
viewer door seams and finishes are illustrative. Existing furniture/scene
exports include these objects. `scripts/refine_open_plan.py` validates saved
storage bounds, containment, furniture collisions and the occupied-chair route
before atomically replacing the canonical model. The reviewed plan is not edited.

`KitchenUnit` authors the kitchen the same way: native
`IfcFurniture/USERDEFINED` with `ObjectType=kitchen_<role>`, a `KIT-` tag, and
`Pset_HomeTwinKitchen` recording Role, Facing, Front, Finish, Shape, Appliance
and `RepresentationMethod=design_envelope`. A unit's width runs along its front
face and its depth runs front to back, so `Facing` is what turns it onto its
wall rather than the caller swapping dimensions. `save_kitchen_units` validates
saved bounds, room containment, floor and ceiling elevations, and collisions
with everything else in the room before replacing the canonical model; an
appliance may share the envelope of the joinery it is fitted into, and nothing
else may overlap.

Worktops are their own elements rather than the top 30 mm of a base unit. That
keeps worktops on separate runs at one line, and it is why a declared
`ObjectKind` beats a name in `IfcRepository._classify`: a worktop is a task
surface to light, not an obstruction a downlight must clear.

A worktop stops flush where it dies into something and overhangs where it does
not. A run that ends against the side of a tall unit stops on that plane; a run
that ends in open room oversails the end by the same 20 mm it oversails the
front. Splashbacks follow the same rule of covering every place a worktop meets
bare wall.

`kitchenRendering.ts` and `blender/render_finishes.py` read those properties
instead of matching names, so door counts, drawer banks and appliance fronts are
display allowances inside an authored envelope, not claims about a fabricated
unit.

A run can be opened by a gola channel instead of a handle or a grip cut into the
front. `kitchenRendering.ts` draws it as a recessed channel at the top of every
door and drawer front, which is why such a run carries a fine dark line at each
opening.

A worktop carries an optional `EdgeDepth`. It is **not** a thicker slab - the
stone stays `height_mm` and a rim mitred underneath is what reads deeper, so the
model can never be read as an order for 60 mm stone. `KitchenUnit` rejects an
`edge_depth_mm` that is not deeper than the slab, or one on anything that is not
a worktop. An island can be built up to 60 mm while wall runs stay 30 mm,
because one thickness everywhere is the flat-looking option. A mitred build-up
is valid on straight sections only, so it rules out a radiused plan corner on
the same piece.

`Shape=curved` is a live type option. Whether a project uses it depends on what
its joinery fabricator can make, so a model with no curved units is not an
oversight.

Where two runs meet, one of them loses its corner. The unit that stands against
the end of the other run cannot open toward it, so the blind part is authored as
its own elements rather than hidden inside a larger box that claims a front it
cannot use. `Front=none` is therefore a statement, not an omission - that
volume is reached sideways from the neighbouring unit.

The exception is worktop height, where a run can turn the corner instead of
dying into the neighbour: stone, display shelf and wall cupboard all wrap into
it. What is left blind is the base under that stone, which is what an L-corner
always leaves, so it takes a pull-out rather than a door you reach past.

A unit may declare `Bays` - `kind@z0+z1` per division, absolute millimetres. An
envelope says where joinery is and nothing about what it holds, so a run drawn
from envelopes alone reads as a closed slab with doors on it. `KitchenUnit`
rejects a bay outside its carcass or overlapping its neighbour.
The cabinetry authoring script is the single source: the internals drawing,
the IFC and the 3D view all read it, so none of them can drift.
`renderKitchenObject` takes the fronts off and draws those bays when the
viewer's **Carcass open** toggle is set.

A blind corner can open at worktop height as an appliance garage. `lift` is a
front type because the distinction is structural rather than decorative: a
hinged leaf would sweep the whole worktop depth, and a flap that swung out
would hit a shelf standing in front of it. The flap therefore lifts and parks
flat inside the carcass, and it is push-to-open, so the face carries no rail and
no handle. buildingSMART does not define it, so the house rule is that the
opening height may not exceed the depth, because the parked flap has to fit
behind the hole it closes. `KitchenUnit` rejects a flap that fails it, and
rejects one on a role that is not joinery.

An island top can be authored as four elements: a carcass, a worktop whose last
part overhangs the seating side, and a `gable` at each end running the full
worktop height to carry that overhang. The knee space is therefore real IFC
geometry rather than a recess the viewer draws, and the hob sits over the
carcass rather than over the void. A gable is floor-standing and takes no
plinth recess, because it is holding stone up rather than closing a run.
Breakfast bar stools reuse the `DiningFurniture` chair solid under
`role="stool"`: `IfcFurnitureType` has no `STOOL`, so a stool is a `CHAIR`
carrying `Pset_HomeTwinFurniture.Role=stool`, and `_SEAT_RATIO` puts its seat at
0.6 of the envelope instead of 0.525 - 645 mm under a 900 mm worktop.
`furnitureRendering.ts` repeats that ratio, so the two must move together.

A tucked stool's bounding box overlaps the overhang, which is what the overhang
is for, so `save_kitchen_units` exempts a worktop against a stool exactly as it
exempts an appliance set into joinery. A stool pushed into the carcass is still
a collision.

A circulation route is set out from the wall face it follows, with a skirting
margin, rather than written out as two points. It then stays against its wall if
the wall is retraced. Lights placed along the route follow the same centreline,
because they light where people walk.

### Wet room convention

Sanitaryware, wet-room joinery, extract fans, flexible ducting and the wall
core they exhaust through are typed in `wet_rooms.py`, and a room's tile or
parquet finish in `finishes.py`. The IFC mapping and the geometry conventions
are documented in those modules.

### Air-conditioning convention

Split-system units and the line sets between them are typed in `hvac.py`. A
line set is authored as one `IfcPipeSegment` per room it crosses, and each run's
body is its enclosure: a gypsum box, trunking, clipped copper or a wall core.
The routes, the checks and the IFC mapping are documented in that module.

## Ceiling gypsum

`CeilingReveal` authors a perimeter slot where the gypsum stops short of a wall.
The model already calls such a void a shadow gap, so a reveal is one rather than
a new kind: an `IfcBuildingElementProxy` with `ObjectKind=shadow_gap`,
`ObjectType=ceiling_reveal` and `Pset_HomeTwinReveal` holding the slot width, its
depth, the wall line it follows and whether it carries an LED lip. A room can
have several, for example 70 mm wide along a diagonal wall and a feature wall.
They are 80 mm deep rather than the full 100 mm plenum where a downstand beam's
underside sits 80 mm over the gypsum. A room that states
no structural ceiling is refused rather than given an assumed plenum.

The section inside the slot (upstand, lip, channel and diffuser) is a finish
allowance in `ceilingGypsum.ts`, the way the concealed-cove section already is.
No luminaire is authored: the lip is the provision for a strip that has not been
selected, so nothing there carries a lumen figure. The lip sits in the bottom
quarter of the slot against the gypsum edge, because the point of the slot is
that it shows the slab 100 mm above it; a lip halfway up reads as a moulding.

A slot needs something behind it. Walls are drawn to the structural ceiling
rather than to the gypsum, so the reveal has a wall face in it, and the run
draws a soffit strip across its top when the structural ceiling plane is not
already being drawn. Without both, the gypsum ended and the lip floated
against nothing.

A diagonal wall can be several faces a few degrees apart, and the reveal follows
all of them. Insetting only the long one left the ring mitring an inset edge
against a near-parallel neighbour, which threw that corner far outside
the room. `insetRingAtReveals` now carries a mitre limit: past three times the
inset the corner steps straight off the edge that moved instead.

A turned element cannot be an axis-aligned box. The box around a diagonal
wall's 70 mm slot can cover most of a room, and clearance checks run against it
reported downlights as sitting in a reveal they clear by more than half a
metre. `BuildingObject` now carries `plan_footprint`, the convex hull of the
solid's plan vertices, and `lighting.py` measures obstruction clearance against
that when it is known. The mesh was already cached for bounds, so the hull is
close to free; `bounds` remains the fallback for anything with no geometry.

`ceilingGypsum.ts` pulls the gypsum ring back along each revealed edge and lets
the corners follow, so a corner where a revealed wall meets one the gypsum still
touches slides along that wall rather than opening a triangle. It also derives a
bulkhead's fascia returns from the soffit ring, keeping the edges that face the
room and dropping the ones that die into a wall. Without them a bulkhead
drop read as a plate floating below the ceiling. That derivation also finds
returns that the hand-written list in `add_cabinet_bulkhead.py` omits.

Concealed LED paths now render with a gypsum ledge, shielding lips, aluminium
channel and recessed upward-facing diffuser. This is a visual section allowance
around the retained IFC centreline: 120 mm overall width, 62.5 mm drop. It is
not a measured construction detail from a reference photo, and no
new gypsum geometry or fixture photometry is claimed in IFC. Slat dimensions
and reveals are likewise visual finish allowances within the panel envelope.
