/**
 * Which plan labels to draw, and where, so that none of them overlap.
 *
 * Every coordinate is in drawn plan units: millimetres, with y pointing down
 * the screen as the SVG draws it. A label's size is estimated on screen from
 * its length and font size, then converted back with the current zoom.
 */

import type { Vec2 } from "./plan";

export type Box = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

/** Screen size of every plan label, in CSS pixels. */
export const LABEL_PX = 11;

// IBM Plex Mono advances 0.6 em per glyph; the padding keeps neighbours apart.
const ADVANCE_EM = 0.6;
const PADDING_PX = 6;
const LINE_EM = 1.25;

export type LabelPlacement =
  /** Centred on a point, and only if it fits wholly inside `within`. */
  | { readonly kind: "inside"; readonly at: Vec2; readonly within: Box }
  /** Centred on a point, turned to run along a wall. */
  | { readonly kind: "at"; readonly at: Vec2; readonly angleDeg?: number }
  /** Next to a mark: right, left, below, then above, clear of `clearMm`. */
  | { readonly kind: "beside"; readonly at: Vec2; readonly clearMm: number }
  /** Just outside a box: its sides, then its corners, then the same further out. */
  | { readonly kind: "around"; readonly box: Box; readonly gapMm: number };

export type LabelOption = {
  readonly text: string;
  readonly fontPx: number;
  readonly placement: LabelPlacement;
  /** Where a leader line from the label points, when the label is offset. */
  readonly leader?: Vec2;
  /** Boxes this label and its leader keep clear of, besides the shared ones. */
  readonly avoid?: ReadonlyArray<Box>;
  /** How many barriers the leader may cross; one, its own wall, unless relaxed. */
  readonly leaderCrossings?: number;
  /** Clear space the label keeps from every other box, beyond touching. */
  readonly spacingMm?: number;
};

/** Options are tried in order; the first that fits is drawn. */
export type LabelRequest = { readonly key: string; readonly options: ReadonlyArray<LabelOption> };

export type PlacedLabel = {
  readonly key: string;
  readonly text: string;
  readonly fontPx: number;
  readonly x: number;
  readonly y: number;
  readonly angleDeg: number;
  readonly box: Box;
  readonly leader?: Vec2;
};

export function labelSizeMm(text: string, fontPx: number, mmPerPx: number): { width: number; height: number } {
  return {
    width: (text.length * ADVANCE_EM * fontPx + PADDING_PX) * mmPerPx,
    height: fontPx * LINE_EM * mmPerPx,
  };
}

function boxAround(at: Vec2, width: number, height: number, angleDeg = 0): Box {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const halfX = (width * cos + height * sin) / 2;
  const halfY = (width * sin + height * cos) / 2;
  return { minX: at.x - halfX, minY: at.y - halfY, maxX: at.x + halfX, maxY: at.y + halfY };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function contains(outer: Box, inner: Box): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const;

function positions(option: LabelOption, width: number, height: number): ReadonlyArray<{ at: Vec2; angleDeg: number }> {
  const { placement } = option;
  if (placement.kind === "beside") {
    // The four sides first, then the corners, then the same again further out.
    const { at, clearMm } = placement;
    return [1, 2].flatMap((ring) =>
      DIRECTIONS.map(([dx, dy]) => ({
        at: { x: at.x + dx * (clearMm * ring + width / 2), y: at.y + dy * (clearMm * ring + height / 2) },
        angleDeg: 0,
      })),
    );
  }
  if (placement.kind === "around") {
    const { box, gapMm } = placement;
    const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    const halfX = (box.maxX - box.minX) / 2;
    const halfY = (box.maxY - box.minY) / 2;
    return [1, 3, 6, 10, 15].flatMap((ring) =>
      DIRECTIONS.map(([dx, dy]) => ({
        at: {
          x: centre.x + dx * (halfX + gapMm * ring + width / 2),
          y: centre.y + dy * (halfY + gapMm * ring + height / 2),
        },
        angleDeg: 0,
      })),
    );
  }
  return [{ at: placement.at, angleDeg: placement.kind === "at" ? (placement.angleDeg ?? 0) : 0 }];
}

/**
 * Where a label may run along a route: beside its longest legs that are long
 * enough to carry it, on either side, turned to read along the leg.
 */
export function routeLabelOptions(
  route: ReadonlyArray<Vec2>,
  text: string,
  fontPx: number,
  mmPerPx: number,
  offsetMm: number,
): LabelOption[] {
  const { width } = labelSizeMm(text, fontPx, mmPerPx);
  const legs = route.slice(1).map((end, index) => [route[index]!, end] as const);
  return legs
    .map(([a, b]) => ({ a, b, length: Math.hypot(b.x - a.x, b.y - a.y) }))
    .filter((leg) => leg.length > width)
    .sort((p, q) => q.length - p.length)
    .flatMap(({ a, b, length }) => {
      let angleDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      if (angleDeg > 90 || angleDeg < -90) angleDeg += 180;
      const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return [1, -1].map((side) => ({
        text,
        fontPx,
        placement: {
          kind: "at" as const,
          at: { x: middle.x + side * normal.x * offsetMm, y: middle.y + side * normal.y * offsetMm },
          angleDeg,
        },
      }));
    });
}

/** The point of a box nearest to `point`, where a leader line meets the label. */
export function nearestOnBox(box: Box, point: Vec2): Vec2 {
  return {
    x: Math.min(Math.max(point.x, box.minX), box.maxX),
    y: Math.min(Math.max(point.y, box.minY), box.maxY),
  };
}

export type Segment = readonly [Vec2, Vec2];

function segmentHitsBox([a, b]: Segment, box: Box): boolean {
  // Liang-Barsky clipping: the segment touches the box if any part survives.
  let low = 0;
  let high = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}

function segmentsCross([a, b]: Segment, [c, d]: Segment): boolean {
  const turn = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
}

/**
 * Place labels greedily in request order, so earlier requests win.
 *
 * A label is dropped rather than drawn over another label, over anything in
 * `occupied` such as the marks themselves, across a line in `barriers` such as
 * a wall, or outside `bounds`. A leader line may not cross another label, an
 * occupied box, another leader, or more than one barrier: the wall of its own room.
 */
export function placeLabels(
  requests: ReadonlyArray<LabelRequest>,
  mmPerPx: number,
  occupied: ReadonlyArray<Box> = [],
  bounds: Box | null = null,
  barriers: ReadonlyArray<Segment> = [],
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const taken = [...occupied];
  const leaders: Segment[] = [];
  for (const request of requests) {
    let chosen: PlacedLabel | null = null;
    let chosenLeader: Segment | null = null;
    for (const option of request.options) {
      const { width, height } = labelSizeMm(option.text, option.fontPx, mmPerPx);
      for (const { at, angleDeg } of positions(option, width, height)) {
        const box = boxAround(at, width, height, angleDeg);
        if (option.placement.kind === "inside" && !contains(option.placement.within, box)) continue;
        if (bounds !== null && !contains(bounds, box)) continue;
        const blockers = option.avoid === undefined ? taken : [...taken, ...option.avoid];
        const spacing = option.spacingMm ?? 0;
        const spaced = { minX: box.minX - spacing, minY: box.minY - spacing, maxX: box.maxX + spacing, maxY: box.maxY + spacing };
        if (blockers.some((other) => boxesOverlap(other, spaced))) continue;
        if (barriers.some((line) => segmentHitsBox(line, box))) continue;
        const leader: Segment | null = option.leader === undefined ? null : [option.leader, nearestOnBox(box, option.leader)];
        if (
          leader !== null &&
          (blockers.some((other) => segmentHitsBox(leader, other)) ||
            leaders.some((other) => segmentsCross(leader, other)) ||
            barriers.filter((line) => segmentsCross(leader, line)).length > (option.leaderCrossings ?? 1))
        ) {
          continue;
        }
        chosen = {
          key: request.key,
          text: option.text,
          fontPx: option.fontPx,
          x: at.x,
          y: at.y,
          angleDeg,
          box,
          ...(option.leader === undefined ? {} : { leader: option.leader }),
        };
        chosenLeader = leader;
        break;
      }
      if (chosen !== null) break;
    }
    if (chosen === null) continue;
    placed.push(chosen);
    taken.push(chosen.box);
    if (chosenLeader !== null) leaders.push(chosenLeader);
  }
  return placed;
}

export type LabelledObject = {
  readonly id: string;
  readonly name: string;
  readonly tag: string | null;
  /** The drawn plan box a label must fit inside. */
  readonly box: Box;
  readonly minZ: number;
  readonly maxZ: number;
};

/** The Tag first, then the IFC name, then the name up to its first comma. */
export function objectLabelTexts(name: string, tag: string | null): string[] {
  const head = name.split(",")[0]?.trim() ?? "";
  return [...new Set([tag?.trim() ?? "", name.trim(), head])].filter((text) => text.length > 0);
}

function area(box: Box): number {
  return Math.max(box.maxX - box.minX, 0) * Math.max(box.maxY - box.minY, 0);
}

function overlapArea(a: Box, b: Box): number {
  return area({
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  });
}

/**
 * An object stacked on top of another in plan, such as an upper cabinet over
 * a base run or a worktop over its drawers, gives its label to the one below.
 */
export function isStacked(object: LabelledObject, others: ReadonlyArray<LabelledObject>): boolean {
  const own = area(object.box);
  if (own <= 0) return false;
  return others.some(
    (other) => other.id !== object.id && other.maxZ <= object.minZ + 1 && overlapArea(object.box, other.box) >= own / 2,
  );
}

/**
 * Label requests for furniture and cabinetry, smallest object first so the
 * most specific name wins where a small object sits on a large one.
 */
export function objectLabelRequests(objects: ReadonlyArray<LabelledObject>, fontPx = LABEL_PX): LabelRequest[] {
  const seen = new Set<string>();
  return objects
    .filter((object) => !isStacked(object, objects))
    .sort((a, b) => area(a.box) - area(b.box))
    .filter((object) => {
      const first = objectLabelTexts(object.name, object.tag)[0] ?? "";
      if (seen.has(first)) return false;
      seen.add(first);
      return true;
    })
    .map((object) => {
      const at = { x: (object.box.minX + object.box.maxX) / 2, y: (object.box.minY + object.box.maxY) / 2 };
      return {
        key: object.id,
        options: objectLabelTexts(object.name, object.tag).map((text) => ({
          text,
          fontPx,
          placement: { kind: "inside", at, within: object.box } as const,
        })),
      };
    });
}

/** A scale bar length that reads at a glance and stays under `maxPx` on screen. */
export function scaleBarMm(mmPerPx: number, maxPx = 110): number {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  return steps.filter((step) => step / mmPerPx <= maxPx).at(-1) ?? steps[0]!;
}
