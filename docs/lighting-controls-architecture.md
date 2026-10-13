# Typed lighting and physical controls

## Decision

Home Twin models spotlights, pendant bulbs, and rope lights as typed
IFC-backed luminaires. It models wall switches as separate physical devices and
their one-to-many relationship through durable IFC-backed control groups.
Whole-floor views compose committed IFC data with disposable room drafts.
Rendered beams and switch on/off previews never enter the canonical model or
lighting validation.

This is the smallest design that supports wall attachment, linear lights, and
multi-light switching without turning the existing spotlight record into a bag
of contradictory optional fields.

## Usage

A caller adds or moves a luminaire with a kind-specific mount. It adds a switch
by naming its room, host wall, offset along the wall, and mounting height. A
separate membership operation assigns several luminaires to one control group.
Every durable mutation supplies an expected IFC revision.

```text
add_pendant(room, ceiling_point, fixture, switching_group, expected_revision)
add_rope_light(room, path, fixture, switching_group, expected_revision)
add_wall_switch(room, host_wall, offset_mm, height_mm, switching_group, expected_revision)
assign_lighting_group(room, [spot_a_id, spot_b_id, pendant_id, switch_id], group, expected_revision)
```

The browser loads one saved whole-plan snapshot, keeps dirty room drafts in
memory, and renders `dirty room draft ?? saved room` for every room. Clicking a
room highlights it. The room rail or an explicit action changes editing scope.
Clicking a switch changes only its browser preview state and visually toggles
every member of its control group.

Control-group labels are building-wide identities. To prevent two unrelated
rooms from being wired together accidentally, a room with no existing lighting
starts with a readable room-scoped label such as `OPEN_PLAN_MAIN`. Reusing a
label across rooms is therefore deliberate.

## Shape

The domain uses a discriminated luminaire union:

- `recessed_spotlight`: ceiling point, circular body and cut-out, mounting
  depth, direction, and spotlight specification;
- `pendant_bulb`: ceiling anchor, drop, canopy, bulb envelope, and source
  specification;
- `rope_light`: two-or-more-point installation path, diameter, mounting mode,
  and linear-source specification.

A wall switch stores `host_wall_id`, `offset_mm`, and
`mounting_height_mm`. Its response may include a derived point for rendering,
but callers cannot author an unrelated XYZ position. A `ControlGroup` has its
own IFC `GlobalId`, member luminaire GlobalIds, and controlling switch
GlobalIds. Version one may expose one switch per group while retaining a model
that can later represent two-way switching.

IFC mappings are:

| Concept | IFC mapping |
| --- | --- |
| Recessed spotlight | `IfcLightFixture`, existing `FixtureKind=recessed_spotlight` convention and cylinder representation |
| Pendant bulb | `IfcLightFixture`, pendant properties and canopy/cable/bulb representation |
| Rope light | `IfcLightFixture`, path properties and path-following physical representation |
| Wall switch | `IfcSwitchingDevice` with a schema-supported switch predefined type, room containment, and Home Twin switch properties |
| Control group | `IfcGroup` plus `IfcRelAssignsToGroup`; members use GlobalIds |

All writes reuse the repository transaction: clone the model, validate the
candidate, write a temporary IFC, reopen it, verify type-specific semantics and
relationships, then atomically replace the canonical file. A room save performs
one transaction rather than replacing the IFC once per device.

Validation dispatches by physical type. Spotlight cut-out and spacing rules do
not apply to a pendant or rope. A pendant validates its ceiling anchor, drop,
and physical envelope. A rope validates its path and mounting plane. A switch
validates its host wall, offset, height, plate bounds, and opening clearance.
Control membership validates existing GlobalIds and deliberate fan-out.

Photometric output remains explicit about method. Existing spotlight cone and
lumen approximations continue. Pendants and ropes are geometrically supported
but excluded from illuminance estimates until a tested point or linear-source
method is implemented. Their attractive renderer does not upgrade that claim.

## Synthesis

Two independent designs agreed on typed luminaires, wall-relative switch
placement, client-side room drafts, and derived beam isolation. One proposed a
durable IFC group; the other retained existing switching-group strings for
compatibility. The durable group is selected because agents and future
two-way/dimmer controls need stable identity. The wall-relative placement and
room-draft overlay from the second design are retained because they prevent
invalid switch geometry and make whole-floor views truthful during editing.

## Tradeoffs

- More explicit domain and wire types are accepted to make invalid combinations
  unrepresentable.
- Browser drafts are accepted because they are disposable and do not compete
  with IFC; there is no server-side draft database.
- Preview switching is deliberately local state, not a live Home Assistant or
  electrical-state claim.
- Pendant and rope photometry is deferred instead of quietly applying the
  spotlight cone model.
- Existing spotlight tools and payloads remain compatibility wrappers while
  new typed operations become the preferred API.

## Alternatives rejected

Adding nullable `drop`, `path`, `wall`, and switch fields to the current
spotlight record was rejected: it exposes invalid combinations to every caller
and mixes ceiling lights with wall controls. A server-side draft session was
rejected because it introduces lifecycle and concurrency state beside the
canonical IFC. Text-only switching groups were rejected as the durable model
because they cannot be safely renamed, addressed by agents, or extended to
multiple switches.

## Risks

- IFC switch predefined values vary by schema and must be capability-checked;
  unsupported writes fail closed.
- Rope paths start as polylines; arbitrary curved runs can be added after the
  installation/export contract is proven.
- Cross-room control groups require membership mutations to verify every
  affected room without making room saves delete foreign members.
- WebGL cannot use an unlimited number of real-time lights. Non-selected
  fixtures may retain emissive geometry while only a bounded subset casts live
  light.

## Status and next step

The typed domain, closed HTTP and MCP schemas, IFC save/reload codecs,
type-specific validation, installation exports, room-draft overlay,
whole-floor renderers, and wall-switch click/drag interaction are implemented
and covered by synthetic IFC round-trip tests. The next fidelity step is a
tested pendant point-source approximation followed by a rope linear-source
model; neither is inferred from the current decorative renderer.
