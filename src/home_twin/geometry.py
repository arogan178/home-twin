"""Pure geometry in canonical millimetres."""

from __future__ import annotations

from collections.abc import Sequence
from math import sqrt

from home_twin.model import Bounds3D, Point2D, Point3D, Polygon2D, RayHit, TriangleMesh, Vector3D

EPSILON = 1e-9


def distance(a: Point3D, b: Point3D) -> float:
    return sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)


def distance_2d(a: Point2D, b: Point2D) -> float:
    return sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)


def point_segment_distance(point: Point2D, start: Point2D, end: Point2D) -> float:
    dx = end.x - start.x
    dy = end.y - start.y
    if abs(dx) < EPSILON and abs(dy) < EPSILON:
        return distance_2d(point, start)
    t = max(0.0, min(1.0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
    return distance_2d(point, Point2D(start.x + t * dx, start.y + t * dy))


def polygon_edge_distance(point: Point2D, polygon: Polygon2D) -> float:
    rings = (polygon.outer, *polygon.holes)
    return min(
        point_segment_distance(point, ring[index], ring[(index + 1) % len(ring)])
        for ring in rings
        for index in range(len(ring))
    )


def _point_in_ring(point: Point2D, ring: tuple[Point2D, ...]) -> bool:
    inside = False
    previous = ring[-1]
    for current in ring:
        if point_segment_distance(point, previous, current) <= EPSILON:
            return True
        crosses = (current.y > point.y) != (previous.y > point.y)
        if crosses:
            x_at_y = (previous.x - current.x) * (point.y - current.y) / (previous.y - current.y) + current.x
            if point.x < x_at_y:
                inside = not inside
        previous = current
    return inside


def point_in_polygon(point: Point2D, polygon: Polygon2D) -> bool:
    return _point_in_ring(point, polygon.outer) and not any(_point_in_ring(point, hole) for hole in polygon.holes)


def circle_fits_polygon(center: Point2D, radius_mm: float, polygon: Polygon2D) -> bool:
    return point_in_polygon(center, polygon) and polygon_edge_distance(center, polygon) + EPSILON >= radius_mm


def bounds_distance(a: Bounds3D, b: Bounds3D) -> float:
    dx = max(a.minimum.x - b.maximum.x, b.minimum.x - a.maximum.x, 0)
    dy = max(a.minimum.y - b.maximum.y, b.minimum.y - a.maximum.y, 0)
    dz = max(a.minimum.z - b.maximum.z, b.minimum.z - a.maximum.z, 0)
    return sqrt(dx * dx + dy * dy + dz * dz)


def convex_hull_2d(points: Sequence[Point2D]) -> tuple[Point2D, ...]:
    """Monotone chain hull, so a turned solid keeps a footprint its box loses."""
    unique = sorted({(round(p.x, 6), round(p.y, 6)) for p in points})
    if len(unique) < 3:
        return tuple(Point2D(x, y) for x, y in unique)

    def build(ordered: list[tuple[float, float]]) -> list[tuple[float, float]]:
        chain: list[tuple[float, float]] = []
        for point in ordered:
            while len(chain) >= 2:
                (ax, ay), (bx, by) = chain[-2], chain[-1]
                if (bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax) > 0:
                    break
                chain.pop()
            chain.append(point)
        return chain

    lower = build(unique)
    upper = build(unique[::-1])
    return tuple(Point2D(x, y) for x, y in lower[:-1] + upper[:-1])


def polygon_clearance(point: Point2D, polygon: Polygon2D) -> float:
    """Plan distance from a point to a footprint; zero once the point is on it."""
    if point_in_polygon(point, polygon):
        return 0.0
    return polygon_edge_distance(point, polygon)


def bounds_overlap_2d(a: Bounds3D, b: Bounds3D, clearance_mm: float = 0) -> bool:
    return not (
        a.maximum.x + clearance_mm < b.minimum.x
        or b.maximum.x + clearance_mm < a.minimum.x
        or a.maximum.y + clearance_mm < b.minimum.y
        or b.maximum.y + clearance_mm < a.minimum.y
    )


def _ring_signed_area(ring: tuple[Point2D, ...]) -> float:
    return (
        sum(
            ring[index].x * ring[(index + 1) % len(ring)].y
            - ring[(index + 1) % len(ring)].x * ring[index].y
            for index in range(len(ring))
        )
        / 2
    )


def _point_in_triangle(point: Point2D, a: Point2D, b: Point2D, c: Point2D) -> bool:
    def side(p: Point2D, q: Point2D) -> float:
        return (q.x - p.x) * (point.y - p.y) - (q.y - p.y) * (point.x - p.x)

    first, second, third = side(a, b), side(b, c), side(c, a)
    return (first >= 0 and second >= 0 and third >= 0) or (first <= 0 and second <= 0 and third <= 0)


def triangulate_ring(ring: tuple[Point2D, ...]) -> tuple[tuple[Point2D, Point2D, Point2D], ...]:
    """Split a simple polygon ring into triangles by ear clipping.

    Concave rings are supported. Holes are not: callers that need them must
    bridge the hole into the outer ring first. The result is counter-clockwise
    and covers the ring exactly, which is what a convex clip needs.
    """

    if len(ring) < 3:
        return ()
    working = list(ring if _ring_signed_area(ring) >= 0 else tuple(reversed(ring)))
    triangles: list[tuple[Point2D, Point2D, Point2D]] = []
    guard = 0
    while len(working) > 3 and guard < len(ring) * len(ring) + 16:
        guard += 1
        for index in range(len(working)):
            previous = working[index - 1]
            current = working[index]
            following = working[(index + 1) % len(working)]
            cross = (current.x - previous.x) * (following.y - previous.y) - (current.y - previous.y) * (
                following.x - previous.x
            )
            if cross <= 0:
                continue
            corners = {(index - 1) % len(working), index, (index + 1) % len(working)}
            if any(
                _point_in_triangle(point, previous, current, following)
                for offset, point in enumerate(working)
                if offset not in corners
            ):
                continue
            triangles.append((previous, current, following))
            del working[index]
            break
        else:
            break
    if len(working) == 3:
        triangles.append((working[0], working[1], working[2]))
    return tuple(triangles)


def polygon_area(polygon: Polygon2D) -> float:
    def ring_area(ring: tuple[Point2D, ...]) -> float:
        return abs(
            sum(
                ring[index].x * ring[(index + 1) % len(ring)].y
                - ring[(index + 1) % len(ring)].x * ring[index].y
                for index in range(len(ring))
            )
        ) / 2

    return ring_area(polygon.outer) - sum(ring_area(hole) for hole in polygon.holes)


def _cross(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _ray_triangle(
    origin: Point3D,
    direction: tuple[float, float, float],
    vertices: tuple[Point3D, Point3D, Point3D],
) -> float | None:
    v0, v1, v2 = vertices
    edge1 = (v1.x - v0.x, v1.y - v0.y, v1.z - v0.z)
    edge2 = (v2.x - v0.x, v2.y - v0.y, v2.z - v0.z)
    h = _cross(direction, edge2)
    determinant = _dot(edge1, h)
    if abs(determinant) < EPSILON:
        return None
    inverse = 1.0 / determinant
    s = (origin.x - v0.x, origin.y - v0.y, origin.z - v0.z)
    u = inverse * _dot(s, h)
    if not 0 <= u <= 1:
        return None
    q = _cross(s, edge1)
    v = inverse * _dot(direction, q)
    if v < 0 or u + v > 1:
        return None
    t = inverse * _dot(edge2, q)
    return t if t > EPSILON else None


def raycast_mesh(origin: Point3D, direction: Vector3D, mesh: TriangleMesh, object_id: str) -> RayHit | None:
    length = sqrt(direction.x**2 + direction.y**2 + direction.z**2)
    unit = (direction.x / length, direction.y / length, direction.z / length)
    hits = [
        hit
        for face in mesh.faces
        if (hit := _ray_triangle(origin, unit, tuple(mesh.vertices[index] for index in face))) is not None
    ]
    if not hits:
        return None
    travel = min(hits)
    return RayHit(
        object_id,
        Point3D(origin.x + unit[0] * travel, origin.y + unit[1] * travel, origin.z + unit[2] * travel),
        travel,
        "triangle_mesh",
    )
