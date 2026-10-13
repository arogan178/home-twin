import type { Stair } from "./types";

const MM = 0.001;

export type StairFlightPart = {
  readonly centreXM: number;
  readonly centreYM: number;
  readonly centreZM: number;
  readonly goingDepthM: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly rotationZ: number;
  readonly topElevationM: number;
};

export type StairFlightParts = {
  readonly treads: ReadonlyArray<StairFlightPart>;
  readonly landingRiser: StairFlightPart | null;
};

/** Build display solids from IFC stair counts without conflating treads and risers. */
export function buildStairFlightParts(stair: Stair): StairFlightParts {
  const bearing = (stair.up_bearing_deg * Math.PI) / 180;
  const ux = Math.sin(bearing);
  const uy = Math.cos(bearing);
  const alongs = stair.footprint.outer.map((point) => point.x * ux + point.y * uy);
  const acrosses = stair.footprint.outer.map((point) => point.x * uy - point.y * ux);
  const minAlongM = Math.min(...alongs) * MM;
  const minAcrossM = Math.min(...acrosses) * MM;
  const goingM = (Math.max(...alongs) - Math.min(...alongs)) * MM;
  const widthM = (Math.max(...acrosses) - Math.min(...acrosses)) * MM;
  const treadCount = Math.max(stair.tread_count, 1);
  const treadDepthM = goingM / treadCount;
  const riserHeightM =
    stair.riser_height_mm > 0 ? stair.riser_height_mm * MM : (stair.rise_mm * MM) / stair.riser_count;
  const baseM = stair.base_elevation_mm * MM;

  const part = (alongCentreM: number, goingDepthM: number, heightM: number): StairFlightPart => ({
    centreXM: alongCentreM * ux + (minAcrossM + widthM / 2) * uy,
    centreYM: alongCentreM * uy - (minAcrossM + widthM / 2) * ux,
    centreZM: baseM + heightM / 2,
    goingDepthM,
    widthM,
    heightM,
    rotationZ: Math.atan2(uy, ux),
    topElevationM: baseM + heightM,
  });

  const treads = Array.from({ length: treadCount }, (_, index) => {
    const heightM = Math.min(riserHeightM * (index + 1), stair.rise_mm * MM);
    return part(minAlongM + treadDepthM * (index + 0.5), treadDepthM, heightM);
  });
  const lastTreadTopM = treads.at(-1)?.topElevationM ?? baseM;
  const flightTopM = baseM + stair.rise_mm * MM;
  const landingRiser = flightTopM > lastTreadTopM + 0.001
    ? part(minAlongM + goingM - Math.min(treadDepthM / 5, 0.04) / 2, Math.min(treadDepthM / 5, 0.04), flightTopM - baseM)
    : null;

  return { treads, landingRiser };
}

export type WallLine = {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
};

export type StairBand = {
  readonly centreXM: number;
  readonly centreYM: number;
  readonly centreZM: number;
  /** Along the rake, not along the plan. */
  readonly lengthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  readonly rotationZ: number;
  /** Tilt of the rake above horizontal, in radians. */
  readonly pitchRad: number;
};

/** The raking band against the flight's wall side: one mitred run, not steps.
 *
 * Stepping it left a staggered black line up the wall. The band follows the
 * nosing line as a single piece, which is how a stone stair has always been
 * detailed, and the panel's own stepped bottom edge dies behind it.
 */
export function stairBand(stair: Stair, walls: ReadonlyArray<WallLine>): StairBand | null {
  const heightM = (stair.skirting_height_mm ?? 0) * MM;
  const thicknessM = (stair.skirting_thickness_mm ?? 0) * MM;
  if (heightM <= 0 || thicknessM <= 0 || walls.length === 0) return null;

  const bearing = (stair.up_bearing_deg * Math.PI) / 180;
  const ux = Math.sin(bearing);
  const uy = Math.cos(bearing);
  const alongs = stair.footprint.outer.map((point) => point.x * ux + point.y * uy);
  const acrosses = stair.footprint.outer.map((point) => point.x * uy - point.y * ux);
  const minAlongM = Math.min(...alongs) * MM;
  const goingM = (Math.max(...alongs) - Math.min(...alongs)) * MM;
  const minAcrossM = Math.min(...acrosses) * MM;
  const maxAcrossM = Math.max(...acrosses) * MM;
  const riseM = stair.rise_mm * MM;
  const baseM = stair.base_elevation_mm * MM;
  const midAlongM = minAlongM + goingM / 2;

  // The band goes against the wall, which is whichever edge of the flight has
  // one: a free edge takes a balustrade, not a skirting.
  const edgeDistance = (acrossM: number): number => {
    const x = midAlongM * ux + acrossM * uy;
    const y = midAlongM * uy - acrossM * ux;
    return Math.min(
      ...walls.map((wall) => {
        const ax = wall.start.x * MM;
        const ay = wall.start.y * MM;
        const bx = wall.end.x * MM;
        const by = wall.end.y * MM;
        const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
        if (lengthSquared < 1e-9) return Math.hypot(x - ax, y - ay);
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / lengthSquared));
        return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
      }),
    );
  };
  const atMin = edgeDistance(minAcrossM) <= edgeDistance(maxAcrossM);
  const acrossCentreM = atMin ? minAcrossM + thicknessM / 2 : maxAcrossM - thicknessM / 2;

  const pitchRad = Math.atan2(riseM, goingM);
  // The nosing line runs from the first tread's top to the flight's head, so
  // the band's own centre rides half its height above that line's midpoint.
  const riserHeightM = riseM / Math.max(stair.riser_count, 1);
  return {
    centreXM: midAlongM * ux + acrossCentreM * uy,
    centreYM: midAlongM * uy - acrossCentreM * ux,
    centreZM: baseM + riserHeightM + riseM / 2 + heightM / (2 * Math.cos(pitchRad)),
    lengthM: Math.hypot(goingM, riseM),
    heightM,
    thicknessM,
    rotationZ: Math.atan2(uy, ux),
    pitchRad,
  };
}
