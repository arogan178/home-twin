export const ROUTE = "Pset_HomeTwinHvac.RouteMm";
export const LEGS = "Pset_HomeTwinHvac.Legs";

/** Across-run and vertical millimetres, matching `home_twin.hvac.ENCLOSURE_MM`. */
export const ENCLOSURE_MM: Readonly<Record<string, readonly [number, number]>> = {
  wall_core: [80, 80],
  gypsum_box: [150, 150],
  trunking: [60, 100],
  clipped: [30, 55],
};

/** Each leg's enclosure, or null when absent or inconsistent with the route. */
export function parseLegs(value: unknown, legCount: number): string[] | null {
  if (typeof value !== "string") return null;
  const legs = value.split(";");
  return legs.length === legCount && legs.every((leg) => leg in ENCLOSURE_MM) ? legs : null;
}
