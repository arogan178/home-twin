import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { WALK_EYE_HEIGHT_M, floorBelow, walkStep } from "./walkPhysics";

/** A horizontal plate with its top face at `topZ`. */
function plate(minX: number, maxX: number, minY: number, maxY: number, topZ: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, maxY - minY, 0.05), new THREE.MeshBasicMaterial());
  mesh.position.set((minX + maxX) / 2, (minY + maxY) / 2, topZ - 0.025);
  mesh.updateMatrixWorld();
  return mesh;
}

function wallAtX(x: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 10, 3), new THREE.MeshBasicMaterial());
  mesh.position.set(x, 0, 1.5);
  mesh.updateMatrixWorld();
  return mesh;
}

const raycaster = new THREE.Raycaster();
const floor = plate(-5, 5, -5, 5, 0);

describe("walk physics", () => {
  it("finds the floor under the feet and ignores a worktop overhead", () => {
    const worktop = plate(0, 1, 0, 1, 0.9);
    expect(floorBelow(raycaster, [floor, worktop], 0.5, 0.5, 0)).toBeCloseTo(0);
    expect(floorBelow(raycaster, [floor], 9, 9, 0)).toBeNull();
  });

  it("climbs a tread one riser at a time", () => {
    const tread = plate(1, 2, -1, 1, 0.18);
    const eye = new THREE.Vector3(0.9, 0, WALK_EYE_HEIGHT_M);
    const next = walkStep(raycaster, [floor, tread], [], eye, new THREE.Vector3(0.2, 0, 0));
    expect(next.x).toBeCloseTo(1.1);
    expect(next.z).toBeCloseTo(0.18 + WALK_EYE_HEIGHT_M);
  });

  it("stops at a wall and slides along it", () => {
    const eye = new THREE.Vector3(0.8, 0, WALK_EYE_HEIGHT_M);
    const wall = wallAtX(1.2);
    const blocked = walkStep(raycaster, [floor], [wall], eye, new THREE.Vector3(0.3, 0, 0));
    expect(blocked.x).toBeCloseTo(0.8);
    const slid = walkStep(raycaster, [floor], [wall], eye, new THREE.Vector3(0.3, 0.2, 0));
    expect(slid.x).toBeCloseTo(0.8);
    expect(slid.y).toBeCloseTo(0.2);
  });

  it("crosses the floorless strip of a doorway to the next room", () => {
    // Two rooms whose floors stop 0.2 m apart at the faces of the wall between.
    const west = plate(-5, 1, -5, 5, 0);
    const east = plate(1.2, 5, -5, 5, 0);
    let eye = new THREE.Vector3(0.9, 0, WALK_EYE_HEIGHT_M);
    for (let step = 0; step < 10; step += 1) {
      eye = walkStep(raycaster, [west, east], [], eye, new THREE.Vector3(0.05, 0, 0));
    }
    expect(eye.x).toBeCloseTo(1.4);
    expect(eye.z).toBeCloseTo(WALK_EYE_HEIGHT_M);
  });

  it("stands the eye at the household's height less the crown", () => {
    expect(WALK_EYE_HEIGHT_M).toBeCloseTo(1.54);
  });

  it("refuses a step off the edge of everything", () => {
    const eye = new THREE.Vector3(4.9, 0, WALK_EYE_HEIGHT_M);
    const next = walkStep(raycaster, [floor], [], eye, new THREE.Vector3(0.5, 0, 0));
    expect(next.x).toBeCloseTo(4.9);
  });
});
