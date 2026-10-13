# Home Twin domain language

This glossary names the residential-lighting concepts used by the domain, IFC,
MCP, HTTP, and browser layers. It describes the problem domain, not the code
that happens to implement it.

- **Luminaire**: a physical installed light-emitting device. A luminaire has an
  IFC `GlobalId` and an installation tag. Recessed spotlights, pendant bulbs,
  and rope lights are kinds of luminaire.
- **Recessed spotlight**: a point luminaire cut into a ceiling. Its ceiling
  point, cut-out, body depth, direction, and beam angle are meaningful.
- **Pendant bulb**: a point luminaire suspended from a ceiling anchor. The
  ceiling anchor and luminous centre are different positions, separated by the
  pendant drop.
- **Rope light**: a flexible linear luminaire installed along a path. It is not
  a collection of synthetic spotlights.
- **Wall switch**: a physical wall-mounted control device. Its authoritative
  placement is a host wall, an offset along that wall, and height above the
  room floor. XYZ is derived for display and export.
- **Control group**: a durable, IFC-identified group of one or more luminaires
  operated together. A wall switch controls a group. The legacy
  `switching_group` text is only a compatibility label.
- **Switch preview**: disposable browser state used to see a control group on
  or off. Preview state is not a claim about live electrical power and is not
  written to IFC.
- **Room lighting draft**: unsaved candidate luminaires, switches, and control
  memberships for one room. Drafts are disposable browser state layered over
  the latest IFC snapshot.
- **Beam footprint**: derived geometric coverage from a luminaire definition.
  It is analysis or display data, never a structural `IfcBeam` and never a
  physical obstruction.
- **Lighting check**: validation of authored physical devices, their mounting,
  and their relationships. Renderer meshes, glow, switch preview, and beam
  cones are not inputs.
- **Installation tag**: a tradesperson-facing label such as `SP07`, `PN01`,
  `RL01`, or `SW01`. Tags are not stable object identities.

