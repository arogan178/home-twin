import * as THREE from "three";

/**
 * Draw a 3D view only when something changed.
 *
 * Both views run a shadow pass and GTAO per frame, so redrawing a still room
 * sixty times a second keeps the GPU busy for a picture that is not changing.
 * A frame is drawn when the camera moved since the last one, or when a scene
 * edit asked for it. Orbit damping decays geometrically and never quite
 * reaches zero, so a move below ten micrometres or a few microradians is no move.
 */
export type RenderScheduler = {
  /** Ask for one more frame, after a change the camera cannot see. */
  invalidate(): void;
  /** True when a frame is due. Consumes the request. */
  consume(camera: THREE.Camera): boolean;
};

const STILL_POSITION_M = 1e-5;
// 1 - |q·q0| grows with the square of the angle, so this is about three microradians.
const STILL_ROTATION = 1e-12;

export function createRenderScheduler(): RenderScheduler {
  const position = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  const quaternion = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
  let requested = true;
  return {
    invalidate() {
      requested = true;
    },
    consume(camera) {
      const moved =
        !(camera.position.distanceTo(position) <= STILL_POSITION_M)
        || !(1 - Math.abs(camera.quaternion.dot(quaternion)) <= STILL_ROTATION);
      if (!moved && !requested) return false;
      position.copy(camera.position);
      quaternion.copy(camera.quaternion);
      requested = false;
      return true;
    },
  };
}
