export type SkirtingVoid = { readonly fromM: number; readonly toM: number; readonly sillM: number };
export type SkirtingRun = { readonly fromM: number; readonly toM: number };

/**
 * The lengths of a wall that carry skirting, given the openings in it.
 *
 * A door reaches the floor and breaks the run; a window sills above the
 * skirting and the run passes behind it untouched.
 */
export function skirtingRuns(
  lengthM: number,
  heightM: number,
  voids: ReadonlyArray<SkirtingVoid>,
): ReadonlyArray<SkirtingRun> {
  const breaks = voids
    .filter((toVoid) => toVoid.sillM < heightM)
    .map((toVoid) => ({
      fromM: Math.max(0, Math.min(toVoid.fromM, toVoid.toM)),
      toM: Math.min(lengthM, Math.max(toVoid.fromM, toVoid.toM)),
    }))
    .filter((gap) => gap.toM > gap.fromM)
    .sort((first, second) => first.fromM - second.fromM);

  const runs: SkirtingRun[] = [];
  let cursor = 0;
  for (const gap of breaks) {
    if (gap.fromM > cursor) runs.push({ fromM: cursor, toM: gap.fromM });
    cursor = Math.max(cursor, gap.toM);
  }
  if (cursor < lengthM) runs.push({ fromM: cursor, toM: lengthM });
  return runs.filter((run) => run.toM - run.fromM > 0.01);
}
