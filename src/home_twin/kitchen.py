"""Kitchen joinery authored as tagged, typed IFC units in the building frame.

A unit carries the run it belongs to in its own properties, so the viewer draws
doors, drawers and appliance fronts from declared design intent instead of
guessing them from a name. IFC holds the envelope; joinery detail inside that
envelope is a display allowance.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from math import cos, isfinite, pi, sin
from pathlib import Path
from typing import Literal

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

from home_twin.furniture import box_solid, check_tags_are_free
from home_twin.geometry import point_in_polygon
from home_twin.model import BuildingObject, HomeTwin, Point2D, Point3D

KitchenRole = Literal["base", "tall", "wall", "shelf", "island", "worktop", "appliance", "filler", "gable"]
KitchenFront = Literal["doors", "drawers", "glass", "integrated", "open", "lift", "none"]
KitchenFacing = Literal["north", "east", "south", "west"]
KitchenShape = Literal["box", "curved"]
KitchenHinge = Literal["left", "right", "pair", "top", "bottom", "pullout", "none"]
"""How the front opens. ``left`` and ``right`` name the hinged edge as seen
standing in front of the unit, which is the way a carpenter hands a door; the
building-frame edge follows from ``facing``. ``pair`` is two leaves hinged on
the outer edges and meeting in the middle."""

ROLE_PROPERTY = "Pset_HomeTwinKitchen.Role"
SEAT_PROPERTY = "Pset_HomeTwinFurniture.Role"

_ROLES = frozenset(("base", "tall", "wall", "shelf", "island", "worktop", "appliance", "filler", "gable"))
_FRONTS = frozenset(("doors", "drawers", "glass", "integrated", "open", "lift", "none"))
_SHAPES = frozenset(("box", "curved"))
_HINGES = frozenset(("left", "right", "pair", "top", "bottom", "pullout", "none"))
_SIDE_HUNG = frozenset(("left", "right", "pair"))
# A front that swings is the only one a hinged edge means anything on.
_HINGED_FRONTS = frozenset(("doors", "glass", "integrated", "lift"))
# A front is the local -Y face, so the placement rotation carries -Y onto the facing.
_FACING_RADIANS = {"south": 0.0, "east": pi / 2, "north": pi, "west": -pi / 2}
_FLOOR_STANDING = frozenset(("base", "tall", "island", "gable"))
_CABINET_ROLES = frozenset(("base", "tall", "wall", "shelf", "filler", "gable"))
# A box the carpenter builds, as opposed to a panel, a slab, a bare shelf or a
# bought appliance standing in an opening. It is what a cutting list counts.
_CARCASS_ROLES = frozenset(("base", "tall", "wall", "island"))


KitchenBayKind = Literal["shelf", "drawer", "appliance", "pullout", "void"]

_BAY_KINDS = frozenset(("shelf", "drawer", "appliance", "pullout", "void"))


@dataclass(frozen=True)
class KitchenBay:
    """One division inside a carcass, in absolute building-frame mm.

    A unit's envelope says where the joinery is and nothing about what it holds,
    so a run drawn from envelopes alone reads as a closed slab with doors on it.
    """

    z0_mm: float
    z1_mm: float
    kind: KitchenBayKind
    label: str = ""

    def __post_init__(self) -> None:
        if self.kind not in _BAY_KINDS:
            raise ValueError(f"Unknown kitchen bay kind {self.kind!r}")
        if not (isfinite(self.z0_mm) and isfinite(self.z1_mm)) or self.z1_mm <= self.z0_mm:
            raise ValueError(f"A kitchen bay runs upward: {self.z0_mm} to {self.z1_mm}")


@dataclass(frozen=True)
class KitchenUnit:
    tag: str
    name: str
    role: KitchenRole
    centre_mm: Point3D
    """Plan centre of the unit; ``z`` is its underside."""
    width_mm: float
    """Along the front face."""
    depth_mm: float
    """Front to back."""
    height_mm: float
    facing: KitchenFacing
    front: KitchenFront = "doors"
    finish: str = "walnut"
    appliance: str | None = None
    shape: KitchenShape = "box"
    edge_depth_mm: float | None = None
    """Apparent edge of a built-up worktop. ``None`` is a plain slab edge."""
    bays: tuple[KitchenBay, ...] = ()
    """What the carcass holds, bottom to top. Empty means undeclared, not empty."""
    hinge: KitchenHinge = "none"
    """Which edge the front is hung on, so a drawing can show the swing."""
    carcass: bool | None = None
    """Override when the role's usual answer is wrong; ``None`` takes it from the role.

    A fully integrated appliance stands in an opening on its own feet and carries
    a decor panel, so it is not a box anybody builds. Its role still says where it
    sits in the run, which is why this cannot simply be read off the role.
    """

    def __post_init__(self) -> None:
        if not self.tag or not self.name:
            raise ValueError("A kitchen unit needs a tag and a name")
        if self.role not in _ROLES:
            raise ValueError(f"Unknown kitchen role {self.role!r}")
        if self.front not in _FRONTS:
            raise ValueError(f"Unknown kitchen front {self.front!r}")
        if self.facing not in _FACING_RADIANS:
            raise ValueError(f"Unknown kitchen facing {self.facing!r}")
        if self.shape not in _SHAPES:
            raise ValueError(f"Unknown kitchen shape {self.shape!r}")
        if self.hinge not in _HINGES:
            raise ValueError(f"Unknown kitchen hinge {self.hinge!r}")
        # A hinge that contradicts its front is worse than no hinge: the drawing
        # would show a swing on something that does not swing.
        if self.hinge in _SIDE_HUNG and self.front not in _HINGED_FRONTS:
            raise ValueError(f"{self.tag} has a {self.front!r} front, so it has no leaf to hang on the {self.hinge}")
        if self.carcass and self.role not in _CARCASS_ROLES:
            raise ValueError(f"{self.tag} is a {self.role}, which is never a carcass anyone builds")
        if self.hinge == "top" and self.front != "lift":
            raise ValueError(f"{self.tag} is hinged at the top but its front is {self.front!r}, not a lift-up flap")
        if self.front == "lift" and self.hinge not in {"top", "none"}:
            raise ValueError(f"{self.tag} is a lift-up flap, so it hangs on its top edge, not the {self.hinge}")
        if not all(isfinite(value) and value > 0 for value in (self.width_mm, self.depth_mm, self.height_mm)):
            raise ValueError("Kitchen unit dimensions must be positive and finite")
        if self.front == "lift":
            if self.role not in _CABINET_ROLES:
                raise ValueError(f"A lift-up flap is joinery, so it cannot front a {self.role} unit")
            # The flap parks flat inside the carcass rather than swinging out, so
            # it has to have somewhere to go: its travel is the opening height and
            # the room for it is the depth behind the opening.
            if self.height_mm > self.depth_mm:
                raise ValueError(
                    f"{self.tag} lifts {self.height_mm:.0f} mm of flap into a {self.depth_mm:.0f} mm deep box, "
                    "so the parked flap does not fit"
                )
        if self.edge_depth_mm is not None:
            # A built-up edge is a rim mitred under the slab, not a thicker slab:
            # the stone stays ``height_mm`` and only the visible edge reads deeper.
            if self.role != "worktop":
                raise ValueError(f"{self.tag} is a {self.role} unit, so it has no worktop edge to build up")
            if not isfinite(self.edge_depth_mm) or self.edge_depth_mm <= self.height_mm:
                raise ValueError(
                    f"{self.tag} builds its edge up to {self.edge_depth_mm} mm, which is not deeper "
                    f"than its {self.height_mm:.0f} mm slab"
                )
        for index, bay in enumerate(self.bays):
            if bay.z0_mm < self.centre_mm.z - 0.1 or bay.z1_mm > self.centre_mm.z + self.height_mm + 0.1:
                raise ValueError(f"{self.tag} bay {bay.kind} at {bay.z0_mm:.0f} falls outside its carcass")
            if index and bay.z0_mm + 0.1 < self.bays[index - 1].z1_mm:
                raise ValueError(f"{self.tag} bays run up the carcass in order and cannot overlap")
        if not all(isfinite(value) for value in (self.centre_mm.x, self.centre_mm.y, self.centre_mm.z)):
            raise ValueError("Kitchen unit position must be finite")

    @property
    def has_carcass(self) -> bool:
        return self.role in _CARCASS_ROLES if self.carcass is None else self.carcass

    @property
    def plan_extent_mm(self) -> tuple[float, float]:
        """World-aligned (x, y) extent; an east or west front turns the unit onto its wall."""
        return (self.depth_mm, self.width_mm) if self.facing in {"east", "west"} else (self.width_mm, self.depth_mm)

    @property
    def object_kind(self) -> str:
        return "cabinet" if self.role in _CABINET_ROLES else "furniture"


def author_kitchen_units(
    model: ifcopenshell.file,
    room_id: str,
    units: tuple[KitchenUnit, ...],
    superseded_names: frozenset[str] = frozenset(),
) -> dict[str, str]:
    """Edit a caller-owned private IFC; the caller must validate and save transactionally.

    Elements the kitchen replaces are named in ``superseded_names`` so that they
    leave in the same transaction; a half-migrated run would read as a collision.
    """
    if len({unit.tag for unit in units}) != len(units):
        raise ValueError("Kitchen unit tags must be unique")
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    frame = ifcopenshell.util.placement.get_local_placement(model.by_type("IfcBuilding")[0].ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    room = model.by_guid(room_id)
    wanted = {unit.tag for unit in units}
    for stale in [
        product
        for product in model.by_type("IfcFurniture")
        if (str(product.ObjectType or "").startswith("kitchen_") and product.Tag not in wanted)
        or (product.Tag is None and product.Name in superseded_names)
    ]:
        ifcopenshell.api.run("root.remove_product", model, product=stale)
    ids = {}
    for unit in units:
        matches = [product for product in model.by_type("IfcFurniture") if product.Tag == unit.tag]
        if len(matches) > 1:
            raise ValueError(f"Duplicate kitchen tag {unit.tag}")
        entity = matches[0] if matches else ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcFurniture")
        entity.Name = unit.name
        entity.Tag = unit.tag
        entity.PredefinedType = "USERDEFINED"
        entity.ObjectType = f"kitchen_{unit.role}"
        if entity.Representation:
            for rep in list(entity.Representation.Representations):
                ifcopenshell.api.run("geometry.unassign_representation", model, product=entity, representation=rep)
                ifcopenshell.api.run("geometry.remove_representation", model, representation=rep)
        sizes = (unit.width_mm / unit_mm, unit.depth_mm / unit_mm, unit.height_mm / unit_mm)
        solid = box_solid(model, *sizes, 0.0, 0.0, 0.0)
        rep = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
        ifcopenshell.api.run("geometry.assign_representation", model, product=entity, representation=rep)
        angle = _FACING_RADIANS[unit.facing]
        matrix = np.eye(4)
        matrix[:2, :2] = ((cos(angle), -sin(angle)), (sin(angle), cos(angle)))
        matrix[:3, 3] = np.array([unit.centre_mm.x, unit.centre_mm.y, unit.centre_mm.z]) / 1000
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=frame @ matrix, is_si=True)
        ifcopenshell.api.run("spatial.assign_container", model, products=[entity], relating_structure=room)
        existing = {
            rel.RelatingPropertyDefinition.Name: rel.RelatingPropertyDefinition
            for rel in entity.IsDefinedBy
            if rel.is_a("IfcRelDefinesByProperties")
        }
        for name, properties in {
            "Pset_HomeTwin": {"ObjectKind": unit.object_kind},
            "Pset_HomeTwinKitchen": {
                "Role": unit.role,
                "Facing": unit.facing,
                "Front": unit.front,
                "Finish": unit.finish,
                "Shape": unit.shape,
                "Appliance": unit.appliance,
                "EdgeDepth": unit.edge_depth_mm,
                "Bays": _bay_text(unit.bays) or None,
                "Hinge": unit.hinge,
                "Carcass": "yes" if unit.has_carcass else "no",
                "RepresentationMethod": "design_envelope",
            },
        }.items():
            pset = existing.get(name)
            if pset is None:
                pset = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
        ids[unit.tag] = entity.GlobalId
    return ids


def _bay_text(bays: tuple[KitchenBay, ...]) -> str:
    """``kind@z0+z1`` per bay, so a reader without the API can still draw inside."""
    return ";".join(f"{bay.kind}@{bay.z0_mm:g}+{bay.z1_mm:g}" for bay in bays)


def _spans(obj: BuildingObject) -> tuple[tuple[float, float], ...]:
    a, b = obj.bounds.minimum, obj.bounds.maximum
    return ((a.x, b.x), (a.y, b.y), (a.z, b.z))


def _collides(first: BuildingObject, second: BuildingObject) -> bool:
    return all(
        min(one[1], other[1]) - max(one[0], other[0]) > 1.0
        for one, other in zip(_spans(first), _spans(second), strict=True)
    )


def _shares_envelope_by_design(first: BuildingObject, second: BuildingObject) -> bool:
    """An appliance is set into joinery, and a stool tucks under a worktop overhang.

    Both read as a box collision because a seat's bounds cover its whole
    envelope, and both are what the overhang and the housing are cut for.
    """
    roles = [first.properties.get(ROLE_PROPERTY), second.properties.get(ROLE_PROPERTY)]
    if "appliance" in roles and all(role is not None for role in roles):
        return True
    seats = {first.properties.get(SEAT_PROPERTY), second.properties.get(SEAT_PROPERTY)}
    return "worktop" in roles and "stool" in seats


def _validate(twin: HomeTwin, room_id: str, units: tuple[KitchenUnit, ...], ids: dict[str, str]) -> None:
    context = twin.get_room_context(room_id)
    objects = {obj.id: obj for obj in context.furniture}
    floor_mm = context.room.elevation_mm
    for unit in units:
        obj = objects[ids[unit.tag]]
        a, b = obj.bounds.minimum, obj.bounds.maximum
        expected = (*unit.plan_extent_mm, unit.height_mm)
        actual = (b.x - a.x, b.y - a.y, b.z - a.z)
        if any(abs(one - other) > 0.1 for one, other in zip(actual, expected, strict=True)):
            raise ValueError(f"Saved kitchen dimensions differ for {unit.tag}")
        if any(not point_in_polygon(Point2D(x, y), context.ceiling.polygon) for x in (a.x, b.x) for y in (a.y, b.y)):
            raise ValueError(f"{unit.tag} is outside the room")
        if unit.role in _FLOOR_STANDING and abs(a.z - floor_mm) > 0.1:
            raise ValueError(f"{unit.tag} is a {unit.role} unit and must stand on the floor")
        if a.z < floor_mm - 0.1:
            raise ValueError(f"{unit.tag} starts below the floor")
        if b.z > context.ceiling.elevation_mm + 0.1:
            raise ValueError(f"{unit.tag} passes through the ceiling")
        for other in objects.values():
            if other.id == obj.id or _shares_envelope_by_design(obj, other):
                continue
            if _collides(obj, other):
                raise ValueError(f"{unit.tag} collides with {other.name}")


def save_kitchen_units(
    path: Path,
    room_id: str,
    units: tuple[KitchenUnit, ...],
    superseded_names: frozenset[str] = frozenset(),
) -> dict[str, str]:
    """Validate a private clone, reopen its IFC, and atomically publish the kitchen."""
    original = path.read_bytes()
    model = ifcopenshell.file.from_string(original.decode())
    check_tags_are_free(model, {unit.tag: room_id for unit in units if unit.tag})
    ids = author_kitchen_units(model, room_id, units, superseded_names)
    descriptor, name = tempfile.mkstemp(suffix=".ifc", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        model.write(str(temporary))
        _validate(HomeTwin.open(temporary), room_id, units, ids)
        if path.read_bytes() != original:
            raise ValueError("Model changed during kitchen authoring")
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
