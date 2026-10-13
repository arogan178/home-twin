import { describe, expect, it } from "vitest";

import { EYE_HEIGHT_M, eyeLevelFrame, fitDistance, openestDirection, planViewFrame } from "./cameraPresets";

const room = { minX: 0, maxX: 8, minY: 0, maxY: 4 };

describe("camera presets", () => {
  it("fits the wider side of an extent inside the field of view", () => {
    // A 90 degree square view sees a half-width equal to its distance.
    expect(fitDistance({ minX: -2, maxX: 2, minY: -1, maxY: 1 }, 90, 1, 1)).toBeCloseTo(2);
    // A narrower canvas has to stand further back to fit the wide side.
    expect(fitDistance(room, 45, 1)).toBeGreaterThan(fitDistance(room, 45, 2));
  });

  it("looks straight down over the middle with plan +Y up the screen", () => {
    const frame = planViewFrame(room, 1, 3.4, 45, 1.6);
    expect(frame.target).toEqual({ x: 4, y: 2, z: 1 });
    expect(frame.position.x).toBe(4);
    expect(frame.position.z).toBeGreaterThan(3.9);
    // A small lean south, so the view direction carries a +Y component.
    expect(frame.position.y).toBeLessThan(2);
    expect(2 - frame.position.y).toBeLessThan(0.02);
  });

  it("stands at eye height facing the given direction", () => {
    const frame = eyeLevelFrame({ x: 2, y: 2 }, { x: 0, y: 3 }, 0.5);
    expect(frame.position).toEqual({ x: 2, y: 2, z: 0.5 + EYE_HEIGHT_M });
    expect(frame.target.x).toBeCloseTo(2);
    expect(frame.target.y).toBeCloseTo(3.5);
    expect(frame.target.z).toBeLessThan(frame.position.z);
  });

  it("faces the longest clear run inside the outline", () => {
    const outline = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 4 },
      { x: 0, y: 4 },
    ];
    const west = openestDirection({ x: 6, y: 2 }, outline);
    // From near the east wall the long run is west, along the room's axis or
    // on one of the diagonals into its far corners.
    expect(west.x).toBeLessThan(-0.9);
    // An L-shaped room: from the corner, the long leg wins over the short one.
    const ell = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 5 },
      { x: 0, y: 5 },
    ];
    const along = openestDirection({ x: 1, y: 1 }, ell);
    expect(along.x).toBeGreaterThan(0.9);
  });
});
