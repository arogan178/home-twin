from __future__ import annotations

import shutil
from dataclasses import replace
from pathlib import Path

import pytest

from home_twin.fixtures import (
    NARROW_SPOTLIGHT,
    RADIUM_36_SPOTLIGHT,
    RADIUM_60_SPOTLIGHT,
    RADIUM_120_SPOTLIGHT,
    RADIUM_43922571,
    RADIUM_44020758,
    RADIUM_44122574,
    WET_ROOM_SPOTLIGHT,
    WIDE_SPOTLIGHT,
    PendantSpec,
    PlannedPendant,
    PlannedRopeLight,
    PlannedSpotlight,
    PlannedWallSwitch,
    RoomLightingDesign,
    RopeLightSpec,
    SpotlightSpec,
)
from home_twin.lighting import validate_room_lighting, wall_switch_point
from home_twin.model import HomeTwin, Point3D


def test_one_physical_switch_can_control_multiple_spotlights(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    ceiling_z = context.ceiling.elevation_mm
    north = max(context.walls, key=lambda wall: (wall.start.y + wall.end.y) / 2)
    lights = (
        PlannedSpotlight("SP10", room.id, Point3D(1500, 1400, ceiling_z), SpotlightSpec(), "MAIN"),
        PlannedSpotlight("SP11", room.id, Point3D(4500, 1400, ceiling_z), SpotlightSpec(), "MAIN"),
    )
    device = PlannedWallSwitch("SW01", room.id, north.wall_id, 3000, 1100, "MAIN")

    report = validate_room_lighting(RoomLightingDesign(room.id, lights, (device,)), context, twin.constraints)

    assert report.valid
    assert not any(finding.code == "switch_group_empty" for finding in report.findings)
    assert wall_switch_point(device, north, room.elevation_mm).z == 1100


def test_pendant_and_rope_are_typed_geometric_devices(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    ceiling_z = context.ceiling.elevation_mm
    pendant = PlannedPendant(
        "PN01",
        room.id,
        Point3D(3000, 2000, ceiling_z),
        PendantSpec(drop_mm=500),
        "ACCENT",
    )
    rope = PlannedRopeLight(
        "RL01",
        room.id,
        (Point3D(1000, 3000, ceiling_z), Point3D(5000, 3000, ceiling_z)),
        RopeLightSpec(),
        "ACCENT",
    )

    report = validate_room_lighting(RoomLightingDesign(room.id, (pendant, rope)), context, twin.constraints)

    assert report.valid
    assert pendant.emitter_point == Point3D(3000, 2000, ceiling_z - 500)


def test_visual_beam_angle_cannot_create_a_physical_layout_error(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    point = Point3D(3000, 2000, context.ceiling.elevation_mm)
    narrow = PlannedSpotlight("SP10", room.id, point, SpotlightSpec(beam_angle_deg=18), "MAIN")
    wide = replace(narrow, spec=replace(narrow.spec, beam_angle_deg=120))

    narrow_report = validate_room_lighting(RoomLightingDesign(room.id, (narrow,)), context, twin.constraints)
    wide_report = validate_room_lighting(RoomLightingDesign(room.id, (wide,)), context, twin.constraints)

    assert narrow_report == wide_report


@pytest.mark.parametrize(
    ("spec", "article", "beam", "peak"),
    [
        (RADIUM_43922571, "43922571", 36, 900),
        (RADIUM_44020758, "44020758", 60, 700),
        (RADIUM_44122574, "44122574", 120, 200),
    ],
)
def test_radium_catalog_records_hold_the_published_lamp_data(spec, article: str, beam: int, peak: int) -> None:
    assert article in (spec.model or "")
    assert spec.lumens == 575
    assert spec.beam_angle_deg == beam
    assert spec.cct_kelvin == 3000
    assert spec.cri == 90
    assert spec.dimmable
    assert spec.peak_candela == peak


def test_open_plan_role_aliases_use_the_radium_catalog_records() -> None:
    assert NARROW_SPOTLIGHT is RADIUM_36_SPOTLIGHT is RADIUM_43922571
    assert WIDE_SPOTLIGHT is RADIUM_60_SPOTLIGHT is RADIUM_44020758
    assert RADIUM_120_SPOTLIGHT is RADIUM_44122574


@pytest.mark.parametrize("spec", [RADIUM_43922571, RADIUM_44020758, RADIUM_44122574])
def test_radium_lamp_data_survives_ifc_save_and_reload(sample_path, spec) -> None:
    # The manufacturer files stay out of the repository; a synthetic beam stands in at their paths.
    synthetic = Path(__file__).parent / "fixtures" / "synthetic-spot.ldt"
    for path in {spec.ies_path for spec in (RADIUM_43922571, RADIUM_44020758) if spec.ies_path}:
        target = sample_path.parents[1] / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(synthetic, target)
    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    added = twin.add_spotlight(
        room.id,
        fixture_id=f"RAD{int(spec.beam_angle_deg)}",
        point=Point3D(1500, 2700, 2800),
        spec=spec,
        switching_group="OPEN_PLAN_MAIN",
        expected_revision=twin.revision,
    )

    reopened = HomeTwin.open(twin.model_path)
    persisted = reopened.get_light_fixture(added.id)
    assert persisted.id == added.id
    assert persisted.tag == f"RAD{int(spec.beam_angle_deg)}"
    assert persisted.spec == spec



def test_a_spotlight_keeps_its_ip_rating_through_ifc_save_and_reload(twin: HomeTwin) -> None:
    room = twin.get_rooms()[0]
    ceiling_z = twin.get_room_context(room.id).ceiling.elevation_mm

    saved = twin.add_spotlight(
        room.id,
        fixture_id="WET1",
        point=Point3D(3000, 2800, ceiling_z),
        spec=WET_ROOM_SPOTLIGHT,
        switching_group="BATH",
    )

    reopened = HomeTwin.open(twin.model_path).get_light_fixture(saved.id)
    assert reopened.spec.ip_rating == "IP20"
    assert reopened.spec == WET_ROOM_SPOTLIGHT
    assert twin.get_light_fixtures(room.id)[0].spec.ip_rating is None, "the sample's dry-room spots state none"


def test_a_vertical_wall_strip_keeps_its_wet_room_spec_through_ifc_save_and_reload(twin: HomeTwin) -> None:
    """A mirror strip is a wall run with no plan length, and it carries an IP rating.

    Both parts are new: the cove runs are horizontal, and only spotlights used
    to record how well the fitting has to be sealed.
    """
    from home_twin.fixtures import RopeMounting

    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    floor_z = context.room.elevation_mm
    spec = RopeLightSpec(
        model="COB 24V 4000K CRI97 R9>50 10W/m in opal-lens profile",
        lumens_per_m=900,
        cct_kelvin=4000,
        cri=97,
        diameter_mm=12,
        minimum_bend_radius_mm=40,
        mounting=RopeMounting.WALL,
        ip_rating="IP44",
    )
    strip = PlannedRopeLight(
        "MIR-L",
        room.id,
        (Point3D(3000, 2000, floor_z + 1200), Point3D(3000, 2000, floor_z + 1900)),
        spec,
        "BATH_MIRROR",
    )
    design = RoomLightingDesign(room.id, (strip,))

    assert validate_room_lighting(design, context, twin.constraints).valid
    twin.apply_room_lighting_design(design, expected_revision=twin.revision)

    reopened = HomeTwin.open(twin.model_path)
    saved = next(item for item in reopened.get_luminaires(room.id) if item.tag == "MIR-L")
    assert saved.spec == spec
    assert [(point.x, point.y, point.z) for point in saved.path] == [
        (3000, 2000, floor_z + 1200),
        (3000, 2000, floor_z + 1900),
    ]


def test_a_switch_records_which_face_of_its_wall_it_is_fitted_to(twin: HomeTwin) -> None:
    """A wall is shared, so naming it does not say which side you reach the plate from.

    A wet room is normally switched from outside it, and the derived point sits
    on the wall line either way, so the face has to be stated rather than
    inferred from the coordinate.
    """
    from home_twin.fixtures import WallSwitchFace, WallSwitchKind, WallSwitchSpec

    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    north = max(context.walls, key=lambda wall: (wall.start.y + wall.end.y) / 2)
    spot = PlannedSpotlight(
        "SP20",
        room.id,
        Point3D(3000, 2000, context.ceiling.elevation_mm),
        SpotlightSpec(),
        "OUTSIDE",
    )
    outside = PlannedWallSwitch(
        "SWX",
        room.id,
        north.wall_id,
        3000,
        1100,
        "OUTSIDE",
        WallSwitchSpec(kind=WallSwitchKind.DIMMER),
        mounting_face=WallSwitchFace.OPPOSITE,
    )
    design = RoomLightingDesign(room.id, (spot,), (outside,))

    assert validate_room_lighting(design, context, twin.constraints).valid
    twin.apply_room_lighting_design(design, expected_revision=twin.revision)

    reopened = HomeTwin.open(twin.model_path)
    saved = next(item for item in reopened.get_wall_switches(room.id) if item.tag == "SWX")
    assert saved.mounting_face is WallSwitchFace.OPPOSITE
    # The face is a stated fact, not a second coordinate: the point is still the
    # one the wall and offset derive, so the same plate on the room face lands here too.
    assert saved.point == wall_switch_point(outside, north, context.room.elevation_mm)


def test_a_movement_sensor_round_trips_through_ifc_with_what_it_controls(sample_path) -> None:
    from home_twin.fixtures import PlannedSensor, SensorSpec

    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    ceiling_z = twin.get_room_context(room.id).ceiling.elevation_mm
    design = twin.get_room_lighting_design(room.id)
    sensor = PlannedSensor(
        "PIR09",
        room.id,
        Point3D(2200, 1800, ceiling_z),
        20,
        controls_tag="EF09",
        spec=SensorSpec(detection_diameter_mm=6000),
    )

    twin.apply_room_lighting_design(replace(design, sensors=(sensor,)), expected_revision=twin.revision)

    saved = HomeTwin.open(sample_path).get_sensors(room.id)
    assert [item.tag for item in saved] == ["PIR09"]
    assert saved[0].controls_tag == "EF09"
    assert saved[0].run_on_minutes == 20
    assert saved[0].spec.detection_diameter_mm == 6000
    assert (saved[0].point.x, saved[0].point.y) == (2200, 1800)

    reopened = HomeTwin.open(sample_path)
    moved = replace(
        reopened.get_room_lighting_design(room.id),
        sensors=(replace(saved[0], point=Point3D(2600, 1800, ceiling_z)),),
    )
    reopened.apply_room_lighting_design(moved, expected_revision=reopened.revision)
    assert HomeTwin.open(sample_path).get_sensors(room.id)[0].point.x == 2600, "a sensor moves by tag, not by copy"

    cleared = HomeTwin.open(sample_path)
    cleared.apply_room_lighting_design(
        replace(cleared.get_room_lighting_design(room.id), sensors=()),
        expected_revision=cleared.revision,
    )
    assert HomeTwin.open(sample_path).get_sensors(room.id) == (), "dropping it from the design removes the entity"


def test_a_sensor_states_what_it_switches_and_is_checked_against_the_ceiling(twin: HomeTwin) -> None:
    """IFC4 has no occupancy sensor, so the class alone says only "movement here".

    What it controls and for how long are the whole point of modelling it, and
    a fan is not a luminaire, so the link is a tag rather than a switching group.
    """
    from home_twin.fixtures import PlannedSensor, SensorSpec

    room = twin.get_rooms()[0]
    context = twin.get_room_context(room.id)
    ceiling_z = context.ceiling.elevation_mm

    with pytest.raises(ValueError, match="either a control group or one installation tag"):
        PlannedSensor("PIR01", room.id, Point3D(0, 0, 0), 20, controls_tag="  ")
    with pytest.raises(ValueError, match="either a control group or one installation tag"):
        PlannedSensor("PIR01", room.id, Point3D(0, 0, 0), 20)
    with pytest.raises(ValueError, match="either a control group or one installation tag"):
        PlannedSensor("PIR01", room.id, Point3D(0, 0, 0), 20, controls_tag="EF01", switching_group="CORRIDOR")
    with pytest.raises(ValueError, match="cannot control itself"):
        PlannedSensor("PIR01", room.id, Point3D(0, 0, 0), 20, controls_tag="PIR01")
    with pytest.raises(ValueError, match="run-on"):
        PlannedSensor("PIR01", room.id, Point3D(0, 0, 0), 0, controls_tag="EF01")
    with pytest.raises(ValueError, match="Detection diameter"):
        SensorSpec(detection_diameter_mm=0)

    lights = (PlannedSpotlight("SP20", room.id, Point3D(1500, 1400, ceiling_z), SpotlightSpec(), "MAIN"),)
    report = validate_room_lighting(
        RoomLightingDesign(
            room.id,
            lights,
            sensors=(
                PlannedSensor("PIR20", room.id, Point3D(1500, 1400, ceiling_z - 300), 20, controls_tag="EF20"),
                PlannedSensor("PIR21", room.id, Point3D(-400, 1400, ceiling_z), 20, controls_tag="SP20"),
            ),
        ),
        context,
        twin.constraints,
    )
    grouped = validate_room_lighting(
        RoomLightingDesign(
            room.id,
            lights,
            sensors=(
                PlannedSensor("PIR22", room.id, Point3D(1500, 1400, ceiling_z), 20, switching_group="MAIN"),
                PlannedSensor("PIR23", room.id, Point3D(2500, 1400, ceiling_z), 20, switching_group="NOWHERE"),
            ),
        ),
        context,
        twin.constraints,
    )
    empty = {f.fixture_tags for f in grouped.findings if f.code == "sensor_controls_empty_group"}
    assert empty == {("PIR23",)}, "a sensor on the room's own group lights something; NOWHERE does not"

    codes = {finding.code for finding in report.findings}
    assert "sensor_wrong_ceiling_elevation" in codes, "a sensor sits on the ceiling plane, like a downlight"
    assert "sensor_outside_ceiling" in codes
    # PIR20 names a fan, which no room can confirm; PIR21 names a light in this room.
    assert {finding.fixture_tags for finding in report.findings if finding.code == "sensor_controls_unknown_tag"} == {
        ("PIR20",)
    }


def test_a_sensor_reaches_the_installation_sheet_with_its_load_and_run_on(sample_path) -> None:
    from home_twin.exports import build_installation_plan
    from home_twin.fixtures import PlannedSensor

    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    ceiling_z = twin.get_room_context(room.id).ceiling.elevation_mm
    design = replace(
        twin.get_room_lighting_design(room.id),
        sensors=(PlannedSensor("PIR30", room.id, Point3D(1500, 1400, ceiling_z), 20, controls_tag="EF30"),),
    )

    plan = build_installation_plan(twin.revision, (design,), {room.id: twin.get_room_context(room.id)})

    assert [row.tag for row in plan.sensors] == ["PIR30"]
    assert plan.sensors[0].controls_tag == "EF30"
    assert plan.sensors[0].run_on_minutes == 20
    assert plan.sensors[0].cutout_diameter_mm == 60


def _two_rooms(path):
    """Give the one-room sample a second space, so a cross-room clash is testable."""
    import ifcopenshell
    import ifcopenshell.api

    model = ifcopenshell.open(str(path))
    storey = model.by_type("IfcBuildingStorey")[0]
    first = model.by_type("IfcSpace")[0]
    body = next(
        c for c in model.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body"
    )
    second = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcSpace", predefined_type="INTERNAL", name="Second room"
    )
    ifcopenshell.api.run("aggregate.assign_object", model, products=[second], relating_object=storey)
    representation = ifcopenshell.api.run(
        "geometry.add_slab_representation",
        model,
        context=body,
        depth=2.8,
        polyline=[(8, 0), (12, 0), (12, 4), (8, 4)],
    )
    ifcopenshell.api.run("geometry.assign_representation", model, product=second, representation=representation)
    model.write(str(path))
    return first.GlobalId, second.GlobalId


def test_a_sensor_tag_cannot_repeat_in_another_room(sample_path) -> None:
    """A Tag is the label an electrician works to, so two PIR01s is not a model."""
    from home_twin.fixtures import PlannedSensor

    first, second = _two_rooms(sample_path)
    twin = HomeTwin.open(sample_path)
    twin.apply_room_lighting_design(
        replace(
            twin.get_room_lighting_design(first),
            sensors=(
                PlannedSensor(
                    "PIR50",
                    first,
                    Point3D(1500, 1400, twin.get_room_context(first).ceiling.elevation_mm),
                    20,
                    controls_tag="EF50",
                ),
            ),
        ),
        expected_revision=twin.revision,
    )

    reopened = HomeTwin.open(sample_path)
    centre = reopened.get_room_context(second)
    clash = replace(
        reopened.get_room_lighting_design(second),
        sensors=(
            PlannedSensor(
                "PIR50",
                second,
                Point3D(10000, 2000, centre.ceiling.elevation_mm),
                20,
                controls_tag="EF51",
            ),
        ),
    )
    with pytest.raises(ValueError, match="already used in another room"):
        reopened.apply_room_lighting_design(clash, expected_revision=reopened.revision)
    assert [s.tag for s in HomeTwin.open(sample_path).get_sensors(second)] == [], "and nothing was written"


def test_a_sensor_switching_lights_joins_that_control_group(sample_path) -> None:
    """A PIR on a corridor is that corridor's switch, so the group has to say so."""
    from home_twin.fixtures import PlannedSensor

    twin = HomeTwin.open(sample_path)
    room = twin.get_rooms()[0]
    ceiling_z = twin.get_room_context(room.id).ceiling.elevation_mm
    design = twin.get_room_lighting_design(room.id)
    group = design.luminaires[0].switching_group

    twin.apply_room_lighting_design(
        replace(
            design,
            sensors=(
                PlannedSensor("PIR60", room.id, Point3D(2200, 1800, ceiling_z), 20, switching_group=group),
            ),
        ),
        expected_revision=twin.revision,
    )

    reopened = HomeTwin.open(sample_path)
    saved = reopened.get_sensors(room.id)[0]
    assert (saved.switching_group, saved.controls_tag) == (group, None)
    control = next(item for item in reopened.get_control_groups() if item.label == group)
    assert control.sensor_ids == (saved.id,), "the group reports the sensor that switches it"


def test_a_fitting_keeps_its_notes_through_ifc_save_and_reload(twin: HomeTwin) -> None:
    """A note is where a fitting takes its power from and why it is where it is.

    It used to be planning-time only and never reached the file, so a supply the
    owner stated out loud vanished on save and the model could not be asked about
    it afterwards. All three fitting kinds carry them.
    """
    room = twin.get_rooms()[0]
    ceiling_z = twin.get_room_context(room.id).ceiling.elevation_mm
    supply = "Supply: the wall socket beside the wardrobe."
    design = RoomLightingDesign(
        room.id,
        (
            PlannedPendant(
                "PEN-N",
                room.id,
                Point3D(3000, 2000, ceiling_z),
                PendantSpec(),
                "NOTED",
                ("A 450 mm opal globe, no selected product.", supply),
            ),
            PlannedRopeLight(
                "LED-N",
                room.id,
                (Point3D(1000, 500, ceiling_z), Point3D(2000, 500, ceiling_z)),
                RopeLightSpec(),
                "NOTED",
                ("Door-switched, not on the plate.", supply),
            ),
        ),
    )

    twin.apply_room_lighting_design(design, expected_revision=twin.revision)

    saved = {item.tag: item for item in HomeTwin.open(twin.model_path).get_luminaires(room.id)}
    assert saved["PEN-N"].notes == ("A 450 mm opal globe, no selected product.", supply)
    assert saved["LED-N"].notes == ("Door-switched, not on the plate.", supply)
