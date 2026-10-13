/**
 * Default cameras that fit what they frame, in building metres.
 *
 * A bounding sphere wastes most of the canvas on a flat floor plan, so these
 * fit the outline itself: every vertex is projected into the view and the
 * camera stands back only as far as the tightest one needs.
 */

import { clearRun, openestDirection, type CameraFrame, type PlanPoint } from "./cameraPresets";

export type Box = {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
};

export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };

/** Overviews look north from somewhere in the southern half, so plan +Y stays up the screen. */
const OVERVIEW_BEARINGS_DEG = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
/** Low enough that the near walls stand in the sightline and fade, so the floor reads past them. */
const ROOM_ELEVATION_DEG = 36;
/** From either southern corner, so two inner walls and the floor between them read. */
const ROOM_BEARINGS_DEG = [35, -35];
const FLOOR_ELEVATION_DEG = 40;

/** A unit vector from the target towards the camera, from a plan bearing and an elevation. */
export function viewDirection(plan: PlanPoint, elevationDeg: number): Vec3 {
  const length = Math.hypot(plan.x, plan.y) || 1;
  const elevation = (elevationDeg * Math.PI) / 180;
  return {
    x: (plan.x / length) * Math.cos(elevation),
    y: (plan.y / length) * Math.cos(elevation),
    z: Math.sin(elevation),
  };
}

/** How far back along `towards` from `centre` the camera must stand for every point to be in view. */
function fitDistanceFor(
  points: ReadonlyArray<Vec3>,
  centre: Vec3,
  towards: Vec3,
  fovDeg: number,
  aspect: number,
  margin: number,
): number {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * Math.max(aspect, 0.2);
  // Camera basis with +Z up: right is horizontal, up completes the frame.
  const horizontal = Math.hypot(towards.x, towards.y) || 1;
  const right = { x: -towards.y / horizontal, y: towards.x / horizontal, z: 0 };
  const up = {
    x: -towards.z * right.y,
    y: towards.z * right.x,
    z: towards.x * right.y - towards.y * right.x,
  };
  let distance = 0;
  for (const point of points) {
    const offset = { x: point.x - centre.x, y: point.y - centre.y, z: point.z - centre.z };
    const dot = (axis: Vec3) => offset.x * axis.x + offset.y * axis.y + offset.z * axis.z;
    const nearer = dot(towards);
    distance = Math.max(
      distance,
      nearer + (margin * Math.abs(dot(right))) / tanH,
      nearer + (margin * Math.abs(dot(up))) / tanV,
    );
  }
  return distance;
}

function centreOf(points: ReadonlyArray<Vec3>): Vec3 {
  const span = (axis: "x" | "y" | "z") => {
    const values = points.map((point) => point[axis]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  return { x: span("x"), y: span("y"), z: span("z") };
}

function frameAt(centre: Vec3, towards: Vec3, distance: number): CameraFrame {
  return {
    position: {
      x: centre.x + towards.x * distance,
      y: centre.y + towards.y * distance,
      z: centre.z + towards.z * distance,
    },
    target: centre,
  };
}

/**
 * Fit the points from whichever southern bearing shows them largest.
 *
 * A room on the diagonal, seen along its length, is a thin strip down the
 * middle of a wide canvas; seen across it, the same room fills the frame.
 */
function overviewFrame(
  points: ReadonlyArray<Vec3>,
  bearingsDeg: ReadonlyArray<number>,
  elevationDeg: number,
  fovDeg: number,
  aspect: number,
  margin: number,
  aimAboveFloorM: number | null,
): CameraFrame {
  const middle = centreOf(points);
  const floor = Math.min(...points.map((point) => point.z));
  const centre = aimAboveFloorM === null ? middle : { ...middle, z: floor + aimAboveFloorM };
  let best: { towards: Vec3; distance: number } | null = null;
  for (const bearing of bearingsDeg) {
    const radians = (bearing * Math.PI) / 180;
    const towards = viewDirection({ x: Math.sin(radians), y: -Math.cos(radians) }, elevationDeg);
    const distance = fitDistanceFor(points, centre, towards, fovDeg, aspect, margin);
    if (best === null || distance < best.distance - 1e-6) best = { towards, distance };
  }
  return frameAt(centre, best!.towards, best!.distance);
}

/**
 * The view a room opens on: three-quarter from a southern corner, the whole
 * room in frame. The near walls stand between the camera and the floor, and
 * the see-through fading takes them, because it probes the floor's corners.
 * Furniture does not fade, so of the two corners the one with fewer floor
 * points hidden behind tall furniture wins, the south-east on a tie.
 */
export function roomOverviewFrame(
  points: ReadonlyArray<Vec3>,
  fovDeg: number,
  aspect: number,
  floorPoints: ReadonlyArray<Vec3> = [],
  furniture: ReadonlyArray<Box> = [],
): CameraFrame {
  let best: { frame: CameraFrame; hidden: number } | null = null;
  for (const bearing of ROOM_BEARINGS_DEG) {
    // Aimed at table height rather than mid-wall, so the sightline runs through
    // the near walls, which then fade, instead of grazing their heads.
    // The wider margin keeps the near wall foot clear of the disclaimer row.
    const frame = overviewFrame(points, [bearing], ROOM_ELEVATION_DEG, fovDeg, aspect, 1.16, 0.9);
    const hidden = floorPoints.filter((point) => furniture.some((box) => segmentHits(frame.position, point, box))).length;
    if (best === null || hidden < best.hidden) best = { frame, hidden };
  }
  return best!.frame;
}

/** The view the whole floor opens on, at a lower angle so the storey heights read. */
export function floorOverviewFrame(points: ReadonlyArray<Vec3>, fovDeg: number, aspect: number): CameraFrame {
  return overviewFrame(points, OVERVIEW_BEARINGS_DEG, FLOOR_ELEVATION_DEG, fovDeg, aspect, 1.06, null);
}

/** Plan outlines raised to a floor and a ceiling height, the points an overview fits. */
export function extrudedOutlines(
  outlines: ReadonlyArray<{ readonly ring: ReadonlyArray<PlanPoint>; readonly fromZ: number; readonly toZ: number }>,
): Vec3[] {
  return outlines.flatMap(({ ring, fromZ, toZ }) => ring.flatMap((point) => [
    { x: point.x, y: point.y, z: fromZ },
    { x: point.x, y: point.y, z: toZ },
  ]));
}

/** Head room kept between the camera and the finished ceiling. */
const CEILING_CLEARANCE_M = 0.3;
/** How close the camera may come to the outline it stands inside. */
const WALL_CLEARANCE_M = 0.45;

/** Whether the segment from `from` to `to` passes through the box. */
function segmentHits(from: Vec3, to: Vec3, box: Box): boolean {
  let enter = 0;
  let leave = 1;
  for (const [start, end, low, high] of [
    [from.x, to.x, box.minX, box.maxX],
    [from.y, to.y, box.minY, box.maxY],
    [from.z, to.z, box.minZ, box.maxZ],
  ] as const) {
    const delta = end - start;
    if (Math.abs(delta) < 1e-12) {
      if (start < low || start > high) return false;
      continue;
    }
    const a = (low - start) / delta;
    const b = (high - start) / delta;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return false;
  }
  return true;
}

/** Within this reach an obstacle on screen fills the frame rather than sitting in it. */
const FOREGROUND_M = 1.6;

/**
 * What a frame loses to obstacles: anything standing between the camera and
 * what it looks at, and anything on screen within arm's length of the lens.
 */
function clutter(frame: CameraFrame, obstacles: ReadonlyArray<Box>, halfDiagonal: number): number {
  const look = {
    x: frame.target.x - frame.position.x,
    y: frame.target.y - frame.position.y,
    z: frame.target.z - frame.position.z,
  };
  const reach = Math.hypot(look.x, look.y, look.z);
  // Stools and chairs drawn up to the furniture itself are part of it, so the
  // occlusion test stops short of the target.
  const short = {
    x: frame.position.x + look.x * 0.75,
    y: frame.position.y + look.y * 0.75,
    z: frame.position.z + look.z * 0.75,
  };
  let cost = 0;
  for (const box of obstacles) {
    if (segmentHits(frame.position, short, box)) cost += 4;
    for (const x of [box.minX, box.maxX]) {
      for (const y of [box.minY, box.maxY]) {
        for (const z of [box.minZ, box.maxZ]) {
          const to = { x: x - frame.position.x, y: y - frame.position.y, z: z - frame.position.z };
          const distance = Math.hypot(to.x, to.y, to.z);
          if (distance >= FOREGROUND_M || distance < 1e-6) continue;
          const cosine = (to.x * look.x + to.y * look.y + to.z * look.z) / (distance * reach);
          if (Math.acos(Math.max(-1, Math.min(1, cosine))) < halfDiagonal) cost += 3 * (1 - distance / FOREGROUND_M);
        }
      }
    }
  }
  return cost;
}

/**
 * Stand in the room on the open side of a piece of furniture, looking at it.
 *
 * The open side is the plan direction with the longest clear run to the room
 * outline, which for an island is the side away from the kitchen run. The
 * camera stays inside the outline and under the ceiling. Of the sixteen
 * directions, the one that looks across the piece rather than at its end, with
 * nothing in the way and no other furniture or pendant shade in the
 * foreground, wins; the longer run breaks a tie.
 */
export function focusFrame(
  object: Box,
  outline: ReadonlyArray<PlanPoint>,
  floorM: number,
  ceilingM: number,
  fovDeg: number,
  aspect: number,
  obstacles: ReadonlyArray<Box> = [],
): CameraFrame {
  const centre = { x: (object.minX + object.maxX) / 2, y: (object.minY + object.maxY) / 2 };
  const span = Math.hypot(object.maxX - object.minX, object.maxY - object.minY);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const halfDiagonal = Math.atan(tanV * Math.hypot(1, Math.max(aspect, 0.2)));
  const wanted = Math.max(span / (2 * tanV), 2.4);
  const long = object.maxX - object.minX >= object.maxY - object.minY;
  const square = Math.abs((object.maxX - object.minX) - (object.maxY - object.minY)) < 0.2;
  const axis = square ? { x: 0, y: 0 } : long ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const targetZ = floorM + Math.min(object.maxZ - floorM, 1.2) * 0.75;
  const height = Math.min(floorM + 2.3, ceilingM - CEILING_CLEARANCE_M);
  // Something hanging over the furniture itself, such as the dining pendant, is part of the view.
  const aside = obstacles.filter((box) => (
    box.maxX < object.minX || box.minX > object.maxX || box.maxY < object.minY || box.minY > object.maxY
  ));
  let best: { frame: CameraFrame; cost: number; run: number } | null = null;
  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 16) * Math.PI * 2;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const run = clearRun(centre, direction, outline);
    if (!Number.isFinite(run)) continue;
    const back = Math.max(Math.min(wanted, run - WALL_CLEARANCE_M), 0.6);
    const frame = {
      position: { x: centre.x + direction.x * back, y: centre.y + direction.y * back, z: height },
      target: { x: centre.x, y: centre.y, z: targetZ },
    };
    // Rounded, so a sliver of clutter does not outweigh a much longer run.
    // An end-on view of a long piece shows its end panel, so a view across it is preferred.
    const endOn = 1.5 * (direction.x * axis.x + direction.y * axis.y) ** 2;
    const cost = Math.round((clutter(frame, aside, halfDiagonal) + endOn) * 4) / 4;
    if (best === null || cost < best.cost || (cost === best.cost && run > best.run + 1e-9)) best = { frame, cost, run };
  }
  if (best !== null) return best.frame;
  const open = openestDirection(centre, outline);
  return {
    position: { x: centre.x + open.x * 0.6, y: centre.y + open.y * 0.6, z: height },
    target: { x: centre.x, y: centre.y, z: targetZ },
  };
}
