from __future__ import annotations

import pytest

from home_twin.geometry import (
    bounds_distance,
    circle_fits_polygon,
    distance,
    point_in_polygon,
    point_segment_distance,
    polygon_area,
    raycast_mesh,
)
from home_twin.model import Bounds3D, Point2D, Point3D, Polygon2D, TriangleMesh, Vector3D


def test_distances_use_millimetres() -> None:
    assert distance(Point3D(0, 0, 0), Point3D(3000, 4000, 0)) == 5000
    assert point_segment_distance(Point2D(500, 800), Point2D(0, 0), Point2D(1000, 0)) == 800
    first = Bounds3D(Point3D(0, 0, 0), Point3D(100, 100, 100))
    second = Bounds3D(Point3D(400, 500, 100), Point3D(500, 600, 200))
    assert bounds_distance(first, second) == 500


def test_polygon_containment_holes_and_fixture_radius() -> None:
    polygon = Polygon2D(
        (Point2D(0, 0), Point2D(4000, 0), Point2D(4000, 3000), Point2D(0, 3000)),
        ((Point2D(1000, 1000), Point2D(2000, 1000), Point2D(2000, 2000), Point2D(1000, 2000)),),
    )
    assert polygon_area(polygon) == 11_000_000
    assert point_in_polygon(Point2D(500, 500), polygon)
    assert not point_in_polygon(Point2D(1500, 1500), polygon)
    assert circle_fits_polygon(Point2D(500, 500), 400, polygon)
    assert not circle_fits_polygon(Point2D(500, 500), 600, polygon)


def test_raycast_returns_nearest_world_space_hit() -> None:
    mesh = TriangleMesh(
        vertices=(Point3D(0, 0, 0), Point3D(1000, 0, 0), Point3D(0, 1000, 0)),
        faces=((0, 1, 2),),
    )
    hit = raycast_mesh(Point3D(100, 100, 1000), Vector3D(0, 0, -1), mesh, "ceiling")
    assert hit is not None
    assert hit.object_id == "ceiling"
    assert hit.distance_mm == pytest.approx(1000)
    assert hit.point == Point3D(100, 100, 0)
