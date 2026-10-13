# Lighting design model

## Scope

The MVP designs recessed spotlights and geometrically places pendant bulbs and
rope lights. Each is a distinct domain type with its own geometry, validation,
IFC representation, and installation export. Physical wall switches are
wall-relative devices, and durable IFC control groups link one switch to any
number of lights. Spotlights read IES photometry when a file is supplied;
pendant and rope photometry is not implemented.

Every spotlight has an IFC `GlobalId`, an installation `Tag`, a room, an exact point, a downward direction, a switching group, dimensions, and the following lighting properties:

- model name;
- lumen output;
- beam angle;
- correlated colour temperature;
- colour rendering index;
- dimming support;
- fixture diameter;
- cut-out diameter;
- mounting depth;
- optional project-relative IES path;
- optional ingress protection rating for the housing, such as `IP65` in zone 1 over a bath or shower.

The IFC mapping is documented in [the architecture](architecture.md#ifc-lighting-convention).

A pendant stores its ceiling anchor, drop, canopy and bulb envelope. A rope
light stores a two-or-more-point millimetre path, diameter, minimum bend radius,
linear output, mounting mode, and an optional ingress protection rating for its
profile. Both ratings reach the installation sheet as an `ip_rating` column. A switch stores a host wall GlobalId, offset
along that wall, mounting height above the room floor, which face of that wall
the plate is on, plate dimensions, type, and switching group. The face matters
because a wall is shared: a wet room switched from the landing carries
`opposite`, and the derived point is the same either way. The derived XYZ returned for a switch is never a second
authoring coordinate.

Switching-group labels are building-wide. The browser gives an empty room a
room-scoped default such as `OPEN_PLAN_MAIN`; matching labels in different
rooms intentionally describe one shared group.

## Constraint checks

`config/constraints.yaml` controls the geometric policy:

- wall and ceiling-edge clearance;
- minimum fixture spacing;
- physical fixture collision tolerance;
- obstruction clearance;
- larger shadow-gap clearance;
- alignment tolerance;
- object kinds to avoid.

The service checks the full room design before a mutation. A hard finding rejects the edit. Stable finding codes include `outside_ceiling`, `wall_clearance`, `minimum_spacing`, `fixture_collision`, `fixture_over_cabinet`, `fixture_over_shadow_gap`, `wrong_ceiling_elevation`, `pendant_drop`, `rope_path_outside_ceiling`, `unknown_switch_wall`, `switch_outside_wall`, and `switch_over_opening`.

The first optimiser creates deterministic grids from the ceiling polygon and the target fixture count. Candidate seats are filtered against the same edge-clearance and minimum-spacing rules that gate a save, so a concave room does not receive seats hard against a re-entrant wall and a proposal is savable as generated. It then orders candidates by hard findings, estimated dark grid cells, fixture count, exact coordinates, and fixture tags. This is deliberately understandable. A future solver can replace candidate generation without changing the validation contract.

### Why a spotlight is kept off the wall

`wall_clearance_mm` defaults to 600 mm, and that is a **layout preference with a
rule-of-thumb basis, not a physical minimum**. Two separate things sit behind it:

- **Buildability.** A recessed downlight needs its cut-out clear of the wall
  plate, the top plate and any noggin, and clear of a curtain track or a shadow
  gap detail. That argues for perhaps 150 to 250 mm, not 600.
- **Where the light lands.** A downlight throws a cone. Closer to a wall than
  roughly half the mounting height, most of that cone lands on the wall as a
  scallop instead of on the floor, so the room reads as a row of bright arcs
  rather than an evenly lit space. In a 2.6 m room that is around 900 mm; 600 mm
  is a compromise that keeps the scallop small.

Neither reason applies if the scallop is the point. Wall washing puts downlights
**deliberately** at 300 to 600 mm to graze a wall. If that is the intent, lower
`wall_clearance_mm` in `config/constraints.yaml`; the check is a project setting
and it says so in the finding.

The check is an error rather than a warning because a fixture that does not fit
its own cut-out is a build failure, and the same rule carries both cases:
`required_edge` is the larger of the project clearance and the fixture radius.

## Two horizontal planes, and what each is for

A bake samples one horizontal plane, either `task` at 800 mm above the floor or
`floor` at 0. They answer different questions and disagree sharply:

| Example bathroom, 150 mm bake | Mean | Over 180 lux | Samples with every fitting shadowed |
|---|---:|---:|---:|
| `task`, 800 mm | 242 lux | 74% | 17% |
| `floor`, 0 mm | 137 lux | 36% | **50%** |

**The task plane is the one to quote.** EN 12464-1 measures maintained
illuminance on the task area, so it is the figure that can be defended, and at
800 mm it clears the bath rim, the vanity top and the cistern.

**The floor plane earns its keep for two things only**: the night-time floor
target — EN 12464-1 asks for 5 lx at floor level at 2200 to 3000 K — and seeing
what furniture actually shades.

**Read the floor number knowing what it counts.** Half the bathroom's floor
samples have every fitting blocked, because half that floor is under the bath,
the vanity and the toilet. That is geometrically true and practically
meaningless: nobody stands there. A floor coverage percentage is therefore a
worse guide to a room than the task figure, not a stricter one.

The rendered coverage surface is drawn 3 mm above whichever plane it samples. A
floor pass otherwise lands coplanar with the floor and the two stipple against
each other. **The lift is display only** and changes no sample.

## Sensors

A movement sensor belongs to a room's lighting design, not to its furniture. It
is a ceiling penetration on a plan position, exactly like a recessed spotlight,
and it is authored, validated, dragged and saved on the same path: same snap
grid, same alignment guides, one **Save**.

**It names its load one of two ways, and exactly one is set.**

- **`switching_group`** when the load is lighting. A PIR on a corridor is one of
  that corridor's switches, so it joins the control group the way a wall plate
  does and the group reports it in `sensor_ids`. A corridor pair of fittings can be
  switched both ways: a PIR above it and a wall plate in the adjoining room.
- **`controls_tag`** when the load is not a luminaire. A fan carries no switching
  group, so a sensor serving one names it directly, which is how an installer
  reads it. Both wet-room PIRs work this way.

It also carries **`run_on_minutes`**: how long the load is held on after
detection stops. A PIR detects movement and infers occupancy, so it cannot see
someone standing still, and the timer is what covers that.

**A sensor tag must be unique across the model, not the room.** A `Tag` is the
label an electrician works to, so two `PIR01`s is not a model. The browser can
only see one room at a time, so the tag generator reads every room's tags from
the whole-plan payload and the save refuses a tag already used elsewhere.

It reaches IFC as an `IfcSensor` with predefined type `MOVEMENTSENSOR`, because
**IFC4 has no occupancy or presence sensor type**. That is the closest the schema
offers and it is not a synonym.

`controls_tag` naming something outside the room is a **warning, not an error**:
a sensor may be installed before the fan it serves, and this model cannot see
another room's installation tags. Detection range is not modelled at all.
`detection_diameter_mm` records a manufacturer's figure where one is published
and is absent otherwise, because walking movement carries much further than the
small movement of someone sitting still and a single number says which was
measured only if the maker states it.

A sensor emits nothing, so it appears in no lux figure and in no coverage
statistic. It is on the installation sheet with its load, its run-on and its
cut-out.

## Four fidelity levels

### Geometric

The geometric level checks beam footprints, room containment, alignment, spacing, and collisions. It uses IFC-derived polygons and solids. It makes no illuminance claim.

### Lumen approximation

The MVP task-plane grid uses recessed-spotlight lumen output, beam angle,
fixture height, a uniform cone, cosine falloff, and a configurable utilization
factor. It excludes pendant and rope photometry, reflected light, surface
materials, daylight, real candela distribution, driver losses, and occlusion
outside the modeled constraints.

Illuminance is maintained rather than initial, and statistics are quoted over
the room minus a perimeter band. Both are described in
[validating the lux figures](validation.md#what-a-reported-figure-now-means).

Every result says `lumen_beam_cone_v1` and carries a disclaimer. Use the grid to compare candidate layouts, not to certify lux.

`HomeTwin.analyse_lighting_layout(layout)` calculates validation, dark zones,
and one task-plane illuminance grid from the same candidate layout. The browser
calls it after unsaved fixture moves and ignores responses for older draft
versions. This keeps both the overlay and the rendered coverage image current
without copying the lighting algorithm into TypeScript or storing browser
drafts on the server.

`ElectricLightingAnalysis.illuminance` carries the samples, the plane elevation,
the grid step, the threshold, the peak and mean value, the covered fraction, the
maintenance factor it applied, and the task-area statistics, all under the same
`lumen_beam_cone_v1` label. The browser shades those samples. A rendered image of
an approximation is still an approximation.

`TaskArea` reports the mean, minimum, `Emin/Eavg` uniformity, and covered
fraction over the samples further than `task_area_border_mm` from a wall. A room
narrower than twice the border reports no task area, because excluding the
perimeter leaves nothing and quoting the whole floor under a task-area label
would be worse than saying so.

The estimate follows each fixture's stored aiming direction. A downlight aimed
at `(0, 0, -1)` reduces to the original vertical beam cone; a tilted fixture
uses the same cone about its own axis instead of being silently treated as
vertical.

Windows, glazed doors, shafts, and light courts are semantic context. They do
not reduce electric-light dark zones. Direct-sun geometry is computed separately
and carries no illuminance value. See [the daylight boundary](daylight.md).

### Lumen approximation with occlusion

`direct_occluded_v1` is the same beam cone with shadow rays added. Before a
fixture contributes to a sample, a straight line from the fixture to that sample
is tested against the solids the model already knows: tall cabinetry, services,
stair masses, and wall panels with their openings cut out. A doorway lets the
ray through, a wall does not, and an object whose top is below the plane being
lit is not an occluder at all, so a 750 mm table cannot shade an 800 mm task
plane.

Solids reduce to axis-aligned boxes and vertical panels rather than meshes, so a
shadow test is a few dozen arithmetic operations. A traced open plan bakes
1,339 samples against eight fixtures in roughly 300 ms. That is fast enough to
ask for and too slow to run on every drag, which is why it has its own
operation:

```python
baked = twin.bake_lighting(layout, step_mm=150, plane="task")
baked.shadowed_fraction     # samples with at least one blocked fixture
baked.occluders             # what was considered
baked.method                # direct_occluded_v1
```

Over HTTP it is `POST /api/rooms/{room_id}/bake`; over MCP it is
`bake_room_lighting`. The browser calls it from **Run shadow pass** and shades
the plan and the 3D floor with the result.

Gypsum is in that set. A traced soffit or bulkhead becomes a prism from its
underside up to the slab, so a beam crossing it is blocked at any angle, while a
beam that has already dropped below the underside passes beneath it.

This is a fidelity step inside the lumen tier, not a new claim. It still
excludes surface materials, daylight, IES data, and light through glazing.
Shadows drawn in the 3D view are rendering, not photometry.

**A shower enclosure shades only as its tray.** Its envelope is mostly glass,
which casts no shadow worth modelling, so `collect_occluders` clips a `shower`
role to the 70 mm tray. Left whole, the 2 m box hid the fitting over an
en-suite tray from the entire room, so it read as shadowed at every sample,
including the tray itself, and the room's coverage figure was understated by
more than half.

### Room interreflection

`direct_occluded_plus_room_interreflection_v1` adds one number to every sample.
Radiosity for a single enclosure of uniform diffuse surfaces reduces to

```
E_indirect = (total flux / total surface area) × ρ̄ / (1 − ρ̄)
```

where `ρ̄` is the area-weighted average reflectance of floor, walls and ceiling.
Home Twin states the reflectances it used (0.7 ceiling, 0.5 walls, 0.2 floor by
default) rather than inferring them from materials it does not have.

The reflectances come from `config/constraints.yaml`, and `Interreflection`
records the exact values it used along with the maintenance factor, because they
are typical finishes rather than measured ones. That is also why
`surface_materials` stays in the exclusions when the term is included.

The term is **uniform by construction**. That is the assumption, not a result:
it says nothing about where the bounce lands, so it cannot tell you that one
corner is better lit than another. What it does fix is the previous claim that a
fully shadowed point receives nothing, which no real room does. `Interreflection`
carries its own exclusions — `directional_bounce`, `per_surface_materials`,
`specular_reflection` — and the bake's method name changes when it is included.

### Alignment

An **axis** is a coordinate two or more spotlights already agree on, within
`alignment_tolerance_mm`. A spotlight is misaligned when it sits near one of
those axes without being on it: `alignment_tolerance_mm` to 200 mm off.

Being somewhere else entirely is a choice, not a slip, so a layout snapped to a
grid reports nothing however many rows it has. The earlier rule compared
`min(dx, dy)` for neighbours in one sort order, which called every diagonal
neighbour on a 250 mm grid a missed axis.

`align_layout` fixes exactly what the check reports: each spotlight within the
band moves onto the axis, and nothing else moves. Over HTTP it is
`POST /api/rooms/{room_id}/align`, and the Light stage offers it as **Align**.

### Dark patches

`baked.dark_regions` groups the under-target samples into the contiguous patches
they form, each with its area, its worst reading, and its centre, worst first. A
list of dark points cannot tell you whether it is one shadow or scattered noise;
an area can.

### The rendered 3D view

The browser 3D view is a picture, never a reading. It used to be worse than
that: it drove each WebGL spotlight at `lumens / 650 x 11` with a `decay` of
1.25, so its falloff matched neither physics nor `lumen_beam_cone_v1`, and the
image disagreed with the numbers beside it.

It now shares the quantities the grid uses. `intensity` is the axial candela the
rated lumens imply over the beam solid angle,

```
I = phi x utilization / (2 pi (1 - cos(beam / 2)))
```

with `decay` 2 and no distance cutoff, so falloff is inverse square. three.js
own `SpotLight.power` setter cannot be used: it divides by a fixed pi steradians
and so renders a 15 degree and a 120 degree downlight of the same output equally
bright, which is the one thing a downlight layout turns on.

Because lights are driven in lux and candela, the view is exposed for the
layout's target illuminance rather than scaled per fixture. Brightness is then
monotonic in lux and comparable between two layouts of the same room.

The indirect term is the shadow pass's own `room_interreflection` when one has
run, and a stated share of the target before that. Shadow maps only subtract
light, so without it every shadowed surface renders black.

What the renderer adds on top carries no lighting claim and is named as such in
the code: the environment map that gives matte surfaces a specular response,
ambient occlusion at contacts, the cone edge softened out to a field angle, and
the daylight and sun values, which are display brightness and never lux. See
[the daylight boundary](daylight.md).

One limit is disclosed rather than hidden. WebGL lights a bounded number of
spotlights, so past that count a fixture contributes nothing to the image. The
view says how many when it bites; the coverage surface and every check still
include all of them.

### Photometric

A spotlight that names a project-relative IES file is evaluated from its measured
candela distribution instead of a uniform beam cone. `home_twin.photometry`
parses IESNA LM-63 of any year, interpolates both angle axes, and calculates
point illuminance by the inverse-square law with the cosine of incidence.
Results say `ies_lm63_point_v1`.

Candela values already carry the luminaire's optical losses, so the lumen-method
utilization factor is not applied on this path.

Only Type C photometry is read, which covers residential downlights. Type A and
Type B files are rejected rather than approximated. A luminaire's own rotation
about its aiming axis is not recorded, so a file read from disk is averaged over
every rotation: flux and the on-axis intensity are kept, and a lean in the
measured beam becomes a symmetric pool rather than one pointing an arbitrary
way. A GU10 seats at any angle, so the average is the best single estimate. A
distribution passed in directly keeps its planes, with the azimuth reference at
building +X towards +Y, counterclockwise in plan.

A layout where only some fixtures name an IES file says
`mixed_ies_and_lumen_beam_cone_v1` and keeps the `ies_photometry` exclusion. The
label always names the weakest tier present, so a partly measured layout cannot
read as measured.

An LDT (EULUMDAT) file is read into the same Type C distribution and carries
the same labels. Its intensities are candela per 1000 lamp lumens, so they are
scaled to the fixture's rated lumens rather than to the lamp sets the file
lists: a manufacturer's family file names sibling products, and none of them
need be the lamp installed. Symmetry code 3, about the C90-C270 plane, is
rejected.

### Validation

Fidelity is not accuracy. [Validating the lux figures](validation.md) records
which components have been checked against an answer derived outside this code,
which have not, and where the error actually comes from. `predict_lux` and
`home-twin compare-measurements` hold a meter reading against the prediction at
the measured point.

### Simulation

Radiance is the preferred full simulation engine. A future adapter will export a frozen IFC-derived room scene, materials, luminaires, and sensor grids, then return derived results tied to the IFC revision. Radiance output will never become canonical geometry.

## Human review still matters

The optimiser cannot decide every design question. It needs a designer or homeowner to judge glare, visual rhythm, focal points, preference for wall washing, pendant relationships, and whether a technically dark area is intentional. The intended loop is query, propose, validate, inspect in the 2D plan and the 3D view, adjust, save, and export. Bonsai remains available for final BIM inspection.
