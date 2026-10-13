# Open-source ecosystem review

Research date: 2026-09-01

This review uses project repositories, source code, official documentation, specifications, release pages, and GitHub commit feeds. It does not use vendor comparison posts or third-party summaries. Activity dates are the latest repository push or default-branch commit observed on the research date. A recent push proves activity, not quality or stability.

## What the research changes

The largest finding is that a generic IFC MCP server no longer needs to be invented. [IfcOpenShell now ships IfcMCP](https://docs.ifcopenshell.org/ifcmcp.html), with model sessions, IFC queries, relationships, clash and clearance checks, validation, 2D drawings, off-screen 3D renders, ShapeBuilder calls, generic `ifcopenshell.api` mutations, quantity write-back, and save. [Bonsai MCP](https://github.com/Show2Instruct/bonsai-mcp) separately connects Codex to a live Blender, Bonsai, and IfcOpenShell session and returns viewport or storey-plan screenshots.

Home Twin should therefore not build another generic IFC server or another Blender socket bridge. It should add the residential contract that these projects do not have: stable room-aware geometry calls, canonical millimetre coordinates, ceiling polygons, point and object measurements, validated fixture placement, lighting constraints, layout optimisation, and trade-ready exports.

The other clear finding is that the open-source lighting stack is good at simulation but weak at design automation. Radiance and its Python front ends can calculate light from a layout. The photometric libraries can parse IES or LDT files and calculate distributions. None of the reviewed projects lays out residential downlights using cabinetry, pendants, shadow gaps, alignment, switching groups, and visual rhythm as constraints. That conclusion is an inference from the documented capability sets below, not a claim that no unpublished prototype exists.

## Capability notation

Each row reports all requested dimensions.

- **IFC**: `R` reads IFC, `W` writes IFC. `Via conversion` means IFC is not the native model.
- **Geometry**: `I` inspects or measures geometry, `M` modifies geometry.
- **Image**: viewport screenshot, 2D plot, or rendered image that an agent can inspect.
- **BIM semantics**: understands IFC classes, spatial containment, property sets, or an equivalent building object model. A named mesh is not counted as semantic BIM.
- **Lighting**: `model` represents fixtures, `render` produces a visual result, `photometric` calculates illuminance or candela distributions, and `optimise` chooses a layout.

## IFC, BIM authoring, and interchange

| Project | Licence, language, maintenance | IFC and MCP | Geometry and image | BIM semantics and lighting | What is reusable here |
|---|---|---|---|---|---|
| [IfcOpenShell](https://github.com/IfcOpenShell/IfcOpenShell) | [LGPL-3.0-or-later for the library](https://github.com/IfcOpenShell/IfcOpenShell#contents); C++ and Python; [repository push 2026-09-01](https://api.github.com/repos/IfcOpenShell/IfcOpenShell) | IFC R/W; no protocol in the core library, but the same monorepo includes IfcMCP | Geometry I/M through OpenCascade and the Python API; no core screenshot API | Full IFC semantics; can create `IfcLightFixture`, but no lighting design or photometry | Canonical parser, serializer, placement utilities, geometry iterator, BVH/UB trees, clash primitives, unit handling, schema validation, and all IFC mutations. This is the foundation. |
| [Bonsai](https://bonsaibim.org/) in the [IfcOpenShell repository](https://github.com/IfcOpenShell/IfcOpenShell) | [GPL-3.0-or-later](https://github.com/IfcOpenShell/IfcOpenShell#contents); Python on Blender; same active monorepo, [2026-09-01](https://api.github.com/repos/IfcOpenShell/IfcOpenShell) | IFC R/W, native authoring; no built-in MCP | Geometry I/M in Blender; viewport screenshots and Blender renders | Full IFC semantics; fixtures can be authored as IFC objects, but there is no layout optimiser or lux engine | Manual authoring, semantic inspection, materials, drawings, and visual QA. Keep it as the human editor rather than the canonical service. |
| [IfcMCP](https://docs.ifcopenshell.org/ifcmcp.html) | [LGPL-3.0-or-later](https://github.com/IfcOpenShell/IfcOpenShell#contents); Python; part of the active IfcOpenShell tree, [2026-08-31 default-branch evidence](https://github.com/IfcOpenShell/IfcOpenShell/commits/v0.9.0) | IFC R/W and MCP; creates, loads, holds, saves, and resets models | Geometry I/M; clash and clearance tools; inline 2D SVG/PNG plots and off-screen 3D PNG renders | Full IFC semantics; generic fixture creation is possible through `ifc_edit`, but no lighting-specific tools | Reuse as the low-level session, query, render, mutation, validation, and save engine. Add narrow Home Twin tools above it. |
| [Bonsai MCP](https://github.com/Show2Instruct/bonsai-mcp) | [MIT](https://github.com/Show2Instruct/bonsai-mcp/blob/main/LICENSE); Python; [latest commit 2026-08-20](https://github.com/Show2Instruct/bonsai-mcp/commits/main) | IFC R/W and MCP; explicitly documents OpenAI Codex | Geometry I/M through live Bonsai, Blender, and IfcOpenShell; viewport and per-storey plan screenshots | IFC classes, spatial structure, properties, quantities, materials, and classifications; no dedicated lighting tools | Best existing Codex visual-inspection bridge. Connect it alongside Home Twin MCP. Do not clone its Blender transport. |
| [ifc-bonsai-mcp](https://github.com/Show2Instruct/ifc-bonsai-mcp) | [MIT](https://github.com/Show2Instruct/ifc-bonsai-mcp/blob/main/LICENSE); Python; [latest commit 2026-07-10](https://github.com/Show2Instruct/ifc-bonsai-mcp/commits/main) | IFC R/W and MCP | Geometry I/M; Blender screenshots | IFC-aware predefined tools; generic Blender and IFC code; no lighting design | Older, larger predecessor to Bonsai MCP. Its authors recommend the smaller project. Reuse examples only when IfcOpenShell does not already cover them. |
| [Speckle Server and Viewer](https://github.com/specklesystems/speckle-server) | [Apache-2.0 unless a package says otherwise](https://github.com/specklesystems/speckle-server#license); TypeScript, Vue, and Three.js; [repository push 2026-08-26](https://api.github.com/repos/specklesystems/speckle-server) | IFC import is supported by the file-import service; no first-party geometry MCP | Geometry I in the web viewer and new object versions through APIs/connectors; preview service renders images | Preserves AEC object metadata, but Speckle is a versioned object graph rather than an IFC-native authoring model; no lighting calculation | Useful later for model sharing, versioning, web viewing, and automation. It adds a server, PostgreSQL, Redis, and object conversion, so it is too much infrastructure for this local MVP. |
| [Speckle Blender connector](https://github.com/specklesystems/speckle-blender) | [Apache-2.0](https://github.com/specklesystems/speckle-blender#license); Python; [repository push 2026-09-01](https://api.github.com/repos/specklesystems/speckle-blender), [release 2026.6.0 on 2026-06-24](https://github.com/specklesystems/speckle-blender/releases) | Speckle objects, not direct IFC authoring; no MCP | Loads objects into Blender and opens the web model; Blender supplies image output | Carries object metadata, but its own README calls Blender sends "highly lossy"; no lighting design | Do not put it in the IFC save path. It may help publish a derived visualisation later. |
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | [MPL-2.0](https://github.com/ThatOpen/engine_web-ifc/blob/main/LICENSE.md); TypeScript/C++/WASM; [repository push 2026-08-31](https://api.github.com/repos/ThatOpen/engine_web-ifc) | IFC R/W; no MCP | Geometry I; low-level line create, update, delete, and save support; demo viewer but no screenshot service | Reads IFC entities, relations, and properties; no lighting layer | Best browser-side IFC parser when a zero-server viewer matters. It should not replace IfcOpenShell in the Python canonical path. |
| [That Open Engine Components](https://github.com/ThatOpen/engine_components) | [MIT](https://github.com/ThatOpen/engine_components#license); TypeScript; [repository push 2026-07-24](https://api.github.com/repos/ThatOpen/engine_components) | IFC R through web-ifc and fragments; no MCP | Geometry I, selection, sections, measurement, visibility, and browser rendering; display edits, not a high-level IFC authoring system | Loads spatial relations, materials, properties, and quantities; no lighting design | Strongest cheap candidate for a minimal browser viewer. Reuse components for orbit, picking, isolation, sections, measurements, and properties. |
| [web-ifc-three](https://github.com/ThatOpen/web-ifc-three) | [MIT](https://github.com/ThatOpen/web-ifc-three/blob/main/LICENSE.md); JavaScript; last repository push [2024-04-17](https://api.github.com/repos/ThatOpen/web-ifc-three) | IFC R and property override; no MCP | Geometry I and Three.js rendering; no screenshot API | IFC IDs and properties; no lighting design | Do not adopt. The [README marks it deprecated](https://github.com/ThatOpen/web-ifc-three#this-library-is-deprecated-use-components-instead) and directs users to Components. |
| [xeokit BIM Viewer](https://github.com/xeokit/xeokit-bim-viewer) | [AGPL-3.0](https://github.com/xeokit/xeokit-bim-viewer#license), with commercial licensing available; JavaScript; [repository push 2026-02-04](https://api.github.com/repos/xeokit/xeokit-bim-viewer) | IFC2x3/IFC4 through conversion to XKT; no MCP | Geometry I, full-precision coordinates, sections, 2D/3D modes, picking, and measurement; browser image can be captured externally | IFC type and spatial trees; no canonical IFC edits or lighting design | A capable alternative viewer, especially for large models and double-precision coordinates. AGPL and the conversion step make That Open Components a simpler MVP choice. |
| [BIMsurfer](https://github.com/aothms/BIMsurfer) | README states an intended MIT licence but the repository has no licence file; JavaScript; last push [2016-12-12](https://api.github.com/repos/aothms/BIMsurfer) | IFC via BIMserver or converted geometry; no MCP | Geometry I and WebGL viewing; no current screenshot service | IFC tree and metadata; no lighting | Historical prior art. The missing explicit licence and inactivity rule out reuse. |
| [OpenUSD](https://github.com/PixarAnimationStudios/OpenUSD) | [Tomorrow Open Source Technology 1.0](https://github.com/PixarAnimationStudios/OpenUSD/blob/dev/LICENSE.txt); C++ and Python; [repository push 2026-08-27](https://api.github.com/repos/PixarAnimationStudios/OpenUSD) | No native IFC and no MCP | Geometry I/M; Hydra/Storm can image scenes | Generic typed schemas for geometry, materials, lights, and physics, but [USD does not define BIM semantics](https://openusd.org/release/intro.html) | Use only as a downstream interchange or Unreal/Omniverse format. `UsdLux` is a rendering schema, not a building-lighting design model. IFC remains canonical. |

### Practical foundation choice

Use IfcOpenShell for the model and geometry. Use official IfcMCP as much as its tool granularity permits. Keep Home Twin's semantic API in a separate Python package so it can be called by MCP, tests, exports, and Blender scripts without speaking MCP internally. Use Bonsai MCP for the screenshot loop. A browser viewer can wait; if added, That Open Components is the least disruptive choice.

## MCP servers, CAD agents, and architectural agents

| Project | Licence, language, maintenance | IFC and MCP | Geometry and image | BIM semantics and lighting | What is reusable here |
|---|---|---|---|---|---|
| [ifc-lite](https://github.com/LTplus-AG/ifc-lite) and [`@ifc-lite/mcp`](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/mcp) | [MPL-2.0](https://github.com/LTplus-AG/ifc-lite#license); TypeScript and Rust/WASM; [repository push 2026-09-01](https://api.github.com/repos/LTplus-AG/ifc-lite), [v4.3.0 released 2026-08-03](https://github.com/LTplus-AG/ifc-lite/releases) | IFC R/W and MCP over stdio or HTTP | Platform has parsing, geometry, WebGPU/WebGL viewing, bounds, area, volume, and clashes. MCP `geometry_get` and `raycast` are [registered but still unsupported](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/mcp#roadmap). Live viewer control is built in. | Rich IFC query, IDS, BCF, bSDD, mutations, and export; no lighting subsystem | The closest competing all-in-one stack. Reuse its tool taxonomy, structured errors, read-only mode, mutation overlay, viewer selection resource, and tests as design references. Python and IfcOpenShell remain the better canonical fit here. |
| [ifcopenshell-mcp](https://github.com/Daviidro/ifcopenshell-mcp) | [MIT](https://github.com/Daviidro/ifcopenshell-mcp/blob/master/LICENSE); Python; [latest commit 2026-08-09](https://github.com/Daviidro/ifcopenshell-mcp/commits/master) | IFC R and MCP; GLB conversion, no IFC mutations | Property and quantity inspection, no tessellated geometry queries; GLB output but no inline render | IFC types, spaces, properties, quantities, validation; no lighting | Eight narrow read tools are useful API examples. Official IfcMCP is broader and maintained with IfcOpenShell, so this should not be a dependency. |
| [bimq](https://github.com/aec-platform/bimq) | [MIT](https://github.com/aec-platform/bimq/blob/master/LICENSE); Python; two commits, latest [2026-08-09](https://github.com/aec-platform/bimq/commits/master) | Read-only IFC/gbXML MCP | Explicitly does not load geometry; no images | Deterministic IFC and gbXML queries with source citations, SI normalisation, field policies, and result caps; no lighting | Its bounded results, model digests, deterministic ordering, and evidence citations are excellent patterns. It is too new and intentionally geometry-free for reuse as the engine. |
| [Speckle MCP](https://github.com/Daviidro/speckle-mcp) | [MIT](https://github.com/Daviidro/speckle-mcp/blob/master/LICENSE); Python; three commits, latest [2026-08-09](https://github.com/Daviidro/speckle-mcp/commits/master) | Speckle project metadata over MCP, not IFC model operations | No geometry query or image output | Lists projects, models, and versions; no BIM element semantics or lighting | Do not confuse it with model access. It is a small Speckle administration bridge. |
| [Blender MCP](https://github.com/ahujasid/blender-mcp) | [MIT](https://github.com/ahujasid/blender-mcp/blob/main/LICENSE); Python; [latest commit 2026-08-30](https://github.com/ahujasid/blender-mcp/commits/main) | MCP, no IFC | Scene I/M, materials, arbitrary `bpy`, asset import, and viewport screenshots | Blender objects only; lights through `bpy`, no BIM or photometry | Dominant generic Blender bridge. It duplicates work that Bonsai MCP already places in an IFC context. Its [2026 terms](https://github.com/ahujasid/blender-mcp/blob/main/TERMS_AND_CONDITIONS.md) say telemetry can include prompts, generated code, scene metadata, screenshots, and manual operator records when consent is enabled. That does not fit a local-first default. |
| [Blender MCP Server](https://github.com/djeada/blender-mcp-server) | [MIT](https://github.com/djeada/blender-mcp-server/blob/main/LICENSE); Python; [latest commit 2026-06-21](https://github.com/djeada/blender-mcp-server/commits/main) | MCP and explicit `codex mcp add`; no IFC | Typed tools for scene/object I/M, materials, render, GLB export, undo/redo, Python, and jobs | No BIM semantics or lighting calculations | Cleaner namespaced tool design than an arbitrary-code-only bridge. Use as an MCP API reference, not another runtime dependency. |
| [Blender Codex MCP](https://github.com/webita/blender-codex-mcp) | [MIT](https://github.com/webita/blender-codex-mcp/blob/main/LICENSE); Python; [latest commit 2026-04-26](https://github.com/webita/blender-codex-mcp/commits/main) | MCP with direct `~/.codex/config.toml` instructions; no IFC | Scene I/M, viewport screenshots, and Blender Python | No BIM semantics or photometry | Proves Codex compatibility, but it is a small fork. Bonsai MCP is more active and understands IFC. |
| [FreeCAD MCP](https://github.com/neka-nat/freecad-mcp) | [MIT](https://github.com/neka-nat/freecad-mcp/blob/main/LICENSE); Python; [latest commit 2026-08-26](https://github.com/neka-nat/freecad-mcp/commits/main) | MCP; the public tool list does not expose IFC | FreeCAD object I/M, arbitrary Python, oriented screenshots, parts, and FEM | CAD object semantics, not a stable IFC building contract; no lighting | Mature CAD-agent reference with useful per-call screenshot controls. It is not a replacement for the IFC layer. |
| [rhino-mcp](https://github.com/EaseHee/rhino-mcp) | [MIT](https://github.com/EaseHee/rhino-mcp/blob/main/LICENSE); Python/C#; [latest commit 2026-05-20](https://github.com/EaseHee/rhino-mcp/commits/main) | MCP; bridge mode claims IFC2x3/IFC4/IFC4x3 import/export | Broad Rhino/Grasshopper geometry I/M, screenshots, renders, measurements, and scripting | BIM metadata tagging and IFC conversion, but Rhino geometry is primary; includes simplified daylight and sun tools, not fixture optimisation | Broad CAD MCP prior art. The live bridge needs proprietary Rhino 8 and exposes hundreds of tools, so it conflicts with a small local IFC MVP. |
| [ChiR24 Unreal MCP](https://github.com/ChiR24/Unreal_mcp) | [MIT](https://github.com/ChiR24/Unreal_mcp/blob/dev/LICENSE); TypeScript/C++; [latest commit 2026-08-29](https://github.com/ChiR24/Unreal_mcp/commits/dev) | MCP, no IFC | Actor and procedural geometry I/M, viewport screenshots, Movie Render Queue | Unreal actors only; can control level lights but has no BIM semantics or lighting calculation | Strongest current optional Unreal bridge. Keep it in the future visualisation pipeline, never in the canonical save path. |
| [IvanMurzak Unreal MCP](https://github.com/IvanMurzak/Unreal-MCP) | [Apache-2.0](https://github.com/IvanMurzak/Unreal-MCP/blob/main/LICENSE); C++ with .NET bridge/CLI; [latest commit 2026-08-30](https://github.com/IvanMurzak/Unreal-MCP/commits/main) | MCP, no IFC | Actor, level, asset, and Blueprint I/M; viewport and isolated-actor screenshots | Unreal object semantics; no BIM or architectural photometry | Another active option with a useful custom-tool registration design. It adds a hosted or self-hosted server and is unnecessary for the MVP. |
| [ifc-llm-assistant](https://github.com/anishrai3008-gif/ifc-llm-assistant) | [MIT](https://github.com/anishrai3008-gif/ifc-llm-assistant/blob/main/LICENSE); Python; one commit [2026-07-09](https://github.com/anishrai3008-gif/ifc-llm-assistant/commits/main) | IFC R; tool-using LLM but not MCP | No geometry engine or images | Eight read-only IFC tools over a deterministic, unit-tested query engine; no lighting | Reuse the control-plane rule: LLMs choose bounded tools, deterministic code owns facts and validation. |
| [Cobbie](https://github.com/sylvainHellin/cobbie) | [CC BY 4.0](https://github.com/sylvainHellin/cobbie/blob/main/LICENSE); Python; [repository push 2026-07-07](https://api.github.com/repos/sylvainHellin/cobbie) | IFC R; multi-agent, not MCP | Information extraction rather than geometric authoring; no images | IFC-aware code generation, verification, debugging, tool creation, and IFC-Bench; no lighting | Reuse benchmark questions and evaluation methods. Do not make dynamic Python generation the public Home Twin API. |
| [Agentic BIM Team](https://github.com/louistrue/agentic-bim-team) | [MIT](https://github.com/louistrue/agentic-bim-team/blob/main/LICENSE); TypeScript/JavaScript; [repository push 2026-04-16](https://api.github.com/repos/louistrue/agentic-bim-team) | Generates and reviews IFC through ifc-lite; not MCP | Geometry QA and a browser viewer; no documented screenshot feedback loop | IFC and BCF with structural, MEP, facade, and fire-review agents; no lighting layout | The IFC plus BCF review loop is useful prior art. It is young, Swiss-specific, and tied to the Claude Agent SDK and sibling services. |
| [CastorIQ](https://github.com/CarloCogni/CastorIQ) | [AGPL-3.0](https://github.com/CarloCogni/CastorIQ/blob/main/LICENSE); Python/Django; [latest commit 2026-08-31](https://github.com/CarloCogni/CastorIQ/commits/main) | IFC R/W after reviewed proposals; not MCP | Explicitly excludes geometry modification; no render loop | IFC properties, materials, classifications, and document-backed answers; no lighting | Risk tiers, reviewed changes, citations, and a Git commit per accepted change are useful patterns. Its database-heavy application stack is not needed. |

### MCP design lessons worth copying

The healthiest projects converge on a few practices:

1. Load a model once, identify the session and model digest, and keep it in memory.
2. Separate read-only mode from mutation advertisement.
3. Return stable structured errors with recovery hints.
4. Keep query, proposal, validation, commit, and save as distinct actions.
5. Make geometry results explicit about units, coordinate frames, approximations, and pending mutations.
6. Return compact lists first and details by stable IFC `GlobalId` on demand.
7. Use screenshots as additional evidence. Never infer canonical coordinates from pixels.
8. Do not expose arbitrary Python as the primary API. Bonsai or Blender code execution is an escape hatch for a human-supervised session.

## Home Assistant floorplans and digital twins

| Project | Licence, language, maintenance | IFC and MCP | Geometry and image | BIM semantics and lighting | What is reusable here |
|---|---|---|---|---|---|
| [ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan) | [Apache-2.0](https://github.com/ExperienceLovelace/ha-floorplan/blob/master/LICENSE); TypeScript; [repository push 2026-08-11](https://api.github.com/repos/ExperienceLovelace/ha-floorplan) | No IFC, no MCP | SVG display and interaction; no geometric measurement or model mutation; browser screenshot only | Maps Home Assistant entity IDs to SVG elements; visual state and service calls; no lighting calculation | Reuse the simple entity-to-visual-ID mapping idea. SVG is a dashboard, not the digital twin. |
| [floor3d-card](https://github.com/adizanni/floor3d-card) | [MIT](https://github.com/adizanni/floor3d-card/blob/master/LICENSE); TypeScript/Three.js; last repository push [2024-04-06](https://api.github.com/repos/adizanni/floor3d-card) | No IFC, no MCP | 3D model viewing and object interaction; no precise building geometry API | Maps model objects to Home Assistant states/actions; visual light effects, not photometry | Good precedent for binding Three.js object names to entities. Maintenance is stale and its mesh scene cannot be canonical. |
| [DT3D for Home Assistant](https://github.com/tentone/dt3d-ha) | [MIT](https://github.com/tentone/dt3d-ha/blob/main/LICENSE); JavaScript; [repository push 2026-08-30](https://api.github.com/repos/tentone/dt3d-ha) | No IFC, no MCP | Integrated 3D editor, imported models, scene I/M, and viewer | Links scene elements to Home Assistant entities; no semantic BIM or photometric calculation | Active proof that local 3D Home Assistant editing is useful. Its add-on scene store is a parallel source of truth, so only the entity-binding and viewer UX are relevant. |
| [ha-floormap](https://github.com/matjahs/ha-floormap) | [MIT](https://github.com/matjahs/ha-floormap/blob/main/LICENSE); TypeScript; [repository push 2026-08-30](https://api.github.com/repos/matjahs/ha-floormap) | SweetHome3D, DXF, SVG, glTF/OBJ adapters; no IFC or MCP | Derived 2D/live-3D viewer and lighting compositing; source model edits happen elsewhere | Reads fixtures from SweetHome3D and creates dynamic, physically plausible visual composites; no validated lux simulation or layout optimiser | The most relevant Home Assistant lighting visualisation. Study its entity mapping, strip handling, and compositing, but keep IFC as source and label its visual method as approximate. |

No reviewed Home Assistant project uses IFC as the canonical home model, exposes precise spatial operations over MCP, or round-trips fixture changes into IFC. Most bind entity IDs to SVG nodes or mesh object names. That makes IFC to Home Assistant mapping a real integration gap, but it should be a small adapter over the IFC model rather than another digital-twin database.

## Lighting simulation, photometry, and IES support

| Project | Licence, language, maintenance | IFC and MCP | Geometry and image | BIM semantics and lighting | What is reusable here |
|---|---|---|---|---|---|
| [Radiance](https://github.com/LBNL-ETA/Radiance) | [Radiance Software License 2.0](https://github.com/LBNL-ETA/Radiance/blob/master/License.txt), BSD-like; C and shell tools; [repository push 2026-08-20](https://api.github.com/repos/LBNL-ETA/Radiance) | No IFC, no MCP | Reads its own scene geometry and produces HDR/images and sensor-grid results; scene files are generated or edited externally | Validated daylight and electric-light simulation, materials, luminaire distributions through `ies2rad`; no BIM object model and no layout optimiser | The accuracy backend to investigate after geometric heuristics work. Export a frozen IFC-derived scene and sensor grid, then treat results as derived data. |
| [frads](https://github.com/LBNL-ETA/frads) | [BSD-3-clause-style LBNL licence](https://github.com/LBNL-ETA/frads/blob/master/license.txt); Python; [repository push 2026-07-15](https://api.github.com/repos/LBNL-ETA/frads) | No IFC, no MCP | Builds and runs Radiance/EnergyPlus workflows and processes images/grids | Lighting and energy simulation workflow, not BIM semantics or optimisation | Better Python integration point than shelling out to many Radiance commands by hand. Evaluate when adding an accurate simulation adapter. |
| [Honeybee Radiance](https://github.com/ladybug-tools/honeybee-radiance) | [AGPL-3.0](https://github.com/ladybug-tools/honeybee-radiance/blob/master/LICENSE); Python; [repository push 2026-08-31](https://api.github.com/repos/ladybug-tools/honeybee-radiance) | No direct IFC and no MCP | Creates analytical geometry, sensor grids, views, and Radiance result files/images | Building-analysis rooms and grids; current [`Luminaire`](https://github.com/ladybug-tools/honeybee-radiance/blob/master/honeybee_radiance/luminaire.py) parses IES LM-63 Type C, places/orients fixtures, and generates Radiance geometry; no layout optimiser | Strong reusable model for IES-backed fixtures, task-plane grids, and simulation folder organisation. AGPL needs review before linking it into a permissively licensed service. A subprocess adapter may be cleaner. |
| [LuxPy](https://github.com/ksmet1977/luxpy) | [GPL-3.0](https://github.com/ksmet1977/luxpy/blob/master/LICENSE.md); Python; [latest commit 2026-03-18](https://github.com/ksmet1977/luxpy/commits/master) | No IFC, no MCP | No building geometry engine; plots photometric and spectral data | CCT, CRI, TM-30, colorimetry, spectral metrics, and IES/LDT distribution visualisation; no room simulation or optimisation | Useful for colour quality and spectral metadata, not spatial layout. Keep optional because GPL and dependency size are disproportionate to the MVP. |
| [eulumdat-rs](https://github.com/holg/eulumdat-rs) | [AGPL-3.0](https://github.com/holg/eulumdat-rs/blob/main/LICENSE); Rust with bindings/apps; [repository push 2026-07-21](https://api.github.com/repos/holg/eulumdat-rs) | No IFC, no MCP | Photometric webs, polar plots, isolux heatmaps, and a map-based manual layout tool; no building solid geometry | Parses, writes, and analyses EULUMDAT, IES LM-63, and TM-33; inverse-square and cosine-corrected point calculations; no indoor fixture optimiser | Broadest current open photometric parser. Its data model, interpolation, beam metrics, spacing criteria, and test corpus are valuable. AGPL makes direct embedding a licence decision. |
| [IESViewer360](https://github.com/changyunhai/IESViewer360) | [MIT](https://github.com/changyunhai/IESViewer360/blob/main/LICENSE); TypeScript; [repository push 2026-06-08](https://api.github.com/repos/changyunhai/IESViewer360) | No IFC, no MCP | 2D/3D photometric visualisation and a simple room lighting simulator | IES parsing and visual lumen analysis; no BIM and no constraint optimiser | Useful browser reference for fixture previews. Do not treat its visual simulation as verified lux without independent validation. |
| [eulumdat-py](https://github.com/123VincentB/eulumdat-py) | [MIT](https://github.com/123VincentB/eulumdat-py/blob/main/LICENSE); Python; [repository push 2026-05-08](https://api.github.com/repos/123VincentB/eulumdat-py) | No IFC, no MCP | No building geometry; examples draw polar plots | Reads and writes EULUMDAT with symmetry expansion; companion packages convert IES/LDT and calculate UGR/beam data; no optimiser | Small dependency-free option for European LDT fixtures. It complements rather than replaces an IES parser. |
| [ies-render](https://github.com/michaellevin/ies-render) | No licence file found, so reuse rights are unclear; Python; last repository push [2024-12-12](https://api.github.com/repos/michaellevin/ies-render) | No IFC, no MCP | Renders a fixture pattern against a wall to a Pillow image | Basic IES angle/candela parsing; no BIM, lux grid, or optimisation | Do not copy code until the author adds a licence. It is useful only as proof that compact fixture thumbnails are cheap to generate. |
| [Blender Cycles IES parser](https://github.com/blender/blender/blob/main/intern/cycles/util/ies.cpp) | [GPL-3.0-or-later](https://github.com/blender/blender/blob/main/COPYING); C++; active Blender source, parser inspected 2026-09-01 | No IFC in core and no MCP | IES texture parsing and rendered light distributions in Cycles | IES Type A/B/C rendering, but no BIM semantics, lux grid, compliance metrics, or layout optimisation | Use for visual validation through Blender. Do not use a beautiful render as a substitute for photometric calculations. |

### Honest lighting tiers

Home Twin should label lighting outputs by method:

| Tier | Allowed claims | Likely implementation |
|---|---|---|
| Geometric | Beam cones, coverage footprints, wall distance, alignment, collisions, dark-zone candidates, task-surface coverage | Native Python geometry on IFC-derived polygons and solids |
| Lumen approximation | Estimated point illuminance or grid values under explicit assumptions, with no inter-reflection claim | Inverse-square and cosine calculations using beam angle, lumen output, maintenance factor, and fixture height |
| Photometric | IES/LDT candela interpolation, luminaire orientation, point/grid illuminance | A tested parser such as Honeybee's luminaire model or eulumdat-rs concepts |
| Simulation | Inter-reflection, material response, daylight, rendered luminance, validated sensor grids | Radiance through frads or Honeybee Radiance |

The optimiser can operate on the first two tiers in the MVP, provided every result says which tier produced it. It should later accept photometric grid results as an objective, without making the Radiance scene the source of truth.

## What already exists and should be reused

1. **IFC parsing, geometry, semantics, and mutation:** IfcOpenShell.
2. **Generic IFC access over MCP:** official IfcMCP.
3. **Live Blender/Bonsai inspection from Codex:** Bonsai MCP.
4. **Manual IFC authoring and visual QA:** Bonsai in Blender.
5. **Browser IFC viewing:** That Open Components and web-ifc, if a general IFC viewer becomes worth maintaining. It has not yet: the browser 3D view draws derived lighting-design geometry rather than arbitrary IFC entities, so it uses three.js (MIT) directly and loads on demand. Adopt Components the day the requirement becomes "open any IFC and browse it".
6. **Accurate lighting calculation:** Radiance, with frads or Honeybee as workflow references.
7. **IES/LDT parsing concepts and tests:** Honeybee Radiance, eulumdat-rs, and eulumdat-py, subject to licence compatibility.
8. **MCP interaction patterns:** ifc-lite's tool taxonomy and error model, bimq's deterministic cited queries, and Bonsai MCP's image loop.

### Derived 3D view decision, 2026-09-02

Three options were weighed for the in-browser 3D room view.

| Option | Cost | Fit |
|---|---|---|
| That Open Components with web-ifc | fragments pipeline, WASM parser, a second IFC reader in the browser | renders IFC entities well; knows nothing about beam cones, task-plane coverage, sun patches, or light shafts |
| xeokit BIM viewer | AGPL, plus an XKT conversion step | capable and precise, but the licence and conversion are disproportionate here |
| three.js on the existing `RoomContext` | one MIT dependency, code-split to a lazy chunk | draws exactly the derived geometry the design work needs, with real spot and directional lights |

three.js was chosen. The view is built from the same room context the 2D plan
uses, so it is disposable and reproducible from IFC and cannot become a second
building model. Nothing in it enters the canonical path. If Home Twin ever needs
to open and browse arbitrary IFC in the browser, that is a different feature and
That Open Components remains the recommendation for it.

Solar geometry was implemented rather than borrowed. The NOAA solar position
calculations are a short, published closed-form algorithm; the reviewed
alternatives that provide it (pvlib, Ladybug) carry large dependency trees or
AGPL, and Radiance remains the intended engine for the daylight *numbers* this
project deliberately does not compute.

## What remains missing

The reviewed sources do not provide these as a coherent, tested, local-first package:

- room-aware IFC geometry with exact ceiling and wall reference frames;
- semantic residential queries with predictable compact schemas;
- millimetre installation coordinates tied to stable reference walls;
- validated creation and movement of `IfcLightFixture` objects;
- configurable residential spotlight constraints;
- alignment across rooms and corridors;
- cabinetry, pendant, AC, beam, duct, and shadow-gap avoidance;
- separation between geometric heuristics and photometric simulation;
- deterministic spotlight optimisation with explainable penalties;
- IFC to Home Assistant entity mapping;
- installation CSV/JSON/SVG drawings generated from canonical IFC;
- an end-to-end agent loop that queries IFC, proposes, validates, commits, screenshots in Bonsai, adjusts, saves, and exports.

That is the project boundary. The independent open-source opportunity is not "IFC MCP" anymore. It is a residential BIM and lighting domain layer that uses the existing IFC MCP and editor ecosystem well.

## Recommended dependency and integration posture

- Make `ifcopenshell` the required model dependency.
- Treat official IfcMCP as an upstream capability to integrate or extend. Avoid depending on its generic `ifc_edit` contract from domain code. Domain functions should call IfcOpenShell directly and expose their own validated schemas.
- Document Bonsai MCP as the recommended second Codex connection for screenshots and live editing. Keep it optional at runtime.
- Do not add Speckle or a database. The one web server is the local browser UI service, and it holds no second building model.
- Keep the browser 3D view a three.js drawing of derived lighting-design geometry, not a general IFC viewer. Adopt That Open Components the day the requirement becomes "open any IFC and browse it".
- Keep Radiance behind an optional adapter. The first milestone needs geometric validation, not a claim of certified lux simulation.
- Keep Unreal downstream and optional: `IFC -> Bonsai/Blender -> glTF/USD/Datasmith -> Unreal`. ChiR24 or IvanMurzak can provide a future agent bridge.
- Record licences per optional integration. AGPL/GPL photometric libraries may be run as separate tools or used as algorithmic references when direct linking would change the distribution obligations of Home Twin.

## Primary source index

The capability tables link each claim directly to its owning repository or documentation. The most consequential source pages are:

- [IfcOpenShell repository and component licences](https://github.com/IfcOpenShell/IfcOpenShell)
- [IfcOpenShell geometry processing](https://docs.ifcopenshell.org/ifcopenshell-python/geometry_processing.html), [geometry creation](https://docs.ifcopenshell.org/ifcopenshell-python/geometry_creation.html), and [geometry tree](https://docs.ifcopenshell.org/ifcopenshell-python/geometry_tree.html)
- [IfcMCP tools and workflow](https://docs.ifcopenshell.org/ifcmcp.html)
- [Bonsai MCP tools](https://github.com/Show2Instruct/bonsai-mcp/blob/main/docs/tools.md)
- [ifc-lite MCP tools and shipped/planned boundary](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/mcp)
- [That Open Components IFC loader source](https://github.com/ThatOpen/engine_components/blob/main/packages/core/src/fragments/IfcLoader/index.ts)
- [web-ifc read/write API and tests](https://github.com/ThatOpen/engine_web-ifc/blob/main/tests/functional/WebIfcApi.spec.ts)
- [Speckle server package map and licence](https://github.com/specklesystems/speckle-server)
- [OpenUSD introduction](https://openusd.org/release/intro.html) and [UsdLux overview](https://openusd.org/dev/user_guides/schemas/usdLux/overview.html)
- [Radiance source mirror](https://github.com/LBNL-ETA/Radiance), [frads](https://github.com/LBNL-ETA/frads), and [Honeybee Radiance luminaire source](https://github.com/ladybug-tools/honeybee-radiance/blob/master/honeybee_radiance/luminaire.py)
- [Home Assistant ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan), [DT3D](https://github.com/tentone/dt3d-ha), and [ha-floormap](https://github.com/matjahs/ha-floormap)
