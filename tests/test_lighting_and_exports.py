from __future__ import annotations

import csv
import json
from dataclasses import asdict
from pathlib import Path

import pytest

from home_twin.fixtures import (
    LightingLayout,
    PlannedSpotlight,
    RoomLightingDesign,
    SpotlightSpec,
)
from home_twin.model import HomeTwin, Point3D


def test_existing_layout_passes_geometric_validation(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    layout = twin.get_lighting_layout(room.id)
    assert [fixture.tag for fixture in layout.fixtures] == ["SP01", "SP02"]
    assert twin.validate_lighting_layout(layout).valid
    spacing = twin.calculate_spacing(room.id)
    assert len(spacing) == 1
    assert spacing[0].distance_mm == 3000
    assert not twin.find_fixture_collisions(room.id).findings


def test_validation_reports_ceiling_wall_and_collision_failures(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    spec = SpotlightSpec()
    layout = LightingLayout(
        room.id,
        (
            PlannedSpotlight("OUTSIDE", room.id, Point3D(-100, 100, 2800), spec, "MAIN"),
            PlannedSpotlight("CLOSE_A", room.id, Point3D(1500, 1400, 2800), spec, "MAIN"),
            PlannedSpotlight("CLOSE_B", room.id, Point3D(1520, 1400, 2800), spec, "MAIN"),
        ),
    )
    codes = {finding.code for finding in twin.validate_lighting_layout(layout).findings}
    assert {"outside_ceiling", "wall_clearance", "minimum_spacing", "fixture_collision"} <= codes


def test_optimizer_is_deterministic_and_non_mutating(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    revision = twin.revision
    fixture = SpotlightSpec(model="Generic 700 lm", lumens=700)
    first = twin.optimise_spotlight_layout(room.id, fixture)
    second = twin.optimise_spotlight_layout(room.id, fixture)
    assert asdict(first) == asdict(second)
    assert first.model_revision == revision
    assert first.validation.valid
    assert twin.revision == revision
    assert [item.tag for item in twin.get_light_fixtures(room.id)] == ["SP01", "SP02"]


def test_candidate_layout_analysis_updates_dark_zones_without_mutating_ifc(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    original_layout = twin.get_lighting_layout(room.id)
    original_bytes = twin.model_path.read_bytes()
    original_revision = twin.revision
    moved = original_layout.fixtures[0]
    candidate = LightingLayout(
        room.id,
        (
            PlannedSpotlight(
                moved.tag,
                room.id,
                Point3D(moved.point.x + 900, moved.point.y + 700, moved.point.z),
                moved.spec,
                moved.switching_group,
            ),
            *original_layout.fixtures[1:],
        ),
    )

    original = twin.analyse_lighting_layout(original_layout)
    changed = twin.analyse_lighting_layout(candidate)

    assert original.dark_zones != changed.dark_zones
    assert changed.method == "lumen_beam_cone_v1"
    assert "daylight" in changed.exclusions
    assert twin.revision == original_revision
    assert twin.model_path.read_bytes() == original_bytes


def test_radium_peak_candela_specs_select_the_declared_approximation(twin: HomeTwin) -> None:
    from home_twin.fixtures import RADIUM_44122574

    room = twin.get_rooms()[0]
    layout = LightingLayout(
        room.id,
        (
            PlannedSpotlight("RAD120A", room.id, Point3D(1500, 1400, 2800), RADIUM_44122574, "MAIN"),
            PlannedSpotlight("RAD120", room.id, Point3D(4500, 1400, 2800), RADIUM_44122574, "MAIN"),
        ),
    )

    analysis = twin.analyse_lighting_layout(layout)

    assert analysis.method == "peak_candela_beam_falloff_v1"
    assert analysis.illuminance is not None
    assert analysis.illuminance.method == "peak_candela_beam_falloff_v1"


def test_applying_proposal_replaces_room_layout_and_properties(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    fixture = SpotlightSpec(model="Replacement 700 lm", lumens=700, diameter_mm=90)
    proposal = twin.optimise_spotlight_layout(room.id, fixture)
    result = twin.apply_lighting_layout(proposal.layout, expected_revision=proposal.model_revision)
    assert result.revision == twin.revision

    reopened = HomeTwin.open(twin.model_path)
    fixtures = reopened.get_light_fixtures(room.id)
    assert len(fixtures) == len(proposal.layout.fixtures)
    assert {item.tag for item in fixtures} == {item.tag for item in proposal.layout.fixtures}
    assert all(item.spec == fixture for item in fixtures)


def test_installation_exports_are_deterministic_and_traceable(twin: HomeTwin, tmp_path: Path) -> None:
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first_paths = twin.export_lighting(directory=first_dir)
    second_paths = twin.export_lighting(directory=second_dir)
    assert [path.name for path in first_paths] == ["lighting-layout.csv", "lighting-layout.json", "lighting-layout.svg"]
    for first, second in zip(first_paths, second_paths, strict=True):
        assert first.read_bytes() == second.read_bytes()

    payload = json.loads((first_dir / "lighting-layout.json").read_text())
    assert payload["model_revision"] == twin.revision
    assert payload["fixtures"][0]["x_mm"] == 1500
    assert payload["fixtures"][0]["z_mm"] == 2800
    assert payload["fixtures"][0]["reference_walls"]

    with (first_dir / "lighting-layout.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["tag"] == "SP01"
    assert rows[0]["switching_group"] == "OPEN_PLAN_MAIN"
    svg = (first_dir / "lighting-layout.svg").read_text()
    assert "SP01" in svg and "X 1500 · Y 1400 · Z 2800" in svg


def test_a_tilted_spotlight_lights_the_side_it_is_aimed_at(twin: HomeTwin) -> None:
    """The stored aiming direction must move the beam, not be silently ignored."""

    from home_twin.lighting import sample_illuminance
    from home_twin.model import Vector3D

    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    spec = SpotlightSpec(lumens=1200, beam_angle_deg=24)
    point = Point3D(3000, 2000, 2800)

    def brightest(direction: Vector3D) -> Point3D:
        layout = LightingLayout(
            room.id,
            (PlannedSpotlight("SPTILT", room.id, point, spec, "MAIN", direction=direction),),
        )
        grid = sample_illuminance(layout, context, twin.constraints)[0]
        return max(grid.samples, key=lambda sample: sample.lux).point

    straight_down = brightest(Vector3D(0, 0, -1))
    aimed_west = brightest(Vector3D(-1, 0, -1))

    assert straight_down.x == 3000
    assert aimed_west.x < straight_down.x - 500
    assert aimed_west.y == straight_down.y


def test_the_illuminance_grid_summarises_the_same_samples_as_the_dark_zones(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    analysis = twin.analyse_lighting_layout(twin.get_lighting_layout(room.id))

    grid = analysis.illuminance
    assert grid is not None
    assert grid.method == "lumen_beam_cone_v1"
    assert grid.step_mm == twin.constraints.grid_step_mm
    assert grid.plane_elevation_mm == room.elevation_mm + twin.constraints.task_plane_height_mm
    dark = [sample for sample in grid.samples if sample.lux < grid.threshold_lux]
    assert len(dark) == len(analysis.dark_zones)
    assert grid.covered_fraction == (len(grid.samples) - len(dark)) / len(grid.samples)
    assert grid.maximum_lux == max(sample.lux for sample in grid.samples)


def test_a_room_narrower_than_its_clearance_says_why_it_gets_no_seats() -> None:
    """An empty proposal must not read as "this room needs no light"."""

    from home_twin.constraints import LightingConstraints
    from home_twin.lighting import optimise_spotlights
    from home_twin.model import (
        Bounds3D,
        Ceiling,
        Point2D,
        Polygon2D,
        Room,
        RoomContext,
        Vector3D,
        WallFace,
    )

    # 800 mm wide against a 600 mm edge clearance: no seat can satisfy it.
    polygon = Polygon2D((Point2D(0, 0), Point2D(800, 0), Point2D(800, 2000), Point2D(0, 2000)))
    room = Room("LOBBY", "Entrance landing", "STOREY", 0.0, Bounds3D(Point3D(0, 0, 0), Point3D(800, 2000, 2600)))
    context = RoomContext(
        room,
        Ceiling("LOBBY", polygon, 2600, "test"),
        (WallFace("W", Point2D(0, 0), Point2D(800, 0), Vector3D(0, 1, 0), 150.0),),
        (),
        (),
        (),
        (),
    )

    proposal = optimise_spotlights("sha256:test", SpotlightSpec(lumens=650), context, LightingConstraints())

    assert proposal.layout.fixtures == ()
    finding = next(item for item in proposal.validation.findings if item.code == "no_compliant_seat")
    assert finding.severity == "warning"
    assert "800" in finding.message
    assert finding.required_mm is not None and finding.measured_mm is not None
    assert finding.required_mm > finding.measured_mm


def test_offered_two_lamps_the_optimiser_builds_the_layout_from_one_of_them() -> None:
    """A mixed offer must still produce one coherent layout, not a mixed ceiling.

    Which lamp wins is the scorer's business. What this pins is that the choice
    is made, recorded on every fitting, and drawn from what was offered.
    """

    from home_twin.constraints import LightingConstraints
    from home_twin.fixtures import NARROW_SPOTLIGHT, WIDE_SPOTLIGHT
    from home_twin.lighting import optimise_spotlights
    from home_twin.model import Bounds3D, Ceiling, Point2D, Polygon2D, Room, RoomContext

    polygon = Polygon2D((Point2D(0, 0), Point2D(4000, 0), Point2D(4000, 4000), Point2D(0, 4000)))
    room = Room("LIV", "Living", "STOREY", 0.0, Bounds3D(Point3D(0, 0, 0), Point3D(4000, 4000, 2600)))
    context = RoomContext(room, Ceiling("LIV", polygon, 2600, "test"), (), (), (), (), ())

    proposal = optimise_spotlights(
        "sha256:test", (NARROW_SPOTLIGHT, WIDE_SPOTLIGHT), context, LightingConstraints()
    )

    chosen = {fixture.spec.model for fixture in proposal.layout.fixtures}
    assert len(chosen) == 1
    assert chosen <= {NARROW_SPOTLIGHT.model, WIDE_SPOTLIGHT.model}


def test_a_snapped_grid_is_not_reported_as_misaligned() -> None:
    """Two lights one grid step apart on both axes are neighbours, not a slip."""

    from home_twin.constraints import LightingConstraints
    from home_twin.lighting import align_layout, find_bad_alignment

    constraints = LightingConstraints()
    grid = LightingLayout(
        "ROOM",
        tuple(
            PlannedSpotlight(f"SP{index:02d}", "ROOM", Point3D(x, y, 2600), SpotlightSpec(), "MAIN")
            for index, (x, y) in enumerate(
                [(x, y) for y in (1000, 1250, 1500) for x in (1000, 2000, 3000)], start=1
            )
        ),
    )
    assert find_bad_alignment(grid, constraints).findings == ()
    # Nothing to pull, so nothing moves.
    assert align_layout(grid, constraints) == grid


def test_a_spotlight_off_a_shared_row_is_reported_and_can_be_pulled_onto_it() -> None:
    from home_twin.constraints import LightingConstraints
    from home_twin.lighting import align_layout, find_bad_alignment

    constraints = LightingConstraints()
    layout = LightingLayout(
        "ROOM",
        (
            PlannedSpotlight("SP01", "ROOM", Point3D(1000, 1500, 2600), SpotlightSpec(), "MAIN"),
            PlannedSpotlight("SP02", "ROOM", Point3D(2000, 1500, 2600), SpotlightSpec(), "MAIN"),
            PlannedSpotlight("SP03", "ROOM", Point3D(3000, 1460, 2600), SpotlightSpec(), "MAIN"),
        ),
    )
    findings = find_bad_alignment(layout, constraints).findings
    assert len(findings) == 1
    # It names the lights it should join, not just the distance.
    assert findings[0].message == "SP03 is 40.0 mm off the row shared by SP01, SP02"

    aligned = align_layout(layout, constraints)
    assert [fixture.point.y for fixture in aligned.fixtures] == [1500, 1500, 1500]
    assert find_bad_alignment(aligned, constraints).findings == ()


def test_a_spotlight_placed_well_away_from_a_row_is_left_alone() -> None:
    """Past the near band it is somewhere else on purpose."""

    from home_twin.constraints import LightingConstraints
    from home_twin.lighting import align_layout, find_bad_alignment

    constraints = LightingConstraints()
    layout = LightingLayout(
        "ROOM",
        (
            PlannedSpotlight("SP01", "ROOM", Point3D(1000, 1500, 2600), SpotlightSpec(), "MAIN"),
            PlannedSpotlight("SP02", "ROOM", Point3D(2000, 1500, 2600), SpotlightSpec(), "MAIN"),
            PlannedSpotlight("SP03", "ROOM", Point3D(3000, 2400, 2600), SpotlightSpec(), "MAIN"),
        ),
    )
    assert find_bad_alignment(layout, constraints).findings == ()
    assert align_layout(layout, constraints) == layout


def test_a_recessed_fitting_deeper_than_the_ceiling_void_is_reported() -> None:
    """A 100 mm plenum is common in an open plan, so most GU10 housings physically will not fit."""
    from home_twin.constraints import LightingConstraints
    from home_twin.fixtures import LightingLayout, PlannedSpotlight, SpotlightSpec
    from home_twin.lighting import validate_layout
    from home_twin.model import (
        Bounds3D,
        Ceiling,
        Point2D,
        Point3D,
        Polygon2D,
        Room,
        RoomContext,
    )

    polygon = Polygon2D((Point2D(0, 0), Point2D(4000, 0), Point2D(4000, 4000), Point2D(0, 4000)))
    room = Room("R", "Open", "STOREY", 0.0, Bounds3D(Point3D(0, 0, 0), Point3D(4000, 4000, 2600)))

    def report(depth: float, structural: float | None, board: float | None = None):
        context = RoomContext(
            room, Ceiling("R", polygon, 2600, "test", structural, board), (), (), (), (), ()
        )
        layout = LightingLayout(
            "R",
            (
                PlannedSpotlight(
                    "S1", "R", Point3D(2000, 2000, 2600), SpotlightSpec(mounting_depth_mm=depth), "G"
                ),
            ),
        )
        return validate_layout(layout, context, LightingConstraints())

    def codes(r):
        return {item.code for item in r.findings}
    assert "recess_deeper_than_ceiling_void" not in codes(report(70, 2700))
    assert "recess_deeper_than_ceiling_void" in codes(report(109, 2700))
    # A slab level with the finished ceiling records no build-up; the plan uses
    # that as its default, so it means unknown rather than a measured zero void.
    assert "recess_deeper_than_ceiling_void" not in codes(report(109, 2600))
    # Without a recorded slab the rule stays silent rather than guessing.
    assert "recess_deeper_than_ceiling_void" not in codes(report(109, None))

    # A housing is cut through the board rather than sat on top of it, so the
    # board costs it nothing: a 100 mm drop carries a 10 mm board and still
    # takes a 95 mm housing.
    assert "recess_deeper_than_ceiling_void" not in codes(report(85, 2700, 10))
    assert "recess_deeper_than_ceiling_void" not in codes(report(95, 2700, 10))
    assert "recess_deeper_than_ceiling_void" in codes(report(109, 2700, 10))

    finding = next(
        item
        for item in report(109, 2700, 10).findings
        if item.code == "recess_deeper_than_ceiling_void"
    )
    assert finding.measured_mm == 100
    assert finding.required_mm == 109


def test_the_installation_sheet_carries_what_the_fitting_must_be_sealed_to(
    twin: HomeTwin, tmp_path: Path
) -> None:
    """An IP rating an installer cannot read off the sheet is decoration."""

    from home_twin.fixtures import (
        WET_ROOM_SPOTLIGHT,
        PlannedRopeLight,
        RoomLightingDesign,
        RopeLightSpec,
        RopeMounting,
    )

    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    ceiling_z = context.ceiling.elevation_mm
    floor_z = context.room.elevation_mm
    design = RoomLightingDesign(
        room.id,
        (
            PlannedSpotlight("WET1", room.id, Point3D(3000, 2800, ceiling_z), WET_ROOM_SPOTLIGHT, "BATH"),
            PlannedRopeLight(
                "WET2",
                room.id,
                (Point3D(3000, 2000, floor_z + 1200), Point3D(3000, 2000, floor_z + 1900)),
                RopeLightSpec(mounting=RopeMounting.WALL, ip_rating="IP44"),
                "BATH_MIRROR",
            ),
        ),
    )
    twin.apply_room_lighting_design(design, expected_revision=twin.revision)

    twin.export_lighting(room_id=room.id, directory=tmp_path)
    with (tmp_path / "lighting-layout.csv").open(newline="") as handle:
        ratings = {row["tag"]: row["ip_rating"] for row in csv.DictReader(handle)}

    assert ratings == {"WET1": "IP20", "WET2": "IP44"}


def test_a_recessed_downlight_puts_its_can_in_the_void_and_its_trim_proud(sample_path) -> None:
    """A downlight is a bezel and a can, not a puck hanging under the ceiling.

    ``mounting_depth_mm`` is the depth above the finished ceiling face, so the
    housing extrudes up; only the trim stands below, and only just.
    """
    from home_twin.ifc import TRIM_PROJECTION_MM

    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    ceiling_z = twin.get_room_context(room.id).ceiling.elevation_mm
    spec = SpotlightSpec(diameter_mm=95, cutout_diameter_mm=80, mounting_depth_mm=90)
    design = RoomLightingDesign(
        room.id,
        (PlannedSpotlight("SP40", room.id, Point3D(2000, 2000, ceiling_z), spec, "MAIN"),),
    )

    twin.apply_room_lighting_design(design, expected_revision=twin.revision)

    reopened = HomeTwin.open(sample_path)
    fixture = next(item for item in reopened.get_luminaires(room.id) if item.tag == "SP40")
    bounds = reopened.get_object(fixture.id).bounds
    assert bounds.minimum.z == pytest.approx(ceiling_z - TRIM_PROJECTION_MM), "the trim barely shows"
    assert bounds.maximum.z == pytest.approx(ceiling_z + 90), "the can is in the void"
    assert bounds.maximum.x - bounds.minimum.x == pytest.approx(95), "the widest part is the trim"
