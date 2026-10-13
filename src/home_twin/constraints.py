"""Project-configurable lighting constraints."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from home_twin.model import ObjectKind


@dataclass(frozen=True, slots=True)
class LightingConstraints:
    wall_clearance_mm: float = 600
    minimum_spacing_mm: float = 900
    obstruction_clearance_mm: float = 150
    shadow_gap_clearance_mm: float = 200
    alignment_tolerance_mm: float = 30
    collision_tolerance_mm: float = 2
    target_lux: float = 180
    task_plane_height_mm: float = 800
    utilization_factor: float = 0.55
    grid_step_mm: float = 500
    # A reported lux figure is maintained, not initial. The default is the
    # product of a domestic LED's lamp lumen maintenance, luminaire dirt
    # depreciation, and room surface depreciation; state the project's own
    # value rather than inheriting this one.
    maintenance_factor: float = 0.8
    # Statistics ignore samples within this distance of a wall. An average that
    # includes the perimeter is an artifact of the room's shape, not a figure
    # any other tool or lux meter can be compared against.
    task_area_border_mm: float = 500
    ceiling_reflectance: float = 0.7
    wall_reflectance: float = 0.5
    floor_reflectance: float = 0.2
    avoid_object_kinds: frozenset[ObjectKind] = frozenset(
        {ObjectKind.CABINET, ObjectKind.SHADOW_GAP, ObjectKind.AC, ObjectKind.BEAM, ObjectKind.DUCT, ObjectKind.PIPE}
    )

    def __post_init__(self) -> None:
        if min(
            self.wall_clearance_mm,
            self.minimum_spacing_mm,
            self.obstruction_clearance_mm,
            self.shadow_gap_clearance_mm,
            self.alignment_tolerance_mm,
            self.grid_step_mm,
            self.task_area_border_mm,
        ) < 0:
            raise ValueError("Constraint distances cannot be negative")
        if not 0 < self.utilization_factor <= 1:
            raise ValueError("Utilization factor must be in (0, 1]")
        if not 0 < self.maintenance_factor <= 1:
            raise ValueError("Maintenance factor must be in (0, 1]")
        for surface, value in self.reflectances.items():
            if not 0 <= value < 1:
                raise ValueError(f"The {surface} reflectance must be in [0, 1), not {value}")

    @property
    def reflectances(self) -> dict[str, float]:
        """The stated surface reflectances the interreflection term uses."""

        return {
            "ceiling": self.ceiling_reflectance,
            "walls": self.wall_reflectance,
            "floor": self.floor_reflectance,
        }


def load_constraints(config_dir: Path) -> LightingConstraints:
    constraint_data: dict = {}
    lighting_data: dict = {}
    constraints_path = config_dir / "constraints.yaml"
    lighting_path = config_dir / "lighting.yaml"
    if constraints_path.exists():
        constraint_data = yaml.safe_load(constraints_path.read_text()) or {}
    if lighting_path.exists():
        lighting_data = yaml.safe_load(lighting_path.read_text()) or {}
    raw = {**lighting_data.get("defaults", {}), **constraint_data.get("lighting", {})}
    allowed = {field.name for field in LightingConstraints.__dataclass_fields__.values()}
    unknown = set(raw) - allowed
    if unknown:
        raise ValueError(f"Unknown lighting constraint keys: {sorted(unknown)}")
    if "avoid_object_kinds" in raw:
        raw["avoid_object_kinds"] = frozenset(ObjectKind(value) for value in raw["avoid_object_kinds"])
    return LightingConstraints(**raw)

