import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { MeasureOverlay, measureBetween, measurementLabel } from "./measureTool";

describe("measure tool", () => {
  it("reports the straight distance and its components in millimetres", () => {
    const result = measureBetween(new THREE.Vector3(1, 2, 0), new THREE.Vector3(4, 6, 0));
    expect(result.distanceMm).toBe(5000);
    expect([result.dxMm, result.dyMm, result.dzMm]).toEqual([3000, 4000, 0]);
    expect(result.axis).toBe("free");
    expect(measurementLabel(result)).toBe("5,000 mm");
  });

  it("locks to the dominant axis and moves the end point onto it", () => {
    const result = measureBetween(new THREE.Vector3(0, 0, 0.9), new THREE.Vector3(0.05, 1.1, 0.95), true);
    expect(result.axis).toBe("y");
    expect(result.distanceMm).toBe(1100);
    expect(result.to.toArray()).toEqual([0, 1.1, 0.9]);
  });

  it("draws on its parent and leaves nothing behind", () => {
    // jsdom has no 2D canvas, so the label is skipped and the marks and line remain.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const parent = new THREE.Group();
    const overlay = new MeasureOverlay(parent);
    const from = new THREE.Vector3();
    overlay.show(from, measureBetween(from, new THREE.Vector3(1, 0, 0)));
    expect(parent.children[0]?.children.length).toBe(3);
    overlay.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
