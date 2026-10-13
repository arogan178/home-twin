"""Room floor and wall finishes authored onto the IfcSpace.

A finish is a named surface and a display colour, not a BIM material layer. It
tells the viewer what to draw and the designer what was decided.

Its reflectance is a separate fact from its colour. Where a project has the
manufacturer's LRV it states it in ``finishes.yaml`` and the lux estimate uses
that; a display colour is only the fallback for a finish that states none. The
two genuinely disagree: the sRGB approximation of NCS S 1002-Y computes 78%
against the 72% the standard carries, and reading the picture instead of the
paint puts that error straight into the interreflected term.
"""

from __future__ import annotations

import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import yaml

from home_twin.model import HomeTwin, Room

PSET = "Pset_HomeTwinFinish"
_COLOUR = re.compile(r"^#[0-9A-Fa-f]{6}$")


@dataclass(frozen=True, slots=True)
class RoomFinish:
    room_id: str
    floor: str | None
    """A finish name such as ``light_grey_tile``, or None where none is chosen.

    Painting the walls must not require inventing a floor: a home often states
    its wall finish long before anyone has picked the flooring, and a
    made-up floor finish would go straight into the reflectance the lux estimate
    uses.
    """
    walls: str
    floor_colour: str | None
    """Display sRGB hex such as ``#B9B6B1``; an approximation of the chosen tile."""
    wall_colour: str
    feature_wall_id: str | None = None
    """The IFC ``GlobalId`` of one wall painted differently from the rest of the room."""
    feature_wall: str | None = None
    feature_wall_colour: str | None = None
    clad_wall_ids: tuple[str, ...] = ()
    """GlobalIds of faces the room's joinery clads, which light sees instead of paint."""
    clad_wall: str | None = None

    skirting: str | None = None
    skirting_height_mm: float | None = None
    skirting_thickness_mm: float | None = None
    """The skirting run around the room, or None where there is none."""

    def __post_init__(self) -> None:
        if not (self.room_id and self.walls):
            raise ValueError("A room finish needs a room id and a wall finish name")
        if (self.floor is None) != (self.floor_colour is None):
            raise ValueError("A floor finish needs both a name and a colour, or neither")
        if not _COLOUR.match(self.wall_colour):
            raise ValueError("Finish colours must be #RRGGBB")
        if self.floor_colour is not None and not _COLOUR.match(self.floor_colour):
            raise ValueError("Finish colours must be #RRGGBB")
        skirting = (self.skirting, self.skirting_height_mm, self.skirting_thickness_mm)
        if any(value is not None for value in skirting) and not all(value is not None for value in skirting):
            raise ValueError("A skirting needs a finish name, a height and a thickness")
        if any(value is not None and value <= 0 for value in skirting[1:]):
            raise ValueError("A skirting height and thickness must be positive")
        feature = (self.feature_wall_id, self.feature_wall, self.feature_wall_colour)
        if any(feature) and not all(feature):
            raise ValueError("A feature wall needs a wall id, a finish name and a colour")
        if self.feature_wall_colour is not None and not _COLOUR.match(self.feature_wall_colour):
            raise ValueError("Finish colours must be #RRGGBB")


def lrv(colour: str) -> float:
    """Luminance of an sRGB display colour, used as a surface reflectance."""

    if not _COLOUR.match(colour):
        raise ValueError(f"A finish colour must be #RRGGBB, not {colour!r}")

    def linear(channel: float) -> float:
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    red, green, blue = (int(colour[index : index + 2], 16) / 255 for index in (1, 3, 5))
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)


# Generic display colours. A project states its own finishes, and any measured
# LRV, in ``finishes.yaml`` beside its IFC; see :func:`load_finishes`.
DEFAULT_FINISH_COLOURS: Mapping[str, str] = {
    "grey_tile": "#CECFCA",
    "light_grey_tile": "#D1D1CF",
    "walnut_parquet_tile": "#6E4B34",
    "walnut_board": "#6E4B34",
    "oak_board": "#B08A5E",
    "warm_off_white": "#EDE6DA",
    "brilliant_white": "#F6F6F4",
}


@dataclass(frozen=True, slots=True)
class FinishCatalogue:
    """Named finishes: a display colour each, and a stated LRV where one is known.

    A stated LRV beats the colour. An sRGB approximation of a paint notation is
    a picture of the paint, not a photometric measurement of it, so the lux
    estimate uses the measured figure when the project has one.
    """

    colours: Mapping[str, str]
    lrv: Mapping[str, float]

    def __post_init__(self) -> None:
        for name, colour in self.colours.items():
            if not isinstance(colour, str) or not _COLOUR.match(colour):
                raise ValueError(f"Finish {name!r} needs a #RRGGBB colour, not {colour!r}")
        for name, value in self.lrv.items():
            if not isinstance(value, int | float) or not 0 <= value <= 1:
                raise ValueError(f"Finish {name!r} needs an LRV in [0, 1], not {value!r}")


DEFAULT_FINISHES = FinishCatalogue(DEFAULT_FINISH_COLOURS, {})
FINISHES_FILE_NAME = "finishes.yaml"


def load_finishes(directory: Path) -> FinishCatalogue:
    """The generic finishes, overlaid by ``finishes.yaml`` in ``directory`` when present.

    The file holds ``colours: {name: "#RRGGBB"}`` and ``lrv: {name: 0.72}``.
    """

    path = directory / FINISHES_FILE_NAME
    if not path.exists():
        return DEFAULT_FINISHES
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    unknown = set(data) - {"colours", "lrv"}
    if unknown:
        raise ValueError(f"{path} has unknown keys {sorted(unknown)}")
    return FinishCatalogue(
        {**DEFAULT_FINISH_COLOURS, **(data.get("colours") or {})},
        dict(data.get("lrv") or {}),
    )


def finish_reflectance(finish: str | None, catalogue: FinishCatalogue = DEFAULT_FINISHES) -> float | None:
    """The finish's stated LRV, else one derived from its display colour."""
    if not finish:
        return None
    stated = catalogue.lrv.get(finish)
    if stated is not None:
        return stated
    colour = catalogue.colours.get(finish)
    return None if colour is None else lrv(colour)


def room_reflectances(
    room: Room, fallback: Mapping[str, float], catalogue: FinishCatalogue = DEFAULT_FINISHES
) -> dict[str, float]:
    """The room's own reflectances where its finish states one, else the project's.

    Only the wall figure is worth much: sweeping a floor from dark walnut to
    pale stone moves a 4 m² room's mean by under a tenth, where the same sweep
    on the walls moves it by half.
    """

    values = dict(fallback)
    for surface, finish in (("walls", room.wall_finish), ("floor", room.floor_finish)):
        reflectance = finish_reflectance(finish, catalogue)
        if reflectance is not None:
            values[surface] = reflectance
    return values


def author_room_finishes(model: ifcopenshell.file, finishes: tuple[RoomFinish, ...]) -> None:
    """Edit a private IFC clone. The caller owns validation and publication."""
    for finish in finishes:
        space = model.by_guid(finish.room_id)
        if not space.is_a("IfcSpace"):
            raise ValueError(f"{finish.room_id} is not an IfcSpace")
        pset = next(
            (
                relation.RelatingPropertyDefinition
                for relation in space.IsDefinedBy
                if relation.is_a("IfcRelDefinesByProperties") and relation.RelatingPropertyDefinition.Name == PSET
            ),
            None,
        )
        if pset is None:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=space, name=PSET)
        ifcopenshell.api.run(
            "pset.edit_pset",
            model,
            pset=pset,
            properties={
                "FloorFinish": finish.floor,
                "WallFinish": finish.walls,
                "FloorColour": finish.floor_colour,
                "WallColour": finish.wall_colour,
                "FeatureWallId": finish.feature_wall_id,
                "FeatureWallFinish": finish.feature_wall,
                "FeatureWallColour": finish.feature_wall_colour,
                "CladWallIds": ";".join(finish.clad_wall_ids) or None,
                "CladWallFinish": finish.clad_wall,
                "SkirtingFinish": finish.skirting,
                "SkirtingHeightMm": finish.skirting_height_mm,
                "SkirtingThicknessMm": finish.skirting_thickness_mm,
            },
        )


def save_room_finishes(path: Path, finishes: tuple[RoomFinish, ...]) -> None:
    """Author on a private clone, reopen it to verify, then atomically publish."""
    path = path.resolve()
    original = path.read_bytes()
    model = ifcopenshell.file.from_string(original.decode())
    author_room_finishes(model, finishes)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".ifc", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        model.write(str(temporary))
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        rooms = {room.id: room for room in HomeTwin.open(temporary).get_rooms()}
        for finish in finishes:
            room = rooms[finish.room_id]
            saved = (room.floor_finish, room.wall_finish, room.feature_wall_id, room.feature_wall)
            if saved != (finish.floor, finish.walls, finish.feature_wall_id, finish.feature_wall):
                raise RuntimeError(f"{room.name} did not reopen with its finishes")
        if path.read_bytes() != original:
            raise RuntimeError("The IFC changed while finishes were prepared")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
