import { describe, expect, it } from "vitest";

import { stairBand } from "./stairGeometry";
import type { Stair } from "./types";

const FLIGHT = {
  id: "S1",
  name: "flight",
  kind: "STRAIGHT",
  footprint: {
    outer: [
      { x: 20856, y: 1716 },
      { x: 22092, y: 1716 },
      { x: 22092, y: 2994 },
      { x: 20856, y: 2994 },
    ],
  },
  bounds: { minimum: { x: 20856, y: 1716, z: 0 }, maximum: { x: 22092, y: 2994, z: 1050 } },
  base_elevation_mm: 0,
  rise_mm: 1050,
  tread_depth_mm: 255.6,
  riser_height_mm: 175,
  tread_count: 5,
  riser_count: 6,
  up_bearing_deg: 0,
  room_ids: [],
  evidence: "test",
  skirting: "crema_di_roccia",
  skirting_height_mm: 80,
  skirting_thickness_mm: 20,
} as unknown as Stair;

// The panelled wall the flight climbs against, and the far wall of the room.
const NEAR_WALL = { start: { x: 22106, y: 344 }, end: { x: 22106, y: 5337 } };
const FAR_WALL = { start: { x: 16967, y: 344 }, end: { x: 16967, y: 5337 } };

describe("stairBand", () => {
  it("is one raking run at the flight's own pitch, not a set of steps", () => {
    const band = stairBand(FLIGHT, [NEAR_WALL, FAR_WALL]);
    expect(band).not.toBeNull();
    // 1050 rise over a 1278 going.
    expect(band!.pitchRad).toBeCloseTo(Math.atan2(1.05, 1.278), 6);
    expect(band!.lengthM).toBeCloseTo(Math.hypot(1.278, 1.05), 6);
    expect(band!.heightM).toBeCloseTo(0.08, 6);
    expect(band!.thicknessM).toBeCloseTo(0.02, 6);
  });

  it("puts the band against the wall, not on the open edge", () => {
    expect(stairBand(FLIGHT, [NEAR_WALL, FAR_WALL])!.centreXM).toBeGreaterThan(22.0);
  });

  it("covers the stepped panel bottoms it is there to hide", () => {
    const band = stairBand(FLIGHT, [NEAR_WALL, FAR_WALL])!;
    const lowestTop = band.centreZM - (band.lengthM / 2) * Math.sin(band.pitchRad) + band.heightM / 2;
    // The first tread's panel starts 20 mm above its nosing at 175.
    expect(lowestTop).toBeGreaterThan(0.175 + 0.02);
  });

  it("draws nothing when the flight states no band", () => {
    const bare = { ...FLIGHT, skirting: null, skirting_height_mm: null, skirting_thickness_mm: null } as Stair;
    expect(stairBand(bare, [NEAR_WALL])).toBeNull();
  });
});
