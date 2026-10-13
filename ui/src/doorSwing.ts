type PlanVector = { readonly x: number; readonly y: number };

/** Signed hinge direction for a door's room-relative swing. */
export function doorSwingSign(
  swing: "inward" | "outward" | null | undefined,
  wallDirection: PlanVector,
  inwardNormal: PlanVector,
): number {
  if (swing === undefined || swing === null) return 1;
  const leftNormal = { x: -wallDirection.y, y: wallDirection.x };
  const desired = swing === "outward"
    ? { x: -inwardNormal.x, y: -inwardNormal.y }
    : inwardNormal;
  return leftNormal.x * desired.x + leftNormal.y * desired.y >= 0 ? 1 : -1;
}
