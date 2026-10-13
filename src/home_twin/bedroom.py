"""Typed bedroom furniture and custom joinery authored into IFC.

Every item is a design envelope placed in the building frame. ``centre_mm`` is
the plan centre with ``z`` at the underside, and the front of a unit is its
local ``-Y`` face, so a piece stands with its back along local ``+Y`` and
``rotation_deg`` turns it anticlockwise on plan: a bed whose headboard is on a
south wall carries ``rotation_deg=180``.

Joinery scribed to a wall that is not square to the frame carries an
``outline_mm`` plan polygon instead. Against a wall that runs a few hundred
millimetres out of square over its length, a wardrobe with a usable straight
front is necessarily a tapering solid, not a box.
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

from home_twin.furniture import box_solid, check_tags_are_free, containing_room, disc_solid
from home_twin.geometry import point_in_polygon, polygon_edge_distance
from home_twin.model import BuildingObject, HomeTwin, ObjectKind, Point2D, Point3D, RoomContext

BedroomRole = Literal[
    "bed",
    "bedside_table",
    "wardrobe",
    "vanity",
    "stool",
    "rug",
    "air_conditioner",
    "mirror",
    "bench",
]

_ROLES = frozenset(BedroomRole.__args__)
# Roles whose body is the ``outline_mm`` polygon extruded, because a box cannot
# follow a wall that is out of square.
_OUTLINE_ROLES = frozenset(("wardrobe", "vanity"))
# Roles that carry an internal fit-out. A vanity is one: makeup and jewellery
# want shallow compartmented drawers beside the knee hole, not an open shelf.
_FITTED_ROLES = frozenset(("wardrobe", "vanity"))
_CABINET_ROLES = frozenset(("wardrobe",))
# Not furniture: a spotlight has to keep clear of it and a lux estimate should
# not count it as something to light.
_PLANT_ROLES = frozenset(("air_conditioner",))
# Air has to get out of the top of a split unit and back in below it. The
# manufacturers ask 50 to 150 above; this is the figure the model checks.
AC_CEILING_CLEARANCE_MM = 50.0
# (IFC class, predefined type). USERDEFINED entities carry ``bedroom_<role>`` as
# ObjectType because IFC4 names no furniture type for a wardrobe, a dressing
# table or a rug.
_IFC_TYPE = {
    "bed": ("IfcFurniture", "BED"),
    "bedside_table": ("IfcFurniture", "TABLE"),
    "wardrobe": ("IfcFurniture", "USERDEFINED"),
    "vanity": ("IfcFurniture", "USERDEFINED"),
    "stool": ("IfcFurniture", "CHAIR"),
    "rug": ("IfcFurniture", "USERDEFINED"),
    # A wall-hung split indoor unit, which IFC4 does name, so it is not furniture
    # and does not pretend to be.
    "air_conditioner": ("IfcUnitaryEquipment", "SPLITSYSTEM"),
    "mirror": ("IfcFurniture", "USERDEFINED"),
    "bench": ("IfcFurniture", "USERDEFINED"),
}
PSET = "Pset_HomeTwinBedroom"

# A headboard reads as part of the bed, not as a wall lining, so it is inside
# the bed's own depth: the mattress is ``depth_mm`` less this.
HEADBOARD_MM = 80.0
BED_BASE_MM = 250.0
BED_MATTRESS_MM = 200.0


@dataclass(frozen=True, slots=True)
class WardrobeBay:
    """One vertical division of a run, with its own boards.

    A run is only as good as what is inside it, and what is inside it is not
    uniform: the bay you hang dresses in and the bay you keep shoes in are the
    same carcass and nothing else about them matches. ``start_mm`` runs along the
    run's own length from its lowest coordinate.
    """

    start_mm: float
    width_mm: float
    shelf_heights_mm: tuple[float, ...] = ()
    rail_heights_mm: tuple[float, ...] = ()
    drawer_heights_mm: tuple[float, ...] = ()
    """Top face of each drawer front, above the run's base."""
    role: str | None = None
    """What the bay is for, such as ``long_hang`` or ``shoes``; a label, not a rule."""
    divider_height_mm: float | None = None
    """How tall the board between this bay and the one before it stands; full height when absent.

    A corner bay has no front of its own and is reached along the run, so a
    full-height divider seals it. Stopping the divider at the top of the drawer
    bank lets one rail run through both bays, which is what a corner rail is for.
    """

    def __post_init__(self) -> None:
        if not isfinite(self.start_mm) or self.start_mm < 0:
            raise ValueError("A bay starts at or after the run's end")
        if not isfinite(self.width_mm) or self.width_mm <= 0:
            raise ValueError("A bay must be wider than nothing")
        for height in self.heights:
            if not isfinite(height) or height <= 0:
                raise ValueError("A board must sit above the run's base")
        if self.divider_height_mm is not None and (
            not isfinite(self.divider_height_mm) or self.divider_height_mm <= 0
        ):
            raise ValueError("A divider is either a stated height or the full one")

    @property
    def heights(self) -> tuple[float, ...]:
        return (*self.shelf_heights_mm, *self.rail_heights_mm, *self.drawer_heights_mm)


@dataclass(frozen=True, slots=True)
class BedroomFurniture:
    tag: str
    room_id: str
    role: BedroomRole
    centre_mm: Point3D
    """Plan centre; ``z`` is the underside. For an outline, the outline's bounding-box centre."""
    width_mm: float
    """Along the front face; the diameter of a round stool."""
    depth_mm: float
    """Front to back; the overall length of a bed, headboard included."""
    height_mm: float
    rotation_deg: float = 0.0
    """Anticlockwise on plan. The front is the local ``-Y`` face. Zero for an outline."""
    finish: str | None = None
    """A material name such as ``walnut_veneer``; a display and specification hint."""
    wall_mounted: bool = False
    """Carried on the wall rather than standing on the floor: a floating unit."""
    outline_mm: tuple[Point2D, ...] = ()
    """Plan outline in the building frame, for joinery scribed to an out-of-square wall."""

    shelf_heights_mm: tuple[float, ...] = ()
    """Shelf top faces above the unit's base. A wardrobe that states any fit-out is drawn open."""
    rail_heights_mm: tuple[float, ...] = ()
    """Hanging rail centres above the unit's base; the clear drop is the rail less what is under it."""
    bays: tuple[WardrobeBay, ...] = ()
    """Vertical divisions of a wardrobe run, each with its own fit-out."""
    plinth_height_mm: float = 0.0
    """A recessed plinth under the carcass, so the run reads as built in rather than stood on the floor."""
    front: str | None = None
    """How the run closes, such as ``sliding_walnut`` or ``tambour``; recorded, not drawn.

    The runs are drawn with their fronts off on purpose: a closed slab says where
    the joinery is and nothing about what it holds.
    """
    interior_finish: str | None = None
    supply: str | None = None
    """Where a powered piece takes its electricity, such as ``socket under the vanity``.

    The model has no socket, and a mirror light or a joinery LED that nobody can
    say the supply for is a thing an electrician finds out on site.
    """
    front_bearing_deg: float | None = None
    """Which way the doors face, anticlockwise from ``+X``, for a run drawn open.

    The outline says where the carcass is and not which of its edges you stand
    at. Every edge but the one facing this way gets a side or a back.
    """

    def __post_init__(self) -> None:
        if not self.tag or not self.room_id:
            raise ValueError("Bedroom furniture needs a tag and IFC room id")
        if self.role not in _ROLES:
            raise ValueError("Unknown bedroom furniture role")
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
            raise ValueError("Bedroom furniture geometry must be finite and positive")
        if self.role == "bed" and self.depth_mm <= HEADBOARD_MM + BED_BASE_MM:
            raise ValueError("A bed must be longer than its own headboard and base")
        if self.role == "stool" and self.width_mm != self.depth_mm:
            raise ValueError("A stool is round, so its width and depth are its diameter")
        if self.wall_mounted and self.role == "wardrobe":
            raise ValueError("A floor-to-ceiling wardrobe stands on the floor")
        if (self.role in _OUTLINE_ROLES) != bool(self.outline_mm):
            raise ValueError("A wardrobe and a vanity are scribed to their wall and need an outline; nothing else does")
        if self.outline_mm:
            self._check_outline()
        if (self.shelf_heights_mm or self.rail_heights_mm or self.bays) and self.role not in _FITTED_ROLES:
            raise ValueError("Only a wardrobe or a vanity carries a shelf, rail and drawer fit-out")
        if self.bays and (self.shelf_heights_mm or self.rail_heights_mm):
            raise ValueError("A run states its bays or one fit-out for the whole run, not both")
        for height in (*self.shelf_heights_mm, *self.rail_heights_mm, *(h for b in self.bays for h in b.heights)):
            if not isfinite(height) or not 0 < height <= self.height_mm:
                raise ValueError("A shelf or rail must sit inside the unit it belongs to")
        if not 0 <= self.plinth_height_mm < self.height_mm:
            raise ValueError("A plinth is shorter than the run standing on it")
        for index, bay in enumerate(self.bays):
            if index and bay.start_mm + 1e-6 < self.bays[index - 1].start_mm + self.bays[index - 1].width_mm:
                raise ValueError("Bays run along the carcass in order and cannot overlap")
        if self.is_open and (self.front_bearing_deg is None or not isfinite(self.front_bearing_deg)):
            raise ValueError("A run drawn open must say which way its doors face")
        if self.front_bearing_deg is not None and not self.is_open:
            raise ValueError("A closed envelope has no open face to point")

    def _check_outline(self) -> None:
        if len(self.outline_mm) < 3:
            raise ValueError("An outline needs three or more points")
        if not all(isfinite(point.x) and isfinite(point.y) for point in self.outline_mm):
            raise ValueError("Outline points must be finite")
        if self.rotation_deg:
            raise ValueError("An outline is already in the building frame, so it cannot also be rotated")
        xs = [point.x for point in self.outline_mm]
        ys = [point.y for point in self.outline_mm]
        expected = (max(xs) - min(xs), max(ys) - min(ys), (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
        stated = (self.width_mm, self.depth_mm, self.centre_mm.x, self.centre_mm.y)
        if any(abs(a - b) > 1.0 for a, b in zip(expected, stated, strict=True)):
            raise ValueError("An outline's bounding box must be the stated centre, width and depth")

    @property
    def object_kind(self) -> str | None:
        if self.role in _CABINET_ROLES:
            return "cabinet"
        return "ac" if self.role in _PLANT_ROLES else None

    @property
    def fit_out(self) -> tuple[WardrobeBay, ...]:
        """The bays as drawn: the stated ones, or one bay spanning the whole run."""
        if self.bays:
            return self.bays
        if not (self.shelf_heights_mm or self.rail_heights_mm):
            return ()
        length = max(self.width_mm, self.depth_mm)
        return (
            WardrobeBay(0.0, length, self.shelf_heights_mm, self.rail_heights_mm),
        )

    @property
    def is_open(self) -> bool:
        """Drawn as its fit-out rather than as a closed envelope: the doors come off.

        A solid box says where the joinery is and nothing about what it holds. A
        run that states its shelves and rails is drawn as them, which is the only
        way a layout can be checked against the clothes that go in it.
        """
        return bool(self.shelf_heights_mm or self.rail_heights_mm or self.bays)


def _extruded_outline(model, item: BedroomFurniture, unit_mm: float):
    """The plan outline, taken relative to the item's centre, extruded to its height."""
    points = [
        model.createIfcCartesianPoint(
            ((point.x - item.centre_mm.x) / unit_mm, (point.y - item.centre_mm.y) / unit_mm)
        )
        for point in item.outline_mm
    ]
    profile = model.createIfcArbitraryClosedProfileDef("AREA", None, model.createIfcPolyline([*points, points[0]]))
    position = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((0.0, 0.0, 0.0)))
    return model.createIfcExtrudedAreaSolid(
        profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), item.height_mm / unit_mm
    )


# Carcass boards, and the gap a rail keeps off the back so a hanger clears it.
PANEL_MM = 18.0
RAIL_DIAMETER_MM = 30.0
RAIL_SETBACK_MM = 60.0
# How far a recessed plinth sits behind the face above it.
PLINTH_SETBACK_MM = 60.0


def _offset_polygon(points: tuple[Point2D, ...], distance: float) -> tuple[Point2D, ...]:
    """A convex outline moved inwards by ``distance`` on every edge.

    Scaling about the centroid would not do: on a run 1614 mm long and 434 mm
    deep it takes 67 mm off each end to move the back 18 mm, and the shelves
    would stop short of the sides they sit on.
    """
    centre = (
        sum(point.x for point in points) / len(points),
        sum(point.y for point in points) / len(points),
    )
    lines = []
    for index, start in enumerate(points):
        end = points[(index + 1) % len(points)]
        run = np.array([end.x - start.x, end.y - start.y], dtype=float)
        length = float(np.linalg.norm(run))
        if length < 1e-9:
            raise ValueError("An outline cannot repeat a point")
        run /= length
        normal = np.array([-run[1], run[0]])
        if np.dot(normal, np.array([centre[0] - start.x, centre[1] - start.y], dtype=float)) < 0:
            normal = -normal
        lines.append((np.array([start.x, start.y], dtype=float) + normal * distance, run))

    moved = []
    for index in range(len(lines)):
        (point_a, run_a), (point_b, run_b) = lines[index - 1], lines[index]
        cross = run_a[0] * run_b[1] - run_a[1] * run_b[0]
        if abs(cross) < 1e-9:
            raise ValueError("An outline cannot double back on itself")
        delta = point_b - point_a
        step = (delta[0] * run_b[1] - delta[1] * run_b[0]) / cross
        crossing = point_a + run_a * step
        moved.append(Point2D(float(crossing[0]), float(crossing[1])))
    return tuple(moved)


def _panel(
    model,
    item: BedroomFurniture,
    points: tuple[Point2D, ...],
    z: float,
    thickness: float,
    unit_mm: float,
    upright: bool = False,
):
    """A board on the item's own plan outline: a base, a shelf, a divider or a top.

    ``upright`` only says the caller means ``thickness`` as a height; the solid is
    built the same way, from a plan profile extruded upwards.
    """
    _ = upright
    nodes = [
        model.createIfcCartesianPoint(((p.x - item.centre_mm.x) / unit_mm, (p.y - item.centre_mm.y) / unit_mm))
        for p in points
    ]
    profile = model.createIfcArbitraryClosedProfileDef("AREA", None, model.createIfcPolyline([*nodes, nodes[0]]))
    position = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((0.0, 0.0, z / unit_mm)))
    return model.createIfcExtrudedAreaSolid(
        profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), thickness / unit_mm
    )


def _rail(
    model,
    item: BedroomFurniture,
    inner: tuple[Point2D, ...],
    along_y: bool,
    low: float,
    high: float,
    z: float,
    unit_mm: float,
):
    """A round rail on the run's own line, spanning one bay of it.

    The line is the run's and not the bay's. A rail inset from an internal bay
    boundary stops short of it, and a run whose rail is two stubs 120 mm apart,
    with a 22 mm step between them because the wall behind slopes, is not a rail
    anything can be slid along. Sliding is the entire reason for running a rail
    into a corner that has no front of its own, so the rail has to be continuous
    or the corner is decorative.
    """
    xs = [point.x for point in inner]
    ys = [point.y for point in inner]
    limit = (min(ys), max(ys)) if along_y else (min(xs), max(xs))
    start_mm, end_mm = max(low, limit[0]), min(high, limit[1])
    if end_mm - start_mm < RAIL_DIAMETER_MM:
        raise ValueError("A bay too short to carry a rail cannot state one")
    across = (min(xs) + max(xs)) / 2 if along_y else (min(ys) + max(ys)) / 2
    origin = np.array(
        [
            (across if along_y else start_mm) - item.centre_mm.x,
            (start_mm if along_y else across) - item.centre_mm.y,
            z,
        ]
    )
    axis = np.array([0.0, 1.0, 0.0]) if along_y else np.array([1.0, 0.0, 0.0])
    position = model.createIfcAxis2Placement3D(
        model.createIfcCartesianPoint(tuple(float(value) / unit_mm for value in origin)),
        model.createIfcDirection(tuple(float(value) for value in axis)),
        model.createIfcDirection((0.0, 0.0, 1.0)),
    )
    profile = model.createIfcCircleProfileDef("AREA", None, None, RAIL_DIAMETER_MM / 2 / unit_mm)
    return model.createIfcExtrudedAreaSolid(
        profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), (end_mm - start_mm) / unit_mm
    )


def _carcass_sides(
    model, item: BedroomFurniture, unit_mm: float, base: float = 0.0
) -> list[ifcopenshell.entity_instance]:
    """A board on every outline edge but the one the fronts would have closed.

    Without them an open run reads as shelves screwed to a wall rather than as a
    wardrobe standing with its fronts off, and the ends are what a shelf lands on.
    Each board runs between the outline and its inset, so the corners mitre
    instead of overshooting the edge next to them.
    """
    facing = radians(item.front_bearing_deg or 0.0)
    front = np.array([cos(facing), sin(facing)])
    points = item.outline_mm
    inner = _offset_polygon(points, PANEL_MM)
    centre = np.array([item.centre_mm.x, item.centre_mm.y], dtype=float)

    def outward(index: int) -> np.ndarray:
        start, end = points[index], points[(index + 1) % len(points)]
        run = np.array([end.x - start.x, end.y - start.y], dtype=float)
        normal = np.array([run[1], -run[0]])
        normal /= np.linalg.norm(normal)
        offset = centre - np.array([start.x, start.y], dtype=float)
        return -normal if np.dot(normal, offset) > 0 else normal

    open_edge = max(range(len(points)), key=lambda index: float(np.dot(outward(index), front)))
    solids = []
    for index in range(len(points)):
        if index == open_edge:
            continue
        following = (index + 1) % len(points)
        corners = (points[index], points[following], inner[following], inner[index])
        nodes = [
            model.createIfcCartesianPoint(
                ((corner.x - item.centre_mm.x) / unit_mm, (corner.y - item.centre_mm.y) / unit_mm)
            )
            for corner in corners
        ]
        profile = model.createIfcArbitraryClosedProfileDef("AREA", None, model.createIfcPolyline([*nodes, nodes[0]]))
        position = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((0.0, 0.0, base / unit_mm)))
        solids.append(
            model.createIfcExtrudedAreaSolid(
                profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), (item.height_mm - base) / unit_mm
            )
        )
    return solids


def _slice_outline(points: tuple[Point2D, ...], along_y: bool, low: float, high: float) -> tuple[Point2D, ...]:
    """The part of a convex outline between two positions along its length.

    A bay's boards have to follow the run's own back, which on this wardrobe
    slopes, so a bay cannot be a rectangle cut out of the bounding box.
    """

    def clip(polygon: list[Point2D], keep_above: bool, limit: float) -> list[Point2D]:
        def inside(point: Point2D) -> bool:
            value = point.y if along_y else point.x
            return value >= limit if keep_above else value <= limit

        result: list[Point2D] = []
        for index, current in enumerate(polygon):
            previous = polygon[index - 1]
            if inside(current) != inside(previous):
                a = previous.y if along_y else previous.x
                b = current.y if along_y else current.x
                ratio = (limit - a) / (b - a)
                result.append(
                    Point2D(
                        previous.x + (current.x - previous.x) * ratio,
                        previous.y + (current.y - previous.y) * ratio,
                    )
                )
            if inside(current):
                result.append(current)
        return result

    clipped = clip(clip(list(points), True, low), False, high)
    if len(clipped) < 3:
        raise ValueError("A bay falls outside the run it belongs to")
    return tuple(clipped)


def _drawer_front(model, item: BedroomFurniture, points: tuple[Point2D, ...], low: float, high: float, unit_mm: float):
    """A front on the open face of a bay, from one drawer division to the next."""
    facing = radians(item.front_bearing_deg or 0.0)
    front = np.array([cos(facing), sin(facing)])
    centre = np.array([item.centre_mm.x, item.centre_mm.y], dtype=float)
    inner = _offset_polygon(points, PANEL_MM)

    def outward(index: int) -> np.ndarray:
        start, end = points[index], points[(index + 1) % len(points)]
        run = np.array([end.x - start.x, end.y - start.y], dtype=float)
        normal = np.array([run[1], -run[0]])
        normal /= np.linalg.norm(normal)
        offset = centre - np.array([start.x, start.y], dtype=float)
        return -normal if np.dot(normal, offset) > 0 else normal

    edge = max(range(len(points)), key=lambda index: float(np.dot(outward(index), front)))
    following = (edge + 1) % len(points)
    corners = (points[edge], points[following], inner[following], inner[edge])
    nodes = [
        model.createIfcCartesianPoint(((c.x - item.centre_mm.x) / unit_mm, (c.y - item.centre_mm.y) / unit_mm))
        for c in corners
    ]
    profile = model.createIfcArbitraryClosedProfileDef("AREA", None, model.createIfcPolyline([*nodes, nodes[0]]))
    position = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((0.0, 0.0, low / unit_mm)))
    return model.createIfcExtrudedAreaSolid(
        profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), (high - low) / unit_mm
    )


# Further than any run is long, so a slice takes the run's own end instead.
_UNBOUNDED_MM = 1e9


def _board_spans(
    bays: tuple[WardrobeBay, ...], origin: float, full_height: float
) -> list[tuple[float, float, float]]:
    """Every board in the run as ``(height, low, high)``, merged where they meet.

    A board stops at the divider before it only where that divider comes up this
    high. Where it does not -- a worktop over a drawer bank's side -- the two
    bays share one board rather than two that abut, because two abutting solids
    render as a seam down a slab that is meant to read as one.
    """
    spans: list[list[float]] = []
    for index, bay in enumerate(bays):
        low = origin + bay.start_mm
        divider_top = bay.divider_height_mm if bay.divider_height_mm is not None else full_height
        # Only the run's own ends are inset; an internal joint is not.
        end = low + bay.width_mm if index + 1 < len(bays) else _UNBOUNDED_MM
        for height in (*bay.shelf_heights_mm, *bay.drawer_heights_mm):
            if index and height <= divider_top + 1e-6:
                spans.append([height, low + PANEL_MM, end])
                continue
            joined = next(
                (span for span in spans if span[0] == height and abs(span[2] - low) < 1e-6),
                None,
            )
            if joined is not None:
                joined[2] = end
            else:
                spans.append([height, low if index else -_UNBOUNDED_MM, end])
    return [(height, low, high) for height, low, high in spans]


def _open_wardrobe(model, item: BedroomFurniture, unit_mm: float) -> list[ifcopenshell.entity_instance]:
    """The run with its fronts off: plinth, carcass, and each bay's own boards."""
    xs = [point.x for point in item.outline_mm]
    ys = [point.y for point in item.outline_mm]
    along_y = (max(ys) - min(ys)) >= (max(xs) - min(xs))
    origin = min(ys) if along_y else min(xs)
    base = item.plinth_height_mm

    inner = _offset_polygon(item.outline_mm, PANEL_MM)
    solids: list[ifcopenshell.entity_instance] = []
    if base:
        # Set back so the run reads as built in rather than stood on the floor.
        solids.append(_panel(model, item, _offset_polygon(item.outline_mm, PLINTH_SETBACK_MM), 0.0, base, unit_mm))
    solids += _carcass_sides(model, item, unit_mm, base)
    solids.append(_panel(model, item, inner, base, PANEL_MM, unit_mm))

    bays = item.fit_out
    full_height = item.height_mm - base
    for height, low, high in _board_spans(bays, origin, full_height):
        solids.append(
            _panel(model, item, _slice_outline(inner, along_y, low, high), base + height - PANEL_MM, PANEL_MM, unit_mm)
        )
    for index, bay in enumerate(bays):
        low = origin + bay.start_mm
        high = low + bay.width_mm
        slice_outline = _slice_outline(item.outline_mm, along_y, low, high)
        if index:
            # A divider between one bay and the next, standing off the base board.
            # A part-height one lets the rail above it run on into the next bay.
            top = bay.divider_height_mm if bay.divider_height_mm is not None else full_height
            solids.append(
                _panel(
                    model,
                    item,
                    _slice_outline(inner, along_y, low, low + PANEL_MM),
                    base + PANEL_MM,
                    top - PANEL_MM,
                    unit_mm,
                    upright=True,
                )
            )
        for height in bay.rail_heights_mm:
            solids.append(_rail(model, item, inner, along_y, low, high, base + height, unit_mm))
        previous = 0.0
        for height in bay.drawer_heights_mm:
            solids.append(_drawer_front(model, item, slice_outline, base + previous, base + height - PANEL_MM, unit_mm))
            previous = height
    return solids


def _items(model: ifcopenshell.file, item: BedroomFurniture, unit_mm: float) -> list[ifcopenshell.entity_instance]:
    w, d, h = item.width_mm, item.depth_mm, item.height_mm

    def box(width: float, depth: float, height: float, x: float, y: float, z: float, radius: float = 0):
        return box_solid(model, *(value / unit_mm for value in (width, depth, height, x, y, z, radius)))

    if item.is_open:
        return _open_wardrobe(model, item, unit_mm)
    if item.role in _OUTLINE_ROLES:
        return [_extruded_outline(model, item, unit_mm)]
    if item.role == "bed":
        # The mattress is the remainder once the headboard has taken its depth,
        # and it is inset so the base reads as a platform under it.
        mattress_depth = d - HEADBOARD_MM
        mattress_y = -HEADBOARD_MM / 2
        # Two pillows at the head. A bed without them renders as a mattress on a
        # box, and the browser view has always drawn them: the two should agree.
        pillow_w, pillow_d, pillow_h = 600.0, 400.0, 130.0
        head_y = mattress_y + mattress_depth / 2
        pillow_y = head_y - pillow_d / 2 - 60
        return [
            box(w, HEADBOARD_MM, h, 0, (d - HEADBOARD_MM) / 2, 0, 12),
            box(w, mattress_depth, BED_BASE_MM, 0, mattress_y, 0),
            box(w - 60, mattress_depth - 60, BED_MATTRESS_MM, 0, mattress_y, BED_BASE_MM, 45),
            # Two courses per pillow, the upper one inset. A rounded box only
            # rounds its plan corners, so one course renders as a slab with
            # sharp top edges: it reads as a block, not as bedding.
            *(
                solid
                for side in (-1, 1)
                for solid in (
                    box(
                        pillow_w,
                        pillow_d,
                        pillow_h * 0.55,
                        side * (pillow_w / 2 + 20),
                        pillow_y,
                        BED_BASE_MM + BED_MATTRESS_MM,
                        90,
                    ),
                    box(
                        pillow_w - 90,
                        pillow_d - 70,
                        pillow_h * 0.45,
                        side * (pillow_w / 2 + 20),
                        pillow_y,
                        BED_BASE_MM + BED_MATTRESS_MM + pillow_h * 0.55,
                        120,
                    ),
                )
            ),
        ]
    if item.role == "mirror":
        # A backing box with the glass standing proud of it. The reveal is on the
        # two sides only, not all round: those are the strips, and they face the
        # seat rather than washing the wall behind. The light is the whole reason
        # this mirror is here, so the geometry has to show where it comes out.
        reveal = 30.0
        glass = 8.0
        return [
            box(w, d - glass, h, 0, glass / 2, 0, 6),
            box(w - reveal * 2, glass, h, 0, -(d - glass) / 2, 0, 4),
        ]
    if item.role == "bench":
        # A seat with an open shelf under it, for the shoes that come off at the
        # door: top slab, two ends, and one shelf between them.
        return [
            box(w, d, 40, 0, 0, h - 40, 8),
            box(40, d, h - 40, -(w - 40) / 2, 0, 0),
            box(40, d, h - 40, (w - 40) / 2, 0, 0),
            box(w - 90, d - 40, 20, 0, 0, h / 2 - 10),
        ]
    if item.role == "air_conditioner":
        # A body with its discharge louvre stepped in underneath, which is what
        # makes a split unit read as one rather than as a box on the wall.
        return [box(w, d, h - 40, 0, 0, 40, 14), box(w - 40, d - 45, 40, 0, -22, 0, 8)]
    if item.role == "bedside_table":
        return [box(w, d, h, 0, 0, 0, 6), box(w - 80, 14, 18, 0, -(d - 14) / 2, h - 40)]
    if item.role == "stool":
        # An upholstered drum on a recessed base, so it reads as a seat rather
        # than a bollard and sits in the same shadow-gap language as the joinery.
        base = 60.0
        return [
            disc_solid(model, *(value / unit_mm for value in (w - 120, 0, 0, 0, base))),
            disc_solid(model, *(value / unit_mm for value in (w, 0, 0, base, h - base))),
        ]
    return [box(w, d, h, 0, 0, 0, 8)]


def _bay_text(bays: tuple[WardrobeBay, ...]) -> str:
    """Each bay as ``role@start+width`` and its fit-out, for readers without the API.

    The browser drew any run with an outline as one solid extrusion, so a
    floor-to-ceiling wardrobe read as a closed slab with doors on it. It cannot
    draw the inside from a role and a width alone.
    """
    parts = []
    for bay in bays:
        fields = [f"{bay.role or 'bay'}@{bay.start_mm:g}+{bay.width_mm:g}"]
        for key, heights in (
            ("s", bay.shelf_heights_mm),
            ("r", bay.rail_heights_mm),
            ("d", bay.drawer_heights_mm),
        ):
            if heights:
                fields.append(f"{key}={','.join(f'{h:g}' for h in heights)}")
        if bay.divider_height_mm is not None:
            fields.append(f"v={bay.divider_height_mm:g}")
        parts.append("|".join(fields))
    return ";".join(parts)


def author_bedroom_furniture(
    model: ifcopenshell.file,
    items: tuple[BedroomFurniture, ...],
) -> dict[str, str]:
    """Edit a private IFC clone. The caller owns validation and publication."""
    if len({item.tag for item in items}) != len(items):
        raise ValueError("Bedroom furniture tags must be unique")
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    building = model.by_type("IfcBuilding")[0]
    frame = ifcopenshell.util.placement.get_local_placement(building.ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    ids: dict[str, str] = {}

    for item in items:
        ifc_class, predefined_type = _IFC_TYPE[item.role]
        matches = [product for product in model.by_type(ifc_class) if getattr(product, "Tag", None) == item.tag]
        if len(matches) > 1:
            raise ValueError(f"Duplicate bedroom furniture tag {item.tag}")
        entity = (
            matches[0]
            if matches
            else ifcopenshell.api.run(
                "root.create_entity",
                model,
                ifc_class=ifc_class,
                predefined_type=predefined_type,
                name=f"{item.role.replace('_', ' ').capitalize()} {item.tag}",
            )
        )
        entity.Tag = item.tag
        entity.PredefinedType = predefined_type
        if predefined_type == "USERDEFINED":
            entity.ObjectType = f"bedroom_{item.role}"
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
        ifcopenshell.api.run(
            "spatial.assign_container", model, products=[entity], relating_structure=model.by_guid(item.room_id)
        )
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
                "WallMounted": item.wall_mounted,
                "OutlineMm": ";".join(f"{p.x:g},{p.y:g}" for p in item.outline_mm) or None,
                "ShelfHeightsMm": ";".join(f"{h:g}" for h in item.shelf_heights_mm) or None,
                "RailHeightsMm": ";".join(f"{h:g}" for h in item.rail_heights_mm) or None,
                "FrontBearingDeg": item.front_bearing_deg,
                "PlinthHeightMm": item.plinth_height_mm or None,
                "Front": item.front,
                "InteriorFinish": item.interior_finish,
                "Supply": item.supply,
                "Bays": _bay_text(item.bays) or None,
            }
        }
        if item.object_kind is not None or "Pset_HomeTwin" in existing:
            psets["Pset_HomeTwin"] = {"ObjectKind": item.object_kind}
        for name, properties in psets.items():
            pset = existing.get(name)
            if pset is None:
                pset = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)
        ids[item.tag] = entity.GlobalId

    # Assert the end state. Upserting alone leaves a run that has been taken out
    # of the design standing in the model, and nothing says so: a deleted shoe
    # run survived one publication that way, and a corner bay another.
    rooms = {item.room_id for item in items}
    for product in _authored_here(model):
        if product.GlobalId not in set(ids.values()) and containing_room(product) in rooms:
            ifcopenshell.api.run("root.remove_product", model, product=product)
    return ids


def _authored_here(model: ifcopenshell.file) -> list[ifcopenshell.entity_instance]:
    """Every product this module wrote, which is every one carrying its property set."""
    return [
        product
        for ifc_class in sorted({klass for klass, _ in _IFC_TYPE.values()})
        for product in model.by_type(ifc_class)
        if any(
            relation.is_a("IfcRelDefinesByProperties")
            and relation.RelatingPropertyDefinition.Name == PSET
            for relation in getattr(product, "IsDefinedBy", ()) or ()
        )
    ]


def _inside_or_on_edge(point: Point2D, context: RoomContext, tolerance_mm: float = 1.0) -> bool:
    polygon = context.ceiling.polygon
    return point_in_polygon(point, polygon) or polygon_edge_distance(point, polygon) <= tolerance_mm


def _footprint_points(obj: BuildingObject) -> tuple[Point2D, ...]:
    if obj.plan_footprint is not None:
        return obj.plan_footprint.outer
    a, b = obj.bounds.minimum, obj.bounds.maximum
    return tuple(Point2D(x, y) for x in (a.x, b.x) for y in (a.y, b.y))


# A stool sits in the vanity's knee hole, and a mirror hangs over its top, so
# all three share plan and the collision check has to expect it.
_DESIGNED_OVERLAPS = frozenset(
    (frozenset(("vanity", "stool")), frozenset(("vanity", "mirror")))
)


def _role_of(obj: BuildingObject) -> object:
    return obj.properties.get(f"{PSET}.Role")


def _collides(first: BuildingObject, second: BuildingObject) -> bool:
    roles = frozenset((_role_of(first), _role_of(second)))
    # Everything in the sleeping area stands on the rug, which is what a rug is for.
    if roles in _DESIGNED_OVERLAPS or "rug" in roles:
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
    item: BedroomFurniture, saved: BuildingObject, context: RoomContext, others: list[BuildingObject]
) -> None:
    if item.role in _PLANT_ROLES:
        expected_kind = ObjectKind.AC
    elif item.role in _CABINET_ROLES:
        expected_kind = ObjectKind.CABINET
    else:
        expected_kind = ObjectKind.FURNITURE
    if saved.kind != expected_kind:
        raise RuntimeError(f"{item.tag} reopened as {saved.kind}, expected {expected_kind}")
    floor = context.room.elevation_mm
    ceiling = context.ceiling.elevation_mm
    bottom, top = saved.bounds.minimum.z, saved.bounds.maximum.z

    if not all(_inside_or_on_edge(point, context) for point in _footprint_points(saved)):
        raise RuntimeError(f"{item.tag} footprint is outside its room")
    if bottom < floor - 1 or top > ceiling + 1:
        raise RuntimeError(f"{item.tag} is outside the room's vertical extent")
    if item.wall_mounted and bottom <= floor + 1:
        raise RuntimeError(f"{item.tag} is stated wall-mounted but reaches the floor")
    if item.role == "air_conditioner" and top > ceiling - AC_CEILING_CLEARANCE_MM:
        raise RuntimeError(
            f"{item.tag} leaves {ceiling - top:.0f} mm over it; a split unit needs "
            f"{AC_CEILING_CLEARANCE_MM:.0f} to draw air in"
        )

    for other in others:
        if other.id != saved.id and _collides(saved, other):
            raise RuntimeError(f"{item.tag} collides with {other.name}")


def save_bedroom_furniture(path: Path, items: tuple[BedroomFurniture, ...]) -> dict[str, str]:
    """Validate a private clone, reopen it, then atomically publish the furniture."""
    path = path.resolve()
    original = path.read_bytes()
    model = ifcopenshell.file.from_string(original.decode())
    check_tags_are_free(model, {item.tag: item.room_id for item in items})
    ids = author_bedroom_furniture(model, items)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".ifc", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        model.write(str(temporary))
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        reopened = HomeTwin.open(temporary)
        rooms = {room.id: reopened.get_room_context(room.id) for room in reopened.get_rooms()}
        for item in items:
            context = rooms[item.room_id]
            objects = [*context.furniture, *context.obstructions]
            saved = next((obj for obj in objects if obj.id == ids[item.tag]), None)
            if saved is None:
                raise RuntimeError(f"{item.tag} was not queryable after IFC reload")
            _check_saved(item, saved, context, objects)
        if path.read_bytes() != original:
            raise RuntimeError("The IFC changed while bedroom furniture was prepared")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return ids
