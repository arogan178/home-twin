"""Deterministic installation plans and CSV, JSON, and SVG renderers."""

from __future__ import annotations

import csv
import io
import json
import os
import tempfile
from dataclasses import asdict, dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from home_twin.fixtures import (
    ControlGroup,
    LightFixture,
    PendantFixture,
    PlannedPendant,
    PlannedRopeLight,
    PlannedSpotlight,
    PlannedWallSwitch,
    RoomLightingDesign,
    RopeLightFixture,
)
from home_twin.geometry import point_segment_distance
from home_twin.model import Point2D, RoomContext


def _round_installation_mm(value: float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _csv_value(value: object) -> object:
    if isinstance(value, str) and (
        value.startswith(("\t", "\r", "\n")) or value.lstrip().startswith(("=", "+", "-", "@"))
    ):
        return "'" + value
    return value


@dataclass(frozen=True, slots=True)
class WallReference:
    wall_id: str
    distance_mm: int


@dataclass(frozen=True, slots=True)
class InstallationFixture:
    fixture_id: str
    tag: str
    room_id: str
    room: str
    x_mm: int
    y_mm: int
    z_mm: int
    fixture_model: str
    fixture_type: str
    ip_rating: str
    """What the fitting has to be sealed to, or empty where none is stated.

    An installer checks this before ordering a housing or an extrusion, so it
    belongs on the sheet and not only in the model.
    """
    beam_angle_deg: float | None
    switching_group: str
    reference_walls: tuple[WallReference, ...]
    adjacent_spacing_mm: int | None
    cutout_diameter_mm: int | None
    path_mm: tuple[tuple[int, int, int], ...]
    notes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class InstallationSwitch:
    switch_id: str
    tag: str
    room_id: str
    room: str
    x_mm: int
    y_mm: int
    z_mm: int
    host_wall_id: str
    offset_mm: int
    mounting_height_mm: int
    switch_type: str
    mounting_face: str
    """``opposite`` when the plate is on the far face of its host wall.

    A wet room is normally switched from outside it, and an installer sent to
    the wrong side of the wall is the reason this is on the sheet.
    """
    switching_group: str
    notes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class InstallationSensor:
    sensor_id: str
    tag: str
    room_id: str
    room: str
    x_mm: int
    y_mm: int
    z_mm: int
    sensor_type: str
    # Exactly one of these is set: a control group when the load is lighting, or
    # an installation tag when it is not, because a fan carries no group.
    switching_group: str | None
    controls_tag: str | None
    run_on_minutes: int
    cutout_diameter_mm: int
    notes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class InstallationPlan:
    model_revision: str
    coordinate_system: str
    coordinate_precision: str
    fixtures: tuple[InstallationFixture, ...]
    switches: tuple[InstallationSwitch, ...]
    control_groups: tuple[ControlGroup, ...]
    sensors: tuple[InstallationSensor, ...] = ()


def _fixture_id(fixture: object) -> str:
    return getattr(fixture, "id", "") or fixture.tag


def build_installation_plan(
    revision: str,
    designs: tuple[RoomLightingDesign, ...],
    contexts: dict[str, RoomContext],
) -> InstallationPlan:
    rows: list[InstallationFixture] = []
    switch_rows: list[InstallationSwitch] = []
    sensor_rows: list[InstallationSensor] = []
    all_luminaires = tuple(luminaire for design in designs for luminaire in design.luminaires)

    def anchor(item: object) -> object:
        if isinstance(item, (PlannedRopeLight, RopeLightFixture)):
            return item.path[0]
        return item.point

    for design in sorted(designs, key=lambda item: item.room_id):
        context = contexts[design.room_id]
        for fixture in sorted(design.luminaires, key=lambda item: (item.tag, _fixture_id(item))):
            fixture_point = anchor(fixture)
            center = Point2D(fixture_point.x, fixture_point.y)
            walls = sorted(
                (
                    WallReference(
                        wall.wall_id,
                        _round_installation_mm(point_segment_distance(center, wall.start, wall.end)),
                    )
                    for wall in context.walls
                ),
                key=lambda reference: (reference.distance_mm, reference.wall_id),
            )[:2]
            adjacent = [
                ((fixture_point.x - anchor(other).x) ** 2 + (fixture_point.y - anchor(other).y) ** 2) ** 0.5
                for other in all_luminaires
                if other is not fixture
            ]
            if isinstance(fixture, (PlannedSpotlight, LightFixture)):
                beam_angle = fixture.spec.beam_angle_deg
                cutout = _round_installation_mm(fixture.spec.cutout_diameter_mm)
                fixture_type = "recessed_spotlight"
                path = ()
            elif isinstance(fixture, (PlannedPendant, PendantFixture)):
                beam_angle = None
                cutout = None
                fixture_type = "pendant_bulb"
                path = ()
            else:
                beam_angle = None
                cutout = None
                fixture_type = "rope_light"
                path = tuple(
                    (
                        _round_installation_mm(point.x),
                        _round_installation_mm(point.y),
                        _round_installation_mm(point.z),
                    )
                    for point in fixture.path
                )
            rows.append(
                InstallationFixture(
                    _fixture_id(fixture),
                    fixture.tag,
                    design.room_id,
                    context.room.name,
                    _round_installation_mm(fixture_point.x),
                    _round_installation_mm(fixture_point.y),
                    _round_installation_mm(fixture_point.z),
                    fixture.spec.model or "",
                    fixture_type,
                    getattr(fixture.spec, "ip_rating", None) or "",
                    beam_angle,
                    fixture.switching_group,
                    tuple(walls),
                    _round_installation_mm(min(adjacent)) if adjacent else None,
                    cutout,
                    path,
                    fixture.notes,
                )
            )
        for device in sorted(design.switches, key=lambda item: (item.tag, _fixture_id(item))):
            if isinstance(device, PlannedWallSwitch):
                from home_twin.lighting import wall_switch_point

                wall = next(wall for wall in context.walls if wall.wall_id == device.host_wall_id)
                switch_point = wall_switch_point(device, wall, context.room.elevation_mm)
            else:
                switch_point = device.point
            switch_rows.append(
                InstallationSwitch(
                    _fixture_id(device),
                    device.tag,
                    design.room_id,
                    context.room.name,
                    _round_installation_mm(switch_point.x),
                    _round_installation_mm(switch_point.y),
                    _round_installation_mm(switch_point.z),
                    device.host_wall_id,
                    _round_installation_mm(device.offset_mm),
                    _round_installation_mm(device.mounting_height_mm),
                    device.spec.kind.value,
                    device.mounting_face.value,
                    device.switching_group,
                    device.notes,
                )
            )
        for sensor in sorted(design.sensors, key=lambda item: (item.tag, _fixture_id(item))):
            sensor_rows.append(
                InstallationSensor(
                    _fixture_id(sensor),
                    sensor.tag,
                    design.room_id,
                    context.room.name,
                    _round_installation_mm(sensor.point.x),
                    _round_installation_mm(sensor.point.y),
                    _round_installation_mm(sensor.point.z),
                    sensor.spec.kind.value,
                    sensor.switching_group,
                    sensor.controls_tag,
                    _round_installation_mm(sensor.run_on_minutes),
                    _round_installation_mm(sensor.spec.cutout_diameter_mm),
                    sensor.notes,
                )
            )
    groups = {
        group.id: group
        for design in designs
        for group in design.control_groups
        if set(group.luminaire_ids) & {_fixture_id(item) for item in design.luminaires}
        or set(group.switch_ids) & {_fixture_id(item) for item in design.switches}
        or set(group.sensor_ids) & {_fixture_id(item) for item in design.sensors}
    }
    return InstallationPlan(
        revision,
        "+X plan-right/east, +Y plan-up/north, +Z up; origin is resolved IFC building origin",
        "Coordinates rounded half away from zero to the nearest millimetre",
        tuple(rows),
        tuple(switch_rows),
        tuple(sorted(groups.values(), key=lambda item: (item.label, item.id))),
        tuple(sensor_rows),
    )


def _csv_bytes(plan: InstallationPlan) -> bytes:
    output = io.StringIO(newline="")
    fieldnames = [
        "fixture_id",
        "tag",
        "room_id",
        "room",
        "x_mm",
        "y_mm",
        "z_mm",
        "fixture_model",
        "fixture_type",
        "ip_rating",
        "beam_angle_deg",
        "switching_group",
        "reference_wall_1",
        "reference_wall_1_distance_mm",
        "reference_wall_2",
        "reference_wall_2_distance_mm",
        "adjacent_spacing_mm",
        "cutout_diameter_mm",
        "path_mm",
        "notes",
        "model_revision",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for fixture in plan.fixtures:
        references = (*fixture.reference_walls, None, None)
        row = {
            "fixture_id": fixture.fixture_id,
            "tag": fixture.tag,
            "room_id": fixture.room_id,
            "room": fixture.room,
            "x_mm": fixture.x_mm,
            "y_mm": fixture.y_mm,
            "z_mm": fixture.z_mm,
            "fixture_model": fixture.fixture_model,
            "fixture_type": fixture.fixture_type,
            "ip_rating": fixture.ip_rating,
            "beam_angle_deg": fixture.beam_angle_deg,
            "switching_group": fixture.switching_group,
            "reference_wall_1": references[0].wall_id if references[0] else "",
            "reference_wall_1_distance_mm": references[0].distance_mm if references[0] else "",
            "reference_wall_2": references[1].wall_id if references[1] else "",
            "reference_wall_2_distance_mm": references[1].distance_mm if references[1] else "",
            "adjacent_spacing_mm": fixture.adjacent_spacing_mm,
            "cutout_diameter_mm": fixture.cutout_diameter_mm,
            "path_mm": " | ".join(f"{x},{y},{z}" for x, y, z in fixture.path_mm),
            "notes": "; ".join(fixture.notes),
            "model_revision": plan.model_revision,
        }
        writer.writerow({key: value if key == "path_mm" else _csv_value(value) for key, value in row.items()})
    return output.getvalue().encode()


def _json_bytes(plan: InstallationPlan) -> bytes:
    return (json.dumps(asdict(plan), indent=2, sort_keys=True) + "\n").encode()


def _svg_bytes(plan: InstallationPlan, contexts: dict[str, RoomContext]) -> bytes:
    polygons = [context.ceiling.polygon for context in contexts.values()]
    if not polygons:
        return b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"/>\n'
    min_x = min(polygon.bounds[0] for polygon in polygons)
    min_y = min(polygon.bounds[1] for polygon in polygons)
    max_x = max(polygon.bounds[2] for polygon in polygons)
    max_y = max(polygon.bounds[3] for polygon in polygons)
    margin = 500
    width = max_x - min_x + margin * 2
    height = max_y - min_y + margin * 2

    def sx(x: float) -> float:
        return x - min_x + margin

    def sy(y: float) -> float:
        return max_y - y + margin

    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {width:.1f} {height:.1f}" width="{width / 10:.1f}mm" height="{height / 10:.1f}mm">',
        "<style>text{font-family:monospace;fill:#111}.room{fill:#fafafa;stroke:#222;stroke-width:18}"
        ".fixture{fill:#fff;stroke:#e24a24;stroke-width:18}.pendant{fill:#ffc34d;stroke:#7a4b16;stroke-width:18}"
        ".rope{fill:none;stroke:#f0a52d;stroke-width:35;stroke-linecap:round}.switch{fill:#fff3d3;stroke:#263942;stroke-width:14}"
        ".dimension{stroke:#777;stroke-width:8}</style>",
        f'<text x="40" y="70" font-size="90">Home Twin lighting layout · {plan.model_revision[:20]}</text>',
    ]
    for room_id, context in sorted(contexts.items()):
        points = " ".join(f"{sx(point.x):.1f},{sy(point.y):.1f}" for point in context.ceiling.polygon.outer)
        lines.append(f'<polygon class="room" points="{points}" data-room-id="{room_id}"/>')
        bounds = context.ceiling.polygon.bounds
        room_name = _escape(context.room.name)
        lines.append(
            f'<text x="{sx(bounds[0]) + 80:.1f}" y="{sy(bounds[3]) + 120:.1f}" '
            f'font-size="100">{room_name}</text>'
        )
    for fixture in plan.fixtures:
        x = sx(fixture.x_mm)
        y = sy(fixture.y_mm)
        if fixture.fixture_type == "rope_light":
            points = " ".join(f"{sx(px):.1f},{sy(py):.1f}" for px, py, _ in fixture.path_mm)
            lines.append(
                f'<polyline class="rope" points="{points}" data-fixture-id="{_escape(fixture.fixture_id)}"/>'
            )
            radius = 45
        else:
            radius = max((fixture.cutout_diameter_mm or 120) / 2, 45)
            css_class = "pendant" if fixture.fixture_type == "pendant_bulb" else "fixture"
            lines.append(
                f'<circle class="{css_class}" cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" '
                f'data-fixture-id="{_escape(fixture.fixture_id)}"/>'
            )
        lines.append(f'<text x="{x + radius + 30:.1f}" y="{y + 30:.1f}" font-size="90">{_escape(fixture.tag)}</text>')
        lines.append(
            f'<text x="{x + radius + 30:.1f}" y="{y + 115:.1f}" font-size="65">'
            f'X {fixture.x_mm} · Y {fixture.y_mm} · Z {fixture.z_mm}</text>'
        )
    for device in plan.switches:
        x = sx(device.x_mm)
        y = sy(device.y_mm)
        lines.append(
            f'<rect class="switch" x="{x - 45:.1f}" y="{y - 45:.1f}" width="90" height="90" rx="12" '
            f'data-switch-id="{_escape(device.switch_id)}"/>'
        )
        lines.append(
            f'<text x="{x + 70:.1f}" y="{y + 25:.1f}" font-size="70">'
            f'{_escape(device.tag)} · {_escape(device.switching_group)}</text>'
        )
    for sensor in plan.sensors:
        x = sx(sensor.x_mm)
        y = sy(sensor.y_mm)
        lines.append(
            f'<circle class="sensor" cx="{x:.1f}" cy="{y:.1f}" r="45" '
            f'data-sensor-id="{_escape(sensor.sensor_id)}"/>'
        )
        lines.append(
            f'<text x="{x + 70:.1f}" y="{y + 25:.1f}" font-size="70">'
            f'{_escape(sensor.tag)} &#8594; {_escape(sensor.switching_group or sensor.controls_tag or "")}</text>'
        )
    lines.append("</svg>")
    return ("\n".join(lines) + "\n").encode()


def _escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _atomic_write(path: Path, content: bytes) -> None:
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        temp_path = Path(temp_name)
        if temp_path.exists():
            temp_path.unlink()


def export_lighting(
    revision: str,
    designs: tuple[RoomLightingDesign, ...],
    contexts: dict[str, RoomContext],
    directory: Path,
    formats: frozenset[str],
) -> tuple[Path, ...]:
    unknown = formats - {"csv", "json", "svg"}
    if unknown:
        raise ValueError(f"Unsupported export formats: {sorted(unknown)}")
    directory.mkdir(parents=True, exist_ok=True)
    plan = build_installation_plan(revision, designs, contexts)
    renderers = {
        "csv": lambda: _csv_bytes(plan),
        "json": lambda: _json_bytes(plan),
        "svg": lambda: _svg_bytes(plan, contexts),
    }
    paths = []
    for format_name in sorted(formats):
        path = directory / f"lighting-layout.{format_name}"
        _atomic_write(path, renderers[format_name]())
        paths.append(path)
    return tuple(paths)
