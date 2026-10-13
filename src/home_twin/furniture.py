"""Dining furniture authored as native IFC solids in the building coordinate frame."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from math import isfinite
from pathlib import Path
from typing import Literal

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

from home_twin.geometry import point_in_polygon
from home_twin.model import HomeTwin, Point2D, Point3D

# A stool carries the chair model at counter height, so its seat sits higher up
# the same overall envelope: 0.6 of a 1000 mm stool is a 645 mm seat, the usual
# 255 mm drop from a 900 mm worktop. IfcFurnitureType has no STOOL, so a stool is
# a CHAIR with the stool role recorded in Pset_HomeTwinFurniture.
_SEAT_RATIO = {"chair": 0.525, "stool": 0.6}
_ENTITY_NAMES = {"table": "Dining table", "chair": "Dining chair", "stool": "Breakfast bar stool"}
# Every piece points its local +Y along bearing_deg, counter-clockwise from building
# +X: a chair faces that way, a table runs its long axis and its extension leaves
# that way. buildingSMART names no such property, so it is recorded as
# Pset_HomeTwinFurniture.BearingDeg and `facing` stays the shorthand for the four
# cardinal cases.
_CARDINAL_BEARING_DEG = {"north": 90.0, "east": 0.0, "south": 270.0, "west": 180.0}


@dataclass(frozen=True)
class DiningFurniture:
    tag: str
    role: Literal["table", "chair", "stool"]
    centre_mm: Point3D
    width_mm: float
    depth_mm: float
    height_mm: float
    facing: Literal["north", "east", "south", "west"] = "north"
    shape: Literal["rounded_rectangle", "round", "oval"] = "rounded_rectangle"
    extended_depth_mm: float | None = None
    closed_depth_mm: float | None = None
    bearing_deg: float | None = None
    # Where a seat stands when the table is closed. A closed table is shorter, so
    # it seats fewer people: a chair with no closed pose is stowed, not moved.
    closed_centre_mm: Point3D | None = None
    closed_bearing_deg: float | None = None
    closed_seat: bool | None = None

    @property
    def bearing(self) -> float:
        """The plan direction of local +Y, degrees counter-clockwise from building +X."""
        if self.bearing_deg is None:
            return _CARDINAL_BEARING_DEG[self.facing]
        return self.bearing_deg % 360

    def __post_init__(self) -> None:
        if not self.tag or self.role not in _SEAT_RATIO.keys() | {"table"}:
            raise ValueError("Dining furniture requires a tag and a table/chair/stool role")
        if self.facing not in {"north", "east", "south", "west"}:
            raise ValueError("Unknown furniture facing")
        if self.shape not in {"rounded_rectangle", "round", "oval"}:
            raise ValueError("Unknown table shape")
        if self.shape == "round" and (self.role != "table" or self.width_mm != self.depth_mm):
            raise ValueError("Round tables require equal width and depth")
        if self.shape == "oval" and (self.role != "table" or self.depth_mm <= self.width_mm):
            raise ValueError("Oval tables run their long axis along depth")
        if self.bearing_deg is not None and (not isfinite(self.bearing_deg) or self.facing != "north"):
            raise ValueError("A bearing replaces facing; leave facing at its default")
        if self.role == "table" and (self.closed_centre_mm is not None or self.closed_seat is not None):
            raise ValueError("A closed pose belongs to a seat, not to the table")
        if (self.closed_centre_mm is None) != (self.closed_bearing_deg is None):
            raise ValueError("A closed pose needs both a centre and a bearing")
        if self.closed_centre_mm is not None and not all(
            isfinite(value) for value in (self.closed_centre_mm.x, self.closed_centre_mm.y, self.closed_bearing_deg)
        ):
            raise ValueError("A closed pose must be finite")
        if self.closed_seat is False and self.closed_centre_mm is not None:
            raise ValueError("A stowed seat has no closed pose")
        if self.extended_depth_mm is not None and (
            self.role != "table" or not isfinite(self.extended_depth_mm) or self.extended_depth_mm <= self.depth_mm
        ):
            raise ValueError("Extension must be longer than the closed table")
        # A table may be drawn closed and carry its open size, or drawn open and
        # carry the size it closes back to. Both at once would be contradictory.
        if self.closed_depth_mm is not None and (
            self.role != "table"
            or self.extended_depth_mm is not None
            or not isfinite(self.closed_depth_mm)
            or self.closed_depth_mm >= self.depth_mm
        ):
            raise ValueError("A closed size must be shorter than the table as drawn")
        dimensions = (self.width_mm, self.depth_mm, self.height_mm)
        if not all(isfinite(value) and value >= 300 for value in dimensions):
            raise ValueError("Dining furniture dimensions must be finite and at least 300 mm")
        if not all(isfinite(value) for value in (self.centre_mm.x, self.centre_mm.y, self.centre_mm.z)):
            raise ValueError("Furniture position must be finite")


def disc_solid(model, diameter: float, x: float, y: float, z: float, height: float):
    position = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((x, y, z)))
    profile = model.createIfcCircleProfileDef("AREA", None, None, diameter / 2)
    return model.createIfcExtrudedAreaSolid(profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), height)


def _outline_parts(item: DiningFurniture) -> tuple[tuple[float, float, float, float, float], ...]:
    """(x, y, width, depth, corner radius) for each solid that can reach the plan
    outline, mirroring what author_dining_furniture builds. A chair's back rail has
    sharper corners than its seat, so it, not the seat, sets the extent on that side
    once the chair is turned off a cardinal bearing."""
    w, d = item.width_mm, item.depth_mm
    if item.role == "table":
        radius = w / 2 if item.shape in {"round", "oval"} else min(w, d) * 0.18
        return ((0.0, 0.0, w, d, radius),)
    return (
        (0.0, 0.0, w, d, 65.0),
        (0.0, -d / 2 + 27.5, w, 55.0, 20.0),
        (0.0, 0.0, w - 65, d - 65, 15.0),
    )


def _expected_plan_bounds(item: DiningFurniture) -> tuple[float, float, float, float]:
    """A rounded outline is an inner rectangle swelled by its radius, so under
    rotation its extent is that rectangle's extent plus the radius. That covers a
    circle and a stadium too, where the inner rectangle degenerates to a point or
    a line."""
    angle = np.radians(item.bearing - 90)
    cos, sin = np.cos(angle), np.sin(angle)
    spans = []
    for x, y, width, depth, radius in _outline_parts(item):
        half_x, half_y = width / 2 - radius, depth / 2 - radius
        centre = (x * cos - y * sin, x * sin + y * cos)
        reach = (
            abs(half_x * cos) + abs(half_y * sin) + radius,
            abs(half_x * sin) + abs(half_y * cos) + radius,
        )
        spans.append((centre[0] - reach[0], centre[1] - reach[1], centre[0] + reach[0], centre[1] + reach[1]))
    return (
        min(s[0] for s in spans),
        min(s[1] for s in spans),
        max(s[2] for s in spans),
        max(s[3] for s in spans),
    )


def containing_room(product: ifcopenshell.entity_instance) -> str | None:
    """The ``IfcSpace`` a product is filed under, or None if it is filed higher up."""
    for relation in getattr(product, "ContainedInStructure", ()) or ():
        structure = getattr(relation, "RelatingStructure", None)
        if structure is not None and structure.is_a("IfcSpace"):
            return structure.GlobalId
    return None


def check_tags_are_free(model: ifcopenshell.file, rooms_by_tag: dict[str, str]) -> None:
    """Refuse a tag that already labels a fitting somewhere else in the model.

    A tag is an installation label, so a second MIR01 is not a second mirror.
    Authoring matches on the tag and reuses what it finds, so the bedroom's
    MIR01 became the bathroom's mirror and the bathroom silently lost its own.
    Checking uniqueness within a room cannot catch it: the fitting it displaces
    is in a different one.
    """
    for product in model.by_type("IfcProduct"):
        tag = getattr(product, "Tag", None)
        if tag not in rooms_by_tag:
            continue
        if containing_room(product) != rooms_by_tag[tag]:
            raise RuntimeError(f"{tag} already labels {product.Name}; an installation tag names one fitting")


def box_solid(model, width: float, depth: float, height: float, x: float, y: float, z: float, radius: float = 0):
    position = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((x, y, z)))
    profile = (
        model.createIfcRoundedRectangleProfileDef("AREA", None, None, width, depth, radius)
        if radius
        else (model.createIfcRectangleProfileDef("AREA", None, None, width, depth))
    )
    return model.createIfcExtrudedAreaSolid(profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), height)


def author_dining_furniture(
    model: ifcopenshell.file,
    room_id: str,
    items: tuple[DiningFurniture, ...],
) -> dict[str, str]:
    """Edit a caller-owned private IFC; the caller must validate and save transactionally."""
    if len({item.tag for item in items}) != len(items):
        raise ValueError("Dining tags must be unique")
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    building = model.by_type("IfcBuilding")[0]
    frame = ifcopenshell.util.placement.get_local_placement(building.ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    room = model.by_guid(room_id)
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    ids = {}
    for item in items:
        matches = [f for f in model.by_type("IfcFurniture") if f.Tag == item.tag]
        if len(matches) > 1:
            raise ValueError(f"Duplicate furniture tag {item.tag}")
        entity = (
            matches[0]
            if matches
            else ifcopenshell.api.run(
                "root.create_entity",
                model,
                ifc_class="IfcFurniture",
                predefined_type="TABLE" if item.role == "table" else "CHAIR",
                name=f"{_ENTITY_NAMES[item.role]} {item.tag}",
            )
        )
        entity.Tag = item.tag
        if entity.Representation:
            for rep in list(entity.Representation.Representations):
                ifcopenshell.api.run("geometry.unassign_representation", model, product=entity, representation=rep)
                ifcopenshell.api.run("geometry.remove_representation", model, representation=rep)
        w, d, h = item.width_mm, item.depth_mm, item.height_mm
        parts = []

        def part(width, depth, height, x, y, z, radius=0, parts=parts):
            parts.append(box_solid(model, *(v / unit_mm for v in (width, depth, height, x, y, z, radius))))

        if item.role == "table":
            if item.shape == "oval":
                # A stadium, as a slab between two half-round ends. A rounded
                # rectangle whose radius is half its width is degenerate and
                # IfcOpenShell drops the solid.
                part(w, d - w, 35, 0, 0, h - 35)
                for end in (-(d - w) / 2, (d - w) / 2):
                    parts.append(
                        disc_solid(model, *(v / unit_mm for v in (w, 0.0, end, h - 35, 35)))
                    )
            elif item.shape == "round":
                parts.append(disc_solid(model, *(v / unit_mm for v in (w, 0.0, 0.0, h - 35, 35))))
            else:
                part(w, d, 35, 0, 0, h - 35, min(w, d) * 0.18)
            if item.shape in {"round", "oval"}:
                # A pedestal, not corner posts. You sit all the way round a round
                # or oval table, and a corner post stands exactly where a chair
                # tucks: it stops the seat 250 mm short of the top.
                spine = (d - w) / 2
                for y in sorted({-spine, spine}):
                    parts.append(disc_solid(model, *(v / unit_mm for v in (w * 0.45, 0.0, y, 0.0, 40))))
                    parts.append(disc_solid(model, *(v / unit_mm for v in (w * 0.18, 0.0, y, 40, h - 75))))
            else:
                for x in (-w * 0.27, w * 0.27):
                    for y in (-d * 0.27, d * 0.27):
                        part(60, 60, h - 35, x, y, 0, 25)
        else:
            seat_z = h * _SEAT_RATIO[item.role]
            part(w, d, 45, 0, 0, seat_z, 65)
            part(w, 55, h - seat_z - 45, 0, -d / 2 + 27.5, seat_z + 45, 20)
            for x in (-w / 2 + 50, w / 2 - 50):
                for y in (-d / 2 + 50, d / 2 - 50):
                    part(35, 35, seat_z, x, y, 0, 15)
        rep = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", parts)
        ifcopenshell.api.run("geometry.assign_representation", model, product=entity, representation=rep)
        rotation = np.radians(item.bearing - 90)
        matrix = np.eye(4)
        matrix[:2, :2] = ((np.cos(rotation), -np.sin(rotation)), (np.sin(rotation), np.cos(rotation)))
        matrix[:3, 3] = np.array([item.centre_mm.x, item.centre_mm.y, item.centre_mm.z]) / 1000
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=frame @ matrix, is_si=True)
        ifcopenshell.api.run("spatial.assign_container", model, products=[entity], relating_structure=room)
        existing_psets = {
            rel.RelatingPropertyDefinition.Name: rel.RelatingPropertyDefinition
            for rel in entity.IsDefinedBy
            if rel.is_a("IfcRelDefinesByProperties")
        }
        for name, properties in {
            "Pset_HomeTwin": {"ObjectKind": "furniture"},
            "Pset_HomeTwinFurniture": {
                "Role": item.role,
                "Facing": None if item.bearing_deg is not None else item.facing,
                "BearingDeg": item.bearing,
                "Finish": "oak_linen",
                "Shape": item.shape,
                "WidthMm": item.width_mm,
                "DepthMm": item.depth_mm,
                "ExtendedDepthMm": item.extended_depth_mm,
                "ClosedDepthMm": item.closed_depth_mm,
                "ClosedSeat": item.closed_seat,
                "ClosedCentreXMm": None if item.closed_centre_mm is None else item.closed_centre_mm.x,
                "ClosedCentreYMm": None if item.closed_centre_mm is None else item.closed_centre_mm.y,
                "ClosedBearingDeg": item.closed_bearing_deg,
            },
        }.items():
            pset = existing_psets.get(name)
            if pset is None:
                pset = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
        ids[item.tag] = entity.GlobalId
    return ids


def save_dining_furniture(path: Path, room_id: str, items: tuple[DiningFurniture, ...]) -> dict[str, str]:
    """Validate a private clone, reopen its IFC, and atomically publish the dining set."""
    original = path.read_bytes()
    model = ifcopenshell.file.from_string(original.decode())
    check_tags_are_free(model, {item.tag: room_id for item in items})
    ids = author_dining_furniture(model, room_id, items)
    descriptor, name = tempfile.mkstemp(suffix=".ifc", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        model.write(str(temporary))
        reopened = HomeTwin.open(temporary)
        context = reopened.get_room_context(room_id)
        furniture = {f.id: f for f in context.furniture}
        building_frame = ifcopenshell.util.placement.get_local_placement(
            model.by_type("IfcBuilding")[0].ObjectPlacement,
        )
        building_frame[:3, 3] *= ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
        for item in items:
            obj = furniture[ids[item.tag]]
            a, b = obj.bounds.minimum, obj.bounds.maximum
            low_x, low_y, high_x, high_y = _expected_plan_bounds(item)
            corners = np.array(
                [
                    building_frame @ np.array([item.centre_mm.x + x, item.centre_mm.y + y, item.centre_mm.z + z, 1])
                    for x in (low_x, high_x)
                    for y in (low_y, high_y)
                    for z in (0, item.height_mm)
                ]
            )[:, :3]
            expected = np.concatenate((corners.min(axis=0), corners.max(axis=0)))
            actual = (a.x, a.y, a.z, b.x, b.y, b.z)
            # A curve is saved as chords, so its extent falls a fraction inside the
            # true outline; a square-cornered box is exact.
            curved = item.shape in {"round", "oval"} or item.role != "table"
            if not np.allclose(actual, expected, atol=2.0 if curved else 0.1, rtol=0):
                raise ValueError(f"Saved furniture dimensions differ for {item.tag}: {actual} vs {tuple(expected)}")
            if any(
                not point_in_polygon(Point2D(x, y), context.ceiling.polygon) for x in (a.x, b.x) for y in (a.y, b.y)
            ):
                raise ValueError(f"{item.tag} is outside the room")
            if abs(a.z - context.room.elevation_mm) > 0.1:
                raise ValueError(f"{item.tag} is not on the room floor")
        if path.read_bytes() != original:
            raise ValueError("Model changed during furniture authoring")
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


@dataclass(frozen=True)
class StorageFurniture:
    tag: str
    role: Literal["media_unit", "drinks_unit"]
    centre_mm: Point3D
    width_mm: float
    depth_mm: float
    height_mm: float

    def __post_init__(self) -> None:
        if not self.tag or self.role not in {"media_unit", "drinks_unit"}:
            raise ValueError("Unknown storage furniture")
        if not all(isfinite(v) and v > 0 for v in (self.width_mm, self.depth_mm, self.height_mm)):
            raise ValueError("Storage dimensions must be positive and finite")
        if not all(isfinite(v) for v in (self.centre_mm.x, self.centre_mm.y, self.centre_mm.z)):
            raise ValueError("Storage position must be finite")


def author_storage_furniture(
    model: ifcopenshell.file, room_id: str, items: tuple[StorageFurniture, ...]
) -> dict[str, str]:
    """Author native storage envelopes in a caller-owned private IFC transaction."""
    if len({item.tag for item in items}) != len(items):
        raise ValueError("Storage tags must be unique")
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    frame = ifcopenshell.util.placement.get_local_placement(model.by_type("IfcBuilding")[0].ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    ids = {}
    for item in items:
        matches = [f for f in model.by_type("IfcFurniture") if f.Tag == item.tag]
        if len(matches) > 1:
            raise ValueError(f"Duplicate storage tag {item.tag}")
        entity = matches[0] if matches else ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcFurniture")
        entity.Name = "Floating TV media console" if item.role == "media_unit" else "Drinks cabinet"
        entity.Tag = item.tag
        entity.PredefinedType = "USERDEFINED"
        entity.ObjectType = item.role
        if entity.Representation:
            for rep in list(entity.Representation.Representations):
                ifcopenshell.api.run("geometry.unassign_representation", model, product=entity, representation=rep)
                ifcopenshell.api.run("geometry.remove_representation", model, representation=rep)
        sizes = (item.width_mm / unit_mm, item.depth_mm / unit_mm, item.height_mm / unit_mm)
        solid = box_solid(model, *sizes, 0.0, 0.0, 0.0)
        rep = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
        ifcopenshell.api.run("geometry.assign_representation", model, product=entity, representation=rep)
        matrix = np.eye(4)
        matrix[:3, 3] = np.array([item.centre_mm.x, item.centre_mm.y, item.centre_mm.z]) / 1000
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=frame @ matrix, is_si=True)
        ifcopenshell.api.run(
            "spatial.assign_container", model, products=[entity], relating_structure=model.by_guid(room_id)
        )
        existing = {
            rel.RelatingPropertyDefinition.Name: rel.RelatingPropertyDefinition
            for rel in entity.IsDefinedBy
            if rel.is_a("IfcRelDefinesByProperties")
        }
        for name, properties in {
            "Pset_HomeTwin": {"ObjectKind": "cabinet"},
            "Pset_HomeTwinFurniture": {
                "Role": item.role,
                "Finish": "walnut",
                "RepresentationMethod": "design_envelope",
            },
        }.items():
            pset = existing.get(name)
            if pset is None:
                pset = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
        ids[item.tag] = entity.GlobalId
    return ids
