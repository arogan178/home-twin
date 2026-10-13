# Home Twin agent guide

## Protect the model

`model/house.ifc` is the canonical source of truth. Do not replace it with JSON, YAML, a database, a Blender file, or a rendered mesh. Derived caches and exports must be disposable and reproducible from IFC.

Never silently change IFC semantics. A fixture mutation must validate a private clone, write a temporary IFC, reopen it, verify the intended change, and atomically replace the canonical file. If any check fails, keep both disk and memory on the previous revision.

Use IFC `GlobalId` values for agent-facing object identity. Use fixture `Tag` values such as `SP07` for installation labels. Do not expose numeric STEP IDs as stable IDs.

## Use the canonical coordinate frame

Public geometry uses a right-handed building frame in millimetres. `+X` is east or right on plan, `+Y` is north or up on plan, and `+Z` is upward. The origin comes from the resolved IFC building placement. Resolve the complete IFC placement chain. Do not add Blender-specific axis assumptions.

Keep units in symbol and field names at transport boundaries. State the method and precision when a geometry result uses a fallback or approximation.

## Design MCP tools around building intent

Expose bounded semantic operations such as `get_walls`, `get_ceiling_polygon`, and `add_spotlight`. Do not make arbitrary Python or generic `ifcopenshell.api` execution the primary interface. Official IfcMCP already provides generic IFC inspection and expert editing.

Give every tool a useful docstring, a closed schema, stable structured errors, and correct read or write annotations. A mutating tool must complete its durable transaction before returning.

## Add BIM object types completely

To add an object or fixture type:

1. Add or extend a domain type.
2. Define its IFC class, predefined type, containment, representation, and property-set mapping.
3. Add geometry and semantic validation.
4. Add it to the installation or data export when relevant.
5. Add a synthetic IFC save/reload test.
6. Document any convention that is not defined by buildingSMART.

Do not add a type only as a string in YAML or MCP.

## Keep lighting claims honest

Separate geometric checks, lumen approximations, IES or LDT photometry, and full simulation in types and output. The MVP does not claim accurate lux simulation. Radiance is the preferred future simulation engine; do not build a competing renderer.

Rendering an approximation does not upgrade it. A coloured coverage image, a beam cone, or a 3D light pool must carry the same method label and disclaimer as the numbers behind it.

Keep daylight on its own axis. Solar position and direct-beam footprints are geometry and must never carry an illuminance value. Site latitude, longitude, and the bearing of plan `+Y` from true north come from native `IfcSite` and `TrueNorth` fields. When a model does not state them, report that the site is unknown; never substitute a plausible location.

## Test geometry before UI

Run `uv run --extra dev pytest` and `uv run --extra dev ruff check .` before committing. Tests must cover transforms, distances, containment, collisions, wall clearance, ceiling containment, deterministic layouts, MCP schemas, and actual IFC save/reload behavior.

Use small synthetic IFC models for geometry cases. A test that only mocks IfcOpenShell does not prove an IFC mutation.

Prove solar and daylight geometry against closed-form identities, such as the solstice altitude `90 - |latitude - declination|` and a symmetric day about solar noon. Do not pin such tests to values copied out of the implementation.

## Author reviewed plan facts through one source

The reviewed plan source is `model/references/plan.yaml`. Browser tracing, the CLI, and the compiler all read and write that one file. Do not add a tracing session, a browser-side draft store, or a second geometry source.

A save must round-trip the document, review it, copy the previous source into `model/references/history/`, and write atomically under the exact current revision. Serialisation must reproduce an unchanged source byte for byte so plan diffs stay reviewable. A source with review blockers may be saved so tracing can continue, but it must never be published.

The browser must not be able to lose a plan field it does not know. Every
object in the plan-document boundary schema preserves unknown keys, because the
editor fetches the whole document and saves the whole document: a field added to
the Python model but missing from the TypeScript one is silently deleted on the
next save. Add the field to both, and keep the round-trip test that proves an unknown
field survives.

A reference underlay is a drawing to trace over. Store it beside the source, record only its calibration, and keep it out of every IFC entity.

## Work in parallel without colliding

Worktrees share one repository. A commit made in any worktree is visible from
every other one immediately; there is nothing to push or pull between them. Only
the checked-out branch differs. `main` in the primary checkout is the single
integration point, and feature worktrees never merge into each other.

Parallel worktrees give parallel checkouts, not parallel ownership. Two sessions
that both edit `RoomView3D.tsx` collide however the branches are arranged, so
partition upcoming work by file before starting it, not by task. "Lighting" and
"stair geometry" sound disjoint and were not. When two pieces of work need the
same file, they are sequential.

That makes a large file a coordination cost, not just a reading cost. Keep the
browser views thin compositions over focused modules - geometry, materials,
render - so that separate concerns land in separate files.

Rebase a local branch onto `main` when the session starts, and land small. Both
integration costs grow with divergence, and the session that resolves a conflict
should be the one that can still build, test, and open the app to check it.
Rebase only a branch that is unpushed and not checked out anywhere else; merge
anything shared. Land with `--ff-only` so `main` never holds a state no one ran.

Never use bare `git stash`. The stash stack is shared across every worktree, so
one session's `pop` can take another's work. Use a temporary commit instead.

Each worktree carries its own `node_modules` and `.venv`, and two sessions
cannot both bind the browser UI's default port. Pass `--port`.

## Prefer existing open-source work

Check [docs/ecosystem-review.md](docs/ecosystem-review.md) before adding an IFC, MCP, Blender, viewer, or lighting dependency. Reuse IfcOpenShell, IfcMCP, Bonsai MCP, That Open Components, and Radiance where their capabilities fit.

Record a newly discovered tooling gap in [docs/gap-analysis.md](docs/gap-analysis.md). Include the existing solutions, why they fail the use case, likely users, build difficulty, open-source and commercial value, and whether the work belongs here.
