/**
 * Where a concealed cove throws its light.
 *
 * A cove in a ceiling reveal is a wall wash: the strip sits in the slot and
 * aims at the wall face beside it, so the wall carries the light and the room
 * reads as lit indirectly. The run itself carries no aim — a rope light is a
 * path, not a spotlight — so the wall it washes has to be recovered from the
 * geometry, and that is what this does.
 *
 * Pure, so the aim can be checked without a WebGL context.
 */

import type { Vec2 } from "./plan";
import type { Design, Fixture, Point } from "./types";

type Wall = Design["walls"][number];

export type CoveWash = {
  /** Midpoint of the run, in plan millimetres. */
  readonly centre: Point;
  /** Unit vector from the run towards the wall it washes, in plan. */
  readonly towards: Vec2;
  /** Unit vector along the run, in plan. A linear source needs its own axis. */
  readonly along: Vec2;
  /** Length of the run, in millimetres. */
  readonly lengthMm: number;
  readonly wallId: string;
};

function unit(x: number, y: number): Vec2 {
  const length = Math.hypot(x, y);
  return length === 0 ? { x: 0, y: 0 } : { x: x / length, y: y / length };
}

/** How far `point` sits from the infinite line through a wall's face. */
function distanceToFace(point: Vec2, wall: Wall): number {
  const normal = unit(wall.inward_normal.x, wall.inward_normal.y);
  return Math.abs((point.x - wall.start.x) * normal.x + (point.y - wall.start.y) * normal.y);
}

/** Whether a run and a wall face point along the same line, either way round. */
function isParallel(runDirection: Vec2, wall: Wall, toleranceDeg: number): boolean {
  const face = unit(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const alignment = Math.abs(runDirection.x * face.x + runDirection.y * face.y);
  return alignment >= Math.cos((toleranceDeg * Math.PI) / 180);
}

/**
 * The wall a concealed run washes, and the direction to aim at it.
 *
 * The wall has to be both parallel to the run and the nearest such wall; a room
 * with two parallel walls would otherwise wash whichever came first. Returns
 * null when no wall runs alongside, because a cove with no wall to light is a
 * detail that has not been drawn yet rather than something to guess at.
 */
export function coveWash(
  from: Point,
  to: Point,
  walls: ReadonlyArray<Wall>,
  toleranceDeg = 5,
): CoveWash | null {
  const direction = unit(to.x - from.x, to.y - from.y);
  const centre = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 };

  let best: { wall: Wall; distance: number } | null = null;
  for (const wall of walls) {
    if (!isParallel(direction, wall, toleranceDeg)) continue;
    const distance = distanceToFace(centre, wall);
    if (best === null || distance < best.distance) best = { wall, distance };
  }
  if (best === null) return null;

  // The stored normal points into the room, and the wall is the other way.
  const inward = unit(best.wall.inward_normal.x, best.wall.inward_normal.y);
  return {
    centre,
    towards: { x: -inward.x, y: -inward.y },
    along: direction,
    lengthMm: Math.hypot(to.x - from.x, to.y - from.y),
    wallId: best.wall.wall_id,
  };
}

/**
 * One wash per straight length of the run.
 *
 * A cove that turns a corner follows walls at different bearings, so a single
 * light spanning end to end would lie across the chord and wash whichever wall
 * happened to be nearest its midpoint. Each straight length gets its own.
 */
export function coveWashes(
  fixture: Extract<Fixture, { kind: "rope_light" }>,
  walls: ReadonlyArray<Wall>,
  toleranceDeg = 5,
): CoveWash[] {
  const washes: CoveWash[] = [];
  for (let index = 1; index < fixture.path.length; index += 1) {
    const from = fixture.path[index - 1];
    const to = fixture.path[index];
    if (from === undefined || to === undefined) continue;
    const wash = coveWash(from, to, walls, toleranceDeg);
    if (wash !== null) washes.push(wash);
  }
  return washes;
}

/**
 * The luminance a cove aperture presents, in candela per square metre.
 *
 * three.js takes a RectAreaLight's intensity in nits, so the strip's rating has
 * to become one. Treating the slot mouth as a Lambertian emitter, a flux `F`
 * spread over area `A` radiates `F / (pi * A)`. Here `F` is `lumensPerM * L`
 * and `A` is `L * band`, so the run length cancels and the answer depends only
 * on the strip's rating and how wide the mouth it escapes through is — which is
 * why a longer cove is not a brighter one.
 *
 * This is the aperture as a diffuse source, not the strip's own distribution:
 * a real COB in an extrusion throws a beam, and the profile shields part of it.
 * It is a photometric derivation rather than a fitted number, which is what
 * lets a strip be swapped and compared, but it is still not a simulation.
 */
export function coveLuminance(lumensPerM: number, bandM: number): number {
  if (lumensPerM <= 0 || bandM <= 0) return 0;
  return lumensPerM / (Math.PI * bandM);
}

export type Triple = { readonly x: number; readonly y: number; readonly z: number };
export type CoveBasis = { readonly x: Triple; readonly y: Triple; readonly z: Triple };

const cross = (a: Triple, b: Triple): Triple => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const norm = (v: Triple): Triple => {
  const length = Math.hypot(v.x, v.y, v.z);
  return length === 0 ? { x: 0, y: 0, z: 0 } : { x: v.x / length, y: v.y / length, z: v.z / length };
};

/**
 * The orientation a linear cove light takes, as an orthonormal basis.
 *
 * A rectangular source has an axis as well as a direction, and `lookAt` only
 * fixes the direction: it takes the width axis from the default up vector, so
 * an eleven metre aperture ends up lying across its own run and radiates like a
 * point at the middle of it. Width therefore has to be pinned to the run.
 *
 * `x` is along the run, `z` is the face normal, and the light emits along `-z`,
 * which is the convention three.js uses for lights. `tilt` leans the aim off
 * plumb towards the wall; 0 falls straight down and 1 is forty-five degrees.
 */
export function coveBasis(along: Vec2, towards: Vec2, tilt: number): CoveBasis {
  const emit = norm({ x: towards.x * tilt, y: towards.y * tilt, z: -1 });
  const z = { x: -emit.x, y: -emit.y, z: -emit.z };
  const runAxis = norm({ x: along.x, y: along.y, z: 0 });
  const y = norm(cross(z, runAxis));
  return { x: norm(cross(y, z)), y, z };
}
