import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** How near and far the camera may sit from what it is looking at, in metres. */
export type OrbitRange = {
  readonly minDistanceM: number;
  readonly maxDistanceM: number;
};

/**
 * One orbit feel for every 3D view.
 *
 * The wheel zooms towards the pointer rather than the orbit centre, so
 * reaching a corner is one gesture instead of zoom-then-pan-then-zoom. Both
 * the middle and the right button pan, because the middle button dollying is
 * a third way to do what the wheel already does. The distance limits keep the
 * model reachable: without them a wheel flick either buries the camera inside
 * a wall or leaves the home a dot.
 */
export function configureOrbit(controls: OrbitControls, range: OrbitRange): void {
  controls.enableDamping = true;
  // 0.08 kept gliding for about half a second after the pointer stopped,
  // which reads as the view drifting on its own.
  controls.dampingFactor = 0.16;
  // Stop just above the horizon. Orbiting under the floor shows the underside
  // of a slab and loses which way up the home is.
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = range.minDistanceM;
  controls.maxDistance = range.maxDistanceM;
  controls.zoomToCursor = true;
  controls.zoomSpeed = 0.85;
  controls.rotateSpeed = 0.75;
  controls.panSpeed = 0.9;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  };
}

/**
 * Slide the view until `point` is at its centre, keeping the direction and
 * distance the camera already had.
 *
 * Moving the target alone would swing the camera round to face the point,
 * which loses the angle the viewer chose. Moving both reads as a slide, and
 * everything afterwards orbits the thing they picked.
 */
export function focusOrbitOn(camera: THREE.Camera, controls: OrbitControls, point: THREE.Vector3): void {
  const shift = point.clone().sub(controls.target);
  controls.target.add(shift);
  camera.position.add(shift);
  controls.update();
}

/** A material is see-through if the viewer can read what is behind it. */
export function isSeeThrough(object: THREE.Object3D): boolean {
  const material = (object as THREE.Mesh).material;
  if (material === undefined) return false;
  const single = Array.isArray(material) ? material[0] : material;
  return single !== undefined && single.transparent === true && (single.opacity ?? 1) < 0.9;
}

/**
 * Centre the view on the solid surface under the pointer.
 *
 * Glass and a wall currently faded out are skipped, so a double-click reaches
 * the room behind them rather than stopping at a pane the viewer is already
 * seeing through. Returns false over empty space, which leaves the view alone
 * instead of swinging it somewhere arbitrary.
 */
export function focusOrbitOnPointer(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  content: THREE.Object3D,
  pointer: THREE.Vector2,
  /** Rejects a hit the view has hidden, such as the far side of a section cut. */
  accept: (point: THREE.Vector3) => boolean = () => true,
): boolean {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObject(content, true)) {
    if (!hit.object.visible || isSeeThrough(hit.object) || !accept(hit.point)) continue;
    focusOrbitOn(camera, controls, hit.point);
    return true;
  }
  return false;
}
