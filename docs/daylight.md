# Sunlight and daylight boundary

## What Home Twin computes

Home Twin computes **solar geometry**. For a stated site, date, and time it
answers two questions:

1. Where is the sun? Apparent altitude and azimuth, the declination, the hour
   angle, the equation of time, and one local day's sun path with sunrise,
   solar noon, and sunset.
2. Where can a direct beam land? The footprint each exterior glazed opening
   casts onto the room floor or the task plane, clipped to the traced room
   outline.

Both results carry a method label. `noaa_solar_position_v1` is the solar
position. `direct_sun_patch_geometry_v1` is the beam footprint.

## What it does not compute

A sun patch is not an illuminance value. `RoomDaylight.exclusions` states this
in every response:

```text
illuminance_values
sky_diffuse
ground_reflected
external_obstructions
glazing_transmittance
frame_and_glazing_subdivision
inter_reflection
internal_furniture_shading
```

A credible daylight number needs a sky model, measured or standard sky
luminance, glazing transmittance per pane, the neighbouring buildings that this
trace does not contain, and surface reflectance. Radiance remains the intended
engine for that work, as recorded in [the lighting design model](lighting-design.md).

The electric-light estimate and the sun geometry never mix. Adding a window
bonus to `lumen_beam_cone_v1` would produce convincing but false lux values, so
`ElectricLightingAnalysis.exclusions` still lists `daylight`.

## Site data is required and never guessed

Solar geometry needs three facts that a floor plan alone does not contain:

| Fact | Where it lives | Why |
|---|---|---|
| Latitude | `IfcSite.RefLatitude` | sets the sun's altitude range |
| Longitude | `IfcSite.RefLongitude` | sets solar time against clock time |
| Bearing of plan `+Y` from true north | model `IfcGeometricRepresentationContext.TrueNorth` | rotates the sun into the building frame |

A timezone name and the evidence status live in `Pset_HomeTwinSite` on the site,
because IFC has no timezone concept.

When the model states no latitude and longitude, `analyse_direct_sun` returns a
result whose `position` is `null` and whose notes begin with `site_unknown`. It
does not substitute a plausible location. The browser shows the same message and
offers the tracing workspace, where the site is entered once and compiled into
the draft.

`Site.true_north_deg` is the clockwise bearing of plan `+Y` measured from true
north. Zero means plan up is true north. Thirty means the plan is rotated so
that plan up points thirty degrees east of true north.

## Accuracy

The solar position uses the NOAA solar calculations, including the standard
atmospheric refraction correction. Against the solstice identity
`90 - |latitude - declination|` it agrees to better than a tenth of a degree,
which is far finer than the fifty-millimetre uncertainty of the plan trace it is
applied to.

Sunrise and sunset are the apparent crossings of the sun's **centre**. They run
about a minute inside published almanac times, which use the upper limb and so
include the solar semi-diameter.

## Patch geometry

For each exterior glazed opening the aperture rectangle is taken from the plan
span and the stored sill and head heights. Its corners are projected along the
sun ray onto the target horizontal plane. The opening is skipped when:

- the sun is below the horizon;
- the sun is on the room side of the host wall, so the opening faces away;
- the head of the opening is below the target plane;
- the whole footprint falls outside the room.

The projected parallelogram is then clipped to the room outline. The room is ear
clipped into triangles first, so each clip runs convex against convex and a
concave room never has a beam bridged across a re-entrant corner. The result is
therefore a set of `pieces`, not one polygon, and `area_m2` is their sum.
`projected_area_m2` is the unclipped footprint, so a caller can tell how much of
the beam left the room.

Sill and head heights in a traced plan are explicit assumptions. Confirm
them on site or from elevations before treating any patch as a design input.

## Calling it

```python
from datetime import datetime
from zoneinfo import ZoneInfo

result = twin.analyse_direct_sun(
    room_id,
    datetime(2026, 12, 21, 12, 0, tzinfo=ZoneInfo("UTC")),
    plane_elevation_mm=room.elevation_mm,
)
result.position.altitude_deg
result.patches[0].area_m2
result.exclusions          # includes illuminance_values
```

Over HTTP:

```text
GET /api/rooms/{room_id}/daylight?at=2026-12-21T12:00&plane=floor
```

A naive `at` is read in the site timezone when the model states one, otherwise
in UTC. The response carries the room result and that day's sun path.

Over MCP: `get_site`, `analyse_direct_sun`, and `get_sun_path`.

## Reading the browser

Enable **Sun** in the lighting workspace. The 2D plan draws each patch as a
dashed warm polygon and puts the sun on the plan compass beside true north. The
3D view adds a sun gizmo, a directional light, and a translucent shaft between
the aperture and its patch. The right rail shows altitude, azimuth, patch count,
lit area, the day's sun path, and the exclusion list.

A low winter sun throws a large patch deep into the room. A high summer sun
throws a small one close to the glazing. If the browser shows the opposite,
suspect the true-north bearing before the algorithm.
