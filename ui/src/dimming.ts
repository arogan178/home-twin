/**
 * A display-only dimming preview, per switching group.
 *
 * The level scales a fitting's rated output in the 3D views and nothing else:
 * the coverage surface, the lux figures and every check stay at full output.
 * It is not a dimmer curve either. An LED's perceived brightness and its colour
 * on a real dimmer depend on the driver, which is what the one-lamp test on
 * the intended dimmer is for. A fitting whose spec says it cannot dim stays at
 * full output, as it would on site.
 */

import type { Fixture, WallSwitch } from "./types";

/** Output fraction per switching group; a group not listed is at full output. */
export type DimLevels = ReadonlyMap<string, number>;

export const DIMMING_METHOD =
  "Preview only: scales rated output in the 3D view. Coverage, lux and checks stay at full output.";

/** The lowest preview level, so a dimmed group never reads as switched off. */
export const MINIMUM_DIM_LEVEL = 0.05;

export function outputFraction(levels: DimLevels, group: string, dimmable: boolean): number {
  if (!dimmable) return 1;
  const level = levels.get(group);
  if (level === undefined || !Number.isFinite(level)) return 1;
  return Math.min(1, Math.max(MINIMUM_DIM_LEVEL, level));
}

export function withDimLevel(levels: DimLevels, group: string, level: number): DimLevels {
  const next = new Map(levels);
  if (level >= 1) next.delete(group);
  else next.set(group, Math.max(MINIMUM_DIM_LEVEL, level));
  return next;
}

function ratedLumens(fixture: Fixture): number {
  if (fixture.kind !== "rope_light") return fixture.spec.lumens ?? 0;
  const lengthM = fixture.path.slice(1).reduce((total, point, index) => {
    const previous = fixture.path[index]!;
    return total + Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) / 1000;
  }, 0);
  return (fixture.spec.lumens_per_m ?? 0) * lengthM;
}

/**
 * The share of the rated electric output that is on, after switching and the
 * preview level. Room interreflection is proportional to the flux put into the
 * room, so the views scale their bounce by it; a layout with no rated output
 * reads as fully on rather than dark.
 */
export function electricOutputShare(
  fixtures: ReadonlyArray<Fixture>,
  offGroups: ReadonlySet<string>,
  levels: DimLevels,
): number {
  let rated = 0;
  let on = 0;
  for (const fixture of fixtures) {
    const lumens = ratedLumens(fixture);
    rated += lumens;
    if (offGroups.has(fixture.switching_group)) continue;
    on += lumens * outputFraction(levels, fixture.switching_group, fixture.spec.dimmable);
  }
  return rated > 0 ? on / rated : 1;
}

export type LightGroupSummary = {
  readonly group: string;
  readonly fixtures: number;
  readonly dimmableFixtures: number;
  readonly switchTags: readonly string[];
  /** True when a switch on the group is stated as a dimmer. */
  readonly hasDimmer: boolean;
};

export function lightGroups(
  fixtures: ReadonlyArray<Fixture>,
  switches: ReadonlyArray<WallSwitch>,
): LightGroupSummary[] {
  const groups = new Map<string, { fixtures: number; dimmable: number; switches: string[]; dimmer: boolean }>();
  const entry = (group: string) => {
    let found = groups.get(group);
    if (found === undefined) {
      found = { fixtures: 0, dimmable: 0, switches: [], dimmer: false };
      groups.set(group, found);
    }
    return found;
  };
  for (const fixture of fixtures) {
    const found = entry(fixture.switching_group);
    found.fixtures += 1;
    if (fixture.spec.dimmable) found.dimmable += 1;
  }
  for (const device of switches) {
    const found = entry(device.switching_group);
    found.switches.push(device.tag);
    if (device.spec.kind === "dimmer") found.dimmer = true;
  }
  return [...groups.entries()]
    .filter(([, value]) => value.fixtures > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, value]) => ({
      group,
      fixtures: value.fixtures,
      dimmableFixtures: value.dimmable,
      switchTags: value.switches,
      hasDimmer: value.dimmer,
    }));
}
