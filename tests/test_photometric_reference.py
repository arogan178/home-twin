"""Reference cases whose answers are known independently of this code.

Every other lighting test asserts a relation: shadowed is darker than open, the
maximum is the largest sample. Those catch a regression but would pass a
formula wrong by a constant factor. The cases here assert absolute values
derived by hand from the defining physics, so they can fail on arithmetic that
is self-consistently wrong.

These are not the CIE 171:2006 test cases. That report is the recognised
instrument for assessing a lighting program and running its scenarios needs the
purchased standard; see docs/validation.md. The derivations below are
independent of it and of Home Twin.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from math import cos, pi, radians, sqrt

import pytest

from home_twin.constraints import LightingConstraints
from home_twin.fixtures import LightingLayout, PlannedSpotlight, SpotlightSpec
from home_twin.lighting import (
    bake_lighting,
    room_interreflection,
    sample_illuminance,
)
from home_twin.model import (
    Bounds3D,
    Ceiling,
    Point2D,
    Point3D,
    Polygon2D,
    Room,
    RoomContext,
    Vector3D,
    WallFace,
)
from home_twin.photometry import parse_ies, point_illuminance_lux, rated_flux_agreement

DEGREES = tuple(float(angle) for angle in range(0, 100, 10))


def ies(
    candela: Sequence[float],
    *,
    vertical: Sequence[float] = DEGREES,
    rated_lumens: float = -1.0,
) -> str:
    """An LM-63 Type C file tabulating one vertical plane."""

    return "\n".join(
        [
            "IESNA:LM-63-2002",
            "TILT=NONE",
            f"1 {rated_lumens:.17g} 1 {len(vertical)} 1 1 2 0 0 0",
            "1 1 10",
            " ".join(f"{angle:g}" for angle in vertical),
            "0",
            " ".join(f"{value:.17g}" for value in candela),
        ]
    )


def isotropic(intensity: float = 1000.0) -> str:
    return ies([intensity] * len(DEGREES))


def lambertian(peak: float = 1000.0, *, rated_lumens: float = -1.0) -> str:
    return ies(
        [peak * cos(radians(angle)) for angle in DEGREES],
        rated_lumens=rated_lumens,
    )


def square_room(side_mm: float = 4000.0, ceiling_mm: float = 2600.0) -> RoomContext:
    polygon = Polygon2D(
        (
            Point2D(0, 0),
            Point2D(side_mm, 0),
            Point2D(side_mm, side_mm),
            Point2D(0, side_mm),
        )
    )
    room = Room(
        "ROOM",
        "Reference room",
        "STOREY",
        0.0,
        Bounds3D(Point3D(0, 0, 0), Point3D(side_mm, side_mm, ceiling_mm)),
    )
    walls = (
        WallFace("W_S", Point2D(0, 0), Point2D(side_mm, 0), Vector3D(0, 1, 0), 150.0),
        WallFace("W_E", Point2D(side_mm, 0), Point2D(side_mm, side_mm), Vector3D(-1, 0, 0), 150.0),
        WallFace("W_N", Point2D(side_mm, side_mm), Point2D(0, side_mm), Vector3D(0, -1, 0), 150.0),
        WallFace("W_W", Point2D(0, side_mm), Point2D(0, 0), Vector3D(1, 0, 0), 150.0),
    )
    return RoomContext(
        room,
        Ceiling("ROOM", polygon, ceiling_mm, "reference", ceiling_mm + 100),
        walls,
        (),
        (),
        (),
        (),
        (),
        (),
    )


def spotlight(point: Point3D, *, lumens: float | None = 800, ies_path: str | None = None) -> PlannedSpotlight:
    return PlannedSpotlight(
        tag="SP01",
        room_id="ROOM",
        point=point,
        spec=SpotlightSpec(model="Reference", lumens=lumens, ies_path=ies_path),
        switching_group="MAIN",
    )


# --- the direct point-source component -------------------------------------


def test_illuminance_off_axis_follows_the_cosine_cubed_form() -> None:
    """E = I·cos³θ/h², the standard form for a point source over a plane.

    Derived here from the mounting height rather than the slant distance, so
    agreement means the inverse-square law and the cosine of incidence compose
    correctly rather than each being right on its own.
    """

    height_mm, offset_mm, intensity = 2000.0, 1000.0, 1000.0
    photometry = parse_ies(isotropic(intensity))

    lux = point_illuminance_lux(
        photometry,
        emitter=Point3D(0, 0, height_mm),
        axis=(0.0, 0.0, -1.0),
        target=Point3D(offset_mm, 0, 0),
    )

    cosine = height_mm / sqrt(height_mm**2 + offset_mm**2)
    expected = intensity * cosine**3 / (height_mm / 1000) ** 2
    assert lux == pytest.approx(expected, rel=1e-12)
    assert lux == pytest.approx(178.885438, rel=1e-6)


def test_a_lambertian_distribution_integrates_to_pi_times_its_peak() -> None:
    """A cosine distribution over a hemisphere carries exactly π·I₀ lumens.

    ∫I₀cosθ dΩ over the hemisphere is πI₀. The zonal sum telescopes to the
    same value for any ascending angle set, so this is an equality rather than
    a convergence check.
    """

    assert parse_ies(lambertian(1000.0)).luminous_flux_lm() == pytest.approx(1000.0 * pi, rel=1e-12)


def test_a_coarse_angle_set_does_not_change_the_lambertian_flux() -> None:
    """The telescoping holds at 30 degree steps, so a sparse file is not penalised."""

    coarse = (0.0, 30.0, 60.0, 90.0)
    text = ies([1000.0 * cos(radians(angle)) for angle in coarse], vertical=coarse)
    assert parse_ies(text).luminous_flux_lm() == pytest.approx(1000.0 * pi, rel=1e-12)


# --- the file's own consistency ---------------------------------------------


def test_a_well_formed_file_reconciles_with_the_flux_it_declares() -> None:
    assert rated_flux_agreement(parse_ies(lambertian(1000.0))) is None

    declared = parse_ies(lambertian(1000.0, rated_lumens=1000.0 * pi))
    assert rated_flux_agreement(declared) == pytest.approx(1.0, rel=1e-9)


def test_a_mislabelled_file_disagrees_with_its_own_rating() -> None:
    """Half the declared flux means a misparse or a bad file, not a dim lamp."""

    overstated = parse_ies(lambertian(1000.0, rated_lumens=2 * 1000.0 * pi))
    assert rated_flux_agreement(overstated) == pytest.approx(0.5, rel=1e-9)


# --- the interreflected component ------------------------------------------


def test_the_bounce_matches_an_explicit_sum_over_reflections() -> None:
    """(F/A)·ρ̄/(1-ρ̄) is the closed form of Σ(F/A)ρ̄ⁿ for n ≥ 1.

    Summing the series directly derives the same number a different way, so
    agreement checks the closed form rather than restating it.
    """

    context = square_room()
    layout = LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),))

    bounce = room_interreflection(layout, context)

    series = sum(
        (bounce.luminous_flux_lm / bounce.surface_area_m2) * bounce.average_reflectance**power
        for power in range(1, 2000)
    )
    assert bounce.lux == pytest.approx(series, rel=1e-9)


def test_the_bounce_uses_the_area_weighted_reflectance_of_the_enclosure() -> None:
    """A 4 m room with a 2.6 m ceiling: 16 m² floor, 16 m² ceiling, 41.6 m² of wall."""

    bounce = room_interreflection(
        LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),)),
        square_room(),
        {"ceiling": 0.7, "walls": 0.5, "floor": 0.2},
    )

    assert bounce.surface_area_m2 == pytest.approx(73.6, rel=1e-9)
    expected = (16 * 0.2 + 16 * 0.7 + 41.6 * 0.5) / 73.6
    assert bounce.average_reflectance == pytest.approx(expected, rel=1e-9)
    assert bounce.lux == pytest.approx((800 / 73.6) * (expected / (1 - expected)), rel=1e-9)


def test_a_face_with_its_own_reflectance_is_weighted_at_it() -> None:
    """The same 4 m room with one 4 m wall in walnut at 0.12.

    Of the 41.6 m² of wall, 10.4 m² is the feature face and 31.2 m² is painted,
    so the enclosure averages (16·0.2 + 16·0.7 + 31.2·0.5 + 10.4·0.12)/73.6.
    The undeclared faces are unaffected, which the test above still asserts.
    """

    context = square_room()
    context = replace(context, walls=(replace(context.walls[0], reflectance=0.12), *context.walls[1:]))

    bounce = room_interreflection(
        LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),)),
        context,
        {"ceiling": 0.7, "walls": 0.5, "floor": 0.2},
    )

    expected = (16 * 0.2 + 16 * 0.7 + 31.2 * 0.5 + 10.4 * 0.12) / 73.6
    assert bounce.surface_area_m2 == pytest.approx(73.6, rel=1e-9)
    assert bounce.average_reflectance == pytest.approx(expected, rel=1e-9)
    assert bounce.lux == pytest.approx((800 / 73.6) * (expected / (1 - expected)), rel=1e-9)


def test_a_black_room_returns_no_bounce() -> None:
    bounce = room_interreflection(
        LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),)),
        square_room(),
        {"ceiling": 0.0, "walls": 0.0, "floor": 0.0},
    )
    assert bounce.lux == 0.0


def test_the_bounce_records_the_reflectances_it_was_given() -> None:
    """The values are typical rather than measured, so the result has to name them."""

    bounce = room_interreflection(
        LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),)),
        square_room(),
        {"ceiling": 0.8, "walls": 0.4, "floor": 0.1},
    )
    assert bounce.reflectances == (("ceiling", 0.8), ("floor", 0.1), ("walls", 0.4))


# --- the composite the browser actually shows ------------------------------


def test_the_grid_reproduces_the_point_calculation_under_the_fixture() -> None:
    """End to end: constraints, grid walk, IES lookup and the maintenance factor.

    The expected value is written out here as intensity over squared distance
    rather than fetched from the photometry module, so this fails if any step
    of the composite drops or double-counts a term.
    """

    context = square_room()
    constraints = LightingConstraints(
        grid_step_mm=1000, task_plane_height_mm=800, maintenance_factor=1.0
    )
    layout = LightingLayout(
        "ROOM", (spotlight(Point3D(2000, 2000, 2600), ies_path="reference.ies"),)
    )
    photometry = {"reference.ies": parse_ies(isotropic(1000.0))}

    grid, _ = sample_illuminance(layout, context, constraints, photometry=photometry)

    below = next(
        sample for sample in grid.samples if sample.point.x == 2000 and sample.point.y == 2000
    )
    drop_m = (2600 - 800) / 1000
    assert below.lux == pytest.approx(1000.0 / drop_m**2, rel=1e-12)
    assert below.lux == pytest.approx(308.641975, rel=1e-6)


def test_the_maintenance_factor_scales_every_component_once() -> None:
    """Direct and bounce both depreciate, so the whole surface scales linearly.

    Applying the factor to one component and not the other, or twice to one,
    breaks the ratio even though each run still looks plausible.
    """

    context = square_room()
    layout = LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),))
    initial = bake_lighting(
        layout, context, LightingConstraints(maintenance_factor=1.0), step_mm=500
    )
    maintained = bake_lighting(
        layout, context, LightingConstraints(maintenance_factor=0.8), step_mm=500
    )

    assert maintained.interreflection is not None and initial.interreflection is not None
    assert maintained.interreflection.lux == pytest.approx(0.8 * initial.interreflection.lux, rel=1e-12)
    assert maintained.mean_lux == pytest.approx(0.8 * initial.mean_lux, rel=1e-12)
    for depreciated, full in zip(maintained.samples, initial.samples, strict=True):
        assert depreciated.lux == pytest.approx(0.8 * full.lux, rel=1e-12)


# --- the task area the statistics are quoted over --------------------------


def test_task_area_statistics_exclude_the_perimeter_band() -> None:
    """A 4 m room on a 1 m grid keeps the 3x3 interior once 500 mm is excluded."""

    context = square_room()
    constraints = LightingConstraints(grid_step_mm=1000, task_area_border_mm=500)
    layout = LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),))

    grid, _ = sample_illuminance(layout, context, constraints)

    assert grid.task_area is not None
    assert grid.task_area.sample_count == 9
    assert grid.task_area.sample_count < len(grid.samples)
    assert grid.task_area.border_mm == 500


def test_uniformity_is_the_minimum_over_the_mean_of_the_task_area() -> None:
    context = square_room()
    constraints = LightingConstraints(grid_step_mm=1000, task_area_border_mm=500)
    layout = LightingLayout("ROOM", (spotlight(Point3D(2000, 2000, 2600), lumens=800),))

    grid, _ = sample_illuminance(layout, context, constraints)

    assert grid.task_area is not None
    assert grid.task_area.uniformity == pytest.approx(
        grid.task_area.minimum_lux / grid.task_area.mean_lux, rel=1e-12
    )
    assert 0 <= grid.task_area.uniformity <= 1


def test_a_room_narrower_than_the_border_reports_no_task_area() -> None:
    """A 1 m corridor has no interior left, and saying so beats quoting the whole room."""

    context = square_room(side_mm=1000)
    constraints = LightingConstraints(grid_step_mm=200, task_area_border_mm=500)
    layout = LightingLayout("ROOM", (spotlight(Point3D(500, 500, 2600), lumens=800),))

    grid, _ = sample_illuminance(layout, context, constraints)

    assert grid.samples
    assert grid.task_area is None
