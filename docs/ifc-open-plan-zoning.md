# Modelling a functional sub-area of an open plan in IFC4

Research date: 2026-09-07

Question: how should a "dining area" inside a single open-plan living/kitchen/dining
`IfcSpace` be modelled in IFC4?

Sources are the buildingSMART IFC4 ADD2 TC1 specification, the IFC 4.3.2.0
specification, the EXPRESS schema as shipped in IfcOpenShell 0.8.5, and
first-party IfcOpenShell source. Schema claims marked *verified* were executed
against `.venv` IfcOpenShell 0.8.5 in this repository, not read off a page.
Anything taken from a secondary source is labelled as such.

## Answer in one line

Option 3, `IfcZone`, is excluded by the specification itself: it cannot carry
geometry. Options 1, 2 and 4 are all legal. Option 4, no entity, is what this
model should keep, because a dining area here is a lighting and furniture region
and IFC gives it no anchor the geometry does not already provide. If it ever
needs durable identity, `IfcSpatialZone` is the entity buildingSMART designed for
it, and no exporter in the field will help you either way.

## What the two entities are for

`IfcSpace`: "A space represents an area or volume bounded actually or
theoretically. Spaces are areas or volumes that provide for certain functions
within a building." It continues: "The `IfcSpace` is used to build the spatial
structure of a building (that serves as the primary project breakdown and is
required to be hierarchical)."
([IfcSpace, IFC4 ADD2 TC1](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspace.htm))

`IfcSpatialZone`: "A spatial zone is a non-hierarchical and potentially
overlapping decomposition of the project under some functional consideration. A
spatial zone might be used to represent a thermal zone, a construction zone, a
lighting zone, a usable area zone. A spatial zone might have its independent
placement and shape representation."
([IfcSpatialZone, IFC4 ADD2 TC1](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialzone.htm))

The distinction is stated by their shared supertype. `IfcSpatialElement` is "the
generalization of all spatial elements that might be used to define a spatial
structure or to define spatial zones", where a spatial structure "is a
hiearchical decomposition of the project" and a spatial zone "is a
non-hierarchical and potentially overlapping decomposition of the project under
some functional consideration".
([IfcSpatialElement](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialelement.htm))

So: hierarchical project breakdown is `IfcSpace`; overlapping functional overlay
is `IfcSpatialZone`. A dining area is a functional consideration over an
existing room, which is the `IfcSpatialZone` sentence almost verbatim.

`IfcZone` is the third thing and is not geometric: "A zone is a group of spaces,
partial spaces or other zones." The specification says so explicitly against
`IfcSpatialZone`: "The `IfcSpatialZone` is different to the `IfcZone` entity by
allowing an own placement and shape representation, whereas `IfcZone` is only a
grouping of `IfcSpace`'s."
([IfcZone](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifczone.htm),
[IfcSpatialZone](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialzone.htm))

## Is a functional zone sharing floor and ceiling with its parent a legitimate IfcSpace?

Yes, and the schema names the mechanism. It is not `PredefinedType`; it is
`CompositionType`, inherited from `IfcSpatialStructureElement`:

> A space can also be decomposed in parts, where each part defines a partial
> space. This is defined by the `CompositionType` attribute of the supertype
> `IfcSpatialStructureElement` which is interpreted as follow:
> COMPLEX = space group / ELEMENT = space / PARTIAL = partial space

([IfcSpace](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspace.htm))

`IfcElementCompositionEnum` defines `PARTIAL` as "A subelement or part".
([IfcElementCompositionEnum](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcelementcompositionenum.htm))

The context note in the question is right about the wrong attribute.
`IfcSpaceTypeEnum` in IFC4 is exactly
`SPACE, PARKING, GFA, INTERNAL, EXTERNAL, USERDEFINED, NOTDEFINED` and has no
`PARTIAL`
([IfcSpaceTypeEnum](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspacetypeenum.htm);
verified against `ifcopenshell.schema_by_name("IFC4")`). `PARTIAL` lives on
`CompositionType`, attribute 9, a different attribute from `PredefinedType`,
attribute 10. IFC4.3 adds `BERTH` to `IfcSpaceTypeEnum` and adds `INTERFERENCE`
and `RESERVATION` to `IfcSpatialZoneTypeEnum`; `CompositionType` is unchanged and
not deprecated in IFC 4.3.2.0
([IfcSpatialStructureElement, IFC 4.3.2.0](https://standards.buildingsmart.org/IFC/DEV/IFC4_3/HTML/lexical/IfcSpatialStructureElement.html);
verified against `IFC4X3_ADD2` in IfcOpenShell).

The specification's own concept template makes nesting conditional on that
attribute. Under *Spatial Composition* on `IfcSpace`:

> By using the inverse relationship `IfcSpace.IsDecomposedBy` it references
> `IfcSpace` by `IfcRelAggregates.RelatedObjects`. If it refers to another
> instance of `IfcSpace`, the referenced `IfcSpace` needs to have a different and
> lower `CompositionType`, i.e. ELEMENT (if the other `IfcSpace` has COMPLEX), or
> PARTIAL (if the other `IfcSpace` has ELEMENT).

([IfcSpace, Concept usage](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspace.htm);
identical wording in [IFC 4.3.2.0](https://standards.buildingsmart.org/IFC/DEV/IFC4_3/HTML/lexical/IfcSpace.html))

So a dining area modelled as a nested `IfcSpace` is legitimate only as
`CompositionType = PARTIAL` under a parent whose `CompositionType` is `ELEMENT`.

This matters for the existing model. `src/home_twin/plan_draft.py` aggregates a
child space into `room.part_of` without ever setting `CompositionType`, and the
attribute defaults to `ELEMENT` when unset ("If no `CompositionType` is
asserted, the dafault value 'ELEMENT' applies",
[IfcSpatialStructureElement](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialstructureelement.htm)).
A split-level area, such as a sunken snug, is therefore an ELEMENT space aggregated into an ELEMENT
space, which the concept template says should be ELEMENT over PARTIAL. Nothing
rejects it: *Spatial Composition* is an mvdXML concept template, not an EXPRESS
where rule, and `ifcopenshell.validate` with `express_rules=True` reports zero
issues for either arrangement (verified). It is still a one-line correctness fix
worth making independently of the dining question.

## Must a nested space partition its parent?

No source found says it must. The specification is silent on gaps and silent on
full coverage.

The only statement near the question is a NOTE, and it delegates:

> NOTE View definitions and implementation agreements may restrict spaces with
> `CompositionType` = ELEMENT to be non-overlapping.

([IfcSpace, IFC4 ADD2 TC1](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspace.htm))

IFC 4.3.2.0 generalises the same NOTE: "View definitions and implementation
agreements *may restrict spaces with the same `CompositionType` to be
non-overlapping*"
([IfcSpace, IFC 4.3.2.0](https://standards.buildingsmart.org/IFC/DEV/IFC4_3/HTML/lexical/IfcSpace.html)).
Read literally, the 4.3 wording says an eventual restriction would apply between
siblings of equal `CompositionType`, not between a PARTIAL child and its ELEMENT
parent, which is the arrangement a dining area would use. That is a permissive
reading of a NOTE about what other documents might say, so it is weak evidence,
but it is the only evidence there is.

The informal propositions on `IfcSpatialStructureElement` constrain the shape of
the tree, not the coverage of the geometry:

> The spatial project structure, established by the `IfcRelAggregates`, shall be
> acyclic. / A site should not be (directly or indirectly) associated to a
> building, storey or space. / A building should not be (directly or indirectly)
> associated to a storey or space. / A storey should not be (directly or
> indirectly) associated to a space.

Its only formal proposition, WR41, is likewise about attachment, not coverage:
"All spatial structure elements shall be associated (using the
`IfcRelAggregates` relationship) with another spatial structure element, or with
IfcProject."
([IfcSpatialStructureElement](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialstructureelement.htm))

`IfcRelAggregates` itself adds only `NoSelfReference` and a semantic dependency
statement: "Decompositions imply a dependency, implying that the whole depends on
the definition of the parts and the parts depend on the existence of the whole."
([IfcRelAggregates](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcrelaggregates.htm))

Conclusion: a partial space covering only part of its parent breaks no published
rule. There is also no published rule that makes it *meaningful*: nothing in
IFC4 says whether a parent's area is net of its partial children or inclusive of
them. That ambiguity is the real cost of option 1, not a validation failure.

## Containment in more than one spatial element

No. The rule is stated twice and is unambiguous:

> The containment relationship of an element within a spatial structure has to be
> a hierarchical relationship; an element can only be contained within a single
> spatial structure element. The reference relationship between an element and
> the spatial structure need not be hierarchical; that is, an element can
> reference many spatial structure elements.

and on the attribute: "Any element can only be contained within one element of
the project spatial structure."
([IfcRelContainedInSpatialStructure](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcrelcontainedinspatialstructure.htm))

`IfcSpatialElement.ContainsElements` repeats it as a NOTE: the containment
relationship "is required to be an hierarchical relationship, where each element
can only be assigned to 0 or 1 spatial structure element."
([IfcSpatialElement](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialelement.htm))

`IfcRelReferencedInSpatialStructure` is the escape hatch: "used to assign
elements in addition to those levels of the project spatial structure, in which
they are referenced, but not primarily contained… Any element can be referenced
to zero, one or several levels of the spatial structure."
It names spatial zones directly: "Elements can also be references in a spatial
zone that is provided as `IfcSpatialZone`."
([IfcRelReferencedInSpatialStructure](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcrelreferencedinspatialstructure.htm))

Its formal proposition `AllowedRelatedElements` grants exactly the exception this
question needs:

> The relationship object shall not be used to include other spatial structure
> elements into a spatial structure element. The hierarchy of the spatial
> structure is defined using `IfcRelAggregates`. Exception: an `IfcSpace` can be
> referenced by another spatial structure element, in particular by an
> `IfcSpatialZone`. — IFC4 CHANGE The relaxation to allow `IfcSpace` has been
> included.

So yes: a pendant may be *contained* in the open-plan `IfcSpace` and
simultaneously *referenced* in a dining `IfcSpatialZone`, and the open-plan space
itself may be referenced in that zone. Verified by round-trip: a synthetic IFC4
file with an `IfcLightFixture` contained in the space and referenced in the zone
reopens and validates with zero issues.

`IfcSpatialZone` states the same direction of travel from its own side: "Physical
elements that are referenced by this spatial zone are related using the
`IfcRelReferencedInSpatialStructure` relationship as it is a non-hierarchical
assignment in addition to the hierarchical spatial containment."
([IfcSpatialZone](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialzone.htm))

## May spatial zones overlap each other and their parent space?

Yes, by definition: "a non-hierarchical and *potentially overlapping*
decomposition of the project"
([IfcSpatialZone](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialzone.htm),
[IfcSpatialElement](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcspatialelement.htm)).
There is no where rule or informal proposition restricting spatial zone geometry
at all. `IfcSpatialZone` has only `CorrectPredefinedType` and
`CorrectTypeAssigned`, both about typing.

Note the asymmetry in the wording: `IfcSpatialZone` says overlap is *expected*,
while `IfcSpace` says overlap *may be restricted by a view definition*. That is
the clearest signal in the specification about which entity an overlapping
functional region belongs to.

`IfcZone` carries a comparable caution: "Certain use cases may restrict the
freedom of non hierarchical relationships. In some building service use cases the
zone denotes a view based delimited volume for the purpose of analysis and
calculation. This type of zone cannot overlap with respect to that analysis, but
may overlap otherwise."
([IfcZone](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifczone.htm))

## Virtual space boundaries

A virtual boundary is how you record that two *already separate* spaces are not
divided by anything physical. It is not a tool for creating the division.

> A virtual element is a special element used to provide imaginary boundaries,
> such as between two adjacent, but not separated, spaces. … The main purpose of
> `IfcVirtualElement` is the provision of a virtual space boundary.

([IfcVirtualElement](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcvirtualelement.htm))

`IfcRelSpaceBoundary` requires the pairing: "if the `IfcRelSpaceBoundary` is used
to express a virtual boundary, the attribute `PhysicalOrVirtualBoundary` has to
be set to VIRTUAL. The attribute `RelatedBuildingElement` shall point to an
instance of `IfcVirtualElement`." IFC4 made that mandatory: "IFC4 CHANGE The
attribute `RelatedBuildingElement` has been made mandatory. For virtual
boundaries the reference to `IfcVirtualElement` is now mandatory."
([IfcRelSpaceBoundary](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcrelspaceboundary.htm))
`IfcPhysicalOrVirtualEnum.VIRTUAL` is "The space boundary is provided virtually
(by a logical divider that has no physical manifestation)."
([IfcPhysicalOrVirtualEnum](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifcphysicalorvirtualenum.htm))

Read carefully, the sanctioned pattern is: two `IfcSpace` instances that are
*siblings* and adjacent, sharing one `IfcVirtualElement` referenced by two
`IfcRelSpaceBoundary` instances: "All instances of `IfcRelSpaceBoundary` given
at the adjacent spaces share the same instance of `IfcVirtualElement`."
That is a *partition* of an open plan into two peer rooms, each with its own
area, boundaries and containment. It is not a sub-area of a room.

The specification never says "use a virtual boundary to subdivide an open plan
into functional areas." It says virtual boundaries exist for adjacent
undivided spaces. If Home Twin's open plan were genuinely two rooms
(separately scheduled, separately measured, separately named on the plan), this
would be the correct pattern, and the boundary between them would be virtual. It
is not the pattern for a dining table's neighbourhood inside one room.

## Also relevant: what IfcZone cannot do

The `IfcZone` page's *Group Assignment* concept rules option 3 out on geometry
alone, in the specification's own words:

> An `IfcZone` is a spatial system under which individual `IfcSpace`'s (and other
> `IfcZone`'s) are grouped. In contrary to the `IfcSpatialZone` entity, `IfcZone`
> is a mere grouping, it can not define an own geometric representation and
> placement. Therefore it cannot be used for spatial zones having a different
> shape and size compared to the shape and size of aggregated spaces.

([IfcZone](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/ifczone.htm))

A dining area is by definition a different shape and size from the open plan it
sits in, so `IfcZone` cannot express it without first making the dining area a
space, which is option 1 again, with an extra grouping object on top.

Its `WR1` also blocks the obvious lighting use: "Only objects of type `IfcSpace`,
`IfcZone` and `IfcSpatialZone` are allowed as RelatedObjects." Verified: assigning
an `IfcLightFixture` to an `IfcZone` and running `ifcopenshell.validate` with
`express_rules=True` produces an `IfcZone.WR1` entity-rule error. IfcOpenShell
encodes the same restriction in
`ifcopenshell/util/system.py`: `"IfcZone": ("IfcZone", "IfcSpace", "IfcSpatialZone")`.
That is why `docs/lighting-controls-architecture.md` is right to map control
groups to plain `IfcGroup` rather than `IfcZone`: `IfcGroup` accepts any
`IfcObjectDefinition`, `IfcZone` does not.

## What exporters and MVDs actually do

### Reference View 1.2 quietly forbids nested spaces

The RV 1.2 copy of `IfcSpace` drops the *Spatial Composition* concept entirely
and truncates *Spatial Decomposition* to:

> By using the inverse relationship `IfcSpace.Decomposes` it references `IfcSite`
> || `IfcBuildingStorey` by `IfcRelAggregates.RelatingObject`.

`|| IfcSpace` and the whole `CompositionType` ladder are deleted relative to the
base schema. Verified by fetching the page: it contains no "Spatial Composition"
string, and its attribute table omits both `BoundedBy` and `ReferencesElements`.
([IfcSpace in RV 1.2](https://standards.buildingsmart.org/MVD/RELEASE/IFC4/ADD2_TC1/RV1_2/HTML/schema/ifcproductextension/lexical/ifcspace.htm))

RV 1.2 also excludes `IfcRelSpaceBoundary` and `IfcRelReferencedInSpatialStructure`
from scope. That produces a real hole: RV includes `IfcSpatialZone` as an entity
while omitting the one relationship that lets a spatial zone reference anything.
An RV-conformant `IfcSpatialZone` is inert.

### Design Transfer View 1.1 has no published documentation

This model's header declares `ViewDefinition[DesignTransferView]`. There is
nothing to check that against. The buildingSMART MVD register lists "IFC4 ADD2
TC1 | Design Transfer View | **Draft**" with no MVD identifier and, in the raw
HTML, no hyperlink in its documentation column
([MVD database](https://technical.buildingsmart.org/standards/ifc/mvd/mvd-database/)).
`https://standards.buildingsmart.org/MVD/RELEASE/IFC4/ADD2_TC1/DTV1_1/HTML/`
returns 404 (verified). Do not treat the DTV as a normative constraint in either
direction; it constrains nothing because it says nothing.

### The concept templates say "same or higher level"

The base *Spatial Composition* template is the one place the specification
addresses nesting directly:

> The order of spatial structure elements being included in the concept for
> builing projects are from high to low level: `IfcProject`, `IfcSite`,
> `IfcBuilding`, `IfcBuildingStorey`, and `IfcSpace` with `IfcSite`,
> `IfcBuildingStorey` and `IfcSpace` being optional levels. Therefore an spatial
> structure element can only be part of an element at the same or higher level.

([Spatial Composition template](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/schema/templates/spatial-composition.htm),
sic on "builing"; the same sentence appears in
[Spatial Decomposition](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/schema/templates/spatial-decomposition.htm))

"The same level" admits space inside space. Neither template says siblings must
not overlap, and neither says a decomposition must cover its parent.

### Revit

Revit exports Rooms, MEP Spaces and Areas through one code path and all three
become `IfcSpace`. `SpatialElementExporter.ExportSpatialElement` is documented as
"Exports spatial elements, including rooms, areas and spaces" and forces the
default: "Force the default export to IfcSpace for Spatial Element if it is set
to UnKnown"
([SpatialElementExporter.cs](https://github.com/Autodesk/revit-ifc/blob/master/Source/Revit.IFC.Export/Exporter/SpatialElementExporter.cs)).
An Area gets a dummy height ("For area spaces, we assign a dummy height (1
unit), as we are not allowed to export IfcSpaces without a volumetric
representation") and no space boundaries.

Area Schemes become `IfcGroup`, not `IfcZone`: "Provides methods to export an
AreaScheme element as IfcGroup"
([AreaSchemeExporter.cs](https://github.com/Autodesk/revit-ifc/blob/master/Source/Revit.IFC.Export/Exporter/AreaSchemeExporter.cs)).
`IfcZone` comes from the MEP Zone element
([ZoneExporter.cs](https://github.com/Autodesk/revit-ifc/blob/master/Source/Revit.IFC.Export/Exporter/ZoneExporter.cs))
or from `ZoneName*` shared parameters on rooms: "The export of IFCZones from
Revit is realized through a set of shared parameters that are assigned to room
objects"
([Revit IFC Manual 2.0, p. 40](https://damassets.autodesk.net/content/dam/autodesk/www/pdfs/revit-ifc-guide-high-res.pdf)).

Two facts decide the question:

- **Revit never nests spaces.** No `IfcSpace` is ever the `RelatingObject` of an
  `IfcRelAggregates`; spaces are registered against a level and emerge as the
  storey's related products.
- **Revit hard-codes `IFCElementComposition.Element` on every space**, and the
  only `PARTIAL` in the entire exporter is on `IfcSite`. The user override
  parameter `IfcElementCompositionType` applies to levels only.

`IfcSpatialZone` is reachable only by per-category mapping in IFC4 exports; it is
absent from Autodesk's published
[supported IFC classes list](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-DocumentPresent/files/GUID-EE6C0CF8-7671-4DCC-B0C7-EEA7513C90A9.htm),
and mapping Areas to it with a `ZoneName` set aborts the export
([revit-ifc issue #727](https://github.com/Autodesk/revit-ifc/issues/727),
filed internally as Revit-217482).

### Archicad

An Archicad Zone maps to `IfcSpace` in the built-in type mapping table; the row
reads "Zone / IFCSpace / IFCSpaceType"
([Built-in IFC Type Mapping](https://help.graphisoft.com/AC/29/INT/_AC29_Help/121_IFC/121_IFC-51.htm)).
`IfcZone` grouping is supported through IFC Assignments and, unlike Revit, nests:
"Grouping by multilevel-hierarchy is also available for IfcZone assignments"
([IFC Assignment types](https://help.graphisoft.com/AC/29/INT/_AC29_Help/121_IFC/121_IFC-48.htm)).

Graphisoft never mentions `IfcSpatialZone`, and its enumeration of spatial
elements is closed without it: "IFC Spatial Elements are IfcProject, IfcSite,
IfcBuilding, IfcBuildingStorey, as well as IfcSpace" (same page). `CompositionType`
does not appear in Archicad's IFC documentation at all. This is silence, not a
documented refusal.

### Neither vendor has a sub-area concept

Revit's sanctioned way to split an open plan is Room Separation Lines, which
produce separate Rooms. Archicad's is Zone Boundary lines, which produce separate
Zones. Both produce peer spaces, not sub-areas, the same conclusion the virtual
boundary section reaches from the schema side.

## Recommendation for the dining area in this model

**Keep option 4. Do not add an entity.**

The dining area in this model already exists in three durable places: the
`DiningFurniture` items with their `Tag` values, the pendant above the table, and
the switching group. Its extent is derivable from the table footprint and the
pendant position at the moment any tool needs it. IFC offers no anchor that
geometry does not already provide, and no source reviewed requires an entity for
a functional region.

That is not the same as "IFC has nothing for this". `IfcSpatialZone` is a good
fit on paper and is the right answer if the region ever needs durable identity:
a saved lighting scene, a Home Assistant area, a coverage target an agent
re-reads. What it does not yet have here is a consumer.

Costs if the decision is revisited:

| Option | What it costs | What it buys |
|---|---|---|
| **1. Nested `IfcSpace`, `PARTIAL`** | A traced polygon in `plan.yaml` for a boundary with no physical referent, inventing surveyed geometry the tracing rules exist to prevent. `get_rooms()` at `src/home_twin/ifc.py:336` enumerates every `IfcSpace`, so the dining area appears as a room in MCP, the room rail, and every fixture-placement target unless filtered by Pset the way daylight sources already are. Quantities become ambiguous: no source says whether the parent's area is net or gross of its partial children. Neither Revit nor Archicad can produce or consume it. | A first-class room with its own boundaries, coverings, and containment. Correct only if the dining area is really a separate room. |
| **2. `IfcSpatialZone`** | New code, because nothing in the repo enumerates `IfcSpatialZone`, which is also why it costs nothing in the existing read path. `PredefinedType = LIGHTING` fits ("a lighting zone; a daylight zone, or an artificial lighting zone"); a dining area as such needs `USERDEFINED` plus `ObjectType`. Poor interoperability: RV 1.2 omits the relationship it needs, Revit reaches it only through category mapping with a known crash, Archicad never mentions it. | The entity buildingSMART defines for exactly this. Overlaps legitimately, carries its own geometry, and can reference both the open plan and the fixtures while they stay contained in the space. Verified to author, save, reopen, and validate cleanly. |
| **3. `IfcZone`** | Ruled out by the specification, not by cost. It cannot carry geometry, and `WR1` rejects the light fixtures. | Nothing this case needs. |
| **4. No entity** | Nothing. The region stays derived and disposable. | Honesty. No claim the model cannot support. |

If option 2 is ever taken, add it the way this repository adds any object type:
a domain type, an explicit IFC mapping, geometry and semantic validation, a
synthetic save/reload test, and a note here, not a string in YAML.

### One unrelated fix this research surfaced

A split-level area is aggregated into its parent room with `CompositionType`
unset on both, which defaults to `ELEMENT` over `ELEMENT`. The *Spatial
Composition* concept template asks for `ELEMENT` over `PARTIAL`. Nothing rejects
the current file (the template is mvdXML, not an EXPRESS rule, and
`ifcopenshell.validate` with `express_rules=True` passes either way, verified),
but setting the child space to `PARTIAL` in `src/home_twin/plan_draft.py` is a one-line
change that makes the model say what the specification means.
