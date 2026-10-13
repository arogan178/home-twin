"""Perimeter gypsum reveals authored as ceiling shadow gaps.

Where the gypsum stops short of a wall, the slot it leaves is a real void that
downlights must clear and that carries a concealed LED lip. The model already
calls such a void a shadow gap, so a reveal is authored as one rather than as a
new kind: the strip volume is IFC, and the lip section inside it is a viewer
allowance the way the concealed-cove section already is.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from math import atan2, cos, hypot, isfinite, sin
from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

from home_twin.furniture import box_solid
from home_twin.geometry import point_in_polygon
from home_twin.model import HomeTwin, Point2D, Vector3D

WIDTH_PROPERTY = "Pset_HomeTwinReveal.WidthMm"


@dataclass(frozen=True)
class CeilingReveal:
    tag: str
    name: str
    start_mm: Point2D
    """Wall face in plan, at the end the run starts from."""
    end_mm: Point2D
    inward_normal: Vector3D
    """The room side of that wall face, from the wall's own IFC geometry."""
    width_mm: float = 70.0
    depth_mm: float = 80.0
    """How far the slot rises above the gypsum, limited by what is over it."""
    led_lip: bool = True
    evidence: str = "owner_reported"

    def __post_init__(self) -> None:
        if not self.tag or not self.name:
            raise ValueError("A ceiling reveal needs a tag and a name")
        if not all(isfinite(v) and v > 0 for v in (self.width_mm, self.depth_mm)):
            raise ValueError("Reveal width and depth must be positive and finite")
        if self.length_mm < 1:
            raise ValueError("A ceiling reveal needs a run to follow")
        if abs(hypot(self.inward_normal.x, self.inward_normal.y) - 1) > 1e-6:
            raise ValueError("The inward normal must be a unit vector in plan")

    @property
    def length_mm(self) -> float:
        return hypot(self.end_mm.x - self.start_mm.x, self.end_mm.y - self.start_mm.y)

    @property
    def centre_mm(self) -> Point2D:
        """Middle of the strip: along the wall, and half its width into the room."""
        offset = self.width_mm / 2
        return Point2D(
            (self.start_mm.x + self.end_mm.x) / 2 + self.inward_normal.x * offset,
            (self.start_mm.y + self.end_mm.y) / 2 + self.inward_normal.y * offset,
        )

    @property
    def bearing_radians(self) -> float:
        return atan2(self.end_mm.y - self.start_mm.y, self.end_mm.x - self.start_mm.x)

    def corners_mm(self) -> tuple[Point2D, ...]:
        along = self.bearing_radians
        half = self.length_mm / 2
        centre = self.centre_mm
        steps = ((cos(along), sin(along)), (-self.inward_normal.y, self.inward_normal.x))
        return tuple(
            Point2D(
                centre.x + steps[0][0] * u * half + self.inward_normal.x * v * self.width_mm / 2,
                centre.y + steps[0][1] * u * half + self.inward_normal.y * v * self.width_mm / 2,
            )
            for u in (-1, 1)
            for v in (-1, 1)
        )


def author_ceiling_reveals(
    model: ifcopenshell.file,
    room_id: str,
    reveals: tuple[CeilingReveal, ...],
    gypsum_elevation_mm: float,
) -> dict[str, str]:
    """Edit a caller-owned private IFC; the caller must validate and save transactionally."""
    if len({reveal.tag for reveal in reveals}) != len(reveals):
        raise ValueError("Ceiling reveal tags must be unique")
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    frame = ifcopenshell.util.placement.get_local_placement(model.by_type("IfcBuilding")[0].ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    room = model.by_guid(room_id)
    wanted = {reveal.tag for reveal in reveals}
    for stale in [
        product
        for product in model.by_type("IfcBuildingElementProxy")
        if str(product.ObjectType or "") == "ceiling_reveal" and product.Tag not in wanted
    ]:
        ifcopenshell.api.run("root.remove_product", model, product=stale)
    ids = {}
    for reveal in reveals:
        matches = [p for p in model.by_type("IfcBuildingElementProxy") if p.Tag == reveal.tag]
        if len(matches) > 1:
            raise ValueError(f"Duplicate reveal tag {reveal.tag}")
        entity = (
            matches[0]
            if matches
            else ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuildingElementProxy")
        )
        entity.Name = reveal.name
        entity.Tag = reveal.tag
        entity.ObjectType = "ceiling_reveal"
        if entity.Representation:
            for rep in list(entity.Representation.Representations):
                ifcopenshell.api.run("geometry.unassign_representation", model, product=entity, representation=rep)
                ifcopenshell.api.run("geometry.remove_representation", model, representation=rep)
        sizes = (reveal.length_mm / unit_mm, reveal.width_mm / unit_mm, reveal.depth_mm / unit_mm)
        solid = box_solid(model, *sizes, 0.0, 0.0, 0.0)
        rep = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
        ifcopenshell.api.run("geometry.assign_representation", model, product=entity, representation=rep)
        angle = reveal.bearing_radians
        matrix = np.eye(4)
        matrix[:2, :2] = ((cos(angle), -sin(angle)), (sin(angle), cos(angle)))
        centre = reveal.centre_mm
        matrix[:3, 3] = np.array([centre.x, centre.y, gypsum_elevation_mm]) / 1000
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=frame @ matrix, is_si=True)
        ifcopenshell.api.run("spatial.assign_container", model, products=[entity], relating_structure=room)
        existing = {
            rel.RelatingPropertyDefinition.Name: rel.RelatingPropertyDefinition
            for rel in entity.IsDefinedBy
            if rel.is_a("IfcRelDefinesByProperties")
        }
        for name, properties in {
            "Pset_HomeTwin": {"ObjectKind": "shadow_gap"},
            "Pset_HomeTwinReveal": {
                "WidthMm": reveal.width_mm,
                "DepthMm": reveal.depth_mm,
                "HasLedLip": reveal.led_lip,
                "StartX": reveal.start_mm.x,
                "StartY": reveal.start_mm.y,
                "EndX": reveal.end_mm.x,
                "EndY": reveal.end_mm.y,
                "Evidence": reveal.evidence,
                "RepresentationMethod": "design_envelope",
            },
        }.items():
            pset = existing.get(name)
            if pset is None:
                pset = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
        ids[reveal.tag] = entity.GlobalId
    return ids


def _validate(twin: HomeTwin, room_id: str, reveals: tuple[CeilingReveal, ...], ids: dict[str, str]) -> None:
    context = twin.get_room_context(room_id)
    gypsum = context.ceiling.elevation_mm
    structural = context.ceiling.structural_elevation_mm
    if structural is None:
        raise ValueError("The room states no structural ceiling, so there is no plenum a reveal can rise into")
    found = {obj.id: obj for obj in context.obstructions}
    for reveal in reveals:
        obj = found.get(ids[reveal.tag])
        if obj is None:
            raise ValueError(f"{reveal.tag} did not read back as a ceiling obstruction")
        a, b = obj.bounds.minimum, obj.bounds.maximum
        if abs(a.z - gypsum) > 0.1:
            raise ValueError(f"{reveal.tag} does not start at the gypsum plane")
        if b.z > structural + 0.1:
            raise ValueError(f"{reveal.tag} rises past the structural ceiling")
        for corner in reveal.corners_mm():
            if not point_in_polygon(corner, context.ceiling.polygon):
                raise ValueError(f"{reveal.tag} leaves the ceiling")
        for other in context.obstructions:
            if other.id == obj.id or other.properties.get(WIDTH_PROPERTY) is not None:
                continue
            c, d = other.bounds.minimum, other.bounds.maximum
            spans = ((a.x, b.x, c.x, d.x), (a.y, b.y, c.y, d.y), (a.z, b.z, c.z, d.z))
            if all(min(hi, other_hi) - max(lo, other_lo) > 1.0 for lo, hi, other_lo, other_hi in spans):
                raise ValueError(f"{reveal.tag} collides with {other.name}")


def save_ceiling_reveals(path: Path, room_id: str, reveals: tuple[CeilingReveal, ...]) -> dict[str, str]:
    """Validate a private clone, reopen its IFC, and atomically publish the reveals."""
    original = path.read_bytes()
    model = ifcopenshell.file.from_string(original.decode())
    gypsum = HomeTwin.open(path).get_room_context(room_id).ceiling.elevation_mm
    ids = author_ceiling_reveals(model, room_id, reveals, gypsum)
    descriptor, name = tempfile.mkstemp(suffix=".ifc", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        model.write(str(temporary))
        _validate(HomeTwin.open(temporary), room_id, reveals, ids)
        if path.read_bytes() != original:
            raise ValueError("Model changed during reveal authoring")
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return ids
