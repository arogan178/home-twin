import { describe, expect, it } from "vitest";

import {
  cornerPointIds,
  nearestRoomOutline,
  soffitHost,
  withAperture,
  withControl,
  withMovedWall,
  withNudgedAperture,
  withRoom,
  withUnderlayCalibration,
  withoutPoint,
  withoutRoom,
  withSchema,
} from "./traceDocument";
import { PlanDocumentSchema, type PlanAperture, type PlanDocument } from "./types";

const traced = { source: "drawing", status: "traced", uncertainty_mm: 50 };
const handPlaced = {
  source: "owner_review_required",
  status: "assumed",
  uncertainty_mm: 75,
  note: "Placed by hand over the reference drawing, not traced from vectors.",
};

function plan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return PlanDocumentSchema.parse({
    schema: "home-twin.plan/v3",
    project_id: "test-plan",
    building_name: "Test flat",
    source: { file_name: "plan.pdf", sha256: "sha256:0", page: 1, locator: "Ground", method: "vector trace" },
    coordinate_frame: {
      units: "millimetres",
      x_axis: "plan_right",
      y_axis: "plan_up",
      z_axis: "up",
      origin: "paper origin",
      trace_transform: "identity",
    },
    evidence: { pdf_trace: traced },
    points: {
      a: { x_mm: 0, y_mm: 0, evidence: "pdf_trace" },
      b: { x_mm: 4000, y_mm: 0, evidence: "pdf_trace" },
      c: { x_mm: 4000, y_mm: 3000, evidence: "pdf_trace" },
      d: { x_mm: 0, y_mm: 3000, evidence: "pdf_trace" },
    },
    controls: [],
    rooms: [
      {
        id: "living",
        name: "Living",
        point_ids: ["a", "b", "c", "d"],
        ceiling_height_mm: 2600,
        ceiling_evidence: "pdf_trace",
        geometry_evidence: "pdf_trace",
      },
    ],
    default_wall: { thickness_mm: 150, evidence: "pdf_trace" },
    wall_overrides: [],
    apertures: [],
    daylight_sources: [],
    review_notes: [],
    ...overrides,
  });
}

const window1200: PlanAperture = {
  id: "aperture_1",
  name: "Opening 3",
  kind: "window",
  host_edge: ["a", "b"],
  width_mm: 1200,
  sill_height_mm: 900,
  height_mm: 1200,
  room_ids: ["living", "hall"],
  exposure: "exterior",
  geometry_evidence: "pdf_trace",
  height_evidence: "pdf_trace",
  glazing_fraction: 0.8,
};

describe("trace document edits", () => {
  it("adds a room on the commonest floor with hand-placed evidence", () => {
    const base = plan();
    const next = withRoom(base, "room_1", ["a", "b", "c"]);
    expect(next.evidence).toEqual({ pdf_trace: traced, hand_placed: handPlaced });
    expect(next.rooms[1]).toEqual({
      id: "room_1",
      name: "Room 2",
      point_ids: ["a", "b", "c"],
      floor_elevation_mm: 0,
      ceiling_height_mm: 2600,
      ceiling_evidence: "pdf_trace",
      geometry_evidence: "hand_placed",
    });
  });

  it("numbers a new opening after the highest used and sizes it to the wall", () => {
    const next = withAperture(plan({ apertures: [window1200] }), "aperture_2", "living", ["b", "c"]);
    expect(next.apertures[1]).toEqual({
      id: "aperture_2",
      name: "Opening 4",
      kind: "window",
      host_edge: ["b", "c"],
      width_mm: 1200,
      sill_height_mm: 900,
      height_mm: 1200,
      room_ids: ["living"],
      exposure: "exterior",
      geometry_evidence: "hand_placed",
      height_evidence: "opening_height_assumption",
      glazing_fraction: 0.8,
    });
    expect(Object.keys(next.evidence)).toEqual(["pdf_trace", "opening_height_assumption", "hand_placed"]);
  });

  it("keeps a shared opening with the remaining room when a room is deleted", () => {
    const own = { ...window1200, id: "aperture_2", room_ids: ["living"] };
    const next = withoutRoom(plan({ apertures: [window1200, own] }), "living");
    expect(next.rooms).toEqual([]);
    expect(next.apertures).toEqual([{ ...window1200, room_ids: ["hall"] }]);
  });

  it("slides an opening along its wall and ignores an arrow square to it", () => {
    const base = plan({ apertures: [window1200] });
    const moved = withNudgedAperture(base, "aperture_1", { x: 1, y: 0 }, 10);
    expect(moved.apertures[0]?.offset_mm).toBe(1410);
    expect(withNudgedAperture(base, "aperture_1", { x: 0, y: 1 }, 10)).toBe(base);
  });

  it("seeds a control with the traced length", () => {
    expect(withControl(plan(), "control_1", ["a", "b"]).controls).toEqual([
      { id: "control_1", from_point: "a", to_point: "b", expected_mm: 4000, tolerance_mm: 20 },
    ]);
  });

  it("returns the same document when a wall move changes nothing", () => {
    const base = plan();
    expect(withMovedWall(base, "a", "b", { x_mm: 0, y_mm: 0 }, { x_mm: 4000, y_mm: 0 })).toBe(base);
    expect(withMovedWall(base, "a", "b", { x_mm: 0, y_mm: 100 }, { x_mm: 4000, y_mm: 100 }).points).toEqual({
      ...base.points,
      a: { x_mm: 0, y_mm: 100, evidence: "pdf_trace" },
      b: { x_mm: 4000, y_mm: 100, evidence: "pdf_trace" },
    });
  });

  it("reuses an existing point at a rectangle corner and allocates the rest", () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
    ];
    expect(cornerPointIds(plan(), corners)).toEqual({
      ids: ["a", "p1", "p2"],
      created: {
        p1: { x_mm: 1000, y_mm: 0, evidence: "hand_placed" },
        p2: { x_mm: 1000, y_mm: 1000, evidence: "hand_placed" },
      },
    });
  });

  it("finds the room a soffit hangs in from where it was drawn", () => {
    const inside = plan({
      points: {
        ...plan().points,
        s1: { x_mm: 500, y_mm: 500, evidence: "hand_placed" },
        s2: { x_mm: 1500, y_mm: 500, evidence: "hand_placed" },
        s3: { x_mm: 1500, y_mm: 1500, evidence: "hand_placed" },
        o1: { x_mm: 5000, y_mm: 500, evidence: "hand_placed" },
        o2: { x_mm: 6000, y_mm: 500, evidence: "hand_placed" },
        o3: { x_mm: 6000, y_mm: 1500, evidence: "hand_placed" },
      },
    });
    expect(soffitHost(inside, ["s1", "s2", "s3"])?.id).toBe("living");
    expect(soffitHost(inside, ["o1", "o2", "o3"])).toBeUndefined();
  });

  it("measures the nearest room outline", () => {
    expect(nearestRoomOutline(plan(), { x: 2000, y: -50 }, null)).toEqual({ roomId: "living", distanceMm: 50 });
    expect(nearestRoomOutline(plan(), { x: 2000, y: -50 }, "other")).toEqual({
      roomId: null,
      distanceMm: Number.POSITIVE_INFINITY,
    });
  });

  it("deletes a point and leaves calibration alone without an underlay", () => {
    const base = plan();
    expect(Object.keys(withoutPoint(base, "d").points)).toEqual(["a", "b", "c"]);
    expect(withUnderlayCalibration(base, { mm_per_px: 2, rotation_deg: 0 }, 1000)).toBe(base);
  });
});

describe("withSchema", () => {
  it("keeps either v3 id and upgrades a v2 source to the current one", () => {
    expect(withSchema(plan()).schema).toBe("home-twin.plan/v3");
    expect(withSchema(plan({ schema: "home-twin.m1-plan/v3" })).schema).toBe("home-twin.m1-plan/v3");
    expect(withSchema(plan({ schema: "home-twin.m1-plan/v2" })).schema).toBe("home-twin.plan/v3");
  });
});
