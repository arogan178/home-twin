import { describe, expect, it } from "vitest";

import { roomFloorLayers, unifyStairwellHoles } from "./roomFloorGeometry";

const upper = [
  { x: 0, y: 0 },
  { x: 4000, y: 0 },
  { x: 4000, y: 4000 },
  { x: 0, y: 4000 },
];
const landing = [
  { x: 1000, y: 0 },
  { x: 2200, y: 0 },
  { x: 2200, y: 1400 },
  { x: 1000, y: 1400 },
];

describe("roomFloorLayers", () => {
  it("draws a lower landing beneath the opening in its parent room", () => {
    const layers = roomFloorLayers({
      upperOutline: upper,
      upperElevationMm: 1050,
      lowerLevels: [{ outline: landing, elevationMm: 0 }],
    });

    expect(layers.map((layer) => layer.elevationMm)).toEqual([1050, 0]);
    expect(layers[1]?.outline).toEqual(landing);
  });
});

describe("unifyStairwellHoles", () => {
  it("merges adjacent stair flight and entrance landing into one clean opening snapped to walls", () => {
    const roomPolygon = [
      { x: 20540, y: 350 },
      { x: 22106, y: 350 },
      { x: 22106, y: 5337 },
      { x: 19228, y: 5337 },
      { x: 19228, y: 9739 },
      { x: 20540, y: 9739 },
    ];
    const stairHole = [
      { x: 20856, y: 1716 },
      { x: 22092, y: 1716 },
      { x: 22092, y: 2994 },
      { x: 20856, y: 2994 },
    ];
    const landingHole = [
      { x: 20856, y: 344 },
      { x: 22092, y: 344 },
      { x: 22092, y: 1716 },
      { x: 20856, y: 1716 },
    ];

    const unified = unifyStairwellHoles(roomPolygon, [stairHole, landingHole]);
    expect(unified).toHaveLength(1);
    expect(unified[0]).toEqual([
      { x: 20856, y: 350 },
      { x: 22106, y: 350 },
      { x: 22106, y: 2994 },
      { x: 20856, y: 2994 },
    ]);
  });

  it("leaves empty holes empty", () => {
    expect(unifyStairwellHoles(upper, [])).toEqual([]);
  });
});
