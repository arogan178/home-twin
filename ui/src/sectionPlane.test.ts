import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { keptBySection, sectionPlane, sectionRange } from "./sectionPlane";

const bounds = { minX: 2, maxX: 8, minY: -1, maxY: 3, minZ: 0, maxZ: 2.6 };

describe("section plane", () => {
  it("keeps what is below a horizontal cut, or above it when flipped", () => {
    const plane = sectionPlane({ mode: "height", atM: 1.2, flip: false });
    expect(keptBySection(plane, new THREE.Vector3(0, 0, 0.5))).toBe(true);
    expect(keptBySection(plane, new THREE.Vector3(0, 0, 2))).toBe(false);
    const flipped = sectionPlane({ mode: "height", atM: 1.2, flip: true });
    expect(keptBySection(flipped, new THREE.Vector3(0, 0, 0.5))).toBe(false);
    expect(keptBySection(flipped, new THREE.Vector3(0, 0, 2))).toBe(true);
  });

  it("keeps the east and north side of a vertical cut", () => {
    const x = sectionPlane({ mode: "x", atM: 5, flip: false });
    expect(keptBySection(x, new THREE.Vector3(6, 0, 0))).toBe(true);
    expect(keptBySection(x, new THREE.Vector3(4, 0, 0))).toBe(false);
    const y = sectionPlane({ mode: "y", atM: 1, flip: true });
    expect(keptBySection(y, new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(keptBySection(y, new THREE.Vector3(0, 2, 0))).toBe(false);
  });

  it("keeps everything when off", () => {
    expect(sectionPlane({ mode: "off", atM: 0, flip: false })).toBeNull();
    expect(keptBySection(null, new THREE.Vector3(99, 99, 99))).toBe(true);
  });

  it("slides across the view and starts at a plan cut or the middle", () => {
    expect(sectionRange("height", bounds)).toEqual({ min: 0, max: 2.6, initial: 1.2 });
    expect(sectionRange("x", bounds)).toEqual({ min: 2, max: 8, initial: 5 });
    expect(sectionRange("y", bounds)).toEqual({ min: -1, max: 3, initial: 1 });
  });
});
