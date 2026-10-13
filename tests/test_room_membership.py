"""Which rooms a door belongs to.

A door used to belong only to the room whose boundary happened to name it, which
is wrong twice over: a door in a party wall opens into both rooms, and a door in
an aggregated sub-space is a door of the room that sub-space is a level of.
"""

from __future__ import annotations

import ifcopenshell
import ifcopenshell.api
import pytest

from home_twin.ifc import IfcRepository


def _project() -> tuple[ifcopenshell.file, ifcopenshell.entity_instance]:
    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Membership")
    ifcopenshell.api.run("unit.assign_unit", model)
    site = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuilding", name="Building")
    storey = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuildingStorey", name="Storey")
    for parent, child in ((project, site), (site, building), (building, storey)):
        ifcopenshell.api.run("aggregate.assign_object", model, products=[child], relating_object=parent)
    return model, storey


def _space(model: ifcopenshell.file, storey: ifcopenshell.entity_instance, name: str):
    space = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcSpace", predefined_type="INTERNAL", name=name
    )
    ifcopenshell.api.run("aggregate.assign_object", model, products=[space], relating_object=storey)
    return space


def _bound(model: ifcopenshell.file, space, element) -> None:
    model.create_entity(
        "IfcRelSpaceBoundary",
        GlobalId=ifcopenshell.guid.new(),
        RelatingSpace=space,
        RelatedBuildingElement=element,
        PhysicalOrVirtualBoundary="PHYSICAL",
        InternalOrExternalBoundary="INTERNAL",
    )


def _door_in(model: ifcopenshell.file, wall, name: str = "Door"):
    """A door filling a void cut through `wall`, the way a traced plan writes it."""
    door = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcDoor", name=name)
    void = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcOpeningElement", name="Void")
    model.create_entity(
        "IfcRelVoidsElement",
        GlobalId=ifcopenshell.guid.new(),
        RelatingBuildingElement=wall,
        RelatedOpeningElement=void,
    )
    model.create_entity(
        "IfcRelFillsElement",
        GlobalId=ifcopenshell.guid.new(),
        RelatingOpeningElement=void,
        RelatedBuildingElement=door,
    )
    return door


@pytest.fixture
def party_wall(tmp_path):
    """Two rooms sharing a wall, with a door bound only to the first."""
    model, storey = _project()
    left = _space(model, storey, "Left")
    right = _space(model, storey, "Right")
    wall = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcWall", name="Party wall")
    _bound(model, left, wall)
    _bound(model, right, wall)
    door = _door_in(model, wall)
    _bound(model, left, door)
    path = tmp_path / "party.ifc"
    model.write(str(path))
    return IfcRepository.open(path), left, right, door


def test_a_room_the_wall_does_not_bound_does_not_get_the_door(tmp_path) -> None:
    model, storey = _project()
    left = _space(model, storey, "Left")
    right = _space(model, storey, "Right")
    elsewhere = _space(model, storey, "Elsewhere")
    wall = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcWall", name="Party wall")
    _bound(model, left, wall)
    _bound(model, right, wall)
    door = _door_in(model, wall)
    _bound(model, left, door)
    path = tmp_path / "elsewhere.ifc"
    model.write(str(path))

    repository = IfcRepository.open(path)
    assert repository.get_openings(elsewhere.GlobalId) == ()


def test_both_rooms_list_the_shared_door(party_wall) -> None:
    repository, left, right, _ = party_wall
    for space in (left, right):
        names = [opening.name for opening in repository.get_openings(space.GlobalId)]
        assert names == ["Door"]


def test_a_wall_running_past_three_rooms_shares_nothing(tmp_path) -> None:
    # Which two rooms such a door joins depends on where along the wall it sits,
    # so it keeps the one boundary it was given rather than being guessed at.
    model, storey = _project()
    spaces = [_space(model, storey, name) for name in ("A", "B", "C")]
    wall = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcWall", name="Long wall")
    for space in spaces:
        _bound(model, space, wall)
    _bound(model, spaces[0], _door_in(model, wall))
    path = tmp_path / "long.ifc"
    model.write(str(path))

    repository = IfcRepository.open(path)
    assert [o.name for o in repository.get_openings(spaces[0].GlobalId)] == ["Door"]
    for unshared in spaces[1:]:
        assert repository.get_openings(unshared.GlobalId) == ()


def test_whatever_sits_in_a_sub_space_sits_in_the_room(tmp_path) -> None:
    model, storey = _project()
    room = _space(model, storey, "Open plan")
    landing = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcSpace", predefined_type="INTERNAL", name="Landing"
    )
    ifcopenshell.api.run("aggregate.assign_object", model, products=[landing], relating_object=room)
    wall = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcWall", name="External wall")
    _bound(model, landing, wall)
    door = _door_in(model, wall, name="Front door")
    _bound(model, landing, door)
    path = tmp_path / "front.ifc"
    model.write(str(path))

    repository = IfcRepository.open(path)
    names = [opening.name for opening in repository.get_openings(room.GlobalId)]
    assert names == ["Front door"]
