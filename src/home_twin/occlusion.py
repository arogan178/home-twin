"""Shadow-ray occlusion against a room's known solids.

This is deliberately not a renderer. It answers one question: does a straight
line from a fixture to a point pass through something solid? The solids are the
ones the model already knows about, reduced to boxes and vertical wall panels,
so a shadow test costs a few dozen arithmetic operations rather than a mesh
traversal.

Adding occlusion to the existing direct estimate is a fidelity step inside the
same tier: still no inter-reflection, still no material response. Radiance
remains the answer when a number has to be defended. See
``docs/lighting-design.md``.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot

from home_twin.model import Bounds3D, ObjectKind, Opening, Point3D, RoomContext

OCCLUSION_METHOD = "direct_occluded_v1"

# A fixture sits in the ceiling plane, so a shadow ray starts a little below it
# to avoid grazing the ceiling slab it is recessed into.
RAY_START_DROP_MM = 5.0
# Solids are tested with a small inset so a sample sitting exactly on a cabinet
# face is not reported as being in its own shadow.
SURFACE_EPSILON_MM = 1.0


# The solid part of a shower enclosure; scripts author the tray at this height.
SHOWER_TRAY_MM = 70.0


@dataclass(frozen=True, slots=True)
class BoxOccluder:
    """An axis-aligned solid, such as tall cabinetry or a stair mass."""

    id: str
    kind: str
    bounds: Bounds3D


@dataclass(frozen=True, slots=True)
class PanelOccluder:
    """A vertical wall panel with its openings cut out.

    ``gaps`` are spans along the panel, measured from ``start``, that a ray can
    pass through: a doorway is a hole and glazing is treated as one too, because
    a pane does not stop a beam.
    """

    id: str
    start: tuple[float, float]
    end: tuple[float, float]
    base_z: float
    top_z: float
    gaps: tuple[tuple[float, float, float, float], ...] = ()


@dataclass(frozen=True, slots=True)
class SlabOccluder:
    """Gypsum hanging below the slab: solid from its underside up to it.

    A bulkhead is not a surface but a prism, and a beam crossing it is blocked
    whatever angle it arrives at.
    """

    id: str
    kind: str
    footprint: tuple[tuple[float, float], ...]
    base_z: float
    top_z: float


@dataclass(frozen=True, slots=True)
class OccluderSet:
    boxes: tuple[BoxOccluder, ...]
    panels: tuple[PanelOccluder, ...]
    slabs: tuple[SlabOccluder, ...] = ()

    @property
    def empty(self) -> bool:
        return not self.boxes and not self.panels and not self.slabs

    @property
    def summary(self) -> tuple[str, ...]:
        kinds = sorted({box.kind for box in self.boxes})
        parts = [f"{len(self.boxes)} solid(s): {', '.join(kinds)}" if self.boxes else "no solids"]
        parts.append(f"{len(self.panels)} wall panel(s)")
        if self.slabs:
            parts.append(f"{len(self.slabs)} gypsum prism(s)")
        return tuple(parts)


def _opening_span(opening: Opening, start: tuple[float, float], end: tuple[float, float]) -> tuple[float, float] | None:
    """Project an opening onto a wall panel, as a span from ``start``."""

    length = hypot(end[0] - start[0], end[1] - start[1])
    if length <= 0:
        return None
    ux, uy = (end[0] - start[0]) / length, (end[1] - start[1]) / length
    first = (opening.start.x - start[0]) * ux + (opening.start.y - start[1]) * uy
    second = (opening.end.x - start[0]) * ux + (opening.end.y - start[1]) * uy
    low, high = sorted((first, second))
    low, high = max(low, 0.0), min(high, length)
    return (low, high) if high - low > 1.0 else None


def collect_occluders(
    context: RoomContext,
    *,
    minimum_height_mm: float = 0.0,
    include_walls: bool = True,
) -> OccluderSet:
    """Reduce a room to the solids that can cast a shadow onto a horizontal plane.

    ``minimum_height_mm`` drops objects whose top is at or below the plane being
    lit: a 750 mm dining table cannot shade an 800 mm task plane.
    """

    boxes: list[BoxOccluder] = []
    seen: set[str] = set()
    for obj in (*context.furniture, *context.obstructions):
        if obj.id in seen:
            continue
        seen.add(obj.id)
        if obj.bounds.maximum.z <= minimum_height_mm + SURFACE_EPSILON_MM:
            continue
        if obj.kind is ObjectKind.SHADOW_GAP:
            # A shadow gap is a ceiling recess, not a solid in the light path.
            continue
        bounds = obj.bounds
        if obj.properties.get("Pset_HomeTwinWetRoom.Role") == "shower":
            # A shower's envelope is mostly glass, which casts no shadow worth
            # modelling; only the tray is solid. Left whole, a 2 m box hides the
            # fitting over it from the entire room.
            top = min(bounds.maximum.z, bounds.minimum.z + SHOWER_TRAY_MM)
            if top <= minimum_height_mm + SURFACE_EPSILON_MM:
                continue
            bounds = Bounds3D(bounds.minimum, Point3D(bounds.maximum.x, bounds.maximum.y, top))
        boxes.append(BoxOccluder(obj.id, obj.kind.value, bounds))
    for stair in context.stairs:
        if stair.bounds.maximum.z <= minimum_height_mm + SURFACE_EPSILON_MM:
            continue
        boxes.append(BoxOccluder(stair.id, "stair", stair.bounds))

    panels: list[PanelOccluder] = []
    if include_walls:
        floor_z = context.room.elevation_mm
        top_z = context.ceiling.elevation_mm
        by_wall: dict[str, list[Opening]] = {}
        for opening in context.openings:
            by_wall.setdefault(opening.host_wall_id, []).append(opening)
        for wall in context.walls:
            start = (wall.start.x, wall.start.y)
            end = (wall.end.x, wall.end.y)
            gaps = []
            for opening in by_wall.get(wall.wall_id, ()):
                span = _opening_span(opening, start, end)
                if span is None:
                    continue
                gaps.append((span[0], span[1], floor_z + opening.sill_height_mm, floor_z + opening.head_height_mm))
            panels.append(PanelOccluder(wall.wall_id, start, end, floor_z, top_z, tuple(gaps)))

    slabs: list[SlabOccluder] = []
    slab_top = context.ceiling.structural_elevation_mm or context.ceiling.elevation_mm
    for soffit in context.soffits:
        if soffit.elevation_mm <= minimum_height_mm + SURFACE_EPSILON_MM:
            continue
        top = max(slab_top, soffit.elevation_mm + 12)
        footprint = tuple((point.x, point.y) for point in soffit.footprint.outer)
        slabs.append(SlabOccluder(soffit.id, soffit.kind, footprint, soffit.elevation_mm, top))
    return OccluderSet(tuple(boxes), tuple(panels), tuple(slabs))


def _segment_hits_box(origin: Point3D, target: Point3D, bounds: Bounds3D) -> bool:
    """Slab test for a finite segment against an axis-aligned box."""

    low = (
        bounds.minimum.x + SURFACE_EPSILON_MM,
        bounds.minimum.y + SURFACE_EPSILON_MM,
        bounds.minimum.z + SURFACE_EPSILON_MM,
    )
    high = (
        bounds.maximum.x - SURFACE_EPSILON_MM,
        bounds.maximum.y - SURFACE_EPSILON_MM,
        bounds.maximum.z - SURFACE_EPSILON_MM,
    )
    if any(high[axis] <= low[axis] for axis in range(3)):
        return False
    start = (origin.x, origin.y, origin.z)
    delta = (target.x - origin.x, target.y - origin.y, target.z - origin.z)
    enter, exit_ = 0.0, 1.0
    for axis in range(3):
        if abs(delta[axis]) < 1e-12:
            if not low[axis] <= start[axis] <= high[axis]:
                return False
            continue
        t0 = (low[axis] - start[axis]) / delta[axis]
        t1 = (high[axis] - start[axis]) / delta[axis]
        if t0 > t1:
            t0, t1 = t1, t0
        enter = max(enter, t0)
        exit_ = min(exit_, t1)
        if enter > exit_:
            return False
    return exit_ > enter


def _segment_hits_panel(origin: Point3D, target: Point3D, panel: PanelOccluder) -> bool:
    """Intersect a finite segment with a vertical wall panel, minus its openings."""

    ax, ay = panel.start
    bx, by = panel.end
    ex, ey = bx - ax, by - ay
    length = hypot(ex, ey)
    if length <= 0:
        return False
    nx, ny = ey / length, -ex / length
    d0 = (origin.x - ax) * nx + (origin.y - ay) * ny
    d1 = (target.x - ax) * nx + (target.y - ay) * ny
    if (d0 > 0) == (d1 > 0):
        return False
    denominator = d0 - d1
    if abs(denominator) < 1e-12:
        return False
    t = d0 / denominator
    if not 0.0 < t < 1.0:
        return False
    hit_x = origin.x + t * (target.x - origin.x)
    hit_y = origin.y + t * (target.y - origin.y)
    hit_z = origin.z + t * (target.z - origin.z)
    along = (hit_x - ax) * (ex / length) + (hit_y - ay) * (ey / length)
    if not -SURFACE_EPSILON_MM <= along <= length + SURFACE_EPSILON_MM:
        return False
    if not panel.base_z - SURFACE_EPSILON_MM <= hit_z <= panel.top_z + SURFACE_EPSILON_MM:
        return False
    for gap_start, gap_end, sill, head in panel.gaps:
        if gap_start <= along <= gap_end and sill <= hit_z <= head:
            return False
    return True


def is_shadowed(origin: Point3D, target: Point3D, occluders: OccluderSet) -> bool:
    """True when a straight line from ``origin`` to ``target`` meets a solid."""

    if any(_segment_hits_box(origin, target, box.bounds) for box in occluders.boxes):
        return True
    if any(_segment_hits_panel(origin, target, panel) for panel in occluders.panels):
        return True
    return any(_segment_hits_slab(origin, target, slab) for slab in occluders.slabs)


def _segment_hits_slab(origin: Point3D, target: Point3D, slab: SlabOccluder) -> bool:
    """Whether the segment passes through a gypsum prism.

    The segment is clipped to the prism's height band first, then tested in
    plan: a prism is a polygon extruded vertically, so the two are separable.
    """

    low = slab.base_z + SURFACE_EPSILON_MM
    high = slab.top_z - SURFACE_EPSILON_MM
    if high <= low:
        return False
    dz = target.z - origin.z
    if abs(dz) < 1e-9:
        if not low <= origin.z <= high:
            return False
        start, end = 0.0, 1.0
    else:
        first = (low - origin.z) / dz
        second = (high - origin.z) / dz
        start, end = (first, second) if first <= second else (second, first)
        start = max(start, 0.0)
        end = min(end, 1.0)
        if start >= end:
            return False

    def at(parameter: float) -> tuple[float, float]:
        return (
            origin.x + (target.x - origin.x) * parameter,
            origin.y + (target.y - origin.y) * parameter,
        )

    entry, exit_ = at(start), at(end)
    if _point_in_ring(entry, slab.footprint) or _point_in_ring(exit_, slab.footprint):
        return True
    ring = slab.footprint
    return any(
        _segments_cross(entry, exit_, ring[index], ring[(index + 1) % len(ring)])
        for index in range(len(ring))
    )


def _point_in_ring(point: tuple[float, float], ring: tuple[tuple[float, float], ...]) -> bool:
    inside = False
    for index in range(len(ring)):
        first = ring[index]
        second = ring[(index + 1) % len(ring)]
        if (first[1] > point[1]) != (second[1] > point[1]):
            crossing = first[0] + (point[1] - first[1]) * (second[0] - first[0]) / (second[1] - first[1])
            if point[0] < crossing:
                inside = not inside
    return inside


def _segments_cross(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> bool:
    def side(p: tuple[float, float], q: tuple[float, float], r: tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2 = side(c, d, a), side(c, d, b)
    d3, d4 = side(a, b, c), side(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def shadow_ray_origin(point: Point3D) -> Point3D:
    """A fixture's ray origin, dropped clear of the ceiling it is recessed into."""

    return Point3D(point.x, point.y, point.z - RAY_START_DROP_MM)
