# Home Twin

An AI-accessible, open-source digital twin for residential buildings.

**[Website](https://arogan178.github.io/home-twin/)** · **[Try the read-only demo](https://arogan178.github.io/home-twin/demo/)**

Home Twin keeps the building in IFC and gives people and AI agents one local interface for rooms, dimensions, lighting constraints, safe fixture edits, and installation coordinates. IFC remains canonical. The browser plan, Blender, and Unreal are derived views.

## What the MVP does

- Loads IFC4 models through IfcOpenShell.
- Queries rooms, walls, ceilings, openings, furniture, bounds, properties, distances, clearances, and ray hits.
- Represents recessed spotlights, pendant bulbs, rope lights, physical wall switches, and durable one-to-many IFC control groups.
- Checks ceiling containment, wall clearance, spacing, alignment, cabinetry, shadow gaps, AC units, beams, and ducts.
- Proposes deterministic spotlight grids with an explicitly labelled lumen and beam-cone approximation.
- Reads IESNA LM-63 photometry for spotlights that name an IES file, and reports the measured method instead.
- Reports maintained illuminance and `Emin/Eavg` uniformity over a task area that excludes the perimeter band.
- Checks its own arithmetic against hand-derived reference cases, and compares predictions with meter readings.
- Adds and edits typed lights and wall switches through verified IFC transactions; spotlight grid tools remain type-specific.
- Provides a local browser UI for IFC intake, room selection, fixture dragging, exact coordinates, validation, and exports.
- Draws rendered task-plane light coverage and beam footprints from the labelled lumen and beam-cone approximation.
- Traces shadow rays against cabinetry, services, stairs, and walls on demand, so a tall cabinet actually casts a shadow.
- Models stairs as `IfcStair` with a real stepped `IfcStairFlight`, and treats them as light obstructions.
- Computes solar position and direct-sun beam footprints from native IFC site and true-north data.
- Switches between a millimetre-exact 2D ceiling plan and a derived 3D room view with beam volumes, light pools, and sun patches.
- Traces a plan in the browser over a calibrated reference drawing, then compiles the reviewed source into a verified draft IFC.
- Exports `lighting-layout.csv`, `lighting-layout.json`, and a top-down `lighting-layout.svg`.
- Exposes the residential operations through MCP with read and write annotations.

The MVP does not claim physically accurate lux simulation. Radiance is the planned simulation backend after the geometric workflow survives a real house. Sun patches are geometry and carry no illuminance value; see [the daylight boundary](docs/daylight.md).

Nothing here has been measured against a lux meter, and the CIE 171:2006 test cases have not been run. [Validating the lux figures](docs/validation.md) records what has been checked against an outside answer, what has not, and why the surface reflectances matter more than the solver.

## Architecture

```text
IFC house.ifc                         canonical model
    |
    v
IfcOpenShell semantics + geometry    parse, query, tessellate, mutate, validate
    |
    v
Home Twin domain facade              rooms, millimetres, lighting, constraints
    |
    +--> Home Twin MCP               bounded agent tools
    +--> Local browser UI            IFC intake, plan tracing, 2D plan, 3D view
    +--> CSV, JSON, and SVG           installation coordinates
    |
    +--> official IfcMCP             generic IFC query, plot, render, expert edit
    +--> Blender + Bonsai MCP        expert authoring and final BIM inspection
    +--> Radiance                    planned daylight and photometric backend
    +--> glTF / USD / Datasmith      possible later Unreal visualisation
```

See [the architecture](docs/architecture.md), [validation](docs/validation.md), [ecosystem review](docs/ecosystem-review.md), and [gap analysis](docs/gap-analysis.md) for the decisions behind this boundary. IfcOpenShell 0.8.5 already includes a generic IfcMCP server, so Home Twin does not rebuild one.

## Requirements

- Python 3.11 through 3.14
- Node.js 22.12 or newer for building the browser UI
- [uv](https://docs.astral.sh/uv/), or another Python package installer
- IfcOpenShell 0.8.5 or newer in the 0.8 series
- Blender and [Bonsai](https://bonsaibim.org/) only for expert BIM authoring and final visual review

## Install and verify

```bash
uv sync --extra dev
uv run home-twin --model model/house.ifc info
uv run pytest
uv run ruff check .
```

The bundled sample IFC is a 6 m by 4 m open-plan room with four walls, a ceiling, cabinetry, a dining table, a shadow gap, an AC unit, and two `IfcLightFixture` spotlights. To create a separate demo, run `uv run python scripts/create_sample_ifc.py model/demo.ifc`.

## Run the browser UI

Build the local frontend once, then start Home Twin:

```bash
npm --prefix ui ci
npm --prefix ui run build
uv run home-twin-ui --model model/house.ifc
```

To build distributable Python packages with the browser UI, run `uv build` after the frontend build. Both the wheel and source archive include the compiled UI. An installed wheel can run `home-twin-ui --model /path/to/house.ifc` without Node.js. Python development, CLI, and MCP installation also work before the frontend is built.

The command opens `http://127.0.0.1:8123`. The UI can inspect an uploaded IFC before adopting it, select rooms, place spotlights, pendant bulbs, rope lights, and physical wall switches, preview one switch controlling multiple lights, edit exact installation data, validate layouts, write verified IFC changes, and download installation files. **2D** and **3D** show the same geometry; the whole-floor views include lights from every saved or locally edited room without turning a room click into navigation. **Light** renders spotlight task-plane coverage; **Sun** adds direct-beam geometry once the model states a site.

**Trace plan** authors the reviewed plan source in the browser: load a reference drawing, calibrate it from a printed dimension, place points, close rooms, record printed controls, add openings, state the site, then build the verified draft IFC. See [browser plan tracing](docs/tracing.md). It is dimension-led, not a PDF recogniser.

`examples/demo/` is a synthetic plan with a diagonal wall, a sunken snug, a lowered bathroom ceiling with a rooflight, a terrace, a stair, and a fictional site. Copy its `plan.yaml` and `underlay.png` into `model/references/`, then build and inspect it without touching the canonical model:

```bash
uv run home-twin review-plan
uv run home-twin build-draft
uv run home-twin-ui --model model/draft.ifc --port 8124
```

The generated `model/draft.ifc` contains the reviewed room zones, ceilings, walls, openings, and daylight sources as semantic IFC. Services, cabinetry, and detailed ceiling construction still need site review. A plan that states no site location leaves sun geometry unavailable until latitude, longitude, and true north are entered and the draft is rebuilt. See [browser plan tracing](docs/tracing.md) and [the UI guide](docs/ui.md).

## Run the MCP server

```bash
uv run home-twin-mcp --model model/house.ifc
```

The server uses stdio. Its model stays in memory for reads, while each fixture mutation writes and verifies the canonical IFC before returning.

To inspect the tool schemas without an MCP client:

```bash
uv run python - <<'PY'
from home_twin.mcp_server import build_server

for tool in build_server()._tool_manager.list_tools():
    print(tool.name, tool.annotations)
PY
```

## Connect Codex

Current Codex clients read stdio MCP servers from `~/.codex/config.toml` or a trusted project-level `.codex/config.toml`. The ChatGPT desktop app, Codex CLI, and IDE extension share this host configuration. See the [official OpenAI MCP setup](https://developers.openai.com/codex/mcp).

Use absolute paths:

```toml
[mcp_servers.home_twin]
command = "uv"
args = ["run", "home-twin-mcp", "--model", "/path/to/home-twin/model/house.ifc"]
cwd = "/path/to/home-twin"
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "writes"

[mcp_servers.ifc]
command = "uv"
args = ["run", "--extra", "ifcmcp", "ifcmcp"]
cwd = "/path/to/home-twin"
default_tools_approval_mode = "writes"

[mcp_servers.bonsai]
command = "uv"
args = ["run", "--directory", "/path/to/bonsai-mcp", "bonsai-mcp"]
default_tools_approval_mode = "prompt"
```

You can also add Home Twin from the CLI:

```bash
codex mcp add home-twin -- uv run --directory /path/to/home-twin home-twin-mcp --model /path/to/home-twin/model/house.ifc
codex mcp list
```

Use the servers for different jobs:

- `home_twin` owns residential queries, constraints, verified fixture mutations, and exports.
- `ifc` supplies generic IFC summaries, relationships, schema help, validation, plots, and renders.
- `bonsai` supplies live Blender/Bonsai inspection and viewport screenshots.

Do not run concurrent generic `ifc_edit`, Bonsai saves, and Home Twin mutations against the same file. Home Twin detects an external file revision and rejects the replacement instead of overwriting it.

## Use Blender and Bonsai for expert authoring

Plan tracing, lighting design, validation, 3D review, and installation export all happen in the browser. Blender and Bonsai remain useful for BIM authoring the browser does not cover: curved walls, sloped ceilings, stairs, and repairing broken relationships.


1. Install Blender and the current Bonsai add-on.
2. In the Bonsai workspace, select **File > Open IFC Project**.
3. Open `model/house.ifc`.
4. After an external Home Twin mutation, reload the project or use Bonsai MCP's `refresh_geometry` or `reload_project` tool.

For agent screenshots, clone [Bonsai MCP](https://github.com/Show2Instruct/bonsai-mcp), install its Blender bridge, start the bridge from the Blender sidebar, and connect the MCP server as shown above. The bridge binds to `127.0.0.1:9878` and can execute Blender Python, so do not expose it to a network.

See [the Blender guide](blender/README.md) for the visual review loop.

## Python example

```python
from pathlib import Path

from home_twin import HomeTwin, SpotlightSpec

twin = HomeTwin.open(Path("model/house.ifc"))
room = twin.get_rooms()[0]

proposal = twin.optimise_spotlight_layout(
    room.id,
    SpotlightSpec(model="Example 8 W", lumens=650, beam_angle_deg=36),
)

print(proposal.validation.valid)
print(proposal.layout.fixtures)

if proposal.validation.valid:
    twin.apply_lighting_layout(proposal.layout, expected_revision=proposal.model_revision)

print(twin.export_lighting())
```

The bundled sample room uses X `0..6000`, Y `0..4000`, and a ceiling at Z `2800` mm. Every proposed or manually supplied coordinate must fit the loaded ceiling and configured clearances.

## Example agent interaction

> Lay out the spotlights in the open-plan area. Keep the spotlight line visually continuous into the corridor, avoid the dining pendant, keep clear of the shadow gap, and give the kitchen enough task lighting.

An agent can:

1. Call `get_rooms`, `get_ceiling_polygon`, `get_walls`, `get_furniture`, and `get_objects`.
2. Call `optimise_spotlight_layout` with a real fixture specification.
3. Inspect stable validation findings and labelled dark-zone estimates.
4. Apply the accepted layout against the exact IFC revision.
5. Ask Bonsai MCP for a top-down viewport screenshot.
6. Move or redistribute fixtures and inspect again.
7. Export the installation CSV, JSON, and SVG.

Coordinates come from IFC geometry. Screenshots are supporting evidence only.

## Repository map

```text
model/                   canonical IFC, measurements, and reviewed plan facts
src/home_twin/           domain facade, IFC adapter, plan compiler, lighting, exports
ui/                      local React ceiling-plan editor
mcp/                     source-tree MCP wrapper and notes
blender/                 Bonsai and visual review instructions
config/                  policy, catalogue defaults, and constraints
exports/                 derived installation files
tests/                   pure geometry and real IFC round-trip tests
docs/                    architecture, research, gaps, lighting, and plan import
```

## Roadmap

The next milestone is to review a room trace against its plan, add openings and fixed obstructions, then run a real lighting review with an electrician or lighting designer. After that evaluation:

- measure the real finishes, state per-room reflectances, and record night meter readings;
- improve non-rectangular and sloped-ceiling support;
- add wall-washing and cross-room alignment constraints;
- add a Radiance adapter for validated simulation;
- map IFC objects to Home Assistant entities;
- add an installation revision sheet and PDF packaging;
- keep Unreal as an optional IFC to Bonsai to glTF, USD, or Datasmith pipeline.

## Licence

Home Twin is licensed under Apache-2.0. IfcOpenShell is LGPL-3.0-or-later. Bonsai is GPL-3.0-or-later. Optional integrations retain their own licences; review [the ecosystem matrix](docs/ecosystem-review.md) before distributing a combined package.
