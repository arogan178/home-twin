import { describe, expect, it } from "vitest";

import { stairwellsThrough, visualDaylight } from "./WholePlanModel";
import { buildStairFlightParts } from "./stairGeometry";
import { wallSolidRectangles } from "./wallGeometry";
import type { WholePlan } from "./types";

function planWithStair(baseElevationMm: number): WholePlan {
  const footprint = { outer: [
    { x: 20856, y: 1716 },
    { x: 22092, y: 1716 },
    { x: 22092, y: 2994 },
    { x: 20856, y: 2994 },
  ], holes: [] };
  return {
    revision: "sha256:test",
    site: null,
    constraints: {} as WholePlan["constraints"],
    rooms: [
      {
        room: { id: "landing", name: "Landing", storey_id: "s", elevation_mm: 0, bounds: {} as never, is_external: false },
        ceiling: { room_id: "landing", polygon: footprint, elevation_mm: 3650, source: "ifc_space" },
        walls: [],
        openings: [],
        daylight_sources: [],
        stairs: [
          {
            id: "entrance_stair",
            name: "Entrance stair",
            room_ids: ["landing"],
            footprint,
            base_elevation_mm: baseElevationMm,
            rise_mm: 875,
            tread_depth_mm: 271,
            tread_count: 5,
            riser_count: 6,
            riser_height_mm: 175,
            up_bearing_deg: 0,
            kind: "straight_run",
            evidence: "drawing_registration",
          } as never,
        ],
        furniture: [],
        obstructions: [],
        fixtures: [],
      } as never,
    ],
  } as never;
}

describe("stairwellsThrough", () => {
  it("opens the floor a flight arrives at", () => {
    expect(stairwellsThrough(planWithStair(0), 1050)).toHaveLength(1);
  });

  it("leaves a floor the flight starts from intact", () => {
    expect(stairwellsThrough(planWithStair(0), 0)).toHaveLength(0);
  });
});

describe("visualDaylight", () => {
  it("moves continuously from night through noon and back to night", () => {
    expect(visualDaylight(0).daylight).toBeCloseTo(0.035);
    expect(visualDaylight(0).sunStrength).toBe(0);
    expect(visualDaylight(6).daylight).toBeLessThan(visualDaylight(12).daylight);
    expect(visualDaylight(12).sunAltitude).toBeGreaterThan(visualDaylight(8).sunAltitude);
    expect(visualDaylight(24).daylight).toBeCloseTo(visualDaylight(0).daylight);
    expect(visualDaylight(12).sunStrength).toBeGreaterThan(0);
  });
});

describe("buildStairFlightParts", () => {
  it("joins five drawn treads to the upper landing with a sixth riser", () => {
    const stair = planWithStair(0).rooms[0]?.stairs[0];
    expect(stair).toBeDefined();
    if (stair === undefined) return;

    const parts = buildStairFlightParts({ ...stair, rise_mm: 1050 });

    expect(parts.treads).toHaveLength(5);
    expect(parts.treads.at(-1)?.topElevationM).toBeCloseTo(0.875);
    expect(parts.landingRiser).not.toBeNull();
    expect(parts.landingRiser?.topElevationM).toBeCloseTo(1.05);
    expect(
      (parts.landingRiser?.centreYM ?? 0) + (parts.landingRiser?.goingDepthM ?? 0) / 2,
    ).toBeCloseTo(2.994);
  });
});

describe("wallSolidRectangles", () => {
  it("does not put wall back over a door with a transom above it", () => {
    const solids = wallSolidRectangles(1.236, 3.65, [
      { fromM: 0.118, toM: 1.118, sillM: 0, headM: 2.1 },
      { fromM: 0.118, toM: 1.118, sillM: 2.1, headM: 3.1 },
    ]);

    const acrossDoor = solids.filter((solid) => solid.fromM < 0.6 && solid.toM > 0.6);
    expect(acrossDoor).toEqual([{ fromM: 0.118, toM: 1.118, bottomM: 3.1, topM: 3.65 }]);
  });
});
