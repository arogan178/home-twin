"""The plan compiler, exercised on the synthetic demo home in ``examples/demo``.

Expectations come from the demo's own coordinates and closed-form geometry, not
from a previous run of the compiler.
"""

from __future__ import annotations

import json
import math
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace

import ifcopenshell
import ifcopenshell.util.element as element_util
import pytest
import yaml

from home_twin.geometry import distance_2d, point_in_polygon
from home_twin.model import HomeTwin, Point2D, Polygon2D
from home_twin.plan_draft import (
    AUTHORED_IN_DRAFT,
    ControlDimension,
    DraftBuildRejected,
    DraftPlanError,
    DraftReplacementRequired,
    DraftWouldDiscardFixtures,
    Evidence,
    EvidenceStatus,
    _draft_authored_counts,
    _ifc_guid,
    _overlapping_wall_edges,
    _sha256,
    build_draft,
    draft_path,
    dump_plan,
    load_plan,
    plan_path,
    review_plan,
    review_plan_file,
    save_plan,
    underlay_stem,
)
from home_twin.sample import create_sample_ifc
from home_twin.validation import StaleRevision

DEMO = Path(__file__).parents[1] / "examples" / "demo"
DEMO_PLAN = DEMO / "plan.yaml"


def _make_project(root: Path, plan_name: str = "plan.yaml") -> Path:
    reference_dir = root / "model" / "references"
    reference_dir.mkdir(parents=True)
    shutil.copy2(DEMO_PLAN, reference_dir / plan_name)
    shutil.copy2(DEMO / "underlay.png", reference_dir / "underlay.png")
    create_sample_ifc(root / "model" / "house.ifc", with_spotlights=False)
    return root


@pytest.fixture
def demo_project(tmp_path: Path) -> Path:
    return _make_project(tmp_path)


@pytest.fixture(scope="module")
def built_demo(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, HomeTwin]:
    """One unmodified demo draft shared by the read-only checks."""

    root = _make_project(tmp_path_factory.mktemp("built"))
    return root, HomeTwin.open(build_draft(root).path)


def _source(root: Path) -> Path:
    return root / "model" / "references" / "plan.yaml"


def _read(root: Path) -> dict:
    return yaml.safe_load(_source(root).read_text())


def _write(root: Path, plan: dict) -> None:
    _source(root).write_text(yaml.safe_dump(plan, sort_keys=False))


def _demo() -> dict:
    return yaml.safe_load(DEMO_PLAN.read_text())


def _by_id(items: list[dict], item_id: str) -> dict:
    return next(item for item in items if item["id"] == item_id)


def _room(twin: HomeTwin, plan: dict, room_id: str):
    name = _by_id(plan["rooms"], room_id)["name"]
    return next(room for room in twin.get_rooms() if room.name == name)


def _shoelace_m2(plan: dict, room_id: str) -> float:
    points = [plan["points"][point_id] for point_id in _by_id(plan["rooms"], room_id)["point_ids"]]
    total = sum(
        first["x_mm"] * second["y_mm"] - second["x_mm"] * first["y_mm"]
        for first, second in zip(points, points[1:] + points[:1], strict=True)
    )
    return abs(total) / 2 / 1_000_000


def _edges(point_ids: Sequence[str]) -> list[frozenset[str]]:
    return [frozenset((first, point_ids[(index + 1) % len(point_ids)])) for index, first in enumerate(point_ids)]


def _omitted(plan: dict) -> set[frozenset[str]]:
    return {frozenset(item["point_ids"]) for item in plan.get("wall_overrides") or [] if item.get("omit")}


def _walled_edges(plan: dict, room_id: str) -> int:
    """A room's traced edges that carry a wall; an omitted edge is an open boundary."""

    return sum(1 for edge in _edges(_by_id(plan["rooms"], room_id)["point_ids"]) if edge not in _omitted(plan))


def _opening_guid(project_id: str, aperture: dict) -> str:
    if aperture["kind"] == "unfilled":
        return _ifc_guid(project_id, "IfcOpeningElement", f"opening:{aperture['id']}")
    ifc_class = "IfcWindow" if aperture["kind"] == "window" else "IfcDoor"
    return _ifc_guid(project_id, ifc_class, aperture["id"])


def _deepest_point(ring: Sequence[Point2D]) -> Point2D:
    """A point well inside a possibly concave ring, on a coarse grid."""

    polygon = Polygon2D(tuple(ring), ())
    xs = [point.x for point in ring]
    ys = [point.y for point in ring]
    best: tuple[float, Point2D] | None = None
    for step_x in range(1, 20):
        for step_y in range(1, 20):
            candidate = Point2D(
                min(xs) + (max(xs) - min(xs)) * step_x / 20,
                min(ys) + (max(ys) - min(ys)) * step_y / 20,
            )
            if not point_in_polygon(candidate, polygon):
                continue
            clearance = min(distance_2d(candidate, corner) for corner in ring)
            if best is None or clearance > best[0]:
                best = (clearance, candidate)
    assert best is not None
    return best[1]


def _trace_bathroom_from_inside(plan: dict) -> None:
    """Give the bathroom its own south face, one default wall thickness north of the living room's."""

    thickness = plan["default_wall"]["thickness_mm"]
    for new, old in (("bt_sw", "ba_sw"), ("bt_se", "ba_se")):
        plan["points"][new] = {**plan["points"][old], "y_mm": plan["points"][old]["y_mm"] + thickness}
    _by_id(plan["rooms"], "bathroom")["point_ids"] = ["bt_sw", "bt_se", "ba_ne", "ba_nw"]
    # The door is hosted on the living room's face; the bathroom reaches it through the merged wall.
    _by_id(plan["apertures"], "bathroom_door")["room_ids"] = ["living"]


def _add_bulkhead(plan: dict, height_mm: float = 2400) -> dict:
    """A 600 mm bulkhead band along the living room's open east edge."""

    plan["points"]["bk_n"] = {"x_mm": 5400, "y_mm": 3000, "evidence": "demo_drawing"}
    plan["points"]["bk_s"] = {"x_mm": 5400, "y_mm": 0, "evidence": "demo_drawing"}
    soffit = {
        "id": "east_bulkhead",
        "name": "East bulkhead",
        "room_id": "living",
        "kind": "bulkhead",
        "point_ids": ["bk_s", "lv_se", "lv_e", "bk_n"],
        "height_mm": height_mm,
        "geometry_evidence": "demo_drawing",
    }
    plan["soffits"] = [soffit]
    return soffit


# Review


def test_the_demo_reviews_with_no_blockers_and_every_control_passes() -> None:
    plan = _demo()
    review = review_plan_file(DEMO.parent, plan=DEMO_PLAN)

    assert review.publishable, review.blockers
    assert review.room_count == len(plan["rooms"]) == 5
    assert review.aperture_count == 8
    assert review.stair_count == 1
    assert review.site_located and review.has_underlay
    traced = {control.id: control for control in review.controls}
    assert all(control.passed for control in review.controls)
    assert traced["south_living_wall"].traced_mm == pytest.approx(6000, abs=1e-6)
    assert traced["east_house_wall"].traced_mm == pytest.approx(6000, abs=1e-6)
    # The diagonal cuts a 2000 mm square corner, so it is 2000 * sqrt(2) long.
    assert traced["diagonal_living_wall"].traced_mm == pytest.approx(2000 * math.sqrt(2), abs=1e-6)

    # One wall per distinct traced edge, less the open boundary to the snug.
    edges = {edge for room in plan["rooms"] for edge in _edges(room["point_ids"])}
    assert review.wall_count == len(edges - _omitted(plan))


def test_internal_area_excludes_outdoor_space() -> None:
    plan = _demo()
    # 6 m square less the 2 m corner triangle the diagonal cuts off.
    assert _shoelace_m2(plan, "living") == pytest.approx(36 - 2)
    assert _shoelace_m2(plan, "bedroom") == pytest.approx(9)
    assert _shoelace_m2(plan, "bathroom") == pytest.approx(4)
    assert _shoelace_m2(plan, "terrace") == pytest.approx(15)
    assert _shoelace_m2(plan, "snug") == pytest.approx(9)

    review = review_plan_file(DEMO.parent, plan=DEMO_PLAN)
    assert review.traced_net_area_m2 == pytest.approx(34 + 9 + 4 + 9, abs=0.01)
    assert not any(
        finding.code in {"exterior_wall_without_opening", "room_without_a_doorway"} and "Terrace" in finding.message
        for finding in review.warnings
    )


def test_a_level_beside_its_room_still_counts_as_floor_area() -> None:
    plan = _demo()
    review = review_plan_file(DEMO.parent, plan=DEMO_PLAN)
    interior = sum(
        _shoelace_m2(plan, room["id"]) for room in plan["rooms"] if room.get("exposure") != "exterior"
    )
    assert review.traced_net_area_m2 == pytest.approx(interior, abs=0.01)


@pytest.mark.parametrize(
    ("corners", "net_area_m2"),
    [
        # Wholly inside the living room: its floor is already the living room's.
        (((1000, 1000), (3000, 1000), (3000, 3000), (1000, 3000)), 34 + 9 + 4),
        # 5 m by 3 m reaching 2 m into the living room: only the 9 m2 outside it is new.
        (((4000, 0), (9000, 0), (9000, 3000), (4000, 3000)), 34 + 9 + 4 + 9),
    ],
)
def test_a_level_counts_only_the_floor_its_room_does_not_cover(
    demo_project: Path, corners: tuple[tuple[int, int], ...], net_area_m2: float
) -> None:
    plan = _read(demo_project)
    point_ids = [f"lvl_{index}" for index in range(len(corners))]
    for point_id, (x_mm, y_mm) in zip(point_ids, corners, strict=True):
        plan["points"][point_id] = {"x_mm": x_mm, "y_mm": y_mm, "evidence": "demo_drawing"}
    _by_id(plan["rooms"], "snug")["point_ids"] = point_ids
    _write(demo_project, plan)

    assert review_plan_file(demo_project).traced_net_area_m2 == pytest.approx(net_area_m2, abs=0.01)


def test_review_rejects_positive_area_room_overlap(demo_project: Path) -> None:
    plan = _read(demo_project)
    plan["points"].update(
        {
            "ov_1": {"x_mm": 2000, "y_mm": 5000, "evidence": "demo_drawing"},
            "ov_2": {"x_mm": 4000, "y_mm": 5000, "evidence": "demo_drawing"},
        }
    )
    # The bathroom now reaches a metre into the living room.
    _by_id(plan["rooms"], "bathroom")["point_ids"] = ["ov_1", "ov_2", "ba_ne", "ba_nw"]
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert not review.publishable
    assert any(finding.code == "room_overlap" for finding in review.blockers)


def test_rooms_hold_their_own_deepest_point_and_no_other_rooms(built_demo: tuple[Path, HomeTwin]) -> None:
    _, twin = built_demo
    plan = _demo()
    polygons = {room.name: twin.get_ceiling_polygon(room.id) for room in twin.get_rooms()}
    levels = {
        _room(twin, plan, room["id"]).name: _room(twin, plan, room["part_of"]).name
        for room in plan["rooms"]
        if room.get("part_of")
    }
    for name, polygon in polygons.items():
        point = _deepest_point(polygon.outer)
        assert point_in_polygon(point, polygon), name
        for other, other_polygon in polygons.items():
            if other == name or levels.get(name) == other:
                continue
            assert not point_in_polygon(point, other_polygon), f"{name} point falls inside {other}"


def test_a_room_with_untraced_external_openings_is_reported(demo_project: Path) -> None:
    review = review_plan_file(demo_project)
    assert not any(finding.code == "exterior_wall_without_opening" for finding in review.warnings)

    plan = _read(demo_project)
    plan["apertures"] = [
        item for item in plan["apertures"] if not (item["exposure"] == "exterior" and "bedroom" in item["room_ids"])
    ]
    _write(demo_project, plan)

    stripped = review_plan_file(demo_project)
    assert any(
        finding.code == "exterior_wall_without_opening" and "Bedroom" in finding.message
        for finding in stripped.warnings
    )


def test_a_degenerate_daylight_source_is_a_blocker(demo_project: Path) -> None:
    plan = _read(demo_project)
    corners = _by_id(plan["daylight_sources"], "bathroom_rooflight")["point_ids"]
    left = min(plan["points"][point_id]["x_mm"] for point_id in corners)
    for point_id in corners:
        if plan["points"][point_id]["x_mm"] > left:
            plan["points"][point_id]["x_mm"] = left + 10
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert not review.publishable
    assert any(finding.code == "degenerate_daylight_source" for finding in review.blockers)


def test_a_control_cannot_claim_more_precision_than_its_evidence(demo_project: Path) -> None:
    document, _, _ = load_plan(demo_project)
    first, second = document.controls[0], document.controls[1]
    laser = Evidence(source="site", status=EvidenceStatus.SITE_MEASURED, uncertainty_mm=3)
    document = document.model_copy(
        update={
            "evidence": {**document.evidence, "site_measured": laser},
            "controls": (
                *document.controls,
                ControlDimension(
                    id="measured_ok",
                    from_point=first.from_point,
                    to_point=first.to_point,
                    expected_mm=first.expected_mm,
                    tolerance_mm=5,
                    evidence="site_measured",
                ),
                ControlDimension(
                    id="too_tight",
                    from_point=second.from_point,
                    to_point=second.to_point,
                    expected_mm=second.expected_mm,
                    tolerance_mm=1,
                    evidence="demo_drawing",
                ),
                ControlDimension(
                    id="no_such_evidence",
                    from_point=first.from_point,
                    to_point=first.to_point,
                    expected_mm=first.expected_mm,
                    tolerance_mm=20,
                    evidence="tape_measure_probably",
                ),
            ),
        }
    )

    report = review_plan(document)
    tight = [finding for finding in report.warnings if finding.code == "control_tighter_than_evidence"]
    assert tight, "1 mm against 5 mm drawing evidence must be reported"
    assert "too_tight" in tight[0].message and "measured_ok" not in tight[0].message
    assert any(finding.code == "unknown_control_evidence" for finding in report.blockers)


def test_two_edges_along_one_wall_are_reported_rather_than_compiled_silently() -> None:
    def point(x: float, y: float) -> SimpleNamespace:
        return SimpleNamespace(domain=lambda x=x, y=y: Point2D(x, y))

    document = SimpleNamespace(
        points={
            "a": point(0, 0),
            "b": point(2000, 0),
            "c": point(200, 19),
            "d": point(1800, 19),
            "e": point(0, 900),
            "f": point(2000, 900),
        },
        rooms=[SimpleNamespace(id="one", part_of=None), SimpleNamespace(id="two", part_of=None)],
    )
    rooms_by_edge = {"a--b": {"one"}, "c--d": {"two"}, "e--f": {"two"}}

    findings = _overlapping_wall_edges(document, rooms_by_edge, set())
    assert [finding.code for finding in findings] == ["overlapping_wall_edges"]
    assert "19 mm apart" in findings[0].message

    # A room that is a level of another shares its walls on purpose.
    document.rooms = [SimpleNamespace(id="one", part_of=None), SimpleNamespace(id="two", part_of="one")]
    assert _overlapping_wall_edges(document, rooms_by_edge, set()) == []


# Stairs and levels


def test_a_split_level_warns_while_only_one_level_is_traced(demo_project: Path) -> None:
    assert not any(finding.code == "split_level_not_modelled" for finding in review_plan_file(demo_project).warnings)
    plan = _read(demo_project)
    for room in plan["rooms"]:
        room["floor_elevation_mm"] = 0
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert any(finding.code == "split_level_not_modelled" for finding in review.warnings)


def test_a_short_storey_flight_is_reported_as_unfinished(demo_project: Path) -> None:
    assert not any(finding.code == "partial_stair_rise" for finding in review_plan_file(demo_project).warnings)
    plan = _read(demo_project)
    plan["stairs"][0]["rise_role"] = "storey"
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert any(finding.code == "partial_stair_rise" for finding in review.warnings)
    assert review.publishable


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [("rise_role", "escalator", "unknown_stair_rise_role"), ("riser_height_mm", 433, "implausible_riser")],
)
def test_an_impossible_stair_is_a_blocker(demo_project: Path, field: str, value: object, code: str) -> None:
    plan = _read(demo_project)
    plan["stairs"][0][field] = value
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert not review.publishable
    assert any(finding.code == code for finding in review.blockers)


def test_a_level_of_an_unknown_room_is_refused(demo_project: Path) -> None:
    plan = _read(demo_project)
    _by_id(plan["rooms"], "snug")["part_of"] = "no_such_room"
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert not review.publishable
    assert any(finding.code == "unknown_parent_room" for finding in review.blockers)


def test_the_split_level_stair_spans_both_floors(built_demo: tuple[Path, HomeTwin]) -> None:
    root, twin = built_demo
    plan = _demo()
    spec = plan["stairs"][0]
    living, snug = _room(twin, plan, "living"), _room(twin, plan, "snug")
    upper = _by_id(plan["rooms"], "living")["floor_elevation_mm"]
    lower = _by_id(plan["rooms"], "snug")["floor_elevation_mm"]
    footprint_x = [plan["points"][point_id]["x_mm"] for point_id in spec["point_ids"]]
    # The flight ascends west (bearing 270), so its going is its plan width in x.
    going_mm = max(footprint_x) - min(footprint_x)

    model = ifcopenshell.open(draft_path(root))
    assert len(model.by_type("IfcStair")) == 1
    flight = model.by_type("IfcStairFlight")[0]
    assert flight.PredefinedType == "STRAIGHT"
    assert flight.NumberOfRisers == round((upper - lower) / spec["riser_height_mm"])
    assert flight.NumberOfTreads == round(going_mm / spec["tread_depth_mm"])

    (stair,) = twin.get_stairs(snug.id)
    assert set(stair.room_ids) == {living.id, snug.id}
    assert stair.riser_height_mm == pytest.approx(spec["riser_height_mm"], abs=0.5)
    assert stair.rise_mm == pytest.approx(upper - lower, abs=1)
    assert stair.bounds.minimum.z == pytest.approx(snug.elevation_mm, abs=1)
    assert stair.bounds.maximum.z == pytest.approx(living.elevation_mm, abs=1)
    assert min(point.x for point in stair.footprint.outer) == pytest.approx(min(footprint_x), abs=1)
    assert max(point.x for point in stair.footprint.outer) == pytest.approx(max(footprint_x), abs=1)


def test_get_stairs_does_not_hand_the_flight_to_a_distant_room(built_demo: tuple[Path, HomeTwin]) -> None:
    """Only rooms the flight names or within 1.5 m of it see it."""

    _, twin = built_demo
    plan = _demo()
    bathroom = _room(twin, plan, "bathroom")
    stair_top = max(plan["points"][point_id]["y_mm"] for point_id in plan["stairs"][0]["point_ids"])
    assert bathroom.bounds.minimum.y - stair_top > 1500
    assert twin.get_stairs(bathroom.id) == ()


def test_a_lower_level_is_part_of_its_room(built_demo: tuple[Path, HomeTwin]) -> None:
    root, twin = built_demo
    plan = _demo()
    snug, living = _room(twin, plan, "snug"), _room(twin, plan, "living")
    assert snug.part_of == living.id
    assert living.part_of is None
    assert snug.elevation_mm == pytest.approx(_by_id(plan["rooms"], "snug")["floor_elevation_mm"], abs=0.5)
    # A level is reached through its room, so it is not reported unreachable.
    assert not any(
        finding.code == "room_without_a_doorway" and snug.name in finding.message
        for finding in review_plan_file(root).warnings
    )
    model = ifcopenshell.open(draft_path(root))
    composition = {space.Name: space.CompositionType for space in model.by_type("IfcSpace")}
    assert composition[snug.name] == "PARTIAL"
    assert composition[living.name] == "ELEMENT"


def test_an_opening_on_a_level_belongs_to_the_room_that_level_is_part_of(built_demo: tuple[Path, HomeTwin]) -> None:
    _, twin = built_demo
    plan = _demo()
    window = _by_id(plan["apertures"], "snug_window")
    assert window["room_ids"] == ["snug"]
    living = _room(twin, plan, "living")
    assert any(opening.name == window["name"] for opening in twin.get_openings(living.id))


# Draft build


def test_the_demo_draft_reopens_with_rooms_walls_and_ceilings(demo_project: Path) -> None:
    canonical = demo_project / "model" / "house.ifc"
    canonical_bytes = canonical.read_bytes()
    plan = _read(demo_project)

    report = build_draft(demo_project)

    assert report.path == demo_project / "model" / "draft.ifc"
    assert report.published
    assert report.schema_issue_count == 0
    assert len(report.rooms_verified) == len(plan["rooms"])
    assert canonical.read_bytes() == canonical_bytes

    twin = HomeTwin.open(report.path)
    assert {room.name for room in twin.get_rooms()} == {room["name"] for room in plan["rooms"]}
    for spec in plan["rooms"]:
        room = _room(twin, plan, spec["id"])
        # Each ceiling lands at its room's own floor plus its stated height.
        expected = spec.get("floor_elevation_mm", 0) + spec["ceiling_height_mm"]
        assert twin.get_ceiling(room.id).elevation_mm == pytest.approx(expected, abs=0.5), spec["id"]
        assert len(twin.get_room_context(room.id).walls) == _walled_edges(plan, spec["id"]), spec["id"]
        assert room.is_external == (spec.get("exposure") == "exterior"), spec["id"]

    model = ifcopenshell.open(report.path)
    terrace = _by_id(plan["rooms"], "terrace")["name"]
    assert next(space for space in model.by_type("IfcSpace") if space.Name == terrace).PredefinedType == "EXTERNAL"
    assert not [covering for covering in model.by_type("IfcCovering") if (covering.Name or "").startswith(terrace)]


def test_the_site_survives_into_the_draft(built_demo: tuple[Path, HomeTwin]) -> None:
    _, twin = built_demo
    stated = _demo()["site"]
    site = twin.get_site()
    assert site.latitude_deg == pytest.approx(stated["latitude_deg"])
    assert site.longitude_deg == pytest.approx(stated["longitude_deg"])
    assert site.true_north_deg == pytest.approx(stated["true_north_deg"], abs=1e-9)
    assert site.timezone == stated["timezone"]


def test_a_lower_finished_ceiling_is_a_soffit_below_the_slab(built_demo: tuple[Path, HomeTwin]) -> None:
    root, twin = built_demo
    plan = _demo()
    for spec in plan["rooms"]:
        ceiling = twin.get_ceiling(_room(twin, plan, spec["id"]).id)
        structural = spec.get("structural_ceiling_height_mm")
        if structural is None:
            assert ceiling.structural_elevation_mm is None, spec["id"]
            continue
        assert ceiling.structural_elevation_mm == pytest.approx(spec.get("floor_elevation_mm", 0) + structural)
        assert ceiling.elevation_mm < ceiling.structural_elevation_mm
        assert ceiling.board_thickness_mm == pytest.approx(spec["ceiling_board_thickness_mm"])

    model = ifcopenshell.open(draft_path(root))
    coverings = {
        covering.Name: covering.Description
        for covering in model.by_type("IfcCovering")
        if (covering.Name or "").endswith(" ceiling")
    }
    dropped = {
        f"{room['name']} ceiling"
        for room in plan["rooms"]
        if (room.get("structural_ceiling_height_mm") or 0) > room["ceiling_height_mm"] + 1
    }
    assert dropped == {"Bathroom ceiling"}
    for name, description in coverings.items():
        assert description == ("gypsum_soffit" if name in dropped else "structural_ceiling"), name


def test_openings_survive_native_ifc_roundtrip(built_demo: tuple[Path, HomeTwin]) -> None:
    _, twin = built_demo
    plan = _demo()
    reopened = {opening.id: opening for room in twin.get_rooms() for opening in twin.get_openings(room.id)}
    for aperture in plan["apertures"]:
        opening = reopened[_opening_guid(plan["project_id"], aperture)]
        assert opening.kind.value == aperture["kind"]
        assert distance_2d(opening.start, opening.end) == pytest.approx(aperture["width_mm"], abs=0.5)
        assert opening.exposure == aperture["exposure"]
        # Heights are measured from the room's own floor, split level included.
        assert opening.sill_height_mm == pytest.approx(aperture["sill_height_mm"], abs=0.5)
        assert opening.head_height_mm == pytest.approx(aperture["sill_height_mm"] + aperture["height_mm"], abs=0.5)

    for source in plan["daylight_sources"]:
        assert any(
            item.name == source["name"] for room in twin.get_rooms() for item in twin.get_daylight_sources(room.id)
        ), source["id"]


def test_a_traced_offset_places_an_opening_off_centre(built_demo: tuple[Path, HomeTwin]) -> None:
    _, twin = built_demo
    plan = _demo()
    points = plan["points"]
    reopened = {opening.id: opening for room in twin.get_rooms() for opening in twin.get_openings(room.id)}
    for aperture in plan["apertures"]:
        opening = reopened[_opening_guid(plan["project_id"], aperture)]
        first = points[aperture["host_edge"][0]]
        host_start = Point2D(first["x_mm"], first["y_mm"])
        near = min(distance_2d(host_start, opening.start), distance_2d(host_start, opening.end))
        assert near == pytest.approx(aperture["offset_mm"], abs=2), aperture["id"]


def test_the_diagonal_wall_face_runs_at_45_degrees_facing_the_room(built_demo: tuple[Path, HomeTwin]) -> None:
    _, twin = built_demo
    living = _room(twin, _demo(), "living")
    diagonal = [
        face
        for face in twin.get_room_context(living.id).walls
        if abs(face.end.x - face.start.x) > 100 and abs(face.end.y - face.start.y) > 100
    ]
    assert len(diagonal) == 1
    face = diagonal[0]
    assert abs(face.end.x - face.start.x) == pytest.approx(abs(face.end.y - face.start.y), abs=0.5)
    # The room lies south-east of the cut corner.
    assert face.inward_normal.x == pytest.approx(math.sqrt(0.5), abs=1e-6)
    assert face.inward_normal.y == pytest.approx(-math.sqrt(0.5), abs=1e-6)


def test_wall_faces_carry_their_stated_thickness(demo_project: Path) -> None:
    plan = _read(demo_project)
    plan["wall_overrides"].append({"point_ids": ["sn_se", "sn_ne"], "thickness_mm": 300, "evidence": "demo_drawing"})
    _write(demo_project, plan)

    twin = HomeTwin.open(build_draft(demo_project).path)
    snug = _room(twin, plan, "snug")
    thicknesses = sorted(
        round(wall.thickness_mm) for room in twin.get_rooms() for wall in twin.get_room_context(room.id).walls
    )
    assert 300 in {round(wall.thickness_mm) for wall in twin.get_room_context(snug.id).walls}
    assert thicknesses.count(300) == 1
    assert set(thicknesses) == {plan["default_wall"]["thickness_mm"], 300}


def test_a_cased_opening_reaches_ifc_with_no_filling(demo_project: Path) -> None:
    plan = _read(demo_project)
    aperture = _by_id(plan["apertures"], "bedroom_door")
    aperture["kind"] = "unfilled"
    aperture.pop("swing")
    _write(demo_project, plan)

    report = build_draft(demo_project)
    model = ifcopenshell.open(report.path)
    cased = [
        opening
        for opening in model.by_type("IfcOpeningElement")
        if element_util.get_psets(opening).get("Pset_HomeTwinDaylight", {}).get("Unfilled")
    ]
    assert [opening.Name for opening in cased] == [f"{aperture['name']} opening"]
    assert not [door for door in model.by_type("IfcDoor") if door.Name == aperture["name"]]

    twin = HomeTwin.open(report.path)
    for room_id in aperture["room_ids"]:
        opening = next(
            item
            for item in twin.get_openings(_room(twin, plan, room_id).id)
            if item.name.startswith(aperture["name"])
        )
        assert opening.kind.value == "unfilled"
        assert opening.exposure == aperture["exposure"]
        assert opening.head_height_mm == pytest.approx(aperture["sill_height_mm"] + aperture["height_mm"], abs=0.5)


def test_an_opening_is_cut_once(built_demo: tuple[Path, HomeTwin]) -> None:
    root, _ = built_demo
    model = ifcopenshell.open(draft_path(root))
    voids: dict[str, int] = {}
    for relation in model.by_type("IfcRelVoidsElement"):
        key = (relation.RelatedOpeningElement.Description or "").strip()
        voids[key] = voids.get(key, 0) + 1
    assert voids == {item["id"]: 1 for item in _demo()["apertures"]}


def test_a_wall_traced_from_both_sides_compiles_to_one_wall(demo_project: Path) -> None:
    plan = _read(demo_project)
    _trace_bathroom_from_inside(plan)
    _write(demo_project, plan)
    assert review_plan_file(demo_project).publishable

    report = build_draft(demo_project)
    model = ifcopenshell.open(report.path)
    walls = model.by_type("IfcWall")
    merged = [wall for wall in walls if "+" in (wall.Name or "")]
    assert len(merged) == 1
    edges = {edge for room in plan["rooms"] for edge in _edges(room["point_ids"])}
    assert len(walls) == len(edges - _omitted(plan)) - len(merged)

    # The door in that wall is still cut once.
    voids = [
        relation
        for relation in model.by_type("IfcRelVoidsElement")
        if relation.RelatedOpeningElement.Description == "bathroom_door"
    ]
    assert len(voids) == 1

    twin = HomeTwin.open(report.path)
    living, bathroom = _room(twin, plan, "living"), _room(twin, plan, "bathroom")
    for room_id in ("living", "bathroom"):
        room = _room(twin, plan, room_id)
        assert len(twin.get_room_context(room.id).walls) == _walled_edges(plan, room_id)
    assert any(opening.name == "Bathroom door" for opening in twin.get_openings(bathroom.id))

    faces: dict[str, list] = {}
    for room in (living, bathroom):
        for wall in twin.get_room_context(room.id).walls:
            faces.setdefault(wall.wall_id, []).append(wall)
    shared = [pair for pair in faces.values() if len(pair) == 2]
    assert len(shared) == 1
    near, far = shared[0]
    # The two faces look at each other across one wall thickness.
    assert near.inward_normal.x * far.inward_normal.x + near.inward_normal.y * far.inward_normal.y == pytest.approx(-1)
    length = distance_2d(near.start, near.end)
    unit_x, unit_y = (near.end.x - near.start.x) / length, (near.end.y - near.start.y) / length
    gap = abs(-(far.start.x - near.start.x) * unit_y + (far.start.y - near.start.y) * unit_x)
    thickness = plan["default_wall"]["thickness_mm"]
    assert gap == pytest.approx(thickness, abs=1)
    assert near.thickness_mm == pytest.approx(thickness, abs=1)
    assert far.thickness_mm == pytest.approx(thickness, abs=1)


def test_a_door_in_a_wall_traced_from_both_sides_reaches_the_far_room_in_review(demo_project: Path) -> None:
    plan = _read(demo_project)
    _trace_bathroom_from_inside(plan)
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert not any(
        finding.code == "room_without_a_doorway" and "Bathroom" in finding.message for finding in review.warnings
    )


def test_a_soffit_is_traced_where_it_is_and_obstructs_light_there(demo_project: Path) -> None:
    from home_twin.occlusion import collect_occluders

    plan = _read(demo_project)
    spec = _add_bulkhead(plan)
    _write(demo_project, plan)

    report = build_draft(demo_project)
    twin = HomeTwin.open(report.path)
    room = _room(twin, plan, spec["room_id"])
    soffit = next(item for item in twin.get_soffits(room.id) if item.name == spec["name"])
    assert soffit.kind == spec["kind"]
    assert soffit.height_above_floor_mm == pytest.approx(spec["height_mm"], abs=0.5)
    assert soffit.elevation_mm == pytest.approx(room.elevation_mm + spec["height_mm"], abs=0.5)
    occluders = collect_occluders(twin.get_room_context(room.id), minimum_height_mm=room.elevation_mm)
    prism = next(slab for slab in occluders.slabs if slab.id == soffit.id)
    assert prism.top_z > prism.base_z

    model = ifcopenshell.open(report.path)
    patches = [
        covering
        for covering in model.by_type("IfcCovering")
        if (covering.Description or "").startswith("gypsum_") and not (covering.Name or "").endswith(" ceiling")
    ]
    assert [covering.Description for covering in patches] == ["gypsum_bulkhead"]


def test_a_soffit_hanging_above_its_own_ceiling_is_refused(demo_project: Path) -> None:
    plan = _read(demo_project)
    _add_bulkhead(plan, height_mm=9000)
    _write(demo_project, plan)

    review = review_plan_file(demo_project)
    assert not review.publishable
    assert any(finding.code == "soffit_above_its_ceiling" for finding in review.blockers)


def test_proposed_layouts_are_savable_in_every_room(built_demo: tuple[Path, HomeTwin]) -> None:
    from home_twin.fixtures import SpotlightSpec

    _, twin = built_demo
    spec = SpotlightSpec(lumens=650, mounting_depth_mm=70)
    for room in twin.get_rooms():
        proposal = twin.optimise_spotlight_layout(room.id, spec)
        findings = proposal.validation.findings
        assert [finding.code for finding in findings if finding.severity == "error"] == [], room.name
        if proposal.layout.fixtures:
            assert twin.validate_lighting_layout(proposal.layout).valid
        else:
            # An empty proposal has to explain itself.
            assert "no_compliant_seat" in [finding.code for finding in findings], room.name


# Revisions and guards


def test_rebuilding_the_same_source_is_a_noop_with_stable_ids(demo_project: Path) -> None:
    first = build_draft(demo_project)
    first_bytes = first.path.read_bytes()
    first_ids = {room.name: room.id for room in HomeTwin.open(first.path).get_rooms()}

    second = build_draft(demo_project)

    assert not second.published
    assert second.revision == first.revision
    assert second.path.read_bytes() == first_bytes
    assert {room.name: room.id for room in HomeTwin.open(second.path).get_rooms()} == first_ids


def test_a_changed_source_requires_the_exact_draft_revision(demo_project: Path) -> None:
    first = build_draft(demo_project)
    canonical = demo_project / "model" / "house.ifc"
    canonical_bytes = canonical.read_bytes()
    plan = _read(demo_project)
    plan["review_notes"].append("Test revision")
    _write(demo_project, plan)

    with pytest.raises(DraftReplacementRequired):
        build_draft(demo_project)
    with pytest.raises(StaleRevision):
        build_draft(demo_project, replace_revision="sha256:stale")

    replaced = build_draft(demo_project, replace_revision=first.revision)
    assert replaced.published
    assert replaced.revision != first.revision
    assert canonical.read_bytes() == canonical_bytes


def test_a_failed_control_leaves_both_ifc_files_unchanged(demo_project: Path) -> None:
    first = build_draft(demo_project)
    draft_bytes = first.path.read_bytes()
    canonical = demo_project / "model" / "house.ifc"
    canonical_bytes = canonical.read_bytes()
    plan = _read(demo_project)
    plan["controls"][0]["expected_mm"] = 9999
    _write(demo_project, plan)

    with pytest.raises(DraftPlanError, match="south_living_wall"):
        build_draft(demo_project, replace_revision=first.revision)

    assert first.path.read_bytes() == draft_bytes
    assert canonical.read_bytes() == canonical_bytes


def test_the_build_refuses_a_hardlink_to_the_canonical_model(demo_project: Path) -> None:
    canonical = demo_project / "model" / "house.ifc"
    draft_path(demo_project).hardlink_to(canonical)
    canonical_bytes = canonical.read_bytes()

    with pytest.raises(DraftBuildRejected, match="cannot alias"):
        build_draft(demo_project)

    assert canonical.read_bytes() == canonical_bytes


def test_rebuilding_refuses_to_silently_discard_anything_authored_in_the_draft(demo_project: Path) -> None:
    from home_twin.fixtures import RoomLightingDesign, SpotlightSpec

    first = build_draft(demo_project)
    twin = HomeTwin.open(first.path)
    room = _room(twin, _read(demo_project), "living")
    proposal = twin.optimise_spotlight_layout(room.id, SpotlightSpec(lumens=650, mounting_depth_mm=70))
    assert proposal.layout.fixtures
    twin.apply_room_lighting_design(
        RoomLightingDesign(room.id, proposal.layout.fixtures), expected_revision=twin.revision
    )
    assert sum(_draft_authored_counts(first.path).values()) > 0

    plan = _read(demo_project)
    plan["review_notes"].append("Test revision")
    _write(demo_project, plan)
    revision = _sha256(first.path)

    # The refusal names what would go, not just how much of it.
    with pytest.raises(DraftWouldDiscardFixtures, match="IfcLightFixture"):
        build_draft(demo_project, replace_revision=revision)
    assert sum(_draft_authored_counts(first.path).values()) > 0

    replaced = build_draft(demo_project, replace_revision=revision, discard_fixtures=True)
    assert replaced.published
    assert sum(_draft_authored_counts(replaced.path).values()) == 0


def test_the_rebuild_guard_names_everything_it_would_destroy() -> None:
    for expected in ("IfcFurniture", "IfcSanitaryTerminal", "IfcUnitaryEquipment", "IfcWasteTerminal"):
        assert expected in AUTHORED_IN_DRAFT, expected
    # Walls and spaces come from the plan and are rebuilt, not lost.
    assert "IfcWall" not in AUTHORED_IN_DRAFT
    assert "IfcSpace" not in AUTHORED_IN_DRAFT


# Source round trip


def test_dump_plan_reproduces_the_demo_source_byte_for_byte() -> None:
    document, _, _ = load_plan(DEMO.parent, plan=DEMO_PLAN)
    assert dump_plan(document) == DEMO_PLAN.read_text(encoding="utf-8")


def test_saving_an_unchanged_plan_keeps_it_byte_identical_and_records_history(demo_project: Path) -> None:
    source = _source(demo_project)
    before = source.read_bytes()
    document, _, revision = load_plan(demo_project)

    saved_revision, review = save_plan(document, demo_project, expected_revision=revision)

    assert source.read_bytes() == before
    assert saved_revision == revision
    assert review.publishable
    history = list((source.parent / "history").iterdir())
    assert len(history) == 1
    assert history[0].read_bytes() == before
    assert history[0].name.startswith("plan-")

    with pytest.raises(StaleRevision):
        save_plan(document, demo_project, expected_revision="sha256:stale")


# Source location


def test_an_explicit_plan_wins_over_both_defaults(tmp_path: Path) -> None:
    references = tmp_path / "model" / "references"
    references.mkdir(parents=True)
    (references / "plan.yaml").touch()
    (references / "m1-plan.yaml").touch()
    root = tmp_path.resolve()

    assert plan_path(root, "elsewhere/house.yaml") == root / "elsewhere" / "house.yaml"
    assert plan_path(root) == root / "model" / "references" / "plan.yaml"
    assert draft_path(root) == root / "model" / "draft.ifc"
    assert underlay_stem(plan_path(root)) == "underlay"


def test_the_default_plan_is_plan_yaml_even_before_it_exists(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    assert plan_path(root) == root / "model" / "references" / "plan.yaml"
    assert draft_path(root) == root / "model" / "draft.ifc"


def test_a_lone_legacy_source_is_found_and_keeps_its_legacy_names(tmp_path: Path) -> None:
    root = _make_project(tmp_path, plan_name="m1-plan.yaml").resolve()

    found = plan_path(root)
    assert found == root / "model" / "references" / "m1-plan.yaml"
    assert draft_path(root) == root / "model" / "m1-draft.ifc"
    assert underlay_stem(found) == "m1-underlay"
    assert review_plan_file(root).publishable
    assert build_draft(root).path == root / "model" / "m1-draft.ifc"


# Schema ids


def _with_schema(tmp_path: Path, schema: str) -> Path:
    text = DEMO_PLAN.read_text(encoding="utf-8")
    assert text.startswith("schema: home-twin.plan/v3\n")
    path = tmp_path / "plan.yaml"
    path.write_text(text.replace("home-twin.plan/v3", schema, 1), encoding="utf-8")
    return path


def test_a_legacy_v3_schema_id_still_loads_and_is_kept(tmp_path: Path) -> None:
    path = _with_schema(tmp_path, "home-twin.m1-plan/v3")
    document, review, _ = load_plan(tmp_path, plan=path)
    assert review.publishable
    assert document.schema_id == "home-twin.m1-plan/v3"
    assert dump_plan(document) == path.read_text(encoding="utf-8")


def test_a_v2_schema_with_a_site_block_is_rejected(tmp_path: Path) -> None:
    path = _with_schema(tmp_path, "home-twin.m1-plan/v2")
    with pytest.raises(ValueError, match="requires schema"):
        load_plan(tmp_path, plan=path)


def test_an_unknown_schema_id_is_rejected(tmp_path: Path) -> None:
    path = _with_schema(tmp_path, "home-twin.plan/v99")
    with pytest.raises(ValueError, match="Unsupported plan schema"):
        load_plan(tmp_path, plan=path)


# CLI


@pytest.mark.parametrize("command", ["review-plan", "review-m1-plan"])
def test_the_cli_reviews_a_named_plan(
    demo_project: Path, command: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from home_twin.cli import main

    monkeypatch.setattr(
        sys,
        "argv",
        ["home-twin", command, "--project-root", str(demo_project), "--plan", "model/references/plan.yaml"],
    )
    main()

    review = json.loads(capsys.readouterr().out)
    assert review["blockers"] == []
    assert len(review["controls"]) == 3
    assert all(control["passed"] for control in review["controls"])


def test_the_cli_builds_the_draft_under_both_names(
    demo_project: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from home_twin.cli import main

    reports = []
    for command in ("build-draft", "build-m1-draft"):
        monkeypatch.setattr(
            sys,
            "argv",
            ["home-twin", command, "--project-root", str(demo_project), "--plan", "model/references/plan.yaml"],
        )
        main()
        reports.append(json.loads(capsys.readouterr().out))

    first, second = reports
    assert first["published"] is True
    # The alias sees the same source and leaves the published draft alone.
    assert second["published"] is False
    assert first["path"] == second["path"] == str(draft_path(demo_project))
    assert first["revision"] == second["revision"]
