"""Lighting fixture domain records."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import StrEnum
from math import isfinite

from home_twin.model import Point3D, Vector3D


@dataclass(frozen=True, slots=True)
class SpotlightSpec:
    model: str | None = None
    # The defaults are a generic 3000 K, CRI 90+ GU10 design allowance. Named
    # product records below carry the selected lamp's published peak intensity.
    lumens: float | None = 575
    beam_angle_deg: float = 36
    cct_kelvin: int | None = 3000
    cri: float | None = 90
    dimmable: bool = True
    diameter_mm: float = 90
    cutout_diameter_mm: float = 80
    mounting_depth_mm: float = 60
    """How far the housing sits above the finished ceiling face.

    A GU10 downlight is the fitting this home uses throughout.
    """
    ies_path: str | None = None
    peak_candela: float | None = None
    """Published on-axis intensity, where the manufacturer states one.

    A rated lumen count says how much light leaves the lamp and a beam angle
    says roughly where. Peak candela adds the published intensity in one
    direction, which supports a better falloff approximation without claiming
    a full IES file. An `ies_path` beats it whenever one exists.
    """
    ip_rating: str | None = None
    """Ingress protection the housing must carry, such as ``IP65`` over a bath.

    The lamp does not change between a dry room and a wet one; the fitting does,
    and the rating is what an installer checks before cutting the hole.
    """

    def __post_init__(self) -> None:
        values = (self.beam_angle_deg, self.diameter_mm, self.cutout_diameter_mm, self.mounting_depth_mm)
        if not all(isfinite(value) and value > 0 for value in values):
            raise ValueError("Fixture angles and dimensions must be positive and finite")
        if not 0 < self.beam_angle_deg < 180:
            raise ValueError("Beam angle must be between 0 and 180 degrees")
        if self.lumens is not None and (not isfinite(self.lumens) or self.lumens <= 0):
            raise ValueError("Lumens must be positive when supplied")
        if self.cri is not None and not 0 <= self.cri <= 100:
            raise ValueError("CRI must be between 0 and 100")


# The open-plan lamps selected from the Radium LED Star PAR16 family. The
# article/listing numbers are retained in the model name so the IFC remains
# traceable to the sourced product without pretending that a generic housing
# dimension is the lamp's 50 x 54 mm body.
RADIUM_43922571 = SpotlightSpec(
    model="Radium RL-PAR16 80 DIM 930/36°/GU10 (43922571), 6.5 W, 50 x 54 mm",
    lumens=575,
    beam_angle_deg=36,
    cct_kelvin=3000,
    cri=90,
    dimmable=True,
    # Radium's product page links the 60° file; the 36° family file is the one
    # measured for this beam.
    ies_path="model/photometry/radium-rl-par16-36-2024.ldt",
    peak_candela=900,
)
# Radium's 60° family LDT puts the peak at 622 cd for 575 lm, under the 700 cd
# the product page states; the measured file governs wherever it is read.
RADIUM_44020758 = SpotlightSpec(
    model="Radium RL-PAR16 80 DIM 930/60°/GU10 (44020758), 6.5 W, 50 x 54 mm",
    lumens=575,
    beam_angle_deg=60,
    cct_kelvin=3000,
    cri=90,
    dimmable=True,
    ies_path="model/photometry/radium-rl-par16-60-2024.ldt",
    peak_candela=700,
)
RADIUM_44122574 = SpotlightSpec(
    model="Radium RL-PAR16 80 DIM 930/120°/GU10 (44122574), 6.5 W, 50 x 54 mm",
    lumens=575,
    beam_angle_deg=120,
    cct_kelvin=3000,
    cri=90,
    dimmable=True,
    peak_candela=200,
)

# Keep the established role names for callers that do not need the product
# family name. They now resolve to the sourced open-plan lamps.
RADIUM_36_SPOTLIGHT = RADIUM_43922571
RADIUM_60_SPOTLIGHT = RADIUM_44020758
RADIUM_120_SPOTLIGHT = RADIUM_44122574
NARROW_SPOTLIGHT = RADIUM_36_SPOTLIGHT
WIDE_SPOTLIGHT = RADIUM_60_SPOTLIGHT

# The wet rooms keep the house's 60-degree lamp and take a different housing,
# with one specification for all six fittings rather than two. This remains a
# separate provisional wet-room record; the open-plan Radium lamp is IP20 and
# its housing/product suitability is not silently promoted to a wet-zone claim.
#
# The beam is the whole reason the lamp did not change. A 100 mm bake with
# shadow rays puts three 60-degree fittings over 180 lux across 61% of the
# bathroom floor and 37% of the en-suite's; the same layout with the only
# high-output dim-to-warm GU10 on the market, a 36-degree Tala, manages 46% and
# 30%. A 36-degree beam throws a 1040 mm pool at the 800 mm plane where a
# 60-degree throws 1848 mm, and no spacing recovers that in a room 1.9 m wide.
# The dim-to-warm lamps that do come at 60 degrees are all under 350 lm and fall
# to 22% covered.
#
# What that costs is warmth on the way down, not dimming: this lamp dims and
# holds 3000 K, where a dim-to-warm lamp falls towards 2000 K and reads like a
# halogen. That is a lamp swap in the same housing whenever it is wanted, so it
# is a preference to test rather than a decision to take now.
#
# The housing is a deep matt baffle, which a warm residential brief usually asks for and
# which is also the only remedy for the one defect this room cannot design out:
# three of the bathroom's four apertures fall in the mirror's reflection field
# at a normal stance, and recessing the lamp is what stops it being seen. The
# 90 mm depth is a generic figure for a baffled GU10 against the flush trim's
# 60, and it fits the 300 mm void either way; the 80 mm cut-out is unchanged, so
# this stays a housing choice rather than a re-cut. `SpotlightSpec` records no
# shielding angle, which is why the reason lives here.
#
# One rating, not two: at a 2400 mm ceiling no fixture here is in any BS 7671
# zone (zones stop at 2.25 m), so IP20 is compliant. It gives up the
# condensation-and-cleaning allowance IP65 would have carried: BA1 over the
# bath and EN3 over the shower see direct steam, and the 20-minute fan run-on
# is what dries the room. Compliance stays unverified until the electrician
# signs it off. A second SKU would only be a second thing to get wrong on site.
WET_ROOM_SPOTLIGHT = replace(
    SpotlightSpec(
        model="Noxion PerfectColor GU10 PAR16 6.7W 930 60D",
        lumens=575,
        beam_angle_deg=60,
        peak_candela=740,
    ),
    model="Noxion PerfectColor GU10 PAR16 6.7W 930 60D in a deep-baffle IP20 trim",
    diameter_mm=95,
    mounting_depth_mm=90,
    ip_rating="IP20",
)


@dataclass(frozen=True, slots=True)
class PlannedSpotlight:
    tag: str
    room_id: str
    point: Point3D
    spec: SpotlightSpec
    switching_group: str
    direction: Vector3D = Vector3D(0, 0, -1)
    notes: tuple[str, ...] = ()
    kind: str = field(default="recessed_spotlight", init=False)

    def __post_init__(self) -> None:
        if not self.tag.strip():
            raise ValueError("Fixture tag cannot be empty")
        if not self.switching_group.strip():
            raise ValueError("Switching group cannot be empty")


@dataclass(frozen=True, slots=True)
class LightFixture:
    id: str
    tag: str
    room_id: str
    point: Point3D
    spec: SpotlightSpec
    switching_group: str
    direction: Vector3D = Vector3D(0, 0, -1)
    notes: tuple[str, ...] = ()
    kind: str = field(default="recessed_spotlight", init=False)

    def at(self, point: Point3D) -> LightFixture:
        return replace(self, point=point)


Fixture = PlannedSpotlight | LightFixture


def _require_positive(label: str, *values: float) -> None:
    if not all(isfinite(value) and value > 0 for value in values):
        raise ValueError(f"{label} must be positive and finite")


@dataclass(frozen=True, slots=True)
class PendantSpec:
    model: str | None = None
    lumens: float | None = 800
    cct_kelvin: int | None = 2700
    cri: float | None = 90
    dimmable: bool = True
    drop_mm: float = 600
    canopy_diameter_mm: float = 100
    canopy_depth_mm: float = 30
    bulb_diameter_mm: float = 120
    """One shade, or the spread of the whole cluster when there is more than one lamp."""
    lamp_count: int = 1
    """Lamps on one canopy. ``lumens`` is their sum, as a fitting is bought and switched as one.

    A cluster drawn as a single globe is a fitting the model cannot be asked
    about: it looks the same at any lamp count, so the spec and the picture
    disagree and only the spec knows.
    """
    ies_path: str | None = None

    def __post_init__(self) -> None:
        _require_positive(
            "Pendant dimensions",
            self.drop_mm,
            self.canopy_diameter_mm,
            self.canopy_depth_mm,
            self.bulb_diameter_mm,
        )
        if self.lamp_count < 1:
            raise ValueError("A pendant has at least one lamp")
        if self.lumens is not None:
            _require_positive("Lumens", self.lumens)
        if self.cri is not None and not 0 <= self.cri <= 100:
            raise ValueError("CRI must be between 0 and 100")


@dataclass(frozen=True, slots=True)
class PlannedPendant:
    tag: str
    room_id: str
    point: Point3D
    spec: PendantSpec
    switching_group: str
    notes: tuple[str, ...] = ()
    kind: str = field(default="pendant_bulb", init=False)

    def __post_init__(self) -> None:
        _require_identity(self.tag, self.switching_group)

    @property
    def emitter_point(self) -> Point3D:
        return Point3D(self.point.x, self.point.y, self.point.z - self.spec.drop_mm)


@dataclass(frozen=True, slots=True)
class PendantFixture:
    id: str
    tag: str
    room_id: str
    point: Point3D
    spec: PendantSpec
    switching_group: str
    notes: tuple[str, ...] = ()
    kind: str = field(default="pendant_bulb", init=False)

    @property
    def emitter_point(self) -> Point3D:
        return Point3D(self.point.x, self.point.y, self.point.z - self.spec.drop_mm)


class RopeMounting(StrEnum):
    CEILING = "ceiling"
    WALL = "wall"
    CONCEALED = "concealed"
    JOINERY = "joinery"


@dataclass(frozen=True, slots=True)
class RopeLightSpec:
    model: str | None = None
    lumens_per_m: float | None = 900
    cct_kelvin: int | None = 3000
    cri: float | None = 90
    dimmable: bool = True
    diameter_mm: float = 16
    minimum_bend_radius_mm: float = 60
    mounting: RopeMounting = RopeMounting.CEILING
    ip_rating: str | None = None
    """Ingress protection the profile must carry, such as ``IP44`` beside a mirror.

    A strip in a wet room is chosen for its sealing as much as its output, and
    the rating is what an installer checks before ordering the extrusion.
    """

    def __post_init__(self) -> None:
        _require_positive("Rope-light dimensions", self.diameter_mm, self.minimum_bend_radius_mm)
        if self.lumens_per_m is not None:
            _require_positive("Lumens per metre", self.lumens_per_m)
        if self.cri is not None and not 0 <= self.cri <= 100:
            raise ValueError("CRI must be between 0 and 100")


@dataclass(frozen=True, slots=True)
class PlannedRopeLight:
    tag: str
    room_id: str
    path: tuple[Point3D, ...]
    spec: RopeLightSpec
    switching_group: str
    notes: tuple[str, ...] = ()
    kind: str = field(default="rope_light", init=False)

    def __post_init__(self) -> None:
        _require_identity(self.tag, self.switching_group)
        if len(self.path) < 2:
            raise ValueError("A rope light needs at least two path points")


@dataclass(frozen=True, slots=True)
class RopeLightFixture:
    id: str
    tag: str
    room_id: str
    path: tuple[Point3D, ...]
    spec: RopeLightSpec
    switching_group: str
    notes: tuple[str, ...] = ()
    kind: str = field(default="rope_light", init=False)


class WallSwitchKind(StrEnum):
    TOGGLE = "toggle"
    DIMMER = "dimmer"
    MOMENTARY = "momentary"


class WallSwitchFace(StrEnum):
    """Which face of the host wall the plate is fitted to.

    A wall is shared, so naming the wall does not say which side of it you
    stand on to reach the switch. ``OPPOSITE`` means the far face: the switch
    controls this room and is reached from whatever is on the other side, which
    is how a bathroom is normally switched. The derived point stays on the wall
    line either way; this records the fact rather than a second coordinate.
    """

    ROOM = "room"
    OPPOSITE = "opposite"


@dataclass(frozen=True, slots=True)
class WallSwitchSpec:
    kind: WallSwitchKind = WallSwitchKind.TOGGLE
    width_mm: float = 86
    height_mm: float = 86
    depth_mm: float = 10

    def __post_init__(self) -> None:
        _require_positive("Switch dimensions", self.width_mm, self.height_mm, self.depth_mm)


@dataclass(frozen=True, slots=True)
class PlannedWallSwitch:
    tag: str
    room_id: str
    host_wall_id: str
    offset_mm: float
    mounting_height_mm: float
    switching_group: str
    spec: WallSwitchSpec = WallSwitchSpec()
    notes: tuple[str, ...] = ()
    mounting_face: WallSwitchFace = WallSwitchFace.ROOM

    def __post_init__(self) -> None:
        _require_identity(self.tag, self.switching_group)
        if not self.host_wall_id.strip():
            raise ValueError("A wall switch needs a host wall")
        if not isfinite(self.offset_mm) or self.offset_mm < 0:
            raise ValueError("Switch offset must be finite and non-negative")
        _require_positive("Switch mounting height", self.mounting_height_mm)


@dataclass(frozen=True, slots=True)
class WallSwitch:
    id: str
    tag: str
    room_id: str
    host_wall_id: str
    offset_mm: float
    mounting_height_mm: float
    switching_group: str
    point: Point3D
    spec: WallSwitchSpec = WallSwitchSpec()
    notes: tuple[str, ...] = ()
    mounting_face: WallSwitchFace = WallSwitchFace.ROOM


class SensorKind(StrEnum):
    """IFC4 has no occupancy sensor, so a PIR is a movement sensor.

    That is not a synonym: a PIR detects movement and infers occupancy, which
    is exactly why every one of them needs a run-on time.
    """

    MOVEMENT = "movement"


@dataclass(frozen=True, slots=True)
class SensorSpec:
    kind: SensorKind = SensorKind.MOVEMENT
    diameter_mm: float = 70
    cutout_diameter_mm: float = 60
    mounting_depth_mm: float = 25
    detection_diameter_mm: float | None = None
    """Manufacturer's detection circle at the floor, where one is published.

    Walking movement carries much further than the small movement of someone
    sitting still, and a single figure says which the maker measured only if
    they state it. Absent by default rather than guessed.
    """

    def __post_init__(self) -> None:
        _require_positive(
            "Sensor dimensions", self.diameter_mm, self.cutout_diameter_mm, self.mounting_depth_mm
        )
        if self.detection_diameter_mm is not None:
            _require_positive("Detection diameter", self.detection_diameter_mm)


@dataclass(frozen=True, slots=True)
class PlannedSensor:
    tag: str
    room_id: str
    point: Point3D
    """Plan centre with ``z`` at the finished ceiling, like a recessed spotlight."""
    run_on_minutes: float
    """How long the load is held on after detection stops."""
    switching_group: str | None = None
    """The control group this sensor switches, when the load is lighting.

    A PIR on a corridor is that corridor's switch, so it joins the group the
    way a wall plate does and shows up in the same control-group checks.
    """
    controls_tag: str | None = None
    """The installation tag this sensor switches, when the load is not a luminaire.

    A fan carries no switching group, so a sensor serving one names it directly.
    That is also how an installer reads it. Exactly one of these two is set.
    """
    spec: SensorSpec = SensorSpec()
    notes: tuple[str, ...] = ()
    kind: str = field(default="movement_sensor", init=False)

    def __post_init__(self) -> None:
        if not self.tag.strip():
            raise ValueError("Installation tag cannot be empty")
        named = [value for value in (self.switching_group, self.controls_tag) if value is not None]
        if len(named) != 1 or not named[0].strip():
            raise ValueError("A sensor switches either a control group or one installation tag")
        if self.controls_tag is not None and self.controls_tag.strip() == self.tag.strip():
            raise ValueError("A sensor cannot control itself")
        _require_positive("Sensor run-on time", self.run_on_minutes)


@dataclass(frozen=True, slots=True)
class SensorDevice:
    id: str
    tag: str
    room_id: str
    point: Point3D
    run_on_minutes: float
    switching_group: str | None = None
    controls_tag: str | None = None
    spec: SensorSpec = SensorSpec()
    notes: tuple[str, ...] = ()
    kind: str = field(default="movement_sensor", init=False)


@dataclass(frozen=True, slots=True)
class ControlGroup:
    id: str
    label: str
    switch_ids: tuple[str, ...]
    luminaire_ids: tuple[str, ...]
    sensor_ids: tuple[str, ...] = ()
    """Sensors that switch this group. A PIR-only corridor has no wall plate."""


Luminaire = Fixture | PlannedPendant | PendantFixture | PlannedRopeLight | RopeLightFixture
InstalledLuminaire = LightFixture | PendantFixture | RopeLightFixture
SwitchDevice = PlannedWallSwitch | WallSwitch
SensorRecord = PlannedSensor | SensorDevice


@dataclass(frozen=True, slots=True)
class RoomLightingDesign:
    room_id: str
    luminaires: tuple[Luminaire, ...]
    switches: tuple[SwitchDevice, ...] = ()
    control_groups: tuple[ControlGroup, ...] = ()
    sensors: tuple[SensorRecord, ...] = ()

    def __post_init__(self) -> None:
        items = (*self.luminaires, *self.switches, *self.sensors)
        if any(item.room_id != self.room_id for item in items):
            raise ValueError("Every lighting device must belong to the design room")
        tags = [item.tag for item in items]
        if len(set(tags)) != len(tags):
            raise ValueError("Lighting installation tags must be unique within a room")

    @property
    def spotlight_layout(self) -> LightingLayout:
        return LightingLayout(
            self.room_id,
            tuple(
                luminaire
                for luminaire in self.luminaires
                if isinstance(luminaire, (PlannedSpotlight, LightFixture))
            ),
        )


def _require_identity(tag: str, switching_group: str) -> None:
    if not tag.strip():
        raise ValueError("Installation tag cannot be empty")
    if not switching_group.strip():
        raise ValueError("Switching group cannot be empty")


@dataclass(frozen=True, slots=True)
class LightingLayout:
    room_id: str
    fixtures: tuple[Fixture, ...]

    def __post_init__(self) -> None:
        if any(fixture.room_id != self.room_id for fixture in self.fixtures):
            raise ValueError("Every fixture must belong to the layout room")

    def with_fixture(self, fixture: Fixture) -> LightingLayout:
        if fixture.room_id != self.room_id:
            raise ValueError("Fixture room does not match layout room")
        if any(existing.tag == fixture.tag for existing in self.fixtures):
            raise ValueError(f"Fixture tag {fixture.tag!r} already exists")
        return LightingLayout(self.room_id, (*self.fixtures, fixture))

    def replace_fixture(self, fixture_id: str, replacement: Fixture) -> LightingLayout:
        found = False
        values: list[Fixture] = []
        for fixture in self.fixtures:
            if isinstance(fixture, LightFixture) and (fixture.id == fixture_id or fixture.tag == fixture_id):
                values.append(replacement)
                found = True
            else:
                values.append(fixture)
        if not found:
            raise KeyError(f"Fixture {fixture_id!r} was not found")
        return LightingLayout(self.room_id, tuple(values))
