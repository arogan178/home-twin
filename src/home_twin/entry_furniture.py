"""Shoe-changing bench with a native IFC seat, side supports and shoe shelf."""

from __future__ import annotations

from dataclasses import dataclass
from math import cos, isfinite, radians, sin

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

from home_twin.furniture import box_solid, check_tags_are_free
from home_twin.model import Point3D


@dataclass(frozen=True)
class ShoeBench:
    tag: str
    centre_mm: Point3D
    width_mm: float = 580
    depth_mm: float = 380
    height_mm: float = 450
    rotation_deg: float = 0.0
    """Anticlockwise on plan. The front is the local ``-Y`` face, so a front
    bearing of ``b`` degrees is a rotation of ``180 - b``. A bench on a wall that
    is not square to the frame needs this or it stands across its own threshold."""
    finish: str = "walnut_linen"
    """A bench under an outdoor overhang is not the one in the lounge: it wants
    a marine material and a vented front, and the model has to say which."""
    vented: bool = False
    """Draw a closed carcass with a louvred front on feet, not an open bench.

    Outdoors under a metre of overhang, wind-driven rain reaches in and an open
    bench is the wrong object. The louvres are what keep damp shoes from going
    sour in a sealed box, and the feet let run-off pass under.
    """

    def __post_init__(self) -> None:
        if not self.tag or not all(
            isfinite(v) and v >= 300
            for v in (
                self.width_mm,
                self.depth_mm,
                self.height_mm,
            )
        ):
            raise ValueError("Shoe bench needs a tag and finite dimensions of at least 300 mm")
        if not all(isfinite(v) for v in (self.centre_mm.x, self.centre_mm.y, self.centre_mm.z)):
            raise ValueError("Shoe bench position must be finite")


def author_shoe_bench(model: ifcopenshell.file, room_id: str, bench: ShoeBench) -> str:
    """Author a private clone; the caller owns validation and durable publication."""
    # This type has no save wrapper to hold the check, and it reuses whatever
    # carries its tag -- so an unchecked tag takes another room's fitting.
    check_tags_are_free(model, {bench.tag: room_id})
    matches = [e for e in model.by_type("IfcFurniture") if e.Tag == bench.tag]
    if len(matches) > 1:
        raise ValueError("Duplicate shoe bench tag")
    entity = (
        matches[0]
        if matches
        else ifcopenshell.api.run(
            "root.create_entity",
            model,
            ifc_class="IfcFurniture",
            name="Shoe changing bench",
        )
    )
    entity.Tag = bench.tag
    entity.PredefinedType = "USERDEFINED"
    entity.ObjectType = "shoe_bench"
    if entity.Representation:
        for rep in list(entity.Representation.Representations):
            ifcopenshell.api.run("geometry.unassign_representation", model, product=entity, representation=rep)
            ifcopenshell.api.run("geometry.remove_representation", model, representation=rep)
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    w, d, h = bench.width_mm, bench.depth_mm, bench.height_mm
    if bench.vented:
        board, foot, slat = 25.0, 50.0, 40.0
        body = h - foot
        parts = [
            (w, d, board, 0, 0, h - board),
            (w - board * 2, d - board, board, 0, board / 2, foot),
            (w - board * 2, board, body - board, 0, (d - board) / 2, foot),
        ]
        parts.extend((board, d, body - board, side * (w - board) / 2, 0, foot) for side in (-1, 1))
        parts.extend((foot, foot, foot, side * (w - foot) / 2 * 0.8, 0, 0) for side in (-1, 1))
        # Horizontal louvres across the front, tilted only in specification: the
        # gaps between them are the ventilation and the reason this is not a box.
        courses = int((body - board * 2) // (slat + 18))
        parts.extend(
            (
                w - board * 2,
                18,
                slat,
                0,
                -(d - 18) / 2,
                foot + board + course * (slat + 18),
            )
            for course in range(courses)
        )
    else:
        parts = [(w, d, 40, 0, 0, h - 40), (w - 60, d - 30, 25, 0, 15, 100)]
        parts.extend((30, d, h - 40, side * (w - 30) / 2, 0, 0) for side in (-1, 1))
    solids = [box_solid(model, *(v / unit_mm for v in part)) for part in parts]
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    rep = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", solids)
    ifcopenshell.api.run("geometry.assign_representation", model, product=entity, representation=rep)
    building = model.by_type("IfcBuilding")[0]
    frame = ifcopenshell.util.placement.get_local_placement(building.ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    angle = radians(bench.rotation_deg)
    local = np.eye(4)
    local[:2, :2] = np.array([[cos(angle), -sin(angle)], [sin(angle), cos(angle)]])
    local[:3, 3] = np.array([bench.centre_mm.x, bench.centre_mm.y, bench.centre_mm.z]) / 1000
    ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=frame @ local, is_si=True)
    ifcopenshell.api.run(
        "spatial.assign_container", model, products=[entity], relating_structure=model.by_guid(room_id)
    )
    existing = {
        r.RelatingPropertyDefinition.Name: r.RelatingPropertyDefinition
        for r in entity.IsDefinedBy
        if r.is_a("IfcRelDefinesByProperties")
    }
    for name, properties in {
        "Pset_HomeTwin": {"ObjectKind": "furniture"},
        "Pset_HomeTwinFurniture": {
            "Role": "shoe_bench",
            "Facing": None,
            "RotationDegrees": bench.rotation_deg,
            "BearingDeg": (bench.rotation_deg + 90.0) % 360.0,
            "WidthMm": bench.width_mm,
            "DepthMm": bench.depth_mm,
            "HeightMm": bench.height_mm,
            "CentreXMm": bench.centre_mm.x,
            "CentreYMm": bench.centre_mm.y,
            "Finish": bench.finish,
            "Vented": bench.vented,
        },
    }.items():
        pset = existing.get(name)
        if pset is None:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
    return entity.GlobalId
