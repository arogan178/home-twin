import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_MESSAGE, demoFile, demoRequestUrl } from "./demo";
import type { Fixture, RoomId } from "./types";

// The same vectors are asserted against scripts/record_demo.py in tests/test_demo_recording.py.
describe("demoFile", () => {
  it("maps a plain read to a JSON file under api/", () => {
    expect(demoFile("/api/project")).toBe("api/project.json");
  });

  it("escapes a GlobalId and keeps the query in the path", () => {
    expect(demoFile("/api/rooms/1iK%24u5yiLN%249MWFffEjU2s/daylight?at=2026-06-21T09%3A00%3A00&plane=floor")).toBe(
      "api/rooms/1iK~24u5yiLN~249MWFffEjU2s/daylight/at~3d2026-06-21T09~3a00~3a00~26plane~3dfloor.json",
    );
  });

  it("takes another suffix for a binary recording", () => {
    expect(demoFile("/api/trace/underlay/file", ".png")).toBe("api/trace/underlay/file.png");
  });
});

describe("demoRequestUrl", () => {
  it("resolves a read below the Pages base", () => {
    expect(demoRequestUrl("/api/site", undefined, "/home-twin/demo/")).toBe("/home-twin/demo/api/site.json");
    expect(demoRequestUrl("/api/site", { method: "get" }, "/")).toBe("/api/site.json");
  });

  it.each(["POST", "DELETE", "PUT"])("refuses a %s", (method) => {
    expect(() => demoRequestUrl("/api/rooms/a/commit", { method }, "/")).toThrow(DEMO_MESSAGE);
  });
});

describe("api in demo mode", () => {
  const roomId = "room-a" as RoomId;
  const savedDesign = {
    revision: "sha256:test",
    room: {
      id: roomId,
      name: "Room A",
      storey_id: "storey",
      elevation_mm: 0,
      bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 3000, y: 3000, z: 2700 } },
    },
    ceiling: {
      room_id: roomId,
      polygon: { outer: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }], holes: [] },
      elevation_mm: 2700,
      source: "test",
    },
    walls: [],
    openings: [],
    daylight_sources: [],
    furniture: [],
    obstructions: [],
    fixtures: [],
    analysis: {
      validation: { findings: [] },
      dark_zones: [],
      illuminance: null,
      method: "lumen_beam_cone_v1",
      exclusions: ["daylight"],
    },
    constraints: {
      wall_clearance_mm: 600,
      minimum_spacing_mm: 900,
      obstruction_clearance_mm: 150,
      shadow_gap_clearance_mm: 200,
      alignment_tolerance_mm: 30,
      collision_tolerance_mm: 2,
      target_lux: 180,
      task_plane_height_mm: 800,
      utilization_factor: 0.55,
      grid_step_mm: 500,
      avoid_object_kinds: [],
    },
  };
  const fetchMock = vi.fn((url: string) => {
    const body = url.endsWith("/design.json") ? savedDesign : { analysis: savedDesign.analysis };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("MODE", "demo");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses every write without a request", async () => {
    const { api } = await import("./api");
    await expect(api.commit(roomId, [], "sha256:test" as never)).rejects.toThrow(DEMO_MESSAGE);
    await expect(api.exports(roomId)).rejects.toThrow(DEMO_MESSAGE);
    await expect(api.buildTrace(null)).rejects.toThrow(DEMO_MESSAGE);
    await expect(api.optimise(roomId, {} as never)).rejects.toThrow(DEMO_MESSAGE);
    await api.discardUnderlay();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a recording in place of the server", async () => {
    const { api } = await import("./api");
    await api.design(roomId);
    expect(fetchMock).toHaveBeenCalledWith("/api/rooms/room-a/design.json", undefined);
  });

  it("replays the analysis only for the saved layout", async () => {
    const { api } = await import("./api");
    await expect(api.analyse(roomId, [])).resolves.toEqual({ analysis: savedDesign.analysis });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/rooms/room-a/analysis.json", undefined);

    const edited = {
      kind: "recessed_spotlight",
      tag: "SP01",
      point: { x: 1500, y: 1500, z: 2700 },
      spec: {},
      switching_group: "MAIN",
      direction: { x: 0, y: 0, z: -1 },
      notes: [],
    } as unknown as Fixture;
    fetchMock.mockClear();
    await expect(api.analyse(roomId, [edited])).rejects.toThrow(DEMO_MESSAGE);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/rooms/room-a/design.json"]);
  });
});
