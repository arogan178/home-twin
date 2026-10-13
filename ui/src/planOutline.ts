/** Drawing a turned object in plan.
 *
 * A bearing is measured counter-clockwise from building +X, but plan screen y
 * runs downward, so the same rotation is drawn clockwise. An SVG rect starts
 * with its long axis pointing down the screen, which is building -Y.
 */
export function planOutlineAngle(bearingDeg: number): number {
  return -(bearingDeg + 90);
}

/** Where the long axis points on screen once the outline is drawn. */
export function planLongAxis(bearingDeg: number): readonly [number, number] {
  const radians = (planOutlineAngle(bearingDeg) * Math.PI) / 180;
  return [-Math.sin(radians), Math.cos(radians)];
}
