import { describe, expect, it } from "vitest";

import {
  controlGroupFor,
  defaultSpec,
  duplicableTags,
  duplicates,
  movedSpotlights,
  nextInstallationTag,
  renameFixture,
  spotlightsOf,
  withFixturePoints,
  withoutTags,
  withSensorPoints,
  withSpotlights,
} from "./lightingDraft";
import type { Fixture, FixtureTag, RecessedSpotlight, Sensor, WallSwitch } from "./types";

const tag = (value: string) => value as FixtureTag;

function spotlight(name: string, x: number, y: number, extra: Partial<RecessedSpotlight> = {}): RecessedSpotlight {
  return {
    kind: "recessed_spotlight",
    tag: tag(name),
    room_id: "room-a",
    point: { x, y, z: 2700 },
    spec: defaultSpec,
    switching_group: "KITCHEN_MAIN",
    direction: { x: 0, y: 0, z: -1 },
    notes: [],
    ...extra,
  } as RecessedSpotlight;
}

const rope = {
  kind: "rope_light",
  tag: tag("RL01"),
  room_id: "room-a",
  path: [{ x: 0, y: 0, z: 2700 }, { x: 800, y: 0, z: 2700 }],
  switching_group: "COVE",
  notes: [],
} as unknown as Fixture;

const wallSwitch = { tag: "SW01", switching_group: "HALL" } as WallSwitch;

describe("nextInstallationTag", () => {
  it("numbers past the highest tag with the prefix, ignoring case and other prefixes", () => {
    expect(nextInstallationTag([{ tag: "SP01" }, { tag: "sp07" }, { tag: "PN09" }], "SP")).toBe("SP08");
  });

  it("starts at 01 and pads to two digits", () => {
    expect(nextInstallationTag([], "PIR")).toBe("PIR01");
  });
});

describe("controlGroupFor", () => {
  it("prefers the selection's group", () => {
    expect(controlGroupFor({ switching_group: "DESK" }, [spotlight("SP01", 0, 0)], [], "Kitchen")).toBe("DESK");
  });

  it("falls back to the first fixture, then the first switch", () => {
    expect(controlGroupFor(null, [spotlight("SP01", 0, 0)], [wallSwitch], "Kitchen")).toBe("KITCHEN_MAIN");
    expect(controlGroupFor(null, [], [wallSwitch], "Kitchen")).toBe("HALL");
  });

  it("names an empty room's group after the room", () => {
    expect(controlGroupFor(null, [], [], "MasterBedroom 2")).toBe("MASTER_BEDROOM_2_MAIN");
    expect(controlGroupFor(null, [], [], "--")).toBe("ROOM_MAIN");
    expect(controlGroupFor(null, [], [], null)).toBe("ROOM_MAIN");
  });
});

describe("point moves", () => {
  it("moves the named fixtures and leaves rope lights on their path", () => {
    const next = withFixturePoints(
      [spotlight("SP01", 0, 0), spotlight("SP02", 100, 0), rope],
      [{ tag: tag("SP02"), point: { x: 500, y: 600, z: 2700 } }, { tag: tag("RL01"), point: { x: 9, y: 9, z: 9 } }],
    );
    expect(next.map((fixture) => (fixture.kind === "rope_light" ? fixture.path[0] : fixture.point))).toEqual([
      { x: 0, y: 0, z: 2700 },
      { x: 500, y: 600, z: 2700 },
      { x: 0, y: 0, z: 2700 },
    ]);
  });

  it("moves sensors by tag", () => {
    const sensors = [{ tag: "PIR01", point: { x: 1, y: 1, z: 2700 } }, { tag: "PIR02", point: { x: 2, y: 2, z: 2700 } }] as Sensor[];
    expect(withSensorPoints(sensors, [{ tag: "PIR02", point: { x: 7, y: 8, z: 2700 } }]).map((sensor) => sensor.point)).toEqual([
      { x: 1, y: 1, z: 2700 },
      { x: 7, y: 8, z: 2700 },
    ]);
  });
});

describe("selection edits", () => {
  it("removes the selected tags", () => {
    expect(withoutTags([spotlight("SP01", 0, 0), spotlight("SP02", 0, 0)], new Set(["SP01"])).map((item) => item.tag)).toEqual(["SP02"]);
  });

  it("copies placed marks one grid step east and south, with fresh tags and no GlobalId", () => {
    const fixtures = [spotlight("SP01", 1000, 2000, { id: "3x$GlobalId", notes: ["keep off beam"] }), spotlight("SP02", 0, 0), rope];
    const selected = new Set([tag("SP01"), tag("RL01")]);
    expect(duplicableTags(fixtures, selected)).toEqual(["SP01"]);
    const copies = duplicates(fixtures, [{ tag: "SP03" } as WallSwitch], selected, 250, []);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ tag: "SP04", point: { x: 1250, y: 1750, z: 2700 }, notes: [] });
    expect(copies[0]).not.toHaveProperty("id");
  });

  it("gives a copy a tag no other room uses", () => {
    // The demo's living room holds SP03-SP05 and the snug SP06-SP07.
    const living = [spotlight("SP03", 0, 0), spotlight("SP04", 0, 0), spotlight("SP05", 0, 0)];
    const snug = [{ tag: "SP06" }, { tag: "SP07" }, { tag: "SW03" }];
    const copies = duplicates(living, [], new Set([tag("SP03")]), 250, snug);
    expect(copies.map((copy) => copy.tag)).toEqual(["SP08"]);
  });

  it("renames a fixture unless the label is empty, unchanged, or taken", () => {
    const fixtures = [spotlight("SP01", 0, 0), spotlight("SP02", 0, 0)];
    const renamed = renameFixture(fixtures, [wallSwitch], tag("SP01"), "  ISLAND1 ");
    expect(renamed.kind).toBe("renamed");
    if (renamed.kind === "renamed") {
      expect(renamed.tag).toBe("ISLAND1");
      expect(renamed.fixtures.map((fixture) => fixture.tag)).toEqual(["ISLAND1", "SP02"]);
    }
    expect(renameFixture(fixtures, [], tag("SP01"), "   ")).toEqual({ kind: "rejected", message: "A light label cannot be empty." });
    expect(renameFixture(fixtures, [], tag("SP01"), "SP01")).toEqual({ kind: "unchanged" });
    expect(renameFixture(fixtures, [wallSwitch], tag("SP01"), "SW01")).toEqual({ kind: "rejected", message: "SW01 is already in use." });
  });
});

describe("spotlight layouts", () => {
  it("replaces only the spotlights, keeping other fixtures first", () => {
    const next = withSpotlights([spotlight("SP01", 0, 0), rope], [spotlight("SP09", 5, 5)]);
    expect(next.map((fixture) => fixture.tag)).toEqual(["RL01", "SP09"]);
    expect(spotlightsOf(next).map((fixture) => fixture.tag)).toEqual(["SP09"]);
  });

  it("counts a spotlight as moved when it is new or shifted in plan, not in height", () => {
    const before = [spotlight("SP01", 0, 0), spotlight("SP02", 100, 0)];
    const after = [spotlight("SP01", 0, 0, { point: { x: 0, y: 0, z: 2500 } }), spotlight("SP02", 100, 50), spotlight("SP03", 0, 0)];
    expect(movedSpotlights(before, after).map((fixture) => fixture.tag)).toEqual(["SP02", "SP03"]);
  });
});
