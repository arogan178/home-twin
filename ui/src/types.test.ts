import { describe, expect, it } from "vitest";

import {
  DesignSchema,
  ElectricLightingAnalysisSchema,
  FixtureSchema,
  FixtureTagSchema,
  PlanDocumentSchema,
  WallSwitchSchema,
} from "./types";

describe("API boundary schemas", () => {
  it("rejects incomplete room designs", () => {
    expect(() => DesignSchema.parse({ revision: "sha256:test" })).toThrow();
  });

  it("constructs fixture tags at the boundary", () => {
    expect(FixtureTagSchema.parse("SP07")).toBe("SP07");
    expect(() => FixtureTagSchema.parse("")).toThrow();
  });

  it("labels candidate analysis as electric only", () => {
    const analysis = ElectricLightingAnalysisSchema.parse({
      validation: { findings: [] },
      dark_zones: [],
      method: "lumen_beam_cone_v1",
      exclusions: ["daylight"],
    });
    expect(analysis.exclusions).toContain("daylight");
  });

  it("accepts the measured photometry labels and rejects an unknown one", () => {
    const analysis = ElectricLightingAnalysisSchema.parse({
      validation: { findings: [] },
      dark_zones: [],
      method: "ies_lm63_point_v1",
      exclusions: ["daylight"],
    });
    expect(analysis.method).toBe("ies_lm63_point_v1");
    expect(analysis.exclusions).not.toContain("ies_photometry");
    expect(() =>
      ElectricLightingAnalysisSchema.parse({
        validation: { findings: [] },
        dark_zones: [],
        method: "radiance_v1",
        exclusions: [],
      }),
    ).toThrow();
  });

  it("accepts the published-candela tier between the cone and the measured labels", () => {
    const analysis = ElectricLightingAnalysisSchema.parse({
      validation: { findings: [] },
      dark_zones: [],
      method: "peak_candela_beam_falloff_v1",
      exclusions: ["daylight", "ies_photometry"],
    });
    expect(analysis.method).toBe("peak_candela_beam_falloff_v1");
    expect(analysis.exclusions).toContain("ies_photometry");
  });

  it("accepts the diffuser tier a credited pendant produces", () => {
    const analysis = ElectricLightingAnalysisSchema.parse({
      validation: { findings: [] },
      dark_zones: [],
      method: "lumen_beam_cone_with_uniform_diffuser_v1",
      exclusions: ["daylight", "ies_photometry"],
    });
    expect(analysis.method).toBe("lumen_beam_cone_with_uniform_diffuser_v1");
  });

  it("keeps each lighting device as a distinct closed type", () => {
    const common = { tag: "PN01", room_id: "R", switching_group: "DINING", notes: [] };
    const pendant = FixtureSchema.parse({
      ...common,
      kind: "pendant_bulb",
      point: { x: 2000, y: 1800, z: 2600 },
      spec: {
        model: null,
        lumens: 800,
        cct_kelvin: 2700,
        cri: 90,
        dimmable: true,
        drop_mm: 650,
        canopy_diameter_mm: 100,
        canopy_depth_mm: 30,
        bulb_diameter_mm: 120,
        ies_path: null,
      },
    });
    const rope = FixtureSchema.parse({
      ...common,
      tag: "RL01",
      kind: "rope_light",
      path: [{ x: 500, y: 500, z: 2600 }, { x: 2500, y: 500, z: 2600 }],
      spec: {
        model: null,
        lumens_per_m: 900,
        cct_kelvin: 3000,
        cri: 90,
        dimmable: true,
        diameter_mm: 16,
        minimum_bend_radius_mm: 60,
        mounting: "concealed",
      },
    });
    const device = WallSwitchSchema.parse({
      ...common,
      tag: "SW01",
      host_wall_id: "W01",
      offset_mm: 900,
      mounting_height_mm: 1100,
      spec: { kind: "dimmer", width_mm: 86, height_mm: 86, depth_mm: 10 },
    });

    expect(pendant.kind).toBe("pendant_bulb");
    expect(rope.kind).toBe("rope_light");
    expect(device.host_wall_id).toBe("W01");
  });
});

describe("the plan document survives a round trip", () => {
  const minimal = {
    schema: "home-twin.m1-plan/v3",
    project_id: "p",
    building_name: "b",
    source: { file_name: "f", sha256: "s", page: 1, locator: "l", method: "m" },
    coordinate_frame: {
      units: "millimetres",
      x_axis: "plan_right",
      y_axis: "plan_up",
      z_axis: "up",
      origin: "o",
      trace_transform: "t",
    },
    evidence: { pdf_trace: { source: "d", status: "traced", uncertainty_mm: 50 } },
    points: {
      a: { x_mm: 0, y_mm: 0, evidence: "pdf_trace" },
      b: { x_mm: 1000, y_mm: 0, evidence: "pdf_trace" },
      c: { x_mm: 1000, y_mm: 1000, evidence: "pdf_trace" },
    },
    controls: [{ id: "w", from_point: "a", to_point: "b", expected_mm: 1000, tolerance_mm: 20 }],
    rooms: [
      {
        id: "r",
        name: "Room",
        point_ids: ["a", "b", "c"],
        floor_elevation_mm: 1050,
        ceiling_height_mm: 2600,
        ceiling_evidence: "pdf_trace",
        geometry_evidence: "pdf_trace",
      },
    ],
    default_wall: { thickness_mm: 150, evidence: "pdf_trace" },
    apertures: [
      {
        id: "d1",
        name: "Door",
        kind: "door",
        host_edge: ["a", "b"],
        width_mm: 900,
        offset_mm: 120,
        sill_height_mm: 0,
        height_mm: 2100,
        room_ids: ["r"],
        exposure: "interior",
        geometry_evidence: "pdf_trace",
        height_evidence: "pdf_trace",
      },
    ],
    stairs: [
      {
        id: "s1",
        name: "Stair",
        point_ids: ["a", "b", "c"],
        kind: "straight_run",
        up_bearing_deg: 0,
        tread_depth_mm: 271,
        riser_height_mm: 175,
        rise_role: "split_level",
        room_ids: ["r"],
        geometry_evidence: "pdf_trace",
        riser_evidence: "pdf_trace",
      },
    ],
  };

  it("keeps the fields the editor does not touch", () => {
    const parsed = PlanDocumentSchema.parse(minimal);

    // These three were absent from this schema once, so every save silently
    // deleted the stairs, flattened the split level, and re-centred every door.
    expect(parsed.stairs).toHaveLength(1);
    expect(parsed.rooms[0]?.floor_elevation_mm).toBe(1050);
    expect(parsed.apertures[0]?.offset_mm).toBe(120);
  });

  it("accepts a wall override that only extends below the room floor", () => {
    const parsed = PlanDocumentSchema.parse({
      ...minimal,
      wall_overrides: [
        {
          point_ids: ["a", "b"],
          base_elevation_mm: 0,
          evidence: "pdf_trace",
          future_field: "preserved",
        },
      ],
    });

    expect(parsed.wall_overrides[0]).toMatchObject({
      base_elevation_mm: 0,
      future_field: "preserved",
    });
  });

  it("keeps fields it has never heard of", () => {
    const fromLaterVersion = {
      ...minimal,
      a_future_block: [{ id: "x" }],
      rooms: [{ ...minimal.rooms[0], a_future_room_field: 7 }],
      apertures: [{ ...minimal.apertures[0], a_future_aperture_field: "keep me" }],
    };

    const parsed = PlanDocumentSchema.parse(fromLaterVersion) as Record<string, unknown>;

    expect(parsed.a_future_block).toEqual([{ id: "x" }]);
    expect((parsed.rooms as Record<string, unknown>[])[0]?.a_future_room_field).toBe(7);
    expect((parsed.apertures as Record<string, unknown>[])[0]?.a_future_aperture_field).toBe("keep me");
  });
});
