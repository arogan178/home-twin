"""Typed sanitary fixtures, joinery, extract fans and ducting authored into IFC.

Every item is a design envelope placed in the building frame. ``centre_mm`` is
the plan centre with ``z`` at the underside; a duct is the exception and is
described by its centreline route. The front of a unit is its local ``-Y`` face
and ``rotation_deg`` turns it anticlockwise on plan, so a vanity against a west
wall carries ``rotation_deg=90`` to face east.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from math import cos, isfinite, radians, sin
from pathlib import Path
from typing import Literal

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

from home_twin.furniture import box_solid, check_tags_are_free, disc_solid
from home_twin.geometry import point_in_polygon, point_segment_distance, polygon_edge_distance
from home_twin.model import BuildingObject, HomeTwin, ObjectKind, Point2D, Point3D, RoomContext

WetRoomRole = Literal[
    "bath",
    "shower",
    "toilet",
    "basin",
    "tap",
    "mirror",
    "vanity",
    "tall_cupboard",
    "ledge",
    "extractor",
    "duct",
    "exhaust_terminal",
    "gully",
]

_ROLES = frozenset(WetRoomRole.__args__)
# Items that live in the void between the gypsum and the slab.
_VOID_ROLES = frozenset(("duct", "exhaust_terminal"))
# A drain is set into the floor, so its body is below the finished level by
# definition. Judging it against the room's floor rejects every correct one.
_RECESSED_ROLES = frozenset(("gully",))
# Joinery a spotlight must keep clear of. A vanity is not one: the only ceiling
# position that lights the front of a face is over the bowl, so it stays
# furniture -- an occluder, but one a fitting may sit above on purpose.
_CABINET_ROLES = frozenset(("tall_cupboard", "ledge"))
# Drawn as a plain box of the stated size. A grate is one; without this a gully
# falls through to the wall-core cylinder and stands 120 mm proud of the paving.
_BOX_ROLES = _CABINET_ROLES | {"vanity", "gully"}
_EXPECTED_KIND = {
    "vanity": ObjectKind.FURNITURE,
    "extractor": ObjectKind.EXTRACTOR,
    "exhaust_terminal": ObjectKind.EXTRACTOR,
    "duct": ObjectKind.DUCT,
    "mirror": ObjectKind.FURNITURE,
    **{role: ObjectKind.CABINET for role in _CABINET_ROLES},
}
# (IFC class, predefined type). USERDEFINED entities carry ``wet_room_<role>``
# as ObjectType because IFC4 has no enumeration for a vanity or a tiled ledge.
_IFC_TYPE = {
    "bath": ("IfcSanitaryTerminal", "BATH"),
    "shower": ("IfcSanitaryTerminal", "SHOWER"),
    "toilet": ("IfcSanitaryTerminal", "TOILETPAN"),
    "basin": ("IfcSanitaryTerminal", "WASHHANDBASIN"),
    "tap": ("IfcValve", "FAUCET"),
    "mirror": ("IfcFurniture", "USERDEFINED"),
    "vanity": ("IfcFurniture", "USERDEFINED"),
    "tall_cupboard": ("IfcFurniture", "USERDEFINED"),
    "ledge": ("IfcBuildingElementProxy", "USERDEFINED"),
    "extractor": ("IfcFan", "NOTDEFINED"),
    # Flexible, which is what this installation uses. It is over the 1.5 m a
    # flexible run is capped at, and sag costs more pressure than the extra
    # length does, so the route is kept straight and the support interval is
    # part of the specification. See docs/wet-room-review-2026-09.md.
    "duct": ("IfcDuctSegment", "FLEXIBLESEGMENT"),
    "exhaust_terminal": ("IfcAirTerminal", "GRILLE"),
    # A yard drainage gully. This module is named for its first use, but a
    # trapped floor drain and an outdoor tap are the same domain as a basin.
    "gully": ("IfcWasteTerminal", "GULLYTRAP"),
}
PSET = "Pset_HomeTwinWetRoom"


@dataclass(frozen=True, slots=True)
class WetRoomFixture:
    tag: str
    room_id: str
    role: WetRoomRole
    centre_mm: Point3D
    """Plan centre; ``z`` is the underside. A duct's centre is its first route point."""
    width_mm: float
    """Along the front face; the diameter of a round basin, tap body, duct or core."""
    depth_mm: float
    """Front to back; a tap's spout reach, a wall core's length through the wall."""
    height_mm: float
    airflow_lps: float | None = None
    rotation_deg: float = 0.0
    """Anticlockwise on plan. The front is the local ``-Y`` face."""
    finish: str | None = None
    """A material name such as ``grey_marble``; a display and specification hint."""
    route_mm: tuple[Point3D, ...] = ()
    """A duct's centreline, two or more points, in the building frame."""
    backlight_cct_kelvin: int | None = None
    """A backlit mirror's colour temperature. It is not part of the lux estimate."""
    product: str | None = None
    """The chosen product, such as ``GROHE Euroeco XL 24273001``.

    Geometry stays a design envelope: naming a product does not mean its
    published dimensions were used, and where they differ the envelope is the
    approximation. Recorded so a decision survives outside these documents.
    """

    def __post_init__(self) -> None:
        if not self.tag or not self.room_id:
            raise ValueError("A wet-room fixture needs a tag and IFC room id")
        if self.role not in _ROLES:
            raise ValueError("Unknown wet-room fixture role")
        values = (
            self.centre_mm.x,
            self.centre_mm.y,
            self.centre_mm.z,
            self.width_mm,
            self.depth_mm,
            self.height_mm,
            self.rotation_deg,
        )
        if not all(isfinite(value) for value in values) or min(self.width_mm, self.depth_mm, self.height_mm) <= 0:
            raise ValueError("Wet-room fixture geometry must be finite and positive")
        if (self.role == "extractor") != (self.airflow_lps is not None):
            raise ValueError("Only an extractor carries a design airflow")
        if self.airflow_lps is not None and (not isfinite(self.airflow_lps) or self.airflow_lps <= 0):
            raise ValueError("Extractor airflow must be positive")
        if (self.role == "duct") != (len(self.route_mm) >= 2):
            raise ValueError("A duct needs a route of two or more points, and only a duct has one")
        if self.role == "duct" and self.route_mm[0] != self.centre_mm:
            raise ValueError("A duct's centre is the first point of its route")
        if self.backlight_cct_kelvin is not None and self.role != "mirror":
            raise ValueError("Only a mirror carries a backlight colour temperature")
        if self.product is not None and not self.product.strip():
            raise ValueError("A named product cannot be blank")

    @property
    def object_kind(self) -> str | None:
        return "cabinet" if self.role in _CABINET_ROLES else None


def _perpendicular(direction: np.ndarray) -> np.ndarray:
    reference = np.array([0.0, 0.0, 1.0]) if abs(direction[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    side = np.cross(direction, reference)
    return side / np.linalg.norm(side)


def _cylinder_between(model, start: np.ndarray, end: np.ndarray, diameter: float):
    """A round straight run from ``start`` to ``end`` in local coordinates."""
    axis = end - start
    length = float(np.linalg.norm(axis))
    axis = axis / length
    position = model.createIfcAxis2Placement3D(
        model.createIfcCartesianPoint(tuple(float(v) for v in start)),
        model.createIfcDirection(tuple(float(v) for v in axis)),
        model.createIfcDirection(tuple(float(v) for v in _perpendicular(axis))),
    )
    profile = model.createIfcCircleProfileDef("AREA", None, None, diameter / 2)
    return model.createIfcExtrudedAreaSolid(profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), length)


def _vertical_plate(model, width: float, height: float, depth: float, z: float):
    """A round or oval plate standing in the local XZ plane, centred on the local origin."""
    position = model.createIfcAxis2Placement3D(
        model.createIfcCartesianPoint((0.0, -depth / 2, z + height / 2)),
        model.createIfcDirection((0.0, 1.0, 0.0)),
        model.createIfcDirection((1.0, 0.0, 0.0)),
    )
    profile = (
        model.createIfcCircleProfileDef("AREA", None, None, width / 2)
        if abs(width - height) < 1e-9
        else model.createIfcEllipseProfileDef("AREA", None, None, width / 2, height / 2)
    )
    return model.createIfcExtrudedAreaSolid(profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), depth)


def _items(model: ifcopenshell.file, item: WetRoomFixture, unit_mm: float) -> list[ifcopenshell.entity_instance]:
    w, d, h = item.width_mm, item.depth_mm, item.height_mm

    def box(width: float, depth: float, height: float, x: float, y: float, z: float, radius: float = 0):
        return box_solid(model, *(value / unit_mm for value in (width, depth, height, x, y, z, radius)))

    def disc(diameter: float, x: float, y: float, z: float, height: float):
        return disc_solid(model, *(value / unit_mm for value in (diameter, x, y, z, height)))

    if item.role == "bath":
        rim, base = 70.0, 100.0
        return [
            box(w, d, base, 0, 0, 0, 45),
            box(w, rim, h - base, 0, -(d - rim) / 2, base, 28),
            box(w, rim, h - base, 0, (d - rim) / 2, base, 28),
            box(rim, d - rim * 2, h - base, -(w - rim) / 2, 0, base, 28),
            box(rim, d - rim * 2, h - base, (w - rim) / 2, 0, base, 28),
        ]
    if item.role == "shower":
        return [
            box(w, d, 70, 0, 0, 0, 30),
            box(w / 2, 12, h - 70, -w / 4, -(d - 12) / 2, 70),
            box(w / 2, 12, h - 70, w / 4, -(d - 36) / 2, 70),
            box(w, 24, 24, 0, -(d - 24) / 2, h - 24),
            box(24, 24, h * 0.58, -w / 2 + 40, 0, h * 0.32),
            box(260, 24, 24, -w / 2 + 158, 0, h * 0.9 - 24),
            disc(200, -w / 2 + 276, 0, h * 0.88 - 18, 18),
        ]
    if item.role == "toilet":
        pan_h = h * 0.53
        cist_d = d * 0.26
        cist_w = w * 0.97
        pan_w = w * 0.95
        rear_d = cist_d + 60.0
        bowl_d = d - cist_d + 10.0
        bowl_y = d / 2 - bowl_d / 2
        seat_d = d - cist_d + 20.0
        seat_y = d / 2 - seat_d / 2
        return [
            box(pan_w, rear_d, pan_h, 0.0, -d / 2 + rear_d / 2, 0.0, 15.0),
            box(pan_w, bowl_d, pan_h, 0.0, bowl_y, 0.0, 100.0),
            box(pan_w + 6.0, seat_d, 30.0, 0.0, seat_y, pan_h, 105.0),
            box(cist_w, cist_d, h - pan_h, 0.0, -d / 2 + cist_d / 2, pan_h, 20.0),
            disc(50.0, 0.0, -d / 2 + cist_d / 2, h, 4.0),
        ]
    if item.role == "basin":
        return [disc(w, 0, 0, 0, h)]
    if item.role == "tap":
        # A tall standing mixer: a round body with the spout reaching forward at the top.
        spout = w * 0.5
        return [disc(w, 0, 0, 0, h), box(spout, d, spout, 0, -d / 2, h - spout)]
    if item.role == "mirror":
        return [_vertical_plate(model, w / unit_mm, h / unit_mm, d / unit_mm, 0.0)]
    if item.role in _BOX_ROLES:
        return [box(w, d, h, 0, 0, 0)]
    if item.role == "extractor":
        return [disc(w, 0, 0, 0, h)]
    if item.role == "duct":
        origin = np.array([item.centre_mm.x, item.centre_mm.y, item.centre_mm.z])
        points = [(np.array([p.x, p.y, p.z]) - origin) / unit_mm for p in item.route_mm]
        return [_cylinder_between(model, a, b, w / unit_mm) for a, b in zip(points, points[1:], strict=False)]
    # A core through the wall: a round run from the wall face into the wall along local +Y.
    start = np.array([0.0, 0.0, h / 2]) / unit_mm
    end = np.array([0.0, d, h / 2]) / unit_mm
    return [_cylinder_between(model, start, end, w / unit_mm)]


def author_wet_room_fixtures(
    model: ifcopenshell.file,
    fixtures: tuple[WetRoomFixture, ...],
) -> dict[str, str]:
    """Edit a private IFC clone. The caller owns validation and publication."""
    if len({item.tag for item in fixtures}) != len(fixtures):
        raise ValueError("Wet-room fixture tags must be unique")
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    building = model.by_type("IfcBuilding")[0]
    frame = ifcopenshell.util.placement.get_local_placement(building.ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    ids: dict[str, str] = {}

    for item in fixtures:
        ifc_class, predefined_type = _IFC_TYPE[item.role]
        matches = [product for product in model.by_type(ifc_class) if getattr(product, "Tag", None) == item.tag]
        if len(matches) > 1:
            raise ValueError(f"Duplicate fixture tag {item.tag}")
        entity = (
            matches[0]
            if matches
            else ifcopenshell.api.run(
                "root.create_entity",
                model,
                ifc_class=ifc_class,
                predefined_type=predefined_type,
                name=f"{item.role.replace('_', ' ').title()} {item.tag}",
            )
        )
        entity.Tag = item.tag
        if predefined_type == "USERDEFINED":
            entity.ObjectType = f"wet_room_{item.role}"
        if entity.Representation:
            for representation in list(entity.Representation.Representations):
                ifcopenshell.api.run(
                    "geometry.unassign_representation",
                    model,
                    product=entity,
                    representation=representation,
                )
                ifcopenshell.api.run("geometry.remove_representation", model, representation=representation)
        representation = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", _items(model, item, unit_mm))
        ifcopenshell.api.run("geometry.assign_representation", model, product=entity, representation=representation)
        angle = radians(item.rotation_deg)
        matrix = np.eye(4)
        matrix[:2, :2] = ((cos(angle), -sin(angle)), (sin(angle), cos(angle)))
        matrix[:3, 3] = np.array([item.centre_mm.x, item.centre_mm.y, item.centre_mm.z]) / 1000
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=frame @ matrix, is_si=True)
        room = model.by_guid(item.room_id)
        ifcopenshell.api.run("spatial.assign_container", model, products=[entity], relating_structure=room)
        existing = {
            relation.RelatingPropertyDefinition.Name: relation.RelatingPropertyDefinition
            for relation in entity.IsDefinedBy
            if relation.is_a("IfcRelDefinesByProperties")
        }
        psets: dict[str, dict[str, object]] = {
            PSET: {
                "Role": item.role,
                "RepresentationMethod": "design_envelope",
                "RotationDegrees": item.rotation_deg,
                "Finish": item.finish,
                "DesignAirflowLps": item.airflow_lps,
                "RouteMm": ";".join(f"{p.x:g},{p.y:g},{p.z:g}" for p in item.route_mm) or None,
                "BacklightCctKelvin": item.backlight_cct_kelvin,
                "Product": item.product,
                "WetZoneElectricalCompliance": (
                    "unverified" if item.role in {"extractor", "mirror"} else None
                ),
            }
        }
        # Written whenever the entity already carries one, so that a role which
        # stops being a cabinet clears its stale kind instead of keeping it.
        if item.object_kind is not None or "Pset_HomeTwin" in existing:
            psets["Pset_HomeTwin"] = {"ObjectKind": item.object_kind}
        for name, properties in psets.items():
            pset = existing.get(name)
            if pset is None:
                pset = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
        ids[item.tag] = entity.GlobalId
    return ids


def _inside_or_on_edge(point: Point2D, context: RoomContext, tolerance_mm: float = 1.0) -> bool:
    polygon = context.ceiling.polygon
    return point_in_polygon(point, polygon) or polygon_edge_distance(point, polygon) <= tolerance_mm


def _footprint_points(obj: BuildingObject) -> tuple[Point2D, ...]:
    if obj.plan_footprint is not None:
        return obj.plan_footprint.outer
    a, b = obj.bounds.minimum, obj.bounds.maximum
    return tuple(Point2D(x, y) for x in (a.x, b.x) for y in (a.y, b.y))


# Pairs whose boxes overlap on purpose: a tap's spout reaches over the bowl it
# fills, and a duct pushes onto the fan spigot and into the wall core.
_DESIGNED_OVERLAPS = frozenset(
    (frozenset(("tap", "basin")), frozenset(("duct", "extractor")), frozenset(("duct", "exhaust_terminal")))
)


def _shares_envelope_by_design(first: BuildingObject, second: BuildingObject) -> bool:
    roles = frozenset((first.properties.get(f"{PSET}.Role"), second.properties.get(f"{PSET}.Role")))
    return roles in _DESIGNED_OVERLAPS


def _collides(first: BuildingObject, second: BuildingObject) -> bool:
    if _shares_envelope_by_design(first, second):
        return False
    a, b = first.bounds, second.bounds
    return all(
        min(high_a, high_b) - max(low_a, low_b) > 1.0
        for low_a, high_a, low_b, high_b in (
            (a.minimum.x, a.maximum.x, b.minimum.x, b.maximum.x),
            (a.minimum.y, a.maximum.y, b.minimum.y, b.maximum.y),
            (a.minimum.z, a.maximum.z, b.minimum.z, b.maximum.z),
        )
    )


def _check_saved(
    item: WetRoomFixture, saved: BuildingObject, context: RoomContext, others: list[BuildingObject]
) -> None:
    expected_kind = _EXPECTED_KIND.get(item.role, ObjectKind.SANITARY_FIXTURE)
    if saved.kind != expected_kind:
        raise RuntimeError(f"{item.tag} reopened as {saved.kind}, expected {expected_kind}")
    floor = context.room.elevation_mm
    ceiling = context.ceiling.elevation_mm
    structural = context.ceiling.structural_elevation_mm
    bottom, top = saved.bounds.minimum.z, saved.bounds.maximum.z

    if item.role == "exhaust_terminal":
        centre = Point2D(item.centre_mm.x, item.centre_mm.y)
        if min(point_segment_distance(centre, wall.start, wall.end) for wall in context.walls) > 1.0:
            raise RuntimeError(f"{item.tag} must start on a wall face of its room")
    elif item.role == "duct":
        if not all(_inside_or_on_edge(Point2D(p.x, p.y), context) for p in item.route_mm):
            raise RuntimeError(f"{item.tag} route leaves its room")
    elif not all(_inside_or_on_edge(point, context) for point in _footprint_points(saved)):
        raise RuntimeError(f"{item.tag} footprint is outside its room")

    if item.role in _VOID_ROLES:
        if structural is None:
            raise RuntimeError(f"{item.tag} sits in the ceiling void, but the room states no structural ceiling")
        if bottom < ceiling - 1 or top > structural + 1:
            raise RuntimeError(f"{item.tag} is outside the void between the ceiling and the slab")
    elif item.role in _RECESSED_ROLES:
        if top > floor + 1:
            raise RuntimeError(
                f"{item.tag} is a drain and must not stand above the floor: top {top:.0f}, floor {floor:.0f}"
            )
    else:
        limit = structural if item.role == "extractor" and structural is not None else ceiling
        if bottom < floor - 1 or top > limit + 1:
            raise RuntimeError(f"{item.tag} is outside the room's vertical extent")

    for other in others:
        if other.id != saved.id and _collides(saved, other):
            raise RuntimeError(f"{item.tag} collides with {other.name}")


def save_wet_room_fixtures(path: Path, fixtures: tuple[WetRoomFixture, ...]) -> dict[str, str]:
    """Validate a private clone, reopen it, then atomically publish the fixtures."""
    path = path.resolve()
    original = path.read_bytes()
    model = ifcopenshell.file.from_string(original.decode())
    check_tags_are_free(model, {item.tag: item.room_id for item in fixtures})
    ids = author_wet_room_fixtures(model, fixtures)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".ifc", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        model.write(str(temporary))
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        reopened = HomeTwin.open(temporary)
        rooms = {room.id: reopened.get_room_context(room.id) for room in reopened.get_rooms()}
        for item in fixtures:
            context = rooms[item.room_id]
            objects = [*context.furniture, *context.obstructions]
            saved = next((obj for obj in objects if obj.id == ids[item.tag]), None)
            if saved is None:
                raise RuntimeError(f"{item.tag} was not queryable after IFC reload")
            _check_saved(item, saved, context, objects)
        if path.read_bytes() != original:
            raise RuntimeError("The IFC changed while wet-room fixtures were prepared")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return ids

