from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from math import isclose, pi
from pathlib import Path

import pytest

from home_twin.constraints import LightingConstraints
from home_twin.fixtures import LightingLayout, PlannedSpotlight, SpotlightSpec
from home_twin.lighting import CONE_METHOD, MIXED_METHOD, load_layout_photometry, predict_lux
from home_twin.model import HomeTwin, Point3D
from home_twin.photometry import (
    PHOTOMETRIC_METHOD,
    load_photometry,
    parse_ies,
    parse_ldt,
    point_illuminance_lux,
    rated_flux_agreement,
)

FLAT_VERTICAL = tuple(float(angle) for angle in range(0, 100, 10))


def ies_text(
    *,
    vertical: Sequence[float] = FLAT_VERTICAL,
    horizontal: Sequence[float] = (0.0,),
    candela: Sequence[Sequence[float]] | None = None,
    multiplier: float = 1.0,
    ballast: float = 1.0,
    lumens_per_lamp: float = -1.0,
    photometric_type: int = 1,
    tilt: str = "NONE",
    tilt_block: str = "",
) -> str:
    planes = candela if candela is not None else [[1000.0] * len(vertical) for _ in horizontal]
    body = "\n".join(" ".join(f"{value:g}" for value in plane) for plane in planes)
    return "\n".join(
        [
            "IESNA:LM-63-2002",
            "[TEST] home-twin unit test",
            f"TILT={tilt}",
            *([tilt_block] if tilt_block else []),
            f"1 {lumens_per_lamp:g} {multiplier:g} {len(vertical)} {len(horizontal)} {photometric_type} 2 0 0 0",
            f"{ballast:g} 1 10",
            " ".join(f"{angle:g}" for angle in vertical),
            " ".join(f"{angle:g}" for angle in horizontal),
            body,
        ]
    )


def test_parses_angles_and_scales_candela_by_multiplier_and_ballast() -> None:
    photometry = parse_ies(ies_text(multiplier=2.0, ballast=0.5, lumens_per_lamp=650))

    assert photometry.vertical_angles == FLAT_VERTICAL
    assert photometry.horizontal_angles == (0.0,)
    assert photometry.rotationally_symmetric
    assert photometry.candela[0][0] == 1000.0
    assert photometry.rated_lumens == 650.0
    assert photometry.input_watts == 10.0


def test_absolute_photometry_reports_no_rated_lumens() -> None:
    assert parse_ies(ies_text(lumens_per_lamp=-1)).rated_lumens is None


def test_numeric_block_may_wrap_across_lines() -> None:
    wrapped = ies_text().replace("1000 1000", "1000\n1000")
    assert parse_ies(wrapped).candela == parse_ies(ies_text()).candela


def test_tilt_include_block_is_consumed_before_the_header() -> None:
    photometry = parse_ies(ies_text(tilt="INCLUDE", tilt_block="1 2\n0 90\n1.0 1.0"))
    assert photometry.candela[0][0] == 1000.0


def test_zonal_flux_of_a_uniform_hemisphere_is_two_pi_times_intensity() -> None:
    flux = parse_ies(ies_text()).luminous_flux_lm()
    assert isclose(flux, 2 * pi * 1000.0, rel_tol=1e-9)


def test_intensity_interpolates_between_tabulated_vertical_angles() -> None:
    candela = [[1000.0, 500.0, 0.0]]
    photometry = parse_ies(ies_text(vertical=(0.0, 10.0, 20.0), candela=candela))

    assert photometry.intensity(0.0, 0.0) == 1000.0
    assert photometry.intensity(5.0, 0.0) == 750.0
    assert photometry.intensity(10.0, 0.0) == 500.0


def test_intensity_past_the_tabulated_range_is_zero_not_the_nearest_reading() -> None:
    photometry = parse_ies(ies_text(vertical=(0.0, 45.0), candela=[[1000.0, 800.0]]))

    assert photometry.intensity(45.0, 0.0) == 800.0
    assert photometry.intensity(45.1, 0.0) == 0.0
    assert photometry.intensity(90.0, 0.0) == 0.0


def test_quadrant_symmetry_mirrors_the_azimuth_onto_the_tabulated_planes() -> None:
    photometry = parse_ies(
        ies_text(
            vertical=(0.0, 90.0),
            horizontal=(0.0, 90.0),
            candela=[[1000.0, 1000.0], [500.0, 500.0]],
        )
    )

    assert not photometry.rotationally_symmetric
    assert photometry.intensity(0.0, 0.0) == 1000.0
    assert photometry.intensity(0.0, 90.0) == 500.0
    assert photometry.intensity(0.0, 45.0) == 750.0
    assert photometry.intensity(0.0, 180.0) == 1000.0
    assert photometry.intensity(0.0, 270.0) == 500.0
    assert photometry.intensity(0.0, 360.0) == 1000.0


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("IESNA:LM-63-2002\n1 -1 1 2 1 1 2 0 0 0\n", "not an IESNA LM-63 file"),
        (ies_text(photometric_type=2), "only Type C photometry"),
        (ies_text().rsplit(" ", 3)[0], "ends before its declared values"),
        (ies_text(vertical=(0.0, 90.0, 45.0), candela=[[1.0, 1.0, 1.0]]), "not in ascending order"),
        (ies_text().replace("TILT=NONE\n1 -1", "TILT=NONE\nrubbish -1"), "is not a number"),
        (ies_text(multiplier=0.0), "must both be positive"),
    ],
)
def test_malformed_files_are_rejected_with_the_reason(text: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_ies(text, source="unit.ies")


def test_illuminance_directly_below_follows_the_inverse_square_law() -> None:
    photometry = parse_ies(ies_text())
    emitter = Point3D(0, 0, 2000)
    axis = (0.0, 0.0, -1.0)

    near = point_illuminance_lux(photometry, emitter=emitter, axis=axis, target=Point3D(0, 0, 0))
    far = point_illuminance_lux(
        photometry, emitter=Point3D(0, 0, 4000), axis=axis, target=Point3D(0, 0, 0)
    )

    assert isclose(near, 250.0, rel_tol=1e-9)
    assert isclose(far, near / 4, rel_tol=1e-9)


def test_illuminance_off_axis_applies_the_cosine_of_incidence() -> None:
    photometry = parse_ies(ies_text())
    lux = point_illuminance_lux(
        photometry,
        emitter=Point3D(0, 0, 2000),
        axis=(0.0, 0.0, -1.0),
        target=Point3D(2000, 0, 0),
    )
    assert isclose(lux, 1000.0 * (0.5**0.5) / 8.0, rel_tol=1e-9)


def test_no_illuminance_behind_the_luminaire_or_above_the_target_plane() -> None:
    photometry = parse_ies(ies_text())
    emitter = Point3D(0, 0, 2000)
    axis = (0.0, 0.0, -1.0)

    assert point_illuminance_lux(photometry, emitter=emitter, axis=axis, target=Point3D(0, 0, 3000)) == 0.0
    assert point_illuminance_lux(photometry, emitter=emitter, axis=axis, target=emitter) == 0.0


def test_azimuth_runs_counterclockwise_from_building_x_in_plan() -> None:
    photometry = parse_ies(
        ies_text(
            vertical=(0.0, 90.0),
            horizontal=(0.0, 90.0, 180.0, 270.0, 360.0),
            candela=[[0.0, 100.0], [0.0, 200.0], [0.0, 300.0], [0.0, 400.0], [0.0, 100.0]],
        )
    )
    emitter = Point3D(0, 0, 1000)
    axis = (0.0, 0.0, -1.0)

    towards_x = point_illuminance_lux(photometry, emitter=emitter, axis=axis, target=Point3D(1_000_000, 0, 0))
    towards_y = point_illuminance_lux(photometry, emitter=emitter, axis=axis, target=Point3D(0, 1_000_000, 0))

    assert towards_y > towards_x
    assert isclose(towards_y / towards_x, 2.0, rel_tol=1e-3)


def test_project_relative_paths_are_confined_to_the_project(tmp_path: Path) -> None:
    (tmp_path / "photometry").mkdir()
    (tmp_path / "photometry" / "spot.ies").write_text(ies_text())
    (tmp_path.parent / "outside.ies").write_text(ies_text())

    assert load_photometry("photometry/spot.ies", root=tmp_path).candela[0][0] == 1000.0
    with pytest.raises(ValueError, match="must be relative to the project"):
        load_photometry(str(tmp_path / "photometry" / "spot.ies"), root=tmp_path)
    with pytest.raises(ValueError, match="must stay inside the project"):
        load_photometry("../outside.ies", root=tmp_path)
    with pytest.raises(FileNotFoundError):
        load_photometry("photometry/missing.ies", root=tmp_path)


def ldt_text(
    *,
    symmetry: int = 1,
    c_angles: Sequence[float] = (0.0,),
    gammas: Sequence[float] = FLAT_VERTICAL,
    planes: Sequence[Sequence[float]] | None = None,
    light_output_ratio: float = 100.0,
) -> str:
    stored = planes if planes is not None else [[1000.0] * len(gammas)]
    header = [
        "home-twin unit test", "1", str(symmetry), str(len(c_angles)), "0", str(len(gammas)), "0",
        "report", "luminaire", "number", "unit.ldt", "2026-09-25",
        "50", "50", "54", "50", "50", "0", "0", "0", "0",
        "100", f"{light_output_ratio:g}", "1.0", "0",
        "2", "1", "SIBLING 35", "287", "3000", "80", "3.5", "1", "SIBLING 80", "672", "3000", "80", "6.5",
    ]
    return "\r\n".join(
        header
        + ["1.0"] * 10
        + [f"{angle:g}" for angle in c_angles]
        + [f"{angle:g}" for angle in gammas]
        + [f"{value:g}" for plane in stored for value in plane]
    )


def test_an_ldt_file_is_scaled_to_the_lamp_not_to_its_listed_siblings() -> None:
    photometry = parse_ldt(ldt_text(light_output_ratio=80), lumens=575)

    assert photometry.rotationally_symmetric
    assert photometry.intensity(0, 0) == pytest.approx(575.0)
    # A constant intensity over the lower hemisphere carries exactly 2 pi I lumens.
    assert photometry.luminous_flux_lm() == pytest.approx(2 * pi * 575.0, rel=1e-12)
    assert photometry.rated_lumens == pytest.approx(575 * 0.8)


def test_a_full_circle_ldt_interpolates_back_to_c0() -> None:
    planes = [[value] * len(FLAT_VERTICAL) for value in (100.0, 200.0, 300.0, 400.0)]
    photometry = parse_ldt(
        ldt_text(symmetry=0, c_angles=(0, 90, 180, 270), planes=planes), lumens=1000
    )

    assert photometry.intensity(10, 90) == pytest.approx(200.0)
    assert photometry.intensity(10, 315) == pytest.approx(250.0)
    # The closing C360 plane is C0 again and must not count twice in the flux.
    assert photometry.luminous_flux_lm() == pytest.approx(2 * pi * 250.0, rel=1e-12)


def test_a_quadrant_ldt_folds_like_a_quadrant_ies_file() -> None:
    planes = [[100.0] * len(FLAT_VERTICAL), [300.0] * len(FLAT_VERTICAL)]
    photometry = parse_ldt(
        ldt_text(symmetry=4, c_angles=(0, 90, 180, 270), planes=planes), lumens=1000
    )

    assert photometry.horizontal_angles == (0.0, 90.0)
    assert photometry.intensity(10, 270) == pytest.approx(300.0)
    assert photometry.intensity(10, 180) == pytest.approx(100.0)


def test_an_ldt_file_needs_a_symmetry_it_can_fold_and_a_lamp_rating(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="symmetry 3"):
        parse_ldt(ldt_text(symmetry=3), lumens=575)
    (tmp_path / "spot.ldt").write_text(ldt_text())
    with pytest.raises(ValueError, match="rated lumens"):
        load_photometry("spot.ldt", root=tmp_path)
    assert load_photometry("spot.ldt", root=tmp_path, lumens=500).intensity(0, 0) == pytest.approx(500.0)


def test_a_file_read_from_disk_is_averaged_over_every_rotation(tmp_path: Path) -> None:
    planes = [[value] * len(FLAT_VERTICAL) for value in (100.0, 200.0, 300.0, 400.0)]
    text = ldt_text(symmetry=0, c_angles=(0, 90, 180, 270), planes=planes)
    (tmp_path / "leaning.ldt").write_text(text)

    measured = parse_ldt(text, lumens=1000)
    averaged = load_photometry("leaning.ldt", root=tmp_path, lumens=1000)

    assert averaged.rotationally_symmetric
    assert averaged.intensity(10, 0) == pytest.approx(250.0)
    assert averaged.luminous_flux_lm() == pytest.approx(measured.luminous_flux_lm(), rel=1e-12)


def test_a_beam_file_on_disk_reconciles_with_its_rating() -> None:
    root = Path(__file__).parents[1]
    photometry = load_photometry("tests/fixtures/synthetic-spot.ldt", root=root, lumens=575)

    # cos^4 gamma at 5000 / (2 pi) cd/klm carries exactly its lamp's flux over the
    # lower hemisphere; the file's 5 degree sampling costs under 1%.
    assert rated_flux_agreement(photometry) == pytest.approx(1.0, abs=0.01)
    assert photometry.intensity(0, 0) == pytest.approx(5 * 575 / (2 * pi), rel=1e-6)


def _spotlight(room_id: str, tag: str, x: float, ies_path: str | None) -> PlannedSpotlight:
    return PlannedSpotlight(
        tag=tag,
        room_id=room_id,
        point=Point3D(x, 2000, 2800),
        spec=SpotlightSpec(model="Measured 8 W", lumens=650, ies_path=ies_path),
        switching_group="MAIN",
    )


def test_a_fully_measured_layout_reports_photometry_and_drops_its_exclusion(
    twin: HomeTwin, sample_path: Path
) -> None:
    root = sample_path.parent.parent
    (root / "photometry").mkdir(exist_ok=True)
    (root / "photometry" / "spot.ies").write_text(ies_text())
    room = twin.get_rooms()[0]
    layout = LightingLayout(room.id, (_spotlight(room.id, "SP01", 2000, "photometry/spot.ies"),))

    analysis = twin.analyse_lighting_layout(layout)

    assert analysis.method == PHOTOMETRIC_METHOD
    assert "ies_photometry" not in analysis.exclusions
    assert analysis.illuminance is not None
    assert analysis.illuminance.method == PHOTOMETRIC_METHOD
    assert analysis.illuminance.maximum_lux > 0


def test_an_ldt_layout_is_measured_at_the_fixture_rating(twin: HomeTwin, sample_path: Path) -> None:
    root = sample_path.parent.parent
    (root / "photometry").mkdir(exist_ok=True)
    (root / "photometry" / "spot.ldt").write_text(ldt_text())
    (root / "photometry" / "spot.ies").write_text(ies_text(candela=[[650.0] * len(FLAT_VERTICAL)]))
    room = twin.get_rooms()[0]

    from_ldt = twin.analyse_lighting_layout(
        LightingLayout(room.id, (_spotlight(room.id, "SP01", 2000, "photometry/spot.ldt"),))
    )
    from_ies = twin.analyse_lighting_layout(
        LightingLayout(room.id, (_spotlight(room.id, "SP01", 2000, "photometry/spot.ies"),))
    )

    assert from_ldt.method == PHOTOMETRIC_METHOD
    assert from_ldt.illuminance.maximum_lux == pytest.approx(from_ies.illuminance.maximum_lux)


def test_a_partly_measured_layout_says_so_and_keeps_the_exclusion(
    twin: HomeTwin, sample_path: Path
) -> None:
    root = sample_path.parent.parent
    (root / "photometry").mkdir(exist_ok=True)
    (root / "photometry" / "spot.ies").write_text(ies_text())
    room = twin.get_rooms()[0]
    layout = LightingLayout(
        room.id,
        (
            _spotlight(room.id, "SP01", 2000, "photometry/spot.ies"),
            _spotlight(room.id, "SP02", 4000, None),
        ),
    )

    analysis = twin.analyse_lighting_layout(layout)

    assert analysis.method == MIXED_METHOD
    assert "ies_photometry" in analysis.exclusions


def test_an_unmeasured_layout_keeps_the_beam_cone_method(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    layout = LightingLayout(room.id, (_spotlight(room.id, "SP01", 2000, None),))

    analysis = twin.analyse_lighting_layout(layout)

    assert analysis.method == CONE_METHOD
    assert "ies_photometry" in analysis.exclusions


def test_measured_photometry_changes_the_baked_surface_and_its_label(
    twin: HomeTwin, sample_path: Path
) -> None:
    root = sample_path.parent.parent
    (root / "photometry").mkdir(exist_ok=True)
    (root / "photometry" / "spot.ies").write_text(ies_text())
    room = twin.get_rooms()[0]
    measured = LightingLayout(room.id, (_spotlight(room.id, "SP01", 2000, "photometry/spot.ies"),))
    cone = LightingLayout(room.id, (_spotlight(room.id, "SP01", 2000, None),))

    baked = twin.bake_lighting(measured, step_mm=500)

    assert baked.method.startswith("ies_lm63_occluded")
    assert "ies_photometry" not in baked.exclusions
    assert baked.maximum_lux != twin.bake_lighting(cone, step_mm=500).maximum_lux


def test_a_uniform_diffuser_puts_its_rated_flux_over_the_sphere() -> None:
    """Exact arithmetic for a uniform emitter, not an assumed distribution.

    A source that throws evenly has an intensity of lumens / 4pi candela in
    every direction, so a point directly under it at one metre sees exactly
    that. The assumption in this tier is the fitting -- an opal globe is close
    to uniform and a reflectored one is not -- never the arithmetic.
    """
    from math import pi

    from home_twin.lighting import uniform_diffuser_lux
    from home_twin.model import Point3D

    emitter = Point3D(0, 0, 2000)
    directly_under = uniform_diffuser_lux(1000, emitter, Point3D(0, 0, 1000))
    assert directly_under == pytest.approx(1000 / (4 * pi))

    # Inverse square: twice as far is a quarter as bright.
    assert uniform_diffuser_lux(1000, emitter, Point3D(0, 0, 0)) == pytest.approx(directly_under / 4)

    # And it falls off with the cosine of incidence, so a point to the side of
    # the same fitting is dimmer than one the same distance directly below it.
    offset = uniform_diffuser_lux(1000, emitter, Point3D(1000, 0, 1000))
    assert 0 < offset < directly_under


def test_a_pendant_lights_a_room_that_carries_no_other_photometry() -> None:
    """A room lit only by pendants used to report 0.0 lux at every point.

    That is not a dark room, it is an unmeasured one, and the two read the same
    on a plan. Crediting the pendant as a uniform diffuser tells them apart.
    """
    from home_twin.lighting import DIFFUSER_METHOD, uniform_diffuser_lux
    from home_twin.model import Point3D

    lit = uniform_diffuser_lux(7605, Point3D(0, 0, 2500), Point3D(0, 0, 800))
    assert lit > 100, "a 7605 lm cluster 1.7 m overhead is not a dark spot"
    assert DIFFUSER_METHOD != "lumen_beam_cone_v1", "the method must say a diffuser was credited"


def test_fixtures_sharing_an_ldt_file_keep_their_own_lamp_rating(twin: HomeTwin, sample_path: Path) -> None:
    root = sample_path.parent.parent
    (root / "photometry").mkdir(exist_ok=True)
    # 1000 cd per 1000 lamp lumens out to 20 degrees, nothing past 30.
    narrow = [[1000.0, 1000.0, 1000.0] + [0.0] * (len(FLAT_VERTICAL) - 3)]
    (root / "photometry" / "spot.ldt").write_text(ldt_text(planes=narrow))
    room = twin.get_rooms()[0]
    dim = _spotlight(room.id, "SP01", 2000, "photometry/spot.ldt")
    bright = _spotlight(room.id, "SP02", 4000, "photometry/spot.ldt")
    layout = LightingLayout(
        room.id,
        (
            replace(dim, spec=replace(dim.spec, lumens=575)),
            replace(bright, spec=replace(bright.spec, lumens=1150)),
        ),
    )

    # Black surfaces leave only direct light. 2 m below each lamp the other sits 45 degrees
    # off axis, outside its beam, so each reading is lumens / 2^2 times the 0.8 maintenance factor.
    constraints = LightingConstraints()
    lux = predict_lux(
        (Point3D(2000, 2000, 800), Point3D(4000, 2000, 800)),
        layout,
        twin.get_room_context(room.id),
        constraints,
        photometry=load_layout_photometry(layout, root),
        reflectances={surface: 0.0 for surface in constraints.reflectances},
    )

    assert lux == pytest.approx((115.0, 230.0))
