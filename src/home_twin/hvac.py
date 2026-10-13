"""Split-system air conditioning authored into IFC: the units and the line sets between them.

A unit is a design envelope placed in the building frame. ``centre_mm`` is the
plan centre with ``z`` at the underside, and the front is the local ``-Y`` face:
a unit hung on a wall has its back along local ``+Y``, and ``rotation_deg``
turns it anticlockwise on plan.

A line set is the liquid and gas copper and the interconnecting cable, with the
condensate drain alongside unless it is run separately. It is authored as one run per room it
passes through, because a product is filed in one room and that room's view
should show what crosses it. A run is a centreline route with an enclosure for
every leg, and its body is that enclosure rather than the copper inside it: a
gypsum box is what the room has to give up, not a 12.7 mm tube.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from math import cos, dist, hypot, isfinite, radians, sin
from pathlib import Path
from typing import Literal

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

from home_twin.bedroom import AC_CEILING_CLEARANCE_MM
from home_twin.furniture import box_solid, check_tags_are_free
from home_twin.geometry import point_in_polygon, polygon_edge_distance
from home_twin.model import BuildingObject, HomeTwin, ObjectKind, Point2D, Point3D, Polygon2D, RoomContext

UnitSection = Literal["indoor", "outdoor"]
Enclosure = Literal["wall_core", "gypsum_box", "trunking", "clipped"]
Condensate = Literal["gravity", "pump", "separate"]

PSET = "Pset_HomeTwinHvac"
# Outer size of each enclosure as (across the run, vertical); a core is round.
# Trunking stands 60 mm off the wall and keeps its 100 mm face on the wall when
# it turns down it. Clipped copper is the insulated pair taped together and
# clipped straight to the wall, 30 mm off it and 55 mm tall.
ENCLOSURE_MM: dict[str, tuple[float, float]] = {
    "wall_core": (80.0, 80.0),
    "gypsum_box": (150.0, 150.0),
    "trunking": (60.0, 100.0),
    "clipped": (30.0, 55.0),
}
# A drain that falls less than this holds water in every sag between supports.
CONDENSATE_FALL = 0.01
# The insulated drain's outside diameter. What an enclosure has above it is how
# far the drain can fall inside it.
DRAIN_MM = 40.0
# A run may start or end this far outside its room, because that leg is the
# core through the wall into the next one.
WALL_REACH_MM = 300.0
# How far a line set's first and last points may sit from the units they join.
CONNECTION_REACH_MM = 150.0


def _finite(*values: float) -> bool:
    return all(isfinite(value) for value in values)


@dataclass(frozen=True, slots=True)
class SplitUnit:
    tag: str
    room_id: str
    section: UnitSection
    centre_mm: Point3D
    """Plan centre; ``z`` is the underside, which for an outdoor unit is the top of its stand."""
    width_mm: float
    depth_mm: float
    height_mm: float
    rotation_deg: float = 0.0
    """Anticlockwise on plan. The front, and an outdoor unit's discharge, is the local ``-Y`` face."""
    capacity_kw: float | None = None
    """Nominal cooling class. A label for the envelope chosen, not a heat-load result."""
    serves: tuple[str, ...] = ()
    """An outdoor unit's indoor units, by tag. Two makes it a dual split."""
    product: str | None = None

    def __post_init__(self) -> None:
        if not self.tag or not self.room_id:
            raise ValueError("A split unit needs a tag and IFC room id")
        if self.section not in ("indoor", "outdoor"):
            raise ValueError("A split unit is indoor or outdoor")
        values = (self.centre_mm.x, self.centre_mm.y, self.centre_mm.z, self.rotation_deg)
        sizes = (self.width_mm, self.depth_mm, self.height_mm)
        if not _finite(*values, *sizes) or min(sizes) <= 0:
            raise ValueError("Split unit geometry must be finite and positive")
        if self.capacity_kw is not None and (not isfinite(self.capacity_kw) or self.capacity_kw <= 0):
            raise ValueError("A stated capacity must be positive")
        if (self.section == "outdoor") != bool(self.serves):
            raise ValueError("An outdoor unit serves one or more indoor units, and only it does")
        if len(set(self.serves)) != len(self.serves):
            raise ValueError("An outdoor unit serves each indoor unit once")


@dataclass(frozen=True, slots=True)
class LineSetRun:
    tag: str
    room_id: str
    indoor_tag: str
    outdoor_tag: str
    sequence: int
    """Position along the line set, counted from the indoor unit at 1."""
    route_mm: tuple[Point3D, ...]
    legs: tuple[Enclosure, ...]
    """The enclosure of each leg, one per pair of consecutive route points."""
    liquid_od_mm: float
    gas_od_mm: float
    condensate: Condensate = "gravity"
    """``pump`` lets the route rise until its highest point, which only a lift at the unit allows.

    ``separate`` means the drain does not travel with the line set, so its route
    places no fall on the copper.
    """
    condensate_outlet: int | None = None
    """The route point where the drain leaves the bundle; the legs after it carry refrigerant only."""

    def __post_init__(self) -> None:
        if not self.tag or not self.room_id or not self.indoor_tag or not self.outdoor_tag:
            raise ValueError("A line-set run needs a tag, a room and the two units it joins")
        if self.sequence < 1:
            raise ValueError("A line set is counted from 1 at its indoor unit")
        if len(self.route_mm) < 2 or len(self.legs) != len(self.route_mm) - 1:
            raise ValueError("A run needs two or more route points and one enclosure per leg")
        if any(leg not in ENCLOSURE_MM for leg in self.legs):
            raise ValueError("Unknown line-set enclosure")
        if not _finite(*(value for p in self.route_mm for value in (p.x, p.y, p.z))):
            raise ValueError("A run's route must be finite")
        if any(a == b for a, b in zip(self.route_mm, self.route_mm[1:], strict=False)):
            raise ValueError("A leg must have length")
        if not _finite(self.liquid_od_mm, self.gas_od_mm) or not 0 < self.liquid_od_mm < self.gas_od_mm:
            raise ValueError("The liquid line is the smaller of two positive diameters")
        if self.condensate == "pump" and self.sequence != 1:
            raise ValueError("A condensate pump sits at the indoor unit, so only the first run can lift")
        if self.condensate == "separate" and self.condensate_outlet is not None:
            raise ValueError("A drain run separately has no outlet on the line set")
        if self.condensate_outlet is not None and not 0 < self.condensate_outlet < len(self.route_mm):
            raise ValueError("The condensate leaves the bundle at one of the run's later route points")

    @property
    def length_mm(self) -> float:
        return sum(_leg_length(a, b) for a, b in zip(self.route_mm, self.route_mm[1:], strict=False))


def _leg_length(a: Point3D, b: Point3D) -> float:
    return dist((a.x, a.y, a.z), (b.x, b.y, b.z))


def condensate_fault(runs: tuple[LineSetRun, ...]) -> str | None:
    """Why a line set's drain would hold water, or None when it falls all the way to its outlet.

    The drain rides inside the enclosures, so a level gypsum box is not a level
    drain: it falls within the box's height for as long as that lasts. It is
    walked as high as each enclosure allows, must drop at least 1 in 100 of every
    leg's plan length, and must never leave the enclosure it is in. A pumped line
    set is walked from its highest point, which is where the lift delivers it.
    """
    if runs[0].condensate == "separate":
        return None
    route = [runs[0].route_mm[0]]
    legs: list[tuple[str, str, int]] = []
    for run in runs:
        route.extend(run.route_mm[1:])
        legs.extend((run.tag, leg, index + 1) for index, leg in enumerate(run.legs))
    last = runs[-1]
    end = len(route) - 1
    if last.condensate_outlet is not None:
        end -= len(last.route_mm) - 1 - last.condensate_outlet
    start = 0
    if runs[0].condensate == "pump":
        start = max(range(end + 1), key=lambda index: (route[index].z, -index))
    drain: float | None = None
    for index in range(start, end):
        a, b = route[index], route[index + 1]
        tag, enclosure, number = legs[index]
        room = (ENCLOSURE_MM[enclosure][1] - DRAIN_MM) / 2
        drain = a.z + room if drain is None else min(drain, a.z + room)
        if drain < a.z - room - 1e-6:
            return f"{tag} leg {number} starts above the drain in its {enclosure}"
        drain = min(drain - CONDENSATE_FALL * hypot(b.x - a.x, b.y - a.y), b.z + room)
        if drain < b.z - room - 1e-6:
            if b.z > a.z:
                return f"{tag} leg {number} rises above its drain"
            return f"{tag} leg {number} runs out of {enclosure} height for a 1 in 100 fall"
    return None


def _horizontal(direction: np.ndarray) -> np.ndarray | None:
    flat = np.array([direction[0], direction[1], 0.0])
    length = np.linalg.norm(flat)
    return None if length < 1e-9 else flat / length


def _leg_solid(model, start: np.ndarray, end: np.ndarray, enclosure: str, beside: np.ndarray | None, unit_mm: float):
    """One leg as an extrusion along it, in local coordinates already scaled to the file's unit."""
    axis = end - start
    length = float(np.linalg.norm(axis))
    axis = axis / length
    across, vertical = (value / unit_mm for value in ENCLOSURE_MM[enclosure])
    flat = _horizontal(axis)
    if flat is not None and abs(axis[2]) < 0.9:
        # X across the run on plan, so the profile's Y comes out vertical.
        reference = np.array([-flat[1], flat[0], 0.0])
        x_dim, y_dim = across, vertical
    else:
        # A drop keeps the face it had on the wall before it turned down.
        reference = beside if beside is not None else np.array([1.0, 0.0, 0.0])
        x_dim, y_dim = vertical, across
    position = model.createIfcAxis2Placement3D(
        model.createIfcCartesianPoint(tuple(float(v) for v in start)),
        model.createIfcDirection(tuple(float(v) for v in axis)),
        model.createIfcDirection(tuple(float(v) for v in reference)),
    )
    profile = (
        model.createIfcCircleProfileDef("AREA", None, None, across / 2)
        if enclosure == "wall_core"
        else model.createIfcRectangleProfileDef("AREA", None, None, x_dim, y_dim)
    )
    return model.createIfcExtrudedAreaSolid(profile, position, model.createIfcDirection((0.0, 0.0, 1.0)), length)


def _run_items(model, run: LineSetRun, unit_mm: float) -> list:
    origin = np.array([run.route_mm[0].x, run.route_mm[0].y, run.route_mm[0].z])
    points = [(np.array([p.x, p.y, p.z]) - origin) / unit_mm for p in run.route_mm]
    directions = [b - a for a, b in zip(points, points[1:], strict=False)]
    solids = []
    for index, (a, b) in enumerate(zip(points, points[1:], strict=False)):
        axis = (b - a) / np.linalg.norm(b - a)
        # Lap each leg into its neighbours so a turn reads as one box, not a notch.
        lap = max(ENCLOSURE_MM[run.legs[index]]) / 2 / unit_mm
        start = a - axis * lap if index > 0 else a
        end = b + axis * lap if index < len(points) - 2 else b
        beside = next(
            (
                flat
                for neighbour in (index - 1, index + 1)
                if 0 <= neighbour < len(directions)
                and (flat := _horizontal(directions[neighbour])) is not None
                and abs(directions[neighbour][2]) < 0.9 * np.linalg.norm(directions[neighbour])
            ),
            None,
        )
        solids.append(_leg_solid(model, start, end, run.legs[index], beside, unit_mm))
    return solids


def _unit_items(model, unit: SplitUnit, unit_mm: float) -> list:
    w, d, h = unit.width_mm, unit.depth_mm, unit.height_mm

    def box(width: float, depth: float, height: float, x: float, y: float, z: float, radius: float = 0):
        return box_solid(model, *(value / unit_mm for value in (width, depth, height, x, y, z, radius)))

    if unit.section == "indoor":
        # The same body-and-louvre form as the bedroom's AC01, so the three read as one family.
        return [box(w, d, h - 40, 0, 0, 40, 14), box(w - 40, d - 45, 40, 0, -22, 0, 8)]
    # A cabinet with its fan guard proud of the discharge face.
    guard = min(h, w * 0.6) * 0.8
    return [box(w, d - 20, h, 0, 10, 0, 10), box(guard, 20, guard, -w * 0.12, -(d - 20) / 2, (h - guard) / 2, 6)]


def _upsert(model, ifc_class: str, predefined_type: str, tag: str, name: str):
    matches = [product for product in model.by_type(ifc_class) if getattr(product, "Tag", None) == tag]
    if len(matches) > 1:
        raise ValueError(f"Duplicate HVAC tag {tag}")
    entity = matches[0] if matches else ifcopenshell.api.run(
        "root.create_entity", model, ifc_class=ifc_class, predefined_type=predefined_type, name=name
    )
    entity.Tag = tag
    entity.PredefinedType = predefined_type
    return entity


def _place(model, entity, body, items, frame, centre: Point3D, rotation_deg: float, room_id: str) -> None:
    if entity.Representation:
        for representation in list(entity.Representation.Representations):
            ifcopenshell.api.run(
                "geometry.unassign_representation", model, product=entity, representation=representation
            )
            ifcopenshell.api.run("geometry.remove_representation", model, representation=representation)
    representation = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", items)
    ifcopenshell.api.run("geometry.assign_representation", model, product=entity, representation=representation)
    angle = radians(rotation_deg)
    matrix = np.eye(4)
    matrix[:2, :2] = ((cos(angle), -sin(angle)), (sin(angle), cos(angle)))
    matrix[:3, 3] = np.array([centre.x, centre.y, centre.z]) / 1000
    ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=frame @ matrix, is_si=True)
    room = model.by_guid(room_id)
    ifcopenshell.api.run("spatial.assign_container", model, products=[entity], relating_structure=room)


def _write_psets(model, entity, psets: dict[str, dict[str, object]]) -> None:
    existing = {
        relation.RelatingPropertyDefinition.Name: relation.RelatingPropertyDefinition
        for relation in entity.IsDefinedBy
        if relation.is_a("IfcRelDefinesByProperties")
    }
    for name, properties in psets.items():
        pset = existing.get(name) or ifcopenshell.api.run("pset.add_pset", model, product=entity, name=name)
        ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties=properties)


def author_split_systems(
    model: ifcopenshell.file, units: tuple[SplitUnit, ...], runs: tuple[LineSetRun, ...]
) -> dict[str, str]:
    """Edit a private IFC clone. The caller owns validation and publication."""
    tags = [item.tag for item in (*units, *runs)]
    if len(set(tags)) != len(tags):
        raise ValueError("HVAC tags must be unique")
    unit_mm = ifcopenshell.util.unit.calculate_unit_scale(model) * 1000
    building = model.by_type("IfcBuilding")[0]
    frame = ifcopenshell.util.placement.get_local_placement(building.ObjectPlacement)
    frame[:3, 3] *= unit_mm / 1000
    body = next(c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    ids: dict[str, str] = {}

    for unit in units:
        # IFC4 names the split system, and both halves are parts of one.
        entity = _upsert(model, "IfcUnitaryEquipment", "SPLITSYSTEM", unit.tag, f"AC {unit.section} unit {unit.tag}")
        items = _unit_items(model, unit, unit_mm)
        _place(model, entity, body, items, frame, unit.centre_mm, unit.rotation_deg, unit.room_id)
        _write_psets(model, entity, {
            PSET: {
                "Role": f"{unit.section}_unit",
                "RepresentationMethod": "design_envelope",
                "RotationDegrees": unit.rotation_deg,
                "WidthMm": unit.width_mm,
                "DepthMm": unit.depth_mm,
                "HeightMm": unit.height_mm,
                "NominalCapacityKw": unit.capacity_kw,
                "Serves": ",".join(unit.serves) or None,
                "Product": unit.product,
            },
            "Pset_HomeTwin": {"ObjectKind": "ac"},
        })
        ids[unit.tag] = entity.GlobalId

    for run in runs:
        entity = _upsert(model, "IfcPipeSegment", "RIGIDSEGMENT", run.tag, f"Line set {run.tag}")
        _place(model, entity, body, _run_items(model, run, unit_mm), frame, run.route_mm[0], 0.0, run.room_id)
        _write_psets(model, entity, {
            PSET: {
                "Role": "line_set",
                "RepresentationMethod": "design_envelope",
                "IndoorTag": run.indoor_tag,
                "OutdoorTag": run.outdoor_tag,
                "Sequence": run.sequence,
                "RouteMm": ";".join(f"{p.x:g},{p.y:g},{p.z:g}" for p in run.route_mm),
                "Legs": ";".join(run.legs),
                "LiquidOdMm": run.liquid_od_mm,
                "GasOdMm": run.gas_od_mm,
                "Condensate": run.condensate,
                "CondensateOutlet": run.condensate_outlet,
                "LengthMm": round(run.length_mm),
            },
            "Pset_HomeTwin": {"ObjectKind": "pipe"},
        })
        ids[run.tag] = entity.GlobalId

    # A save is the whole installation. Upserting alone would leave a unit taken
    # out of the design standing in the model.
    for product in _authored_here(model):
        if product.GlobalId not in ids.values():
            ifcopenshell.api.run("root.remove_product", model, product=product)
    return ids


def _authored_here(model: ifcopenshell.file) -> list[ifcopenshell.entity_instance]:
    """Every product this module wrote, which is every one carrying its property set."""
    return [
        product
        for ifc_class in ("IfcUnitaryEquipment", "IfcPipeSegment")
        for product in model.by_type(ifc_class)
        if any(
            relation.is_a("IfcRelDefinesByProperties") and relation.RelatingPropertyDefinition.Name == PSET
            for relation in product.IsDefinedBy
        )
    ]


def _inside_or_near(point: Point2D, context: RoomContext, reach_mm: float) -> bool:
    polygon = context.ceiling.polygon
    return point_in_polygon(point, polygon) or polygon_edge_distance(point, polygon) <= reach_mm


def _footprint_points(obj: BuildingObject) -> tuple[Point2D, ...]:
    if obj.plan_footprint is not None:
        return obj.plan_footprint.outer
    a, b = obj.bounds.minimum, obj.bounds.maximum
    return tuple(Point2D(x, y) for x in (a.x, b.x) for y in (a.y, b.y))


def _box_distance(point: Point3D, obj: BuildingObject) -> float:
    a, b = obj.bounds.minimum, obj.bounds.maximum
    axes = ((point.x, a.x, b.x), (point.y, a.y, b.y), (point.z, a.z, b.z))
    return dist((0.0, 0.0, 0.0), tuple(max(low - value, 0.0, value - high) for value, low, high in axes))


def _overlaps(first: BuildingObject, second: BuildingObject) -> bool:
    """Whether two solids share volume, judged on their plan hulls rather than their boxes.

    Two outdoor units turned 45 degrees and set 250 mm apart have boxes that
    overlap by 20 mm; their hulls do not.
    """
    a, b = first.bounds, second.bounds
    if min(a.maximum.z, b.maximum.z) - max(a.minimum.z, b.minimum.z) <= 1.0:
        return False
    rings = (_footprint_points(first), _footprint_points(second))
    for ring in rings:
        for start, end in zip(ring, (*ring[1:], ring[0]), strict=False):
            normal = (start.y - end.y, end.x - start.x)
            length = hypot(*normal)
            if length < 1e-9:
                continue
            spans = [[(p.x * normal[0] + p.y * normal[1]) / length for p in other] for other in rings]
            if min(max(spans[0]), max(spans[1])) - max(min(spans[0]), min(spans[1])) <= 1.0:
                return False
    return True


def _run_hits(run: LineSetRun, obj: BuildingObject) -> bool:
    """Whether any leg's enclosure passes through the object, sampled every 25 mm.

    Judged against the object's plan hull where it has one: a unit turned 45
    degrees has a box half as wide again as itself.
    """
    hull = Polygon2D(_footprint_points(obj))
    low, high = obj.bounds.minimum.z, obj.bounds.maximum.z
    for index, (a, b) in enumerate(zip(run.route_mm, run.route_mm[1:], strict=False)):
        half = max(ENCLOSURE_MM[run.legs[index]]) / 2 - 1.0
        steps = max(int(_leg_length(a, b) // 25), 1)
        for step in range(steps + 1):
            t = step / steps
            z = a.z + (b.z - a.z) * t
            if z < low - half or z > high + half:
                continue
            plan = Point2D(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
            if point_in_polygon(plan, hull) or polygon_edge_distance(plan, hull) < half:
                return True
    return False


def _check_unit(unit: SplitUnit, saved: BuildingObject, context: RoomContext, others: list[BuildingObject]) -> None:
    if saved.kind != ObjectKind.AC:
        raise RuntimeError(f"{unit.tag} reopened as {saved.kind}, expected {ObjectKind.AC}")
    if not all(_inside_or_near(point, context, 1.0) for point in _footprint_points(saved)):
        raise RuntimeError(f"{unit.tag} footprint is outside its room")
    floor, ceiling = context.room.elevation_mm, context.ceiling.elevation_mm
    bottom, top = saved.bounds.minimum.z, saved.bounds.maximum.z
    if bottom < floor - 1 or top > ceiling + 1:
        raise RuntimeError(f"{unit.tag} is outside the room's vertical extent")
    if unit.section == "indoor":
        if bottom <= floor + 1:
            raise RuntimeError(f"{unit.tag} is a wall unit but reaches the floor")
        if top > ceiling - AC_CEILING_CLEARANCE_MM:
            raise RuntimeError(
                f"{unit.tag} leaves {ceiling - top:.0f} mm over it; a split unit needs "
                f"{AC_CEILING_CLEARANCE_MM:.0f} to draw air in"
            )
    for other in others:
        if other.id != saved.id and other.kind != ObjectKind.PIPE and _overlaps(saved, other):
            raise RuntimeError(f"{unit.tag} collides with {other.name}")


def _check_run(
    run: LineSetRun, saved: BuildingObject, context: RoomContext, others: list[BuildingObject], joined: set[str]
) -> None:
    if saved.kind != ObjectKind.PIPE:
        raise RuntimeError(f"{run.tag} reopened as {saved.kind}, expected {ObjectKind.PIPE}")
    plan = [Point2D(p.x, p.y) for p in run.route_mm]
    if not all(_inside_or_near(point, context, 1.0) for point in plan[1:-1]):
        raise RuntimeError(f"{run.tag} route leaves its room between its ends")
    if not all(_inside_or_near(point, context, WALL_REACH_MM) for point in (plan[0], plan[-1])):
        raise RuntimeError(f"{run.tag} starts or ends further outside its room than a wall is thick")
    floor = context.room.elevation_mm
    ceiling = context.ceiling.structural_elevation_mm or context.ceiling.elevation_mm
    if any(p.z < floor - 1 or p.z > ceiling + 1 for p in run.route_mm):
        raise RuntimeError(f"{run.tag} route leaves the room's vertical extent")
    for other in others:
        if other.id != saved.id and other.id not in joined and other.kind != ObjectKind.PIPE and _run_hits(run, other):
            raise RuntimeError(f"{run.tag} runs through {other.name}")


def _check_line_sets(runs: tuple[LineSetRun, ...], units: dict[str, BuildingObject]) -> None:
    """Each line set must be whole: counted from 1, joined end to end, and landing on both units."""
    by_indoor: dict[str, list[LineSetRun]] = {}
    for run in runs:
        by_indoor.setdefault(run.indoor_tag, []).append(run)
    for indoor_tag, chain in by_indoor.items():
        chain.sort(key=lambda run: run.sequence)
        if [run.sequence for run in chain] != list(range(1, len(chain) + 1)):
            raise RuntimeError(f"The line set from {indoor_tag} is not numbered 1 to {len(chain)}")
        if len({run.outdoor_tag for run in chain}) != 1:
            raise RuntimeError(f"The line set from {indoor_tag} names more than one outdoor unit")
        outdoor_tag = chain[0].outdoor_tag
        if indoor_tag not in units or outdoor_tag not in units:
            raise RuntimeError(f"The line set from {indoor_tag} to {outdoor_tag} is missing one of its units")
        outdoor = units[outdoor_tag]
        if indoor_tag not in str(outdoor.properties.get(f"{PSET}.Serves", "")).split(","):
            raise RuntimeError(f"{outdoor_tag} does not serve {indoor_tag}")
        if len({run.condensate == "separate" for run in chain}) != 1:
            raise RuntimeError(f"The line set from {indoor_tag} carries its drain in some runs and not others")
        if any(run.condensate_outlet is not None for run in chain[:-1]):
            raise RuntimeError(f"The line set from {indoor_tag} drops its condensate before its last run")
        if len({(run.liquid_od_mm, run.gas_od_mm) for run in chain}) != 1:
            raise RuntimeError(f"The line set from {indoor_tag} changes pipe size between runs")
        for before, after in zip(chain, chain[1:], strict=False):
            if _leg_length(before.route_mm[-1], after.route_mm[0]) > 1.0:
                raise RuntimeError(f"{before.tag} does not meet {after.tag}")
        if (fault := condensate_fault(tuple(chain))) is not None:
            raise RuntimeError(f"The line set from {indoor_tag} would hold condensate: {fault}")
        if _box_distance(chain[0].route_mm[0], units[indoor_tag]) > CONNECTION_REACH_MM:
            raise RuntimeError(f"{chain[0].tag} does not start at {indoor_tag}")
        if _box_distance(chain[-1].route_mm[-1], outdoor) > CONNECTION_REACH_MM:
            raise RuntimeError(f"{chain[-1].tag} does not end at {outdoor_tag}")


def save_split_systems(
    path: Path, units: tuple[SplitUnit, ...], runs: tuple[LineSetRun, ...]
) -> dict[str, str]:
    """Validate a private clone, reopen it, then atomically publish the units and line sets.

    A save is the whole installation: a unit or run this module authored that
    the save omits is removed. A line set must be saved whole; its indoor unit
    may already be in the model under another module, as the main bedroom's AC01 is.
    """
    path = path.resolve()
    original = path.read_bytes()
    model = ifcopenshell.file.from_string(original.decode())
    # A run may move room when its route changes; the guard is for tags other modules own.
    own = {product.Tag for product in _authored_here(model)}
    check_tags_are_free(model, {item.tag: item.room_id for item in (*units, *runs) if item.tag not in own})
    ids = author_split_systems(model, units, runs)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".ifc", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        model.write(str(temporary))
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        reopened = HomeTwin.open(temporary)
        rooms = {room.id: reopened.get_room_context(room.id) for room in reopened.get_rooms()}
        plant = {
            product.Tag: reopened.get_object(product.GlobalId)
            for product in model.by_type("IfcUnitaryEquipment")
            if product.Tag
        }
        _check_line_sets(runs, plant)
        for item in (*units, *runs):
            context = rooms[item.room_id]
            objects = [*context.furniture, *context.obstructions]
            saved = next((obj for obj in objects if obj.id == ids[item.tag]), None)
            if saved is None:
                raise RuntimeError(f"{item.tag} was not queryable after IFC reload")
            if isinstance(item, SplitUnit):
                _check_unit(item, saved, context, objects)
            else:
                # A core must miss the doors and windows in the wall it goes through.
                openings = reopened.get_objects(room=item.room_id, type="opening")
                joined = {plant[tag].id for tag in (item.indoor_tag, item.outdoor_tag)}
                _check_run(item, saved, context, [*objects, *openings], joined)
        if path.read_bytes() != original:
            raise RuntimeError("The IFC changed while the split systems were prepared")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return ids
