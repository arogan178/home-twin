import type { Point } from "./types";

type Mark<Tag extends string> = { readonly tag: Tag; readonly point: Point };

/** One snap step east and one south, so a copy never hides under its original. */
export function duplicateOffsetMm(snapMm: number): { x: number; y: number } {
  const stepMm = snapMm > 0 ? snapMm : 100;
  return { x: stepMm, y: -stepMm };
}

export function snapToGridMm(point: { x: number; y: number }, snapMm: number): { x: number; y: number } {
  const stepMm = Math.max(snapMm, 1);
  return { x: Math.round(point.x / stepMm) * stepMm, y: Math.round(point.y / stepMm) * stepMm };
}

/**
 * Equal plan spacing between the two marks furthest apart, which stay put.
 *
 * The rest keep their order along that line (projection, then tag), the same
 * ordering the MCP `distribute_fixtures` tool uses, so nothing crosses over.
 * No snap is applied: equal spacing wins over the grid. Each keeps its own Z.
 */
export function distributeEvenly<Tag extends string>(
  marks: ReadonlyArray<Mark<Tag>>,
): ReadonlyArray<Mark<Tag>> {
  if (marks.length < 3) return marks;
  let first = marks[0]!;
  let last = marks[1]!;
  let widestMm = -1;
  for (let i = 0; i < marks.length; i += 1) {
    for (let j = i + 1; j < marks.length; j += 1) {
      const a = marks[i]!.point;
      const b = marks[j]!.point;
      const spanMm = Math.hypot(b.x - a.x, b.y - a.y);
      if (spanMm > widestMm) {
        widestMm = spanMm;
        first = marks[i]!;
        last = marks[j]!;
      }
    }
  }
  const dx = last.point.x - first.point.x;
  const dy = last.point.y - first.point.y;
  const along = (mark: Mark<Tag>) => (mark.point.x - first.point.x) * dx + (mark.point.y - first.point.y) * dy;
  const between = marks
    .filter((mark) => mark !== first && mark !== last)
    .sort((a, b) => along(a) - along(b) || a.tag.localeCompare(b.tag));
  const ordered = [first, ...between, last];
  const intervals = ordered.length - 1;
  return ordered.map((mark, index) => ({
    tag: mark.tag,
    point: {
      x: first.point.x + (dx * index) / intervals,
      y: first.point.y + (dy * index) / intervals,
      z: mark.point.z,
    },
  }));
}
