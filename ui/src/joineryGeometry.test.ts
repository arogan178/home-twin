import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { chamferedBoard, hingeCount, Joinery, joineryParts } from "./joineryGeometry";

describe("chamfered board", () => {
  it("fills exactly the size it is given", () => {
    const geometry = chamferedBoard([0.6, 0.022, 0.7], 0.0015, "-y");
    geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(0.6, 6);
    expect(size.y).toBeCloseTo(0.022, 6);
    expect(size.z).toBeCloseTo(0.7, 6);
  });

  it("cuts the arris on the show face only", () => {
    const geometry = chamferedBoard([0.6, 0.022, 0.7], 0.002, "-y");
    const position = geometry.getAttribute("position");
    const front: number[] = [];
    const back: number[] = [];
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(position.getY(i) + 0.011) < 1e-6) front.push(Math.abs(position.getX(i)));
      if (Math.abs(position.getY(i) - 0.011) < 1e-6) back.push(Math.abs(position.getX(i)));
    }
    // The show face stops 2 mm short of each edge; the back runs to it.
    expect(Math.max(...front)).toBeCloseTo(0.298, 6);
    expect(Math.max(...back)).toBeCloseTo(0.3, 6);
    // Show face, back, four chamfers and four sides, two triangles each.
    expect(position.count / 3).toBe(20);
  });

  it("is a plain box without a show face", () => {
    expect(chamferedBoard([1, 1, 1], 0.01).getAttribute("position").count / 3).toBe(12);
  });

  it("faces every triangle outward", () => {
    const geometry = chamferedBoard([0.4, 0.3, 0.2], 0.01, "+z");
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    for (let i = 0; i < position.count; i += 1) {
      const outward = position.getX(i) * normal.getX(i) + position.getY(i) * normal.getY(i) + position.getZ(i) * normal.getZ(i);
      expect(outward).toBeGreaterThan(0);
    }
  });
});

describe("joinery collector", () => {
  it("draws one mesh per material and keeps each part findable", () => {
    const walnut = new THREE.MeshStandardMaterial();
    const black = new THREE.MeshStandardMaterial();
    const joinery = new Joinery();
    joinery.board("Door front", walnut, [0.5, 0.02, 0.7], [-0.25, 0, 0.35], 0.0015, "-y");
    joinery.board("Door front", walnut, [0.5, 0.02, 0.7], [0.25, 0, 0.35], 0.0015, "-y");
    joinery.board("Gola channel", black, [1, 0.026, 0.057], [0, 0.02, 0.7], 0);
    const group = new THREE.Group();
    group.position.set(10, 0, 1);
    const meshes = joinery.build(group, (item) => item);
    expect(meshes).toHaveLength(2);
    const doors = joineryParts(group, "Door front");
    expect(doors).toHaveLength(2);
    expect(doors[1]!.material).toBe(walnut);
    expect(doors[1]!.box.min.x).toBeCloseTo(10, 6);
    expect(doors[1]!.box.max.z).toBeCloseTo(1.7, 6);
  });

  it("lays grain up a door and along a top", () => {
    const joinery = new Joinery();
    const material = new THREE.MeshStandardMaterial();
    joinery.board("Door front", material, [0.5, 0.02, 0.7], [0, 0, 0.35]);
    const [mesh] = joinery.build(new THREE.Group(), (item) => item);
    const geometry = mesh!.geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < position.count; i += 1) {
      if (normal.getY(i) < -0.5) {
        expect(uv.getX(i)).toBeCloseTo(position.getX(i), 6);
        expect(uv.getY(i)).toBeCloseTo(position.getZ(i), 6);
      }
    }
  });
});

it("hangs a leaf on as many hinges as its height asks for", () => {
  expect([0.7, 1.2, 1.9, 2.3].map(hingeCount)).toEqual([2, 3, 4, 5]);
});
