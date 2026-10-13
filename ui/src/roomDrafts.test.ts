import { describe, expect, it } from "vitest";

import { mergeRoomDrafts, tagsOutsideRoom } from "./roomDrafts";
import { WholePlanSchema, type Fixture, type RoomId } from "./types";

function spotlight(tag: string, roomId: RoomId): Fixture {
  return {
    kind: "recessed_spotlight",
    tag: tag as Fixture["tag"],
    room_id: roomId,
    point: { x: 1000, y: 1000, z: 2600 },
    direction: { x: 0, y: 0, z: -1 },
    switching_group: "MAIN",
    notes: [],
    spec: {
      model: null,
      lumens: 650,
      beam_angle_deg: 36,
      cct_kelvin: 3000,
      cri: 90,
      dimmable: true,
      diameter_mm: 82,
      cutout_diameter_mm: 68,
      mounting_depth_mm: 95,
      ies_path: null,
      peak_candela: null,
    },
  };
}

describe("whole-plan room drafts", () => {
  it("overlays dirty lighting from several rooms without mutating the saved snapshot", () => {
    const roomShape = (id: string) => ({
      room: {
        id,
        name: id,
        storey_id: "S",
        elevation_mm: 0,
        bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 3000, y: 3000, z: 2600 } },
        is_external: false,
      },
      ceiling: {
        room_id: id,
        polygon: { outer: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }], holes: [] },
        elevation_mm: 2600,
        source: "test",
      },
      walls: [],
      openings: [],
      daylight_sources: [],
      stairs: [],
      soffits: [],
      furniture: [],
      obstructions: [],
      fixtures: [],
      switches: [],
    });
    const plan = WholePlanSchema.parse({
      revision: "sha256:test",
      site: {
        id: "SITE",
        name: "Site",
        latitude_deg: null,
        longitude_deg: null,
        elevation_mm: 0,
        true_north_deg: 0,
        timezone: null,
        evidence: "test",
      },
      constraints: {
        wall_clearance_mm: 400,
        minimum_spacing_mm: 700,
        obstruction_clearance_mm: 100,
        shadow_gap_clearance_mm: 150,
        alignment_tolerance_mm: 20,
        collision_tolerance_mm: 5,
        target_lux: 200,
        task_plane_height_mm: 800,
        utilization_factor: 0.6,
        grid_step_mm: 500,
        avoid_object_kinds: [],
      },
      rooms: [roomShape("A"), roomShape("B")],
    });

    const merged = mergeRoomDrafts(plan, {
      A: { fixtures: [spotlight("SP01", "A" as RoomId)], switches: [] },
      B: { fixtures: [spotlight("SP02", "B" as RoomId)], switches: [] },
    });

    expect(merged.rooms.map((room) => room.fixtures.map((fixture) => fixture.tag))).toEqual([
      ["SP01"],
      ["SP02"],
    ]);
    expect(plan.rooms.every((room) => room.fixtures.length === 0)).toBe(true);

    const drafts = { B: { fixtures: [spotlight("SP06", "B" as RoomId)], switches: [] } };
    expect(tagsOutsideRoom(plan, drafts, "A" as RoomId).map((item) => item.tag)).toEqual(["SP06"]);
    expect(tagsOutsideRoom(plan, drafts, "B" as RoomId)).toEqual([]);
  });
});
