/**
 * Pure edits on a room's lighting draft: the fixtures, wall switches and
 * sensors not yet saved to IFC. Each returns the next value and leaves undo,
 * room drafts and analysis to the caller.
 */

import { duplicateOffsetMm } from "./fixtureArrangement";
import { availableInteriorPoint, deepestInteriorPoint, placedFixtures, pointInPolygon, type Vec2 } from "./plan";
import { findWallSwitchSeat } from "./switchGeometry";
import {
  FixtureTagSchema,
  type Design,
  type Fixture,
  type FixtureTag,
  type Point,
  type RecessedSpotlight,
  type Sensor,
  type SensorSpec,
  type SpotlightSpec,
  type WallSwitch,
} from "./types";

export const defaultSensorSpec: SensorSpec = {
  kind: "movement",
  diameter_mm: 70,
  cutout_diameter_mm: 60,
  mounting_depth_mm: 25,
  detection_diameter_mm: null,
};

export const defaultSpec: SpotlightSpec = {
  model: null,
  lumens: 650,
  beam_angle_deg: 36,
  cct_kelvin: 3000,
  cri: 90,
  dimmable: true,
  diameter_mm: 90,
  cutout_diameter_mm: 80,
  mounting_depth_mm: 95,
  ies_path: null,
  peak_candela: null,
  ip_rating: null,
};

export const defaultPendantSpec = {
  model: null,
  lumens: 800,
  cct_kelvin: 2700,
  cri: 90,
  dimmable: true,
  drop_mm: 600,
  canopy_diameter_mm: 100,
  canopy_depth_mm: 30,
  bulb_diameter_mm: 120,
  ies_path: null,
} as const;

export const defaultRopeSpec = {
  model: null,
  lumens_per_m: 900,
  cct_kelvin: 3000,
  cri: 90,
  dimmable: true,
  diameter_mm: 16,
  minimum_bend_radius_mm: 60,
  mounting: "ceiling" as const,
};

export type PointMove<Tag extends string> = { readonly tag: Tag; readonly point: Point };

/** Devices in every other room. A Tag is unique across the home, not the room. */
export type OtherRoomTags = ReadonlyArray<{ readonly tag: string }>;

export function nextInstallationTag(fixtures: ReadonlyArray<{ readonly tag: string }>, prefix: string): FixtureTag {
  let highest = 0;
  for (const fixture of fixtures) {
    const match = new RegExp(`^${prefix}(\\d+)$`, "i").exec(fixture.tag);
    const number = match?.[1];
    if (number !== undefined) highest = Math.max(highest, Number(number));
  }
  return FixtureTagSchema.parse(`${prefix}${String(highest + 1).padStart(2, "0")}`);
}

/** The group a new device joins: the selection's, else the room's first, else one named for the room. */
export function controlGroupFor(
  selected: { readonly switching_group: string } | null,
  fixtures: ReadonlyArray<Fixture>,
  switches: ReadonlyArray<WallSwitch>,
  roomName: string | null,
): string {
  const existing = selected?.switching_group ?? fixtures[0]?.switching_group ?? switches[0]?.switching_group;
  if (existing !== undefined) return existing;
  if (roomName === null) return "ROOM_MAIN";
  const roomLabel = roomName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${roomLabel || "ROOM"}_MAIN`;
}

export function fixtureAnchors(fixtures: ReadonlyArray<Fixture>): Array<{ x: number; y: number }> {
  return fixtures.map((fixture) => (fixture.kind === "rope_light" ? fixture.path[0]! : fixture.point));
}

export function insideCeiling(design: Design, at: Vec2): boolean {
  const { outer, holes } = design.ceiling.polygon;
  return pointInPolygon(at, outer) && !holes.some((hole) => pointInPolygon(at, hole));
}

export function newSpotlight(
  design: Design,
  fixtures: ReadonlyArray<Fixture>,
  at: Vec2 | undefined,
  spec: SpotlightSpec,
  switchingGroup: string,
  otherRooms: OtherRoomTags,
): Fixture {
  // A concave room's bounding-box centre can sit outside the ceiling, so the
  // new mark goes to the point furthest from every edge instead.
  const seat = at ?? availableInteriorPoint(
    design.ceiling.polygon.outer,
    fixtureAnchors(fixtures),
    design.constraints.minimum_spacing_mm,
    Math.max(design.constraints.wall_clearance_mm, defaultSpec.diameter_mm / 2),
  );
  return {
    kind: "recessed_spotlight",
    tag: nextInstallationTag([...otherRooms, ...fixtures], "SP"),
    room_id: design.room.id,
    point: { x: seat.x, y: seat.y, z: design.ceiling.elevation_mm },
    spec,
    switching_group: switchingGroup,
    direction: { x: 0, y: 0, z: -1 },
    notes: [],
  };
}

export function newPendant(
  design: Design,
  fixtures: ReadonlyArray<Fixture>,
  at: Vec2 | undefined,
  switchingGroup: string,
  otherRooms: OtherRoomTags,
): Fixture {
  const seat = at ?? availableInteriorPoint(
    design.ceiling.polygon.outer,
    fixtureAnchors(fixtures),
    450,
    defaultPendantSpec.bulb_diameter_mm / 2,
  );
  return {
    kind: "pendant_bulb",
    tag: nextInstallationTag([...otherRooms, ...fixtures], "PN"),
    room_id: design.room.id,
    point: { x: seat.x, y: seat.y, z: design.ceiling.elevation_mm },
    spec: defaultPendantSpec,
    switching_group: switchingGroup,
    notes: [],
  };
}

export function newRopeLight(
  design: Design,
  fixtures: ReadonlyArray<Fixture>,
  switchingGroup: string,
  otherRooms: OtherRoomTags,
): Fixture {
  const seat = availableInteriorPoint(design.ceiling.polygon.outer, fixtureAnchors(fixtures), 600, 450);
  const ring = design.ceiling.polygon.outer;
  const horizontal = [{ x: seat.x - 400, y: seat.y }, { x: seat.x + 400, y: seat.y }];
  const vertical = [{ x: seat.x, y: seat.y - 400 }, { x: seat.x, y: seat.y + 400 }];
  const path2d = horizontal.every((point) => pointInPolygon(point, ring)) ? horizontal : vertical;
  return {
    kind: "rope_light",
    tag: nextInstallationTag([...otherRooms, ...fixtures], "RL"),
    room_id: design.room.id,
    path: path2d.map((point) => ({ ...point, z: design.ceiling.elevation_mm })),
    spec: defaultRopeSpec,
    switching_group: switchingGroup,
    notes: [],
  };
}

/** A toggle on the first wall segment wide enough for its plate, or null when none is. */
export function newWallSwitch(
  design: Design,
  fixtures: ReadonlyArray<Fixture>,
  switches: ReadonlyArray<WallSwitch>,
  switchingGroup: string,
  otherRooms: OtherRoomTags,
): WallSwitch | null {
  const seat = deepestInteriorPoint(design.ceiling.polygon.outer);
  const placement = findWallSwitchSeat(design.walls, design.openings, seat, 86);
  if (placement === null) return null;
  return {
    tag: nextInstallationTag([...otherRooms, ...fixtures, ...switches], "SW"),
    room_id: design.room.id,
    host_wall_id: placement.host_wall_id,
    offset_mm: placement.offset_mm,
    mounting_height_mm: 1100,
    switching_group: switchingGroup,
    mounting_face: "room",
    spec: { kind: "toggle", width_mm: 86, height_mm: 86, depth_mm: 10 },
    notes: [],
  };
}

/** A movement sensor at the next free ceiling seat. */
export function newSensor(
  design: Design,
  fixtures: ReadonlyArray<Fixture>,
  sensors: ReadonlyArray<Sensor>,
  otherRooms: OtherRoomTags,
  switchingGroup: string,
): Sensor {
  const seat = availableInteriorPoint(
    design.ceiling.polygon.outer,
    fixtureAnchors(fixtures),
    design.constraints.minimum_spacing_mm,
    Math.max(design.constraints.wall_clearance_mm, defaultSensorSpec.diameter_mm / 2),
  );
  // A new sensor switches the group being worked on, which is what a PIR in a
  // room of lights does. A fan carries no group, so those are set by hand.
  return {
    tag: nextInstallationTag([...otherRooms, ...fixtures, ...sensors], "PIR"),
    room_id: design.room.id,
    point: { x: seat.x, y: seat.y, z: design.ceiling.elevation_mm },
    run_on_minutes: sensors.at(-1)?.run_on_minutes ?? 20,
    switching_group: switchingGroup,
    controls_tag: null,
    spec: defaultSensorSpec,
    notes: [],
    kind: "movement_sensor",
  };
}

/** Rope lights follow a path, not a point, so a point move leaves them where they are. */
export function withFixturePoints(fixtures: ReadonlyArray<Fixture>, moves: ReadonlyArray<PointMove<FixtureTag>>): Fixture[] {
  const points = new Map(moves.map((move) => [move.tag, move.point]));
  return fixtures.map((fixture) => {
    const point = points.get(fixture.tag);
    return point === undefined || fixture.kind === "rope_light" ? fixture : { ...fixture, point };
  });
}

export function withSensorPoints(sensors: ReadonlyArray<Sensor>, moves: ReadonlyArray<PointMove<string>>): Sensor[] {
  const points = new Map(moves.map((move) => [move.tag, move.point]));
  return sensors.map((sensor) => {
    const point = points.get(sensor.tag);
    return point === undefined ? sensor : { ...sensor, point };
  });
}

export function withoutTags<Item extends { readonly tag: string }>(
  items: ReadonlyArray<Item>,
  tags: ReadonlySet<string>,
): Item[] {
  return items.filter((item) => !tags.has(item.tag));
}

/** The selected marks that can be copied: rope lights are drawn, not duplicated. */
export function duplicableTags(fixtures: ReadonlyArray<Fixture>, selected: ReadonlySet<FixtureTag>): ReadonlyArray<FixtureTag> {
  return placedFixtures(fixtures)
    .filter((fixture) => selected.has(fixture.tag))
    .map((fixture) => fixture.tag);
}

/** Copies of the selected marks, one grid step away, with fresh tags and no IFC identity. */
export function duplicates(
  fixtures: ReadonlyArray<Fixture>,
  switches: ReadonlyArray<WallSwitch>,
  selected: ReadonlySet<FixtureTag>,
  snapMm: number,
  otherRooms: OtherRoomTags,
): Fixture[] {
  const originals = placedFixtures(fixtures).filter((fixture) => selected.has(fixture.tag));
  const offset = duplicateOffsetMm(snapMm);
  const copies: Fixture[] = [];
  for (const original of originals) {
    const { id: _globalId, ...rest } = original;
    const tag = nextInstallationTag(
      [...otherRooms, ...fixtures, ...switches, ...copies],
      original.kind === "recessed_spotlight" ? "SP" : "PN",
    );
    const point = { x: original.point.x + offset.x, y: original.point.y + offset.y, z: original.point.z };
    copies.push({ ...rest, tag, point, notes: [] });
  }
  return copies;
}

export function selectedSpotlights(fixtures: ReadonlyArray<Fixture>, selected: ReadonlySet<FixtureTag>): RecessedSpotlight[] {
  return fixtures.filter(
    (fixture): fixture is RecessedSpotlight => fixture.kind === "recessed_spotlight" && selected.has(fixture.tag),
  );
}

export function spotlightsOf(fixtures: ReadonlyArray<Fixture>): RecessedSpotlight[] {
  return fixtures.filter((fixture): fixture is RecessedSpotlight => fixture.kind === "recessed_spotlight");
}

/** Every other fixture kept, every spotlight replaced by `spotlights`. */
export function withSpotlights(fixtures: ReadonlyArray<Fixture>, spotlights: ReadonlyArray<Fixture>): Fixture[] {
  return [...fixtures.filter((fixture) => fixture.kind !== "recessed_spotlight"), ...spotlights];
}

/** The spotlights in `after` that are new or sit somewhere else in plan than in `before`. */
export function movedSpotlights(
  before: ReadonlyArray<RecessedSpotlight>,
  after: ReadonlyArray<RecessedSpotlight>,
): RecessedSpotlight[] {
  const points = new Map(before.map((fixture) => [fixture.tag, fixture.point]));
  return after.filter((fixture) => {
    const original = points.get(fixture.tag);
    return original === undefined || original.x !== fixture.point.x || original.y !== fixture.point.y;
  });
}

export type RenameResult =
  | { readonly kind: "renamed"; readonly fixtures: Fixture[]; readonly tag: FixtureTag }
  | { readonly kind: "unchanged" }
  | { readonly kind: "rejected"; readonly message: string };

/** Relabels one fixture; a label must be non-empty and unused by any fixture or switch in the room. */
export function renameFixture(
  fixtures: ReadonlyArray<Fixture>,
  switches: ReadonlyArray<WallSwitch>,
  from: FixtureTag,
  nextValue: string,
): RenameResult {
  const parsed = FixtureTagSchema.safeParse(nextValue.trim());
  if (!parsed.success) return { kind: "rejected", message: "A light label cannot be empty." };
  const nextTag = parsed.data;
  if (nextTag === from) return { kind: "unchanged" };
  if ([...fixtures, ...switches].some((item) => item.tag === nextTag)) {
    return { kind: "rejected", message: `${nextTag} is already in use.` };
  }
  return {
    kind: "renamed",
    tag: nextTag,
    fixtures: fixtures.map((fixture) => (fixture.tag === from ? { ...fixture, tag: nextTag } : fixture)),
  };
}
