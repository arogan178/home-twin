/** Pure plan geometry behind the tracing gestures: preview, ortho lock, typed lengths, rectangles and wall drags. */

import type { Vec2 } from "./plan";

export type SnapKind = "point" | "line" | "grid";

/** Where a click at the cursor would land, and what it snapped to. */
export type DrawPreview = {
  readonly point: Vec2;
  readonly snap: SnapKind;
  readonly pointId: string | null;
};

export const roundTenthMm = (value: number) => Math.round(value * 10) / 10 || 0;

/** The cursor projected onto plan X or Y through `fromMm`, whichever it is nearer. */
export function orthoLock(fromMm: Vec2, towardMm: Vec2): Vec2 {
  return Math.abs(towardMm.x - fromMm.x) >= Math.abs(towardMm.y - fromMm.y)
    ? { x: towardMm.x, y: fromMm.y }
    : { x: fromMm.x, y: towardMm.y };
}

/**
 * The ortho-locked landing point: a traced point lying exactly on the locked
 * axis wins when within reach, otherwise the free coordinate snaps to the grid.
 */
export function snapOnAxis(
  fromMm: Vec2,
  rawMm: Vec2,
  points: ReadonlyArray<{ readonly id: string; readonly at: Vec2 }>,
  pointRadiusMm: number,
  gridMm: number,
): DrawPreview {
  const locked = orthoLock(fromMm, rawMm);
  const alongX = locked.y === fromMm.y;
  let best: DrawPreview | null = null;
  let bestDistance = pointRadiusMm;
  for (const candidate of points) {
    const onAxis = alongX
      ? Math.abs(candidate.at.y - fromMm.y) <= 0.5
      : Math.abs(candidate.at.x - fromMm.x) <= 0.5;
    const distance = Math.hypot(candidate.at.x - locked.x, candidate.at.y - locked.y);
    if (onAxis && distance <= bestDistance) {
      bestDistance = distance;
      best = { point: candidate.at, snap: "point", pointId: candidate.id };
    }
  }
  if (best !== null) return best;
  const point = alongX
    ? { x: Math.round(locked.x / gridMm) * gridMm, y: fromMm.y }
    : { x: fromMm.x, y: Math.round(locked.y / gridMm) * gridMm };
  return { point, snap: "grid", pointId: null };
}

/** The point `lengthMm` from `fromMm` toward `towardMm`, to 0.1 mm; null without a direction. */
export function pointAtLength(fromMm: Vec2, towardMm: Vec2, lengthMm: number): Vec2 | null {
  const dx = towardMm.x - fromMm.x;
  const dy = towardMm.y - fromMm.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return null;
  return { x: roundTenthMm(fromMm.x + (dx / distance) * lengthMm), y: roundTenthMm(fromMm.y + (dy / distance) * lengthMm) };
}

/** The axis-aligned rectangle spanned by two opposite corners, anticlockwise from its minimum corner. */
export function rectangleCorners(aMm: Vec2, bMm: Vec2): Vec2[] | null {
  if (aMm.x === bMm.x || aMm.y === bMm.y) return null;
  const minX = Math.min(aMm.x, bMm.x);
  const maxX = Math.max(aMm.x, bMm.x);
  const minY = Math.min(aMm.y, bMm.y);
  const maxY = Math.max(aMm.y, bMm.y);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

/**
 * How far to move both ends of a wall so it stays parallel: the drag's
 * component perpendicular to the wall, landing on a parallel traced wall line
 * within `lineSnapMm`, otherwise on the grid. Segments touching either end of
 * the wall move with it, so they are not snap targets.
 */
export function wallOffset(
  startMm: Vec2,
  endMm: Vec2,
  grabMm: Vec2,
  cursorMm: Vec2,
  lines: ReadonlyArray<readonly [Vec2, Vec2]>,
  gridMm: number,
  lineSnapMm: number,
): { readonly offsetMm: Vec2; readonly snap: "line" | "grid" } | null {
  const dx = endMm.x - startMm.x;
  const dy = endMm.y - startMm.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const normal = { x: -dy / length, y: dx / length };
  const dragged = (cursorMm.x - grabMm.x) * normal.x + (cursorMm.y - grabMm.y) * normal.y;
  const base = startMm.x * normal.x + startMm.y * normal.y;
  const touches = (point: Vec2) =>
    (point.x === startMm.x && point.y === startMm.y) || (point.x === endMm.x && point.y === endMm.y);

  let offset: number | null = null;
  let bestGap = lineSnapMm;
  for (const [a, b] of lines) {
    if (touches(a) || touches(b)) continue;
    const lx = b.x - a.x;
    const ly = b.y - a.y;
    const lineLength = Math.hypot(lx, ly);
    if (lineLength === 0 || Math.abs(lx * dy - ly * dx) / (lineLength * length) > 0.001) continue;
    const candidate = a.x * normal.x + a.y * normal.y - base;
    const gap = Math.abs(candidate - dragged);
    if (gap <= bestGap) {
      bestGap = gap;
      offset = candidate;
    }
  }
  const snap = offset === null ? "grid" : "line";
  if (offset === null) {
    // An axis wall lands on a grid line; an oblique one moves in whole grid steps.
    const axisAligned = Math.abs(normal.x) < 1e-9 || Math.abs(normal.y) < 1e-9;
    offset = axisAligned
      ? Math.round((base + dragged) / gridMm) * gridMm - base
      : Math.round(dragged / gridMm) * gridMm;
  }
  return { offsetMm: { x: normal.x * offset || 0, y: normal.y * offset || 0 }, snap };
}

const SNAP_LABEL: Record<SnapKind, string> = { point: "point", line: "traced wall", grid: "grid" };

/** The drawing readout, word for word what the canvas shows, for the accessibility tree. */
export function describePreview({
  fromMm,
  preview,
  closing,
  locked,
  rectangle,
}: {
  readonly fromMm: Vec2 | null;
  readonly preview: { readonly point: Vec2; readonly snap: SnapKind | null; readonly pointId: string | null };
  readonly closing: boolean;
  readonly locked: boolean;
  readonly rectangle: ReadonlyArray<Vec2> | null;
}): string {
  if (rectangle !== null) {
    const [min, , max] = rectangle;
    if (min === undefined || max === undefined) return "";
    return `Rectangle ${roundTenthMm(max.x - min.x)} × ${roundTenthMm(max.y - min.y)} mm`;
  }
  const { point, snap, pointId } = preview;
  const parts: string[] = [];
  if (fromMm !== null) parts.push(`Length ${roundTenthMm(Math.hypot(point.x - fromMm.x, point.y - fromMm.y))} mm`);
  if (locked) parts.push(point.y === fromMm?.y ? "locked to plan X" : "locked to plan Y");
  if (snap !== null) {
    const target = pointId === null ? SNAP_LABEL[snap] : `point ${pointId}`;
    parts.push(`snaps to ${target} at x ${roundTenthMm(point.x)}, y ${roundTenthMm(point.y)} mm`);
  }
  if (closing) parts.push("click to close");
  return parts.join(" · ");
}
