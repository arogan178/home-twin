"""Deterministic solar geometry and direct-sun patch projection.

This module is geometry only. It answers "where can direct sunlight land, and
from which direction" for a stated site, date, and time. It deliberately does
not produce illuminance or daylight-factor numbers: that needs a sky model,
glazing transmittance, external obstructions, and surface reflectance, none of
which this project has reviewed data for. See ``docs/daylight.md``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from math import acos, asin, cos, degrees, hypot, radians, sin, tan

from home_twin.geometry import point_in_polygon, polygon_area, triangulate_ring
from home_twin.model import (
    Opening,
    OpeningKind,
    Point2D,
    Point3D,
    Polygon2D,
    RoomContext,
    Site,
    Vector3D,
)

SOLAR_METHOD = "noaa_solar_position_v1"
PATCH_METHOD = "direct_sun_patch_geometry_v1"
CLIP_METHOD = "ear_clip_triangulation_and_convex_clip_v1"
PATCH_EXCLUSIONS: tuple[str, ...] = (
    "illuminance_values",
    "sky_diffuse",
    "ground_reflected",
    "external_obstructions",
    "glazing_transmittance",
    "frame_and_glazing_subdivision",
    "inter_reflection",
    "internal_furniture_shading",
)
GLAZED_OPENING_KINDS = frozenset({OpeningKind.WINDOW, OpeningKind.SLIDING_DOOR})

_REFRACTION_LIMIT_DEG = -0.575


@dataclass(frozen=True, slots=True)
class SolarPosition:
    """Apparent solar position for one instant at one site."""

    when: str
    altitude_deg: float
    azimuth_deg: float
    declination_deg: float
    hour_angle_deg: float
    equation_of_time_min: float
    above_horizon: bool
    method: str = SOLAR_METHOD


@dataclass(frozen=True, slots=True)
class SunPathSample:
    when: str
    altitude_deg: float
    azimuth_deg: float


@dataclass(frozen=True, slots=True)
class SunPath:
    """One day of solar positions, sampled at a fixed step."""

    date: str
    step_minutes: int
    samples: tuple[SunPathSample, ...]
    sunrise: str | None
    sunset: str | None
    solar_noon: str | None
    max_altitude_deg: float
    method: str = SOLAR_METHOD


@dataclass(frozen=True, slots=True)
class SunPatch:
    """A direct-beam footprint cast through one opening onto a horizontal plane.

    ``pieces`` tiles the part of the footprint that lands inside the room. A
    concave room can split one beam into several pieces, so the room boundary is
    respected exactly instead of being bridged across a re-entrant corner.
    """

    opening_id: str
    opening_name: str
    opening_kind: str
    pieces: tuple[Polygon2D, ...]
    projected: Polygon2D
    plane_elevation_mm: float
    area_m2: float
    projected_area_m2: float
    incidence_deg: float
    method: str = PATCH_METHOD
    clip_method: str = CLIP_METHOD

    @property
    def fully_inside_room(self) -> bool:
        return abs(self.area_m2 - self.projected_area_m2) < 1e-6


@dataclass(frozen=True, slots=True)
class RoomDaylight:
    """Direct-sun geometry for one room at one instant."""

    room_id: str
    site: Site
    when: str
    plane_elevation_mm: float
    position: SolarPosition | None
    sun_direction: Vector3D | None
    patches: tuple[SunPatch, ...]
    notes: tuple[str, ...]
    method: str = PATCH_METHOD
    exclusions: tuple[str, ...] = PATCH_EXCLUSIONS


def _julian_century(moment: datetime) -> float:
    utc = moment.astimezone(UTC)
    year, month = utc.year, utc.month
    day = (
        utc.day
        + (utc.hour + (utc.minute + (utc.second + utc.microsecond / 1e6) / 60) / 60) / 24
    )
    if month <= 2:
        year -= 1
        month += 12
    a = year // 100
    b = 2 - a + a // 4
    julian_day = (
        int(365.25 * (year + 4716)) + int(30.6001 * (month + 1)) + day + b - 1524.5
    )
    return (julian_day - 2451545.0) / 36525.0


def solar_position(latitude_deg: float, longitude_deg: float, moment: datetime) -> SolarPosition:
    """Return the apparent solar position using the NOAA solar calculations.

    ``moment`` must be timezone aware. Angles are degrees; ``azimuth_deg`` is
    measured clockwise from true north. Accuracy is roughly one arc minute for
    dates near the present, which is far finer than any plan trace tolerance.
    """

    if moment.tzinfo is None:
        raise ValueError("A solar position needs a timezone-aware instant")
    century = _julian_century(moment)
    mean_longitude = (280.46646 + century * (36000.76983 + century * 0.0003032)) % 360
    mean_anomaly = 357.52911 + century * (35999.05029 - 0.0001537 * century)
    eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century)
    centre = (
        sin(radians(mean_anomaly)) * (1.914602 - century * (0.004817 + 0.000014 * century))
        + sin(radians(2 * mean_anomaly)) * (0.019993 - 0.000101 * century)
        + sin(radians(3 * mean_anomaly)) * 0.000289
    )
    true_longitude = mean_longitude + centre
    apparent_longitude = (
        true_longitude - 0.00569 - 0.00478 * sin(radians(125.04 - 1934.136 * century))
    )
    mean_obliquity = 23 + (26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60
    obliquity = mean_obliquity + 0.00256 * cos(radians(125.04 - 1934.136 * century))
    declination = degrees(asin(sin(radians(obliquity)) * sin(radians(apparent_longitude))))
    variance = tan(radians(obliquity / 2)) ** 2
    equation_of_time = 4 * degrees(
        variance * sin(2 * radians(mean_longitude))
        - 2 * eccentricity * sin(radians(mean_anomaly))
        + 4 * eccentricity * variance * sin(radians(mean_anomaly)) * cos(2 * radians(mean_longitude))
        - 0.5 * variance * variance * sin(4 * radians(mean_longitude))
        - 1.25 * eccentricity * eccentricity * sin(2 * radians(mean_anomaly))
    )
    offset = moment.utcoffset() or timedelta(0)
    local_minutes = moment.hour * 60 + moment.minute + moment.second / 60
    true_solar_minutes = (
        local_minutes + equation_of_time + 4 * longitude_deg - 60 * (offset.total_seconds() / 3600)
    ) % 1440
    hour_angle = true_solar_minutes / 4 - 180 if true_solar_minutes / 4 >= 0 else true_solar_minutes / 4 + 180

    latitude = radians(latitude_deg)
    declination_rad = radians(declination)
    cosine_zenith = min(
        1.0,
        max(
            -1.0,
            sin(latitude) * sin(declination_rad)
            + cos(latitude) * cos(declination_rad) * cos(radians(hour_angle)),
        ),
    )
    zenith = degrees(acos(cosine_zenith))
    elevation = 90 - zenith
    apparent_elevation = elevation + _refraction_deg(elevation)

    sine_zenith = sin(radians(zenith))
    if abs(sine_zenith) < 1e-9 or abs(cos(latitude)) < 1e-9:
        azimuth = 180.0 if latitude_deg >= 0 else 0.0
    else:
        ratio = min(
            1.0,
            max(-1.0, (sin(latitude) * cosine_zenith - sin(declination_rad)) / (cos(latitude) * sine_zenith)),
        )
        base = degrees(acos(ratio))
        azimuth = (base + 180) % 360 if hour_angle > 0 else (540 - base) % 360

    return SolarPosition(
        when=moment.isoformat(),
        altitude_deg=apparent_elevation,
        azimuth_deg=azimuth,
        declination_deg=declination,
        hour_angle_deg=hour_angle,
        equation_of_time_min=equation_of_time,
        above_horizon=apparent_elevation > 0,
    )


def _refraction_deg(elevation_deg: float) -> float:
    """Approximate atmospheric refraction, as used by the NOAA spreadsheet."""

    if elevation_deg > 85:
        return 0.0
    tangent = tan(radians(elevation_deg))
    if elevation_deg > 5:
        seconds = 58.1 / tangent - 0.07 / tangent**3 + 0.000086 / tangent**5
    elif elevation_deg > _REFRACTION_LIMIT_DEG:
        seconds = 1735 + elevation_deg * (
            -518.2 + elevation_deg * (103.4 + elevation_deg * (-12.79 + elevation_deg * 0.711))
        )
    else:
        seconds = -20.774 / tangent
    return seconds / 3600


def sun_direction(position: SolarPosition, true_north_deg: float) -> Vector3D:
    """Return the unit vector pointing from the building towards the sun.

    ``true_north_deg`` is the clockwise bearing of building ``+Y`` from true
    north, so the sun's plan bearing inside the building frame is
    ``azimuth - true_north_deg``.
    """

    bearing = radians(position.azimuth_deg - true_north_deg)
    altitude = radians(position.altitude_deg)
    return Vector3D(
        cos(altitude) * sin(bearing),
        cos(altitude) * cos(bearing),
        sin(altitude),
    )


def sun_path(
    latitude_deg: float,
    longitude_deg: float,
    day: datetime,
    *,
    step_minutes: int = 20,
) -> SunPath:
    """Sample one local day of solar positions and locate the horizon crossings."""

    if step_minutes <= 0 or 1440 % step_minutes != 0:
        raise ValueError("The sun-path step must divide 1440 minutes")
    if day.tzinfo is None:
        raise ValueError("A sun path needs a timezone-aware day")
    midnight = day.replace(hour=0, minute=0, second=0, microsecond=0)
    steps = 1440 // step_minutes
    positions = [
        solar_position(latitude_deg, longitude_deg, midnight + timedelta(minutes=step_minutes * index))
        for index in range(steps + 1)
    ]
    samples = tuple(
        SunPathSample(item.when, item.altitude_deg, item.azimuth_deg) for item in positions
    )
    sunrise: str | None = None
    sunset: str | None = None
    for earlier, later in zip(positions, positions[1:], strict=False):
        if earlier.altitude_deg <= 0 < later.altitude_deg and sunrise is None:
            sunrise = _horizon_crossing(latitude_deg, longitude_deg, earlier, later, rising=True)
        if earlier.altitude_deg > 0 >= later.altitude_deg:
            sunset = _horizon_crossing(latitude_deg, longitude_deg, earlier, later, rising=False)
    noon = _solar_noon(latitude_deg, longitude_deg, midnight)
    noon_position = solar_position(latitude_deg, longitude_deg, noon)
    return SunPath(
        date=midnight.date().isoformat(),
        step_minutes=step_minutes,
        samples=samples,
        sunrise=sunrise,
        sunset=sunset,
        solar_noon=noon.replace(microsecond=0).isoformat() if noon_position.above_horizon else None,
        max_altitude_deg=noon_position.altitude_deg,
    )


def _solar_noon(latitude_deg: float, longitude_deg: float, midnight: datetime) -> datetime:
    """Solve for the instant of zero hour angle on this local day."""

    moment = midnight + timedelta(hours=12)
    for _ in range(4):
        position = solar_position(latitude_deg, longitude_deg, moment)
        moment -= timedelta(minutes=position.hour_angle_deg * 4)
    return moment


def _horizon_crossing(
    latitude_deg: float,
    longitude_deg: float,
    earlier: SolarPosition,
    later: SolarPosition,
    *,
    rising: bool,
) -> str:
    """Bisect the bracketed interval for the apparent horizon crossing.

    The result is the apparent centre crossing. It excludes the solar
    semi-diameter, so it runs about a minute inside published sunrise and
    sunset times.
    """

    low = datetime.fromisoformat(earlier.when)
    high = datetime.fromisoformat(later.when)
    for _ in range(28):
        middle = low + (high - low) / 2
        above = solar_position(latitude_deg, longitude_deg, middle).altitude_deg > 0
        if above == rising:
            high = middle
        else:
            low = middle
    return (low + (high - low) / 2).replace(microsecond=0).isoformat()


def _signed_area(points: tuple[Point2D, ...]) -> float:
    return (
        sum(
            points[index].x * points[(index + 1) % len(points)].y
            - points[(index + 1) % len(points)].x * points[index].y
            for index in range(len(points))
        )
        / 2
    )


def _counter_clockwise(points: tuple[Point2D, ...]) -> tuple[Point2D, ...]:
    return points if _signed_area(points) >= 0 else tuple(reversed(points))


def clip_convex_to_polygon(
    convex_subject: tuple[Point2D, ...],
    polygon: Polygon2D,
) -> tuple[Polygon2D, ...]:
    """Clip a convex polygon against a possibly concave polygon.

    The concave polygon is ear clipped into triangles first, so every
    Sutherland and Hodgman pass runs convex against convex and the result never
    bridges a re-entrant corner. Holes are ignored: the room polygons this
    project traces have none.
    """

    pieces: list[Polygon2D] = []
    for triangle in triangulate_ring(polygon.outer):
        clipped = clip_to_convex(convex_subject, triangle)
        if len(clipped) >= 3 and abs(_signed_area(clipped)) > 1.0:
            pieces.append(Polygon2D(_counter_clockwise(clipped)))
    return tuple(pieces)


def clip_to_convex(
    subject: tuple[Point2D, ...],
    convex_clip: tuple[Point2D, ...],
) -> tuple[Point2D, ...]:
    """Clip a convex subject polygon against a convex clip polygon.

    Both polygons must be convex. Use :func:`clip_convex_to_polygon` when the
    clip region is a traced room outline.
    """

    clip = _counter_clockwise(convex_clip)
    output = list(_counter_clockwise(subject))
    for index in range(len(clip)):
        if not output:
            return ()
        edge_start = clip[index]
        edge_end = clip[(index + 1) % len(clip)]
        edge_x = edge_end.x - edge_start.x
        edge_y = edge_end.y - edge_start.y

        def inside(
            point: Point2D,
            sx: float = edge_start.x,
            sy: float = edge_start.y,
            ex: float = edge_x,
            ey: float = edge_y,
        ) -> float:
            return ex * (point.y - sy) - ey * (point.x - sx)

        current = output
        output = []
        previous = current[-1]
        previous_side = inside(previous)
        for point in current:
            side = inside(point)
            if side >= 0:
                if previous_side < 0:
                    output.append(_intersect(previous, point, edge_start, edge_end))
                output.append(point)
            elif previous_side >= 0:
                output.append(_intersect(previous, point, edge_start, edge_end))
            previous, previous_side = point, side
    return tuple(output)


def _intersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D) -> Point2D:
    r_x, r_y = b.x - a.x, b.y - a.y
    s_x, s_y = d.x - c.x, d.y - c.y
    denominator = r_x * s_y - r_y * s_x
    if abs(denominator) < 1e-12:
        return a
    t = ((c.x - a.x) * s_y - (c.y - a.y) * s_x) / denominator
    return Point2D(a.x + t * r_x, a.y + t * r_y)


def _opening_normal(opening: Opening, context: RoomContext) -> Vector3D | None:
    """Return the inward horizontal normal of the opening's host wall face."""

    for wall in context.walls:
        if wall.wall_id == opening.host_wall_id:
            return wall.inward_normal
    length = hypot(opening.end.x - opening.start.x, opening.end.y - opening.start.y)
    if length <= 0:
        return None
    normal_x = (opening.end.y - opening.start.y) / length
    normal_y = -(opening.end.x - opening.start.x) / length
    middle = Point2D(
        (opening.start.x + opening.end.x) / 2,
        (opening.start.y + opening.end.y) / 2,
    )
    probe = Point2D(middle.x + normal_x * 50, middle.y + normal_y * 50)
    if point_in_polygon(probe, context.ceiling.polygon):
        return Vector3D(normal_x, normal_y, 0)
    return Vector3D(-normal_x, -normal_y, 0)


def _overhang_shadow_edge(
    opening: Opening,
    context: RoomContext,
    towards_sun: Vector3D,
    plane_elevation_mm: float,
    normal: Vector3D,
) -> tuple[Point2D, Vector3D] | None:
    """Where a horizontal projection above this opening stops the sun, or None.

    A balcony floor over a slider shades it whether anyone designed it as one,
    and it shades the wrong half. The soffit sits barely above the head, so a
    ray leaving a point near the glass exits low and meets the balcony's
    underside; only rays from deep in the room see sky under its edge. The lit
    ground is therefore a strip **beyond** this line, not a pool at the glass.

    Returns a point on the shadow's inner edge and the inward normal of the lit
    side, so the caller can clip to a half-plane. That is exact for a projection
    running the full width of the opening, which a balcony floor does.
    """

    if opening.overhang_depth_mm is None or opening.overhang_depth_mm <= 0:
        return None
    soffit = opening.overhang_soffit_mm
    if soffit is None:
        soffit = context.ceiling.elevation_mm - context.room.elevation_mm
    soffit_z = context.room.elevation_mm + soffit
    if soffit_z <= plane_elevation_mm:
        return None
    # The outer edge of the projection, at the middle of the opening: outward is
    # away from the room, which is the direction the balcony reaches.
    middle = Point2D((opening.start.x + opening.end.x) / 2, (opening.start.y + opening.end.y) / 2)
    lip = Point2D(
        middle.x - normal.x * opening.overhang_depth_mm,
        middle.y - normal.y * opening.overhang_depth_mm,
    )
    if towards_sun.z <= 0:
        return None
    drop = soffit_z - plane_elevation_mm
    shadow = Point2D(
        lip.x - drop * towards_sun.x / towards_sun.z,
        lip.y - drop * towards_sun.y / towards_sun.z,
    )
    return shadow, normal


def _clip_beyond(
    polygon: tuple[Point2D, ...], through: Point2D, inward: Vector3D
) -> tuple[Point2D, ...]:
    """Sutherland-Hodgman against one half-plane: keep what is further in."""

    def side(point: Point2D) -> float:
        return (point.x - through.x) * inward.x + (point.y - through.y) * inward.y

    kept: list[Point2D] = []
    for index, current in enumerate(polygon):
        previous = polygon[index - 1]
        here, there = side(current), side(previous)
        if here >= 0:
            if there < 0:
                t = there / (there - here)
                kept.append(Point2D(previous.x + (current.x - previous.x) * t,
                                    previous.y + (current.y - previous.y) * t))
            kept.append(current)
        elif there >= 0:
            t = there / (there - here)
            kept.append(Point2D(previous.x + (current.x - previous.x) * t,
                                previous.y + (current.y - previous.y) * t))
    return tuple(kept)


def project_sun_patch(
    opening: Opening,
    context: RoomContext,
    towards_sun: Vector3D,
    plane_elevation_mm: float,
) -> SunPatch | None:
    """Project one opening's aperture rectangle onto a horizontal plane.

    Returns ``None`` when the sun is below the horizon, behind the wall, or the
    projected footprint falls entirely outside the room.
    """

    if towards_sun.z <= 0:
        return None
    normal = _opening_normal(opening, context)
    if normal is None:
        return None
    if towards_sun.x * normal.x + towards_sun.y * normal.y >= 0:
        return None

    floor_z = context.room.elevation_mm
    sill_z = floor_z + opening.sill_height_mm
    head_z = floor_z + opening.head_height_mm
    if head_z <= plane_elevation_mm:
        return None
    corners = (
        Point3D(opening.start.x, opening.start.y, max(sill_z, plane_elevation_mm)),
        Point3D(opening.end.x, opening.end.y, max(sill_z, plane_elevation_mm)),
        Point3D(opening.end.x, opening.end.y, head_z),
        Point3D(opening.start.x, opening.start.y, head_z),
    )
    horizontal = hypot(towards_sun.x, towards_sun.y)
    if horizontal <= 1e-9:
        shadow_x = shadow_y = 0.0
    else:
        shadow_x = towards_sun.x / towards_sun.z
        shadow_y = towards_sun.y / towards_sun.z
    projected = tuple(
        Point2D(
            corner.x - (corner.z - plane_elevation_mm) * shadow_x,
            corner.y - (corner.z - plane_elevation_mm) * shadow_y,
        )
        for corner in corners
    )
    projected_area = abs(_signed_area(projected))
    if projected_area < 1_000:
        return None

    shaded = _overhang_shadow_edge(opening, context, towards_sun, plane_elevation_mm, normal)
    if shaded is not None:
        projected = _clip_beyond(projected, *shaded)
        if len(projected) < 3:
            return None
        projected_area = abs(_signed_area(projected))
        if projected_area < 1_000:
            return None

    pieces = clip_convex_to_polygon(_counter_clockwise(projected), context.ceiling.polygon)
    area = sum(polygon_area(piece) for piece in pieces)
    if not pieces or area < 1_000:
        return None
    incidence = degrees(
        acos(
            min(
                1.0,
                max(
                    -1.0,
                    -(towards_sun.x * normal.x + towards_sun.y * normal.y + towards_sun.z * normal.z),
                ),
            )
        )
    )
    return SunPatch(
        opening_id=opening.id,
        opening_name=opening.name,
        opening_kind=opening.kind.value,
        pieces=pieces,
        projected=Polygon2D(_counter_clockwise(projected)),
        plane_elevation_mm=plane_elevation_mm,
        area_m2=area / 1_000_000,
        projected_area_m2=projected_area / 1_000_000,
        incidence_deg=incidence,
    )


def analyse_direct_sun(
    context: RoomContext,
    site: Site,
    moment: datetime,
    *,
    plane_elevation_mm: float | None = None,
) -> RoomDaylight:
    """Return direct-sun geometry for one room at one instant.

    The result is geometric. It states where a direct beam can reach and from
    which direction, and never an illuminance value.
    """

    plane = context.room.elevation_mm if plane_elevation_mm is None else plane_elevation_mm
    notes: list[str] = []
    if not site.located:
        return RoomDaylight(
            room_id=context.room.id,
            site=site,
            when=moment.isoformat(),
            plane_elevation_mm=plane,
            position=None,
            sun_direction=None,
            patches=(),
            notes=(
                "site_unknown: the IFC states no site latitude and longitude, "
                "so no solar position can be computed.",
            ),
        )
    assert site.latitude_deg is not None and site.longitude_deg is not None
    position = solar_position(site.latitude_deg, site.longitude_deg, moment)
    towards_sun = sun_direction(position, site.true_north_deg)
    if not position.above_horizon:
        notes.append("The sun is below the horizon at this instant, so there is no direct beam.")
        return RoomDaylight(
            room_id=context.room.id,
            site=site,
            when=moment.isoformat(),
            plane_elevation_mm=plane,
            position=position,
            sun_direction=towards_sun,
            patches=(),
            notes=tuple(notes),
        )

    glazed = [
        opening
        for opening in context.openings
        if opening.kind in GLAZED_OPENING_KINDS and opening.exposure == "exterior"
    ]
    if not glazed:
        notes.append(
            "This room has no exterior glazed opening in the model, so no direct sun patch is possible."
        )
    patches = tuple(
        patch
        for opening in glazed
        if (patch := project_sun_patch(opening, context, towards_sun, plane)) is not None
    )
    if glazed and not patches:
        notes.append(
            "Every exterior opening faces away from the sun or casts its patch outside this room."
        )
    if site.evidence != "confirmed":
        notes.append(f"Site evidence is {site.evidence}; confirm latitude, longitude, and true north on site.")
    notes.append("Sill and head heights come from the model and remain trace assumptions until surveyed.")
    return RoomDaylight(
        room_id=context.room.id,
        site=site,
        when=moment.isoformat(),
        plane_elevation_mm=plane,
        position=position,
        sun_direction=towards_sun,
        patches=patches,
        notes=tuple(notes),
    )
