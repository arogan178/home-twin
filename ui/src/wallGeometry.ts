export type WallVoid = {
  readonly fromM: number;
  readonly toM: number;
  readonly sillM: number;
  readonly headM: number;
};

export type WallSolidRectangle = {
  readonly fromM: number;
  readonly toM: number;
  readonly bottomM: number;
  readonly topM: number;
};

function uniqueSorted(values: ReadonlyArray<number>): number[] {
  return [...new Set(values)].sort((first, second) => first - second);
}

/** Subtract rectangular aperture voids from a wall elevation. */
export function wallSolidRectangles(
  lengthM: number,
  heightM: number,
  voids: ReadonlyArray<WallVoid>,
): WallSolidRectangle[] {
  const clipped = voids
    .map((item) => ({
      fromM: Math.max(0, Math.min(item.fromM, item.toM, lengthM)),
      toM: Math.max(0, Math.min(Math.max(item.fromM, item.toM), lengthM)),
      sillM: Math.max(0, Math.min(item.sillM, item.headM, heightM)),
      headM: Math.max(0, Math.min(Math.max(item.sillM, item.headM), heightM)),
    }))
    .filter((item) => item.toM - item.fromM > 0.001 && item.headM - item.sillM > 0.001);
  const horizontalCuts = uniqueSorted([0, lengthM, ...clipped.flatMap((item) => [item.fromM, item.toM])]);
  const solids: WallSolidRectangle[] = [];

  for (let index = 0; index < horizontalCuts.length - 1; index += 1) {
    const fromM = horizontalCuts[index];
    const toM = horizontalCuts[index + 1];
    if (fromM === undefined || toM === undefined || toM - fromM <= 0.001) continue;
    const middleM = (fromM + toM) / 2;
    const verticalVoids = clipped
      .filter((item) => item.fromM < middleM && item.toM > middleM)
      .map((item) => [item.sillM, item.headM] as const)
      .sort((first, second) => first[0] - second[0]);
    let cursorM = 0;
    for (const [sillM, headM] of verticalVoids) {
      if (sillM > cursorM + 0.001) solids.push({ fromM, toM, bottomM: cursorM, topM: sillM });
      cursorM = Math.max(cursorM, headM);
    }
    if (cursorM < heightM - 0.001) solids.push({ fromM, toM, bottomM: cursorM, topM: heightM });
  }
  return solids;
}
