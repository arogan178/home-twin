from __future__ import annotations

from pathlib import Path

import pytest

from home_twin.mcp_server import PointInput, SpotlightInput, build_server
from home_twin.model import HomeTwin


def test_semantic_mcp_tool_schemas(sample_path: Path) -> None:
    server = build_server(sample_path)
    tools = {tool.name: tool for tool in server._tool_manager.list_tools()}
    required = {
        "get_building",
        "get_storeys",
        "get_rooms",
        "get_room",
        "get_objects",
        "get_walls",
        "get_ceiling",
        "get_openings",
        "get_furniture",
        "get_light_fixtures",
        "get_luminaires",
        "get_wall_switches",
        "get_control_groups",
        "get_room_lighting_design",
        "get_object_properties",
        "get_object_bounds",
        "measure_between_objects",
        "measure_points",
        "distance_to_wall",
        "raycast",
        "get_clearances",
        "get_ceiling_polygon",
        "get_lighting_layout",
        "get_site",
        "get_stairs",
        "bake_room_lighting",
        "analyse_direct_sun",
        "get_sun_path",
        "validate_lighting_layout",
        "validate_room_lighting_design",
        "optimise_spotlight_layout",
        "add_spotlight",
        "add_pendant",
        "add_rope_light",
        "add_wall_switch",
        "move_wall_switch",
        "assign_lighting_group",
        "delete_lighting_device",
        "move_fixture",
        "delete_fixture",
        "align_fixtures",
        "distribute_fixtures",
        "save_model",
        "export_lighting_layout",
    }
    assert required <= tools.keys()
    assert tools["get_building"].annotations.readOnlyHint is True
    assert tools["add_spotlight"].annotations.readOnlyHint is False
    assert tools["delete_fixture"].annotations.destructiveHint is True
    assert tools["delete_lighting_device"].annotations.destructiveHint is True

    add_schema = tools["add_spotlight"].parameters
    assert add_schema["required"] == [
        "room_id",
        "fixture_id",
        "point",
        "fixture",
        "switching_group",
        "expected_revision",
    ]
    assert add_schema["properties"]["point"] == {"$ref": "#/$defs/PointInput"}
    assert add_schema["$defs"]["PointInput"]["additionalProperties"] is False
    assert add_schema["$defs"]["SpotlightInput"]["additionalProperties"] is False
    assert tools["add_pendant"].parameters["$defs"]["PendantInput"]["additionalProperties"] is False
    assert tools["add_rope_light"].parameters["$defs"]["RopeLightInput"]["additionalProperties"] is False
    assert tools["add_wall_switch"].parameters["$defs"]["WallSwitchInput"]["additionalProperties"] is False
    assert "arbitrary" not in " ".join(tool.description.lower() for tool in tools.values())


def test_distribute_fixtures_orders_by_position_not_tag(sample_path: Path) -> None:
    server = build_server(sample_path)
    tools = {tool.name: tool for tool in server._tool_manager.list_tools()}
    revision = tools["save_model"].fn()["revision"]
    room_id = tools["get_rooms"].fn()[0]["id"]
    # SP03 sits west of SP01, so tag order and west-to-east order disagree.
    tools["add_spotlight"].fn(
        room_id=room_id,
        fixture_id="SP03",
        point=PointInput(x=800, y=2800, z=2800),
        fixture=SpotlightInput(),
        switching_group="ROOM_MAIN",
        expected_revision=revision,
    )
    revision = tools["save_model"].fn()["revision"]
    ids = {fixture.tag: fixture.id for fixture in HomeTwin.open(sample_path).get_lighting_layout(room_id).fixtures}

    tools["distribute_fixtures"].fn(
        fixture_ids=[ids["SP01"], ids["SP02"], ids["SP03"]],
        start=PointInput(x=1000, y=2000, z=2800),
        end=PointInput(x=5000, y=2000, z=2800),
        expected_revision=revision,
    )

    reopened = HomeTwin.open(sample_path).get_lighting_layout(room_id)
    placed = {fixture.tag: (fixture.point.x, fixture.point.y) for fixture in reopened.fixtures}
    assert placed["SP03"] == pytest.approx((1000, 2000))
    assert placed["SP01"] == pytest.approx((3000, 2000))
    assert placed["SP02"] == pytest.approx((5000, 2000))
