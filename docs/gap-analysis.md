# Gap analysis

Research date: 2026-09-01

This analysis uses the projects and primary sources in [the ecosystem review](ecosystem-review.md). The main correction to the original premise is important: a generic IFC MCP server is no longer a gap. IfcOpenShell 0.8.5 includes IfcMCP, and Bonsai MCP already gives Codex an IFC-aware Blender connection. Home Twin should build the residential contract above those tools.

## Residential semantic tools over IFC

1. **Problem.** An agent needs answers such as "which walls bound this room?" and "where can a downlight fit?" without understanding IFC relationships, placements, or units.
2. **Existing solutions.** IfcMCP, ifc-lite MCP, ifcopenshell-mcp, and bimq expose broad IFC queries.
3. **Why they are insufficient.** Their contracts are generic. They do not guarantee room-relative millimetre geometry, ceiling polygons, residential classifications, or installer reference distances.
4. **Who would use it.** Home renovators, architects, interior designers, MEP designers, installers, and agent developers.
5. **Difficulty.** Medium. IFC inconsistencies and room-boundary recovery are harder than the MCP transport.
6. **Open-source value.** High. A compact semantic contract would make existing IFC engines much easier for agents to use.
7. **Commercial value.** Medium. Support, model cleanup, and design workflows are sellable, but the query layer itself should remain open.
8. **Location.** Inside Home Twin first. Propose reusable geometry tools upstream to IfcMCP after the contract survives real houses.

## Constraint-based residential lighting layout

1. **Problem.** Residential downlight layouts must balance task lighting, wall washing, cabinetry, pendants, shadow gaps, switching groups, and visual alignment.
2. **Existing solutions.** Radiance, Honeybee, DIALux-style proprietary products, IES viewers, and generic optimisation libraries calculate or visualise light after fixture positions exist.
3. **Why they are insufficient.** The reviewed open tools do not choose residential fixture positions from BIM semantics and human design constraints.
4. **Who would use it.** Lighting designers, electricians, kitchen designers, architects, renovators, and homeowners.
5. **Difficulty.** High. A useful optimiser needs explainable constraints, good defaults, photometric input, and human review.
6. **Open-source value.** Very high. It is the clearest missing reusable component found in the research.
7. **Commercial value.** High. Manufacturer catalogues, calibrated recommendations, review workflows, and professional exports could support a paid product.
8. **Location.** Build the geometric MVP here. Split out a general optimiser only after two or more real projects prove the domain model.

## IFC to Home Assistant mapping

1. **Problem.** A light, sensor, thermostat, or room in IFC needs a stable link to its Home Assistant entity.
2. **Existing solutions.** ha-floorplan, floor3d-card, DT3D, and ha-floormap bind SVG or mesh names to Home Assistant IDs.
3. **Why they are insufficient.** None uses canonical IFC identifiers and semantics or writes mappings that survive a BIM round trip.
4. **Who would use it.** Home Assistant users, smart-home installers, digital-twin developers, and facilities teams.
5. **Difficulty.** Medium. The mapping is simple; identity, discovery, and lifecycle rules are not.
6. **Open-source value.** High because it can connect two healthy open-source ecosystems.
7. **Commercial value.** Medium through commissioning, diagnostics, and managed mappings.
8. **Location.** A separate adapter package or repository after the core object identity rules are stable.

## Agent-friendly building geometry

1. **Problem.** Geometry engines return meshes, BReps, or IFC entities, while agents need bounded operations such as distance, clearance, containment, and ray hits with declared accuracy.
2. **Existing solutions.** IfcOpenShell has geometry trees and clash tools. IfcMCP exposes generic clash and shape operations. ifc-lite has planned geometry and raycast tools.
3. **Why they are insufficient.** The results are not yet a small, stable, room-aware contract with millimetre units, approximation labels, and deterministic ordering.
4. **Who would use it.** BIM agent authors, checking tools, renovation planners, robotics projects, and viewer developers.
5. **Difficulty.** Medium to high because imported IFC geometry varies widely.
6. **Open-source value.** High. This is useful beyond homes.
7. **Commercial value.** Medium as infrastructure, hosted model processing, or model-quality tooling.
8. **Location.** Keep the residential facade here and upstream general operations where possible. A competing generic IFC server would add little value.

## Installation-coordinate drawings

1. **Problem.** A valid BIM layout is not yet a document an electrician can mark on a ceiling.
2. **Existing solutions.** IFC drawing tools, CAD/BIM sheets, IfcMCP plots, and spreadsheet exports provide parts of the workflow.
3. **Why they are insufficient.** They do not automatically create a fixture schedule tied to chosen reference walls, adjacent spacing, cut-out size, switching group, and revision.
4. **Who would use it.** Electricians, site managers, lighting designers, cabinet installers, and homeowners.
5. **Difficulty.** Medium for SVG and CSV. Production drawing standards, revisions, and PDF packaging raise the difficulty.
6. **Open-source value.** High because it closes the loop from model to physical work.
7. **Commercial value.** Medium to high as part of professional documentation and sign-off.
8. **Location.** Inside Home Twin. It is a core output, not a separate platform.

## IFC-to-photometric simulation bridge

1. **Problem.** Accurate illuminance needs IFC room geometry, materials, luminaires, orientations, IES or LDT data, and task grids translated into a validated simulator.
2. **Existing solutions.** Radiance, frads, and Honeybee Radiance provide the simulation engine and Python workflows.
3. **Why they are insufficient.** No reviewed tool offers a narrow residential IFC-to-Radiance adapter with traceable fixture identity and results that return to the IFC workflow.
4. **Who would use it.** Lighting engineers, architects, energy consultants, researchers, and advanced homeowners.
5. **Difficulty.** High. Geometry cleanup, material assumptions, luminaire conversion, and validation all matter.
6. **Open-source value.** High if the adapter remains reproducible and honest about assumptions.
7. **Commercial value.** High for verified calculations, reports, catalogue data, and compute-heavy studies.
8. **Location.** An optional Home Twin adapter first. Consider a separate repository when it supports more than this optimiser.

## Dimensioned plan to IFC

1. **Problem.** Most homeowners start with PDF, raster, DWG, or DXF plans rather than a clean IFC model.
2. **Existing solutions.** CAD import, Bonsai tracing, vector extraction, commercial scan-to-BIM products, and research plan-recognition models cover fragments of the job.
3. **Why they are insufficient.** Automatic tools struggle with scale, wall topology, openings, ambiguous symbols, and conflicting dimensions. They rarely produce trustworthy residential IFC semantics without review.
4. **Who would use it.** Homeowners, surveyors, architects, real-estate platforms, insurers, and renovation firms.
5. **Difficulty.** Very high for general automation. A dimension-led tracing assistant is medium difficulty.
6. **Open-source value.** Very high because model creation is the largest adoption barrier.
7. **Commercial value.** Very high through per-plan conversion and reviewed scan-to-BIM services.
8. **Location.** Separate repository and product for the recognition half. The review half now lives here: the browser tracing workspace calibrates a reference drawing, records points, room topology, printed controls, and openings, checks controls live, and compiles a verified draft IFC under a revision guard. See [browser plan tracing](tracing.md). What is still missing, and still belongs elsewhere, is symbol classification, wall-line vectorisation, dimension text extraction, topology repair, and confidence reporting. Home Twin covers reviewed tracing, not computer vision.

## Residential direct-sun geometry from BIM

1. **Problem.** A homeowner planning lighting, blinds, or glazing wants to know where sun actually lands in a room across a day and a year, before commissioning a simulation.
2. **Existing solutions.** Radiance, Honeybee, and Ladybug compute daylight properly. Rhino, SketchUp, Blender, and several CAD tools show sun paths and shadows. Sun-position libraries such as pvlib and NOAA's published algorithm give the angles.
3. **Why they are insufficient.** None reads an IFC room, resolves its exterior glazed openings, and returns a beam footprint clipped to the traced room outline as a typed, labelled result an agent can query. The simulation tools need a modelled scene and a sky; the CAD tools need a person at the screen.
4. **Who would use it.** Homeowners, lighting designers, blind and shading suppliers, and renovation agents.
5. **Difficulty.** Low for the geometry, given a site and true north. High for anything claiming illuminance.
6. **Open-source value.** Moderate. It is a small, honest layer that keeps a large class of users from over-trusting a rendered picture.
7. **Commercial value.** Low on its own; useful as a step towards shading and glazing advice.
8. **Location.** Here, as `src/home_twin/daylight.py`, strictly as geometry. The illuminance question stays with Radiance. See [the daylight boundary](daylight.md).

## Residential renovation planning agents

1. **Problem.** Renovation decisions cross rooms, trades, dependencies, quantities, access, and the existing building state.
2. **Existing solutions.** General planning agents, BIM review agents, cost schedules, and project-management tools handle documents or schedules but not a home-scale semantic model end to end.
3. **Why they are insufficient.** They lack reliable residential geometry operations, explicit assumptions, and validated model mutations.
4. **Who would use it.** Renovators, architects, contractors, quantity surveyors, and homeowners.
5. **Difficulty.** Very high because regulations, pricing, sequencing, and responsibility vary by location.
6. **Open-source value.** Medium until the geometry and object model are trustworthy.
7. **Commercial value.** High, but liability and local data are substantial barriers.
8. **Location.** Separate application built on Home Twin later. Do not put planning-agent infrastructure in the MVP.

## Residential IFC content conventions

1. **Problem.** IFC can represent home devices and finishes in many valid ways, which makes agents and integrations less predictable.
2. **Existing solutions.** IFC classes, buildingSMART property sets, IDS, bSDD, and authoring templates provide general standards.
3. **Why they are insufficient.** They do not prescribe a lightweight convention for downlights, shadow gaps, cabinets, Home Assistant IDs, installation references, and design intent.
4. **Who would use it.** Home Twin users, BIM authors, fixture manufacturers, smart-home integrators, and agent developers.
5. **Difficulty.** Medium technically and high socially because conventions need adoption.
6. **Open-source value.** High. IDS files, property-set templates, and sample models can make the ecosystem interoperable.
7. **Commercial value.** Low alone, but it supports catalogues, validation, and services.
8. **Location.** Inside this repository as documented conventions and test fixtures. Publish it separately only if other projects adopt it.

## Model quality and safe agent edits

1. **Problem.** Agent changes must preserve unknown IFC relationships and make unintended semantic changes visible.
2. **Existing solutions.** IfcOpenShell validation, IfcDiff, IDS, BCF, Git, CastorIQ review proposals, and IfcMCP save operations cover much of the problem.
3. **Why they are insufficient.** The pieces are not packaged as a residential mutation gate with precondition checks, semantic diffs, and save/reload verification.
4. **Who would use it.** Any team that lets agents modify BIM files.
5. **Difficulty.** Medium for a narrow mutation set and high for arbitrary IFC edits.
6. **Open-source value.** High, but the implementation should compose existing validators and diff tools.
7. **Commercial value.** Medium through audit, approvals, and managed collaboration.
8. **Location.** Keep narrow validation in Home Twin. Contribute general safety improvements upstream instead of starting another IFC edit framework.

## Gaps that are already filled

The research does not support new projects for these categories:

- a generic IFC MCP server, because official IfcMCP and ifc-lite MCP already cover it;
- a generic Blender MCP bridge, because Blender MCP and Bonsai MCP are active;
- another general IFC web viewer, because That Open Components, xeokit, Speckle, and ifc-lite are established; the derived room view here renders lighting-design geometry, not arbitrary IFC;
- another solar-position implementation as a library, because the NOAA algorithm is published and pvlib and Ladybug already package it;
- a new physically accurate lighting engine, because Radiance is validated and actively maintained;
- another mesh-based Home Assistant floorplan card, because several active projects already serve that use case.

The strongest independent opportunity is a constraint-based residential lighting designer backed by semantic BIM. The most valuable adjacent opportunity is reviewed plan-to-IFC conversion. Home Twin should first prove precise room geometry, safe fixture edits, and installation exports before either becomes a separate product.
