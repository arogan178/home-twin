/**
 * Named camera positions for the 3D views, in building metres.
 *
 * The plan view looks straight down with plan +Y up the screen, so it reads
 * like the 2D ceiling plan. The eye-level view stands a person in the room,
 * which is where glare and the height of a pool of light are judged.
 */

export type CameraFrame = {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
};

export type PlanExtent = {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
};

/** The household's average standing height: 1.65 m between the two of them. */
export const HOUSEHOLD_HEIGHT_M = 1.65;
/** Eyes sit about 11 cm below the crown, so this is where the view is taken from. */
export const EYE_HEIGHT_M = HOUSEHOLD_HEIGHT_M - 0.11;

/** How far the camera must stand from a centred extent to fit it in the view. */
export function fitDistance(extent: PlanExtent, fovDeg: number, aspect: number, margin = 1.1): number {
  const vertical = (fovDeg * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 0.2));
  const halfWidth = Math.max((extent.maxX - extent.minX) / 2, 0.5);
  const halfDepth = Math.max((extent.maxY - extent.minY) / 2, 0.5);
  return Math.max(halfDepth / Math.tan(vertical / 2), halfWidth / Math.tan(horizontal / 2)) * margin;
}

export function planViewFrame(
  extent: PlanExtent,
  floorM: number,
  topM: number,
  fovDeg: number,
  aspect: number,
): CameraFrame {
  const x = (extent.minX + extent.maxX) / 2;
  const y = (extent.minY + extent.maxY) / 2;
  const height = Math.max(fitDistance(extent, fovDeg, aspect) + floorM, topM + 0.5);
  // Straight down is degenerate for an orbit whose up is +Z, and a hair of
  // southward lean is what keeps plan +Y pointing up the screen.
  return {
    position: { x, y: y - (height - floorM) * 1e-3, z: height },
    target: { x, y, z: floorM },
  };
}

export type PlanPoint = { readonly x: number; readonly y: number };

/** How far a ray from `at` runs before it meets the ring's outline. */
export function clearRun(at: PlanPoint, direction: PlanPoint, ring: ReadonlyArray<PlanPoint>): number {
  let nearest = Infinity;
  ring.forEach((start, index) => {
    const end = ring[(index + 1) % ring.length]!;
    const edgeX = end.x - start.x;
    const edgeY = end.y - start.y;
    const denominator = direction.x * edgeY - direction.y * edgeX;
    if (Math.abs(denominator) < 1e-12) return;
    const offsetX = start.x - at.x;
    const offsetY = start.y - at.y;
    const along = (offsetX * edgeY - offsetY * edgeX) / denominator;
    const onEdge = (offsetX * direction.y - offsetY * direction.x) / denominator;
    if (along > 1e-9 && onEdge >= 0 && onEdge <= 1) nearest = Math.min(nearest, along);
  });
  return nearest;
}

/**
 * The plan direction with the longest clear run to the room's outline, of
 * sixteen. Standing a person where the room is deepest and facing the long
 * view is what a first look at a room is; facing the nearest wall is not.
 */
export function openestDirection(at: PlanPoint, ring: ReadonlyArray<PlanPoint>): PlanPoint {
  let best = { x: 0, y: 1 };
  let bestRun = -1;
  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 16) * Math.PI * 2;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const run = clearRun(at, direction, ring);
    if (Number.isFinite(run) && run > bestRun + 1e-9) {
      bestRun = run;
      best = direction;
    }
  }
  return best;
}

/** Stand at `at` at eye height, facing `direction` in plan. */
export function eyeLevelFrame(at: PlanPoint, direction: PlanPoint, floorM: number): CameraFrame {
  const length = Math.hypot(direction.x, direction.y) || 1;
  const reach = 1.5;
  const eyeZ = floorM + EYE_HEIGHT_M;
  return {
    position: { x: at.x, y: at.y, z: eyeZ },
    target: {
      x: at.x + (direction.x / length) * reach,
      y: at.y + (direction.y / length) * reach,
      z: eyeZ - 0.15,
    },
  };
}
