import { describe, expect, it } from "vitest";

import { MINIMUM_DIM_LEVEL, electricOutputShare, lightGroups, outputFraction, withDimLevel } from "./dimming";
import type { Fixture, WallSwitch } from "./types";

const spot = (tag: string, group: string, dimmable: boolean): Fixture => ({
  kind: "recessed_spotlight",
  tag: tag as Fixture["tag"],
  room_id: "room" as Fixture["room_id"],
  point: { x: 0, y: 0, z: 2400 },
  spec: {
    model: null,
    lumens: 575,
    beam_angle_deg: 60,
    cct_kelvin: 3000,
    cri: 90,
    dimmable,
    diameter_mm: 90,
    cutout_diameter_mm: 80,
    mounting_depth_mm: 60,
    ies_path: null,
    peak_candela: 700,
  },
  switching_group: group,
  direction: { x: 0, y: 0, z: -1 },
  notes: [],
});

const plate = (tag: string, group: string, kind: "toggle" | "dimmer"): WallSwitch => ({
  tag,
  room_id: "room" as WallSwitch["room_id"],
  host_wall_id: "wall",
  offset_mm: 100,
  mounting_height_mm: 1100,
  switching_group: group,
  mounting_face: "room",
  spec: { kind, width_mm: 86, height_mm: 86, depth_mm: 10 },
  notes: [],
});

describe("dimming preview", () => {
  it("scales a dimmable group and leaves a fixed-output fitting at full", () => {
    const levels = new Map([["LOUNGE", 0.3]]);
    expect(outputFraction(levels, "LOUNGE", true)).toBe(0.3);
    expect(outputFraction(levels, "LOUNGE", false)).toBe(1);
    expect(outputFraction(levels, "KITCHEN", true)).toBe(1);
  });

  it("never dims below the preview floor and forgets a group back at full", () => {
    let levels = withDimLevel(new Map(), "LOUNGE", 0);
    expect(outputFraction(levels, "LOUNGE", true)).toBe(MINIMUM_DIM_LEVEL);
    levels = withDimLevel(levels, "LOUNGE", 1);
    expect(levels.has("LOUNGE")).toBe(false);
  });

  it("weighs the output that is on by rated lumens, after switching and dimming", () => {
    const fixtures = [spot("L1", "LOUNGE", true), spot("L2", "LOUNGE", true), spot("I1", "ISLAND", false)];
    expect(electricOutputShare(fixtures, new Set(), new Map())).toBe(1);
    expect(electricOutputShare(fixtures, new Set(["LOUNGE"]), new Map())).toBeCloseTo(1 / 3);
    expect(electricOutputShare(fixtures, new Set(["LOUNGE", "ISLAND"]), new Map())).toBe(0);
    // A fixed-output fitting ignores the preview level; the dimmable pair drops to half.
    expect(electricOutputShare(fixtures, new Set(), new Map([["LOUNGE", 0.5], ["ISLAND", 0.5]]))).toBeCloseTo(2 / 3);
    expect(electricOutputShare([], new Set(), new Map())).toBe(1);
  });

  it("summarises each lit group with its switches and dimmable share", () => {
    const groups = lightGroups(
      [spot("I1", "ISLAND", false), spot("I2", "ISLAND", false), spot("L1", "LOUNGE", true)],
      [plate("SW01", "LOUNGE", "dimmer"), plate("SW02", "ISLAND", "toggle"), plate("SW03", "EMPTY", "toggle")],
    );
    expect(groups).toEqual([
      { group: "ISLAND", fixtures: 2, dimmableFixtures: 0, switchTags: ["SW02"], hasDimmer: false },
      { group: "LOUNGE", fixtures: 1, dimmableFixtures: 1, switchTags: ["SW01"], hasDimmer: true },
    ]);
  });
});
