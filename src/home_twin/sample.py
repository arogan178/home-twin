"""Create the small synthetic IFC used by tests and the repository demo."""

from __future__ import annotations

from math import cos, sin
from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import numpy as np

from home_twin.fixtures import PlannedSpotlight, SpotlightSpec
from home_twin.ifc import IfcRepository
from home_twin.model import Point3D


def _placement(x: float, y: float, z: float, angle: float = 0) -> np.ndarray:
    matrix = np.eye(4)
    matrix[0, 0] = cos(angle)
    matrix[0, 1] = -sin(angle)
    matrix[1, 0] = sin(angle)
    matrix[1, 1] = cos(angle)
    matrix[:3, 3] = [x, y, z]
    return matrix


def create_sample_ifc(path: Path, *, overwrite: bool = False, with_spotlights: bool = True) -> Path:
    """Create a 6 m by 4 m open-plan room with residential obstructions."""

    path = path.resolve()
    if path.exists() and not overwrite:
        raise FileExistsError(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Home Twin sample")
    ifcopenshell.api.run("unit.assign_unit", model)
    model_context = ifcopenshell.api.run("context.add_context", model, context_type="Model")
    body = ifcopenshell.api.run(
        "context.add_context",
        model,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=model_context,
    )

    site = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuilding", name="Sample house")
    storey = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuildingStorey", name="Ground floor")
    room = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcSpace", predefined_type="INTERNAL", name="Open plan"
    )
    for parent, child in ((project, site), (site, building), (building, storey), (storey, room)):
        ifcopenshell.api.run("aggregate.assign_object", model, products=[child], relating_object=parent)

    room_representation = ifcopenshell.api.run(
        "geometry.add_slab_representation",
        model,
        context=body,
        depth=2.8,
        polyline=[(0, 0), (6, 0), (6, 4), (0, 4)],
    )
    ifcopenshell.api.run("geometry.assign_representation", model, product=room, representation=room_representation)
    ifcopenshell.api.run("geometry.edit_object_placement", model, product=room, matrix=_placement(0, 0, 0), is_si=True)

    def add_wall(name: str, length: float, x: float, y: float, angle: float) -> ifcopenshell.entity_instance:
        wall = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcWall", name=name)
        representation = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            model,
            context=body,
            length=length,
            height=2.8,
            thickness=0.1,
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=wall, representation=representation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", model, product=wall, matrix=_placement(x, y, 0, angle), is_si=True
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[wall], relating_structure=storey)
        return wall

    add_wall("South wall", 6, 0, -0.1, 0)
    add_wall("North wall", 6, 0, 4, 0)
    add_wall("West wall", 4, 0, 0, 1.5707963267948966)
    add_wall("East wall", 4, 6.1, 0, 1.5707963267948966)

    def add_box(
        ifc_class: str,
        name: str,
        width: float,
        depth: float,
        height: float,
        x: float,
        y: float,
        z: float,
        *,
        predefined_type: str | None = None,
        container: ifcopenshell.entity_instance = room,
        object_kind: str | None = None,
    ) -> ifcopenshell.entity_instance:
        product = ifcopenshell.api.run(
            "root.create_entity",
            model,
            ifc_class=ifc_class,
            predefined_type=predefined_type,
            name=name,
        )
        representation = ifcopenshell.api.run(
            "geometry.add_slab_representation",
            model,
            context=body,
            depth=height,
            polyline=[(0, 0), (width, 0), (width, depth), (0, depth)],
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=product, representation=representation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", model, product=product, matrix=_placement(x, y, z), is_si=True
        )
        ifcopenshell.api.run("spatial.assign_container", model, products=[product], relating_structure=container)
        if object_kind:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=product, name="Pset_HomeTwin")
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties={"ObjectKind": object_kind})
        return product

    add_box("IfcCovering", "Ceiling", 6, 4, 0.1, 0, 0, 2.8, predefined_type="CEILING")
    add_box("IfcFurniture", "Tall kitchen cabinetry", 3, 0.6, 2.2, 1.5, 3.4, 0, object_kind="cabinet")
    add_box("IfcFurniture", "Dining table", 1.8, 0.9, 0.75, 2.1, 1.55, 0, object_kind="furniture")
    add_box(
        "IfcBuildingElementProxy",
        "North shadow gap",
        6,
        0.15,
        0.05,
        0,
        3.85,
        2.75,
        object_kind="shadow_gap",
    )
    add_box(
        "IfcBuildingElementProxy",
        "AC indoor unit",
        1,
        0.25,
        0.3,
        4.5,
        3.7,
        2.2,
        object_kind="ac",
    )

    model.write(path)
    if with_spotlights:
        repository = IfcRepository.open(path)
        spec = SpotlightSpec(model="Sample 8 W", lumens=650)
        first = PlannedSpotlight("SP01", room.GlobalId, Point3D(1500, 1400, 2800), spec, "OPEN_PLAN_MAIN")
        repository.add_spotlight(first, repository.revision)
        second = PlannedSpotlight("SP02", room.GlobalId, Point3D(4500, 1400, 2800), spec, "OPEN_PLAN_MAIN")
        repository.add_spotlight(second, repository.revision)
    return path

