import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createArchitecturalMaterials, periodicNoise, ringCoverage, softExtrudeGeometry, stonePixel } from "./architecturalMaterials";

describe("procedural textures", () => {
  it("repeats noise across its period so a tile has no seam", () => {
    expect(periodicNoise(1.5, 2.25, 4)).toBeCloseTo(0.7368, 4);
    expect(periodicNoise(5.5, 6.25, 4)).toBeCloseTo(0.7368, 4);
  });

  it("clouds the stone toward grey where its noise sits mid-range", () => {
    expect(stonePixel(0, 0, 256)).toEqual([240, 239, 236]);
    expect(stonePixel(100, 40, 256)).toEqual([229, 228, 226]);
    expect(stonePixel(256, 0, 256)).toEqual(stonePixel(0, 0, 256));
  });

  it("prints a hob ring on its radius and nowhere else", () => {
    expect(ringCoverage(123, 64, 128, 60, 2)).toBe(1);
    expect(ringCoverage(125, 64, 128, 60, 2)).toBe(0);
    expect(ringCoverage(64, 64, 128, 60, 2)).toBe(0);
  });

  it("samples every texture through mipmaps", () => {
    const finishes = createArchitecturalMaterials();
    try {
      const textures = finishes.resources.filter((resource): resource is THREE.Texture => resource instanceof THREE.Texture);
      expect(textures.filter((texture) => texture.minFilter !== THREE.LinearMipmapLinearFilter)).toEqual([]);
      expect(textures).toHaveLength(12);
    } finally {
      for (const resource of finishes.resources) resource.dispose();
    }
  });
});

describe("softExtrudeGeometry", () => {
  it("rounds the arris without growing the slab", () => {
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 0.5), new THREE.Vector2(0, 0.5)]);
    const geometry = softExtrudeGeometry(shape, 0.04, 0.005);
    try {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      expect([box.min.x, box.min.y, box.min.z].map((value) => +value.toFixed(6))).toEqual([0, 0, 0]);
      expect([box.max.x, box.max.y, box.max.z].map((value) => +value.toFixed(6))).toEqual([1, 0.5, 0.04]);
      const position = geometry.getAttribute("position");
      const topX = Array.from({ length: position.count }, (_, index) => index)
        .filter((index) => Math.abs(position.getZ(index) - 0.04) < 1e-9)
        .map((index) => position.getX(index));
      expect(+Math.max(...topX).toFixed(6)).toBe(0.995);
    } finally {
      geometry.dispose();
    }
  });
});
