import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { describe, expect, it } from "vitest";

import { configureOrbit, focusOrbitOn, focusOrbitOnPointer } from "./cameraControls";

/** Only the parts of OrbitControls these helpers touch. */
function stubControls(): OrbitControls {
  return {
    target: new THREE.Vector3(),
    update: () => true,
  } as unknown as OrbitControls;
}

describe("configureOrbit", () => {
  it("zooms towards the pointer, pans on both spare buttons, and stays above the floor", () => {
    const controls = stubControls();

    configureOrbit(controls, { minDistanceM: 0.6, maxDistanceM: 80 });

    expect(controls.zoomToCursor).toBe(true);
    expect(controls.enableDamping).toBe(true);
    expect(controls.minDistance).toBe(0.6);
    expect(controls.maxDistance).toBe(80);
    expect(controls.maxPolarAngle).toBeLessThan(Math.PI / 2);
    expect(controls.mouseButtons.MIDDLE).toBe(THREE.MOUSE.PAN);
    expect(controls.mouseButtons.RIGHT).toBe(THREE.MOUSE.PAN);
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.ROTATE);
  });
});

describe("focusOrbitOn", () => {
  it("centres the point without turning the camera or changing its distance", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, -6, 4);
    const controls = stubControls();
    controls.target.set(0, 0, 0);
    const before = camera.position.distanceTo(controls.target);
    const direction = controls.target.clone().sub(camera.position).normalize();

    focusOrbitOn(camera, controls, new THREE.Vector3(15, 10, 1));

    expect(controls.target.toArray()).toEqual([15, 10, 1]);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(before, 6);
    const after = controls.target.clone().sub(camera.position).normalize();
    expect(after.dot(direction)).toBeCloseTo(1, 6);
  });
});

describe("focusOrbitOnPointer", () => {
  function solid(y: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(4, 0.2, 4),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    mesh.position.set(0, y, 0);
    return mesh;
  }

  function pane(y: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(4, 0.2, 4),
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.12 }),
    );
    mesh.position.set(0, y, 0);
    return mesh;
  }

  function aimedCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -10, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return camera;
  }

  it("looks past a wall it can already see through and lands on what is behind", () => {
    const content = new THREE.Group();
    content.add(pane(-2));
    content.add(solid(2));
    content.updateMatrixWorld(true);
    const controls = stubControls();

    const hit = focusOrbitOnPointer(aimedCamera(), controls, content, new THREE.Vector2(0, 0));

    expect(hit).toBe(true);
    expect(controls.target.y).toBeCloseTo(1.9, 1);
  });

  it("leaves the view alone when the pointer is over empty space", () => {
    const content = new THREE.Group();
    content.add(solid(2));
    content.updateMatrixWorld(true);
    const controls = stubControls();
    controls.target.set(7, 7, 7);

    const hit = focusOrbitOnPointer(aimedCamera(), controls, content, new THREE.Vector2(0.98, 0.98));

    expect(hit).toBe(false);
    expect(controls.target.toArray()).toEqual([7, 7, 7]);
  });
});
