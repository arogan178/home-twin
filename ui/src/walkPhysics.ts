import * as THREE from "three";

import { EYE_HEIGHT_M } from "./cameraPresets";

/**
 * Walking through the whole-floor view on the floors and stairs it draws.
 *
 * The eye rides a fixed height above whatever surface is under it, so a
 * flight of treads lifts the camera one riser at a time and the split level
 * is walked into rather than flown over. Walls stop the body instead of being
 * passed through. It is display behaviour for reading the home at eye level,
 * not a clearance check.
 *
 * Each room's floor stops at its own wall face, so a doorway is a strip the
 * wall's thickness wide with no floor under it. A step onto that strip is
 * taken when there is floor again within a door's depth ahead.
 */

export const WALK_EYE_HEIGHT_M = EYE_HEIGHT_M;
/** The highest step taken without a stop: a stair riser, not a worktop. */
export const WALK_STEP_UP_M = 0.4;
/** The furthest drop followed in one move, so a stairwell edge is walked down, not fallen through. */
export const WALK_STEP_DOWN_M = 1.2;
/** How close the body gets to a wall face. */
export const WALK_BODY_RADIUS_M = 0.25;
/** The widest floorless strip crossed, which is a thick wall's doorway. */
export const WALK_THRESHOLD_M = 0.6;

const DOWN = new THREE.Vector3(0, 0, -1);

/** The walkable surface under a plan point, from just above the feet down. */
export function floorBelow(
  raycaster: THREE.Raycaster,
  walkables: ReadonlyArray<THREE.Object3D>,
  x: number,
  y: number,
  feetZ: number,
): number | null {
  raycaster.set(new THREE.Vector3(x, y, feetZ + WALK_STEP_UP_M), DOWN);
  raycaster.far = WALK_STEP_UP_M + WALK_STEP_DOWN_M;
  const hit = raycaster.intersectObjects(walkables as THREE.Object3D[], false)[0];
  raycaster.far = Infinity;
  return hit === undefined ? null : hit.point.z;
}

/** Whether there is floor at the feet's level within a threshold's depth along a move. */
function floorBeyond(
  raycaster: THREE.Raycaster,
  walkables: ReadonlyArray<THREE.Object3D>,
  x: number,
  y: number,
  move: THREE.Vector3,
  feetZ: number,
): number | null {
  const length = Math.hypot(move.x, move.y);
  if (length === 0) return null;
  for (let reach = 0.1; reach <= WALK_THRESHOLD_M + 1e-9; reach += 0.1) {
    const floor = floorBelow(raycaster, walkables, x + (move.x / length) * reach, y + (move.y / length) * reach, feetZ);
    if (floor !== null && Math.abs(floor - feetZ) <= WALK_STEP_UP_M) return floor;
  }
  return null;
}

/** Whether a wall stands within reach of the body along a horizontal move. */
export function wallAhead(
  raycaster: THREE.Raycaster,
  walls: ReadonlyArray<THREE.Object3D>,
  eye: THREE.Vector3,
  move: THREE.Vector3,
): boolean {
  const length = Math.hypot(move.x, move.y);
  if (length === 0) return false;
  const direction = new THREE.Vector3(move.x / length, move.y / length, 0);
  // Knee and chest height, so a low wall and a nib above a door both stop it.
  for (const drop of [WALK_EYE_HEIGHT_M - 0.45, 0.5]) {
    raycaster.set(new THREE.Vector3(eye.x, eye.y, eye.z - drop), direction);
    raycaster.far = length + WALK_BODY_RADIUS_M;
    const blocked = raycaster.intersectObjects(walls as THREE.Object3D[], false).length > 0;
    raycaster.far = Infinity;
    if (blocked) return true;
  }
  return false;
}

/**
 * Move the eye by `move` in plan, sliding along a wall it meets, and settle it
 * on the surface underneath. A move with no floor under it is refused.
 */
export function walkStep(
  raycaster: THREE.Raycaster,
  walkables: ReadonlyArray<THREE.Object3D>,
  walls: ReadonlyArray<THREE.Object3D>,
  eye: THREE.Vector3,
  move: THREE.Vector3,
): THREE.Vector3 {
  const feetZ = eye.z - WALK_EYE_HEIGHT_M;
  const candidates = [move, new THREE.Vector3(move.x, 0, 0), new THREE.Vector3(0, move.y, 0)];
  for (const candidate of candidates) {
    if (candidate.lengthSq() === 0 || wallAhead(raycaster, walls, eye, candidate)) continue;
    const x = eye.x + candidate.x;
    const y = eye.y + candidate.y;
    const floor = floorBelow(raycaster, walkables, x, y, feetZ);
    if (floor !== null) return new THREE.Vector3(x, y, floor + WALK_EYE_HEIGHT_M);
    // Mid-doorway the feet keep their level until the next room's floor.
    if (floorBeyond(raycaster, walkables, x, y, candidate, feetZ) !== null) return new THREE.Vector3(x, y, eye.z);
  }
  const floor = floorBelow(raycaster, walkables, eye.x, eye.y, feetZ);
  return floor === null ? eye.clone() : new THREE.Vector3(eye.x, eye.y, floor + WALK_EYE_HEIGHT_M);
}
