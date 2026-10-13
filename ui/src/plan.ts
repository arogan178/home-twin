/**
 * Pure plan-frame helpers shared by the 2D plan, the 3D view, and tracing.
 *
 * Everything here works in the canonical building frame: millimetres, +X plan
 * right, +Y plan up, +Z up. Screen space negates Y so that plan up is screen
 * up, which is why every renderer calls {@link screenY} instead of inventing
 * its own flip.
 */

import type { Fixture, PlanUnderlay, Point, RecessedSpotlight } from "./types";

export type Vec2 = { readonly x: number; readonly y: number };

export const screenY = (planY: number): number => -planY;

export type Extent = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
};

export function extentOf(points: ReadonlyArray<Vec2>, fallback: Extent | null = null): Extent {
  if (points.length === 0) {
    return fallback ?? { minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000 };
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * A static SVG `viewBox` for a plan extent, in screen space with Y flipped.
 *
 * Interactive views use `usePlanViewport` instead, which owns pan and zoom.
 */
export function planViewBox(extent: Extent, marginMm: number): string {
  return [
    extent.minX - marginMm,
    screenY(extent.maxY) - marginMm,
    extent.width + marginMm * 2,
    extent.height + marginMm * 2,
  ].join(" ");
}

/**
 * The quadrilateral a wall face covers, drawn away from the room it faces.
 *
 * A plan reads as a plan when its walls are solid bands rather than
 * centrelines, and the band has to sit behind the face or it eats the room.
 */
export function wallBand(wall: {
  readonly start: Vec2;
  readonly end: Vec2;
  readonly inward_normal: { readonly x: number; readonly y: number };
  readonly thickness_mm: number;
}): ReadonlyArray<Vec2> {
  const backX = -wall.inward_normal.x * wall.thickness_mm;
  const backY = -wall.inward_normal.y * wall.thickness_mm;
  return [
    wall.start,
    wall.end,
    { x: wall.end.x + backX, y: wall.end.y + backY },
    { x: wall.start.x + backX, y: wall.start.y + backY },
  ];
}

export function polygonPoints(points: ReadonlyArray<Vec2>): string {
  return points.map((point) => `${point.x},${screenY(point.y)}`).join(" ");
}

export function pointInPolygon(point: Vec2, ring: ReadonlyArray<Vec2>): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const last = ring[previous];
    if (current === undefined || last === undefined) continue;
    const crosses = current.y > point.y !== last.y > point.y;
    if (!crosses) continue;
    const xAtY = ((last.x - current.x) * (point.y - current.y)) / (last.y - current.y) + current.x;
    if (point.x < xAtY) inside = !inside;
  }
  return inside;
}

function segmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

export function edgeDistance(point: Vec2, ring: ReadonlyArray<Vec2>): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    nearest = Math.min(nearest, segmentDistance(point, start, end));
  }
  return nearest;
}

/**
 * The interior point furthest from every edge, found by coarse-to-fine search.
 *
 * A bounding-box centre is wrong for the concave open-plan outline: it can land
 * outside the room and make a new fixture fail validation before it is moved.
 */
export function deepestInteriorPoint(ring: ReadonlyArray<Vec2>, snapMm = 10): Vec2 {
  const extent = extentOf(ring);
  let best: Vec2 = { x: extent.minX + extent.width / 2, y: extent.minY + extent.height / 2 };
  let bestClearance = pointInPolygon(best, ring) ? edgeDistance(best, ring) : -1;
  let step = Math.max(extent.width, extent.height) / 12;
  let searchExtent = extent;
  for (let pass = 0; pass < 4 && step >= snapMm; pass += 1) {
    for (let y = searchExtent.minY; y <= searchExtent.maxY + 1e-6; y += step) {
      for (let x = searchExtent.minX; x <= searchExtent.maxX + 1e-6; x += step) {
        const candidate = { x, y };
        if (!pointInPolygon(candidate, ring)) continue;
        const clearance = edgeDistance(candidate, ring);
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = candidate;
        }
      }
    }
    searchExtent = {
      minX: best.x - step,
      maxX: best.x + step,
      minY: best.y - step,
      maxY: best.y + step,
      width: step * 2,
      height: step * 2,
    };
    step /= 4;
  }
  return { x: Math.round(best.x / snapMm) * snapMm, y: Math.round(best.y / snapMm) * snapMm };
}

/** Choose a distinct, contained default seat for a newly added fixture. */
export function availableInteriorPoint(
  ring: ReadonlyArray<Vec2>,
  occupied: ReadonlyArray<Vec2>,
  minimumDistanceMm: number,
  edgeClearanceMm: number,
  snapMm = 10,
): Vec2 {
  const deepest = deepestInteriorPoint(ring, snapMm);
  if (occupied.length === 0) return deepest;
  const extent = extentOf(ring);
  const step = Math.max(100, Math.min(300, minimumDistanceMm / 3));
  const candidates: Vec2[] = edgeDistance(deepest, ring) >= edgeClearanceMm ? [deepest] : [];
  for (let y = extent.minY; y <= extent.maxY + 1e-6; y += step) {
    for (let x = extent.minX; x <= extent.maxX + 1e-6; x += step) {
      const point = { x, y };
      const snapped = {
        x: Math.round(point.x / snapMm) * snapMm,
        y: Math.round(point.y / snapMm) * snapMm,
      };
      if (pointInPolygon(snapped, ring) && edgeDistance(snapped, ring) >= edgeClearanceMm) {
        candidates.push(snapped);
      }
    }
  }
  const scored = candidates.map((point) => ({
    point,
    separation: Math.min(...occupied.map((other) => Math.hypot(point.x - other.x, point.y - other.y))),
    clearance: edgeDistance(point, ring),
  }));
  scored.sort(
    (a, b) =>
      b.separation - a.separation
      || b.clearance - a.clearance
      || a.point.x - b.point.x
      || a.point.y - b.point.y,
  );
  const selected = scored.find((item) => item.separation >= minimumDistanceMm) ?? scored[0];
  if (selected === undefined) return deepest;
  return selected.point;
}

export function unitDirection(direction: Point): readonly [number, number, number] {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length === 0) return [0, 0, -1];
  return [direction.x / length, direction.y / length, direction.z / length];
}

/** The circular beam radius of a downlight on a horizontal plane. */
export function beamFootprintRadiusMm(
  fixture: Pick<RecessedSpotlight, "point" | "spec">,
  planeElevationMm: number,
): number {
  const throwDistanceMm = Math.max(fixture.point.z - planeElevationMm, 0);
  return throwDistanceMm * Math.tan((fixture.spec.beam_angle_deg * Math.PI) / 360);
}

export type BeamFootprint = {
  readonly tilted: boolean;
  readonly centre: Vec2;
  readonly radiusMm: number;
  readonly outline: ReadonlyArray<Vec2>;
};

/**
 * The beam-cone footprint on a horizontal plane, honouring the aiming vector.
 *
 * A downlight aimed straight down gives a circle. A tilted fixture gives the
 * conic section, sampled as an outline, so the drawing agrees with the aiming
 * direction the lighting analysis uses.
 */
export function beamFootprint(
  fixture: Pick<RecessedSpotlight, "point" | "spec" | "direction">,
  planeElevationMm: number,
  segments = 48,
): BeamFootprint {
  const radiusMm = beamFootprintRadiusMm(fixture, planeElevationMm);
  const [ax, ay, az] = unitDirection(fixture.direction);
  const centre = { x: fixture.point.x, y: fixture.point.y };
  const vertical = Math.abs(ax) < 1e-9 && Math.abs(ay) < 1e-9 && az < 0;
  if (vertical || radiusMm <= 0) {
    return { tilted: false, centre, radiusMm, outline: [] };
  }
  if (az >= 0) return { tilted: true, centre, radiusMm: 0, outline: [] };

  // Two unit vectors spanning the plane perpendicular to the aiming axis.
  const helper: readonly [number, number, number] = Math.abs(az) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const ux = ay * helper[2] - az * helper[1];
  const uy = az * helper[0] - ax * helper[2];
  const uz = ax * helper[1] - ay * helper[0];
  const uLength = Math.hypot(ux, uy, uz) || 1;
  const u = [ux / uLength, uy / uLength, uz / uLength] as const;
  const v = [
    ay * u[2] - az * u[1],
    az * u[0] - ax * u[2],
    ax * u[1] - ay * u[0],
  ] as const;

  const half = (fixture.spec.beam_angle_deg * Math.PI) / 360;
  const outline: Vec2[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const rimX = ax * Math.cos(half) + (u[0] * Math.cos(angle) + v[0] * Math.sin(angle)) * Math.sin(half);
    const rimY = ay * Math.cos(half) + (u[1] * Math.cos(angle) + v[1] * Math.sin(angle)) * Math.sin(half);
    const rimZ = az * Math.cos(half) + (u[2] * Math.cos(angle) + v[2] * Math.sin(angle)) * Math.sin(half);
    if (rimZ >= -1e-9) continue;
    const travel = (planeElevationMm - fixture.point.z) / rimZ;
    if (travel <= 0) continue;
    outline.push({ x: fixture.point.x + rimX * travel, y: fixture.point.y + rimY * travel });
  }
  if (outline.length < 3) return { tilted: true, centre, radiusMm: 0, outline: [] };
  const footprintExtent = extentOf(outline);
  return {
    tilted: true,
    centre: {
      x: footprintExtent.minX + footprintExtent.width / 2,
      y: footprintExtent.minY + footprintExtent.height / 2,
    },
    radiusMm: Math.max(footprintExtent.width, footprintExtent.height) / 2,
    outline,
  };
}

export type IlluminanceCell = {
  readonly x: number;
  readonly y: number;
  readonly sizeMm: number;
  readonly lux: number;
  readonly intensity: number;
};

/**
 * The minimum a light surface needs to be drawn: samples, a step, and a ceiling.
 *
 * Both the interactive grid and the occlusion-aware bake satisfy it, so one
 * renderer draws either.
 */
export type LightSurface = {
  readonly samples: ReadonlyArray<{ readonly point: Point; readonly lux: number; readonly method?: string }>;
  readonly step_mm: number;
  readonly maximum_lux: number;
  readonly threshold_lux: number;
};

export type SnapResult = {
  readonly point: Vec2;
  /** The traced point it landed on, when it landed on one. */
  readonly pointId: string | null;
  /** The segment it slid along, when it did. */
  readonly onLine: boolean;
};

/**
 * Snap a raw plan position to a traced point, then to a line, then to the grid.
 *
 * Points win over lines because a shared corner matters more than a shared
 * face. Sliding onto a line is what lets a new point sit exactly on a wall
 * someone has already traced, rather than a few millimetres off it.
 */
export function snapToGeometry(
  raw: Vec2,
  points: ReadonlyArray<{ readonly id: string; readonly at: Vec2 }>,
  segments: ReadonlyArray<readonly [Vec2, Vec2]>,
  pointRadiusMm: number,
  lineRadiusMm: number,
  gridMm: number,
): SnapResult {
  let bestId: string | null = null;
  let bestDistance = pointRadiusMm;
  let bestAt: Vec2 | null = null;
  for (const candidate of points) {
    const distance = Math.hypot(candidate.at.x - raw.x, candidate.at.y - raw.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestId = candidate.id;
      bestAt = candidate.at;
    }
  }
  if (bestId !== null && bestAt !== null) return { point: bestAt, pointId: bestId, onLine: false };

  let closest: Vec2 | null = null;
  let closestDistance = lineRadiusMm;
  for (const [start, end] of segments) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const t = Math.max(0, Math.min(1, ((raw.x - start.x) * dx + (raw.y - start.y) * dy) / lengthSquared));
    const at = { x: start.x + t * dx, y: start.y + t * dy };
    const distance = Math.hypot(at.x - raw.x, at.y - raw.y);
    if (distance <= closestDistance) {
      closestDistance = distance;
      closest = at;
    }
  }
  if (closest !== null) {
    return {
      point: { x: Math.round(closest.x * 10) / 10, y: Math.round(closest.y * 10) / 10 },
      pointId: null,
      onLine: true,
    };
  }
  return {
    point: { x: Math.round(raw.x / gridMm) * gridMm, y: Math.round(raw.y / gridMm) * gridMm },
    pointId: null,
    onLine: false,
  };
}

/**
 * Where along a host edge an opening of a given width should start, for a
 * pointer dropped at `at`.
 *
 * Clamped so the opening cannot run off either end of its wall.
 */
export function offsetAlongEdge(
  start: Vec2,
  end: Vec2,
  at: Vec2,
  widthMm: number,
  snapMm = 5,
  grabOffsetMm = 0,
): number {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length <= 0) return 0;
  const ux = (end.x - start.x) / length;
  const uy = (end.y - start.y) / length;
  const along = (at.x - start.x) * ux + (at.y - start.y) * uy;
  const raw = along - widthMm / 2 + grabOffsetMm;
  const limit = Math.max(0, length - widthMm);
  return Math.min(Math.max(Math.round(raw / snapMm) * snapMm, 0), limit);
}

/**
 * The index at which a point should be inserted into a closed outline.
 *
 * The nearest edge decides, so clicking on a wall adds a vertex there rather
 * than at the end of the list, where it would fold the outline over itself.
 */
export function insertionIndex(ring: ReadonlyArray<Vec2>, at: Vec2): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - start.x) * dx + (at.y - start.y) * dy) / lengthSquared));
    const distance = Math.hypot(at.x - (start.x + t * dx), at.y - (start.y + t * dy));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index + 1;
    }
  }
  return best;
}

/** A light surface with enough context to be labelled and placed in space. */
export type RenderableLightSurface = LightSurface & {
  readonly method: string;
  readonly plane_elevation_mm: number;
};

/** Square cells for a rendered light-coverage image, one per grid sample. */
export function illuminanceCells(grid: LightSurface | null): ReadonlyArray<IlluminanceCell> {
  if (grid === null || grid.samples.length === 0) return [];
  const ceiling = Math.max(grid.maximum_lux, grid.threshold_lux, 1);
  return grid.samples.map((sample) => ({
    x: sample.point.x,
    y: sample.point.y,
    sizeMm: grid.step_mm,
    lux: sample.lux,
    intensity: Math.min(1, sample.lux / ceiling),
  }));
}

/**
 * A warm ramp for rendered illuminance, from unlit to the brightest sample.
 *
 * The ramp is a reading aid for a labelled approximation. It is not a
 * calibrated false-colour scale.
 */
export function luxColour(intensity: number): string {
  const clamped = Math.min(1, Math.max(0, intensity));
  const hue = 46 - 16 * clamped;
  const lightness = 24 + 52 * Math.sqrt(clamped);
  return `hsl(${hue.toFixed(1)} 92% ${lightness.toFixed(1)}%)`;
}

export type UnderlayTransform = {
  readonly toPlan: (pixel: Vec2) => Vec2;
  readonly toPixel: (plan: Vec2) => Vec2;
};

/**
 * The calibrated mapping between underlay pixels and plan millimetres.
 *
 * Image Y points down and plan Y points up, so the transform negates Y before
 * rotating by the calibrated angle.
 */
export function underlayTransform(underlay: PlanUnderlay): UnderlayTransform {
  const radians = (underlay.rotation_deg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    toPlan: (pixel) => {
      const dx = (pixel.x - underlay.origin_px.x) * underlay.mm_per_px;
      const dy = -(pixel.y - underlay.origin_px.y) * underlay.mm_per_px;
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    },
    toPixel: (plan) => {
      const dx = plan.x * cos + plan.y * sin;
      const dy = -plan.x * sin + plan.y * cos;
      return {
        x: underlay.origin_px.x + dx / underlay.mm_per_px,
        y: underlay.origin_px.y - dy / underlay.mm_per_px,
      };
    },
  };
}

/**
 * Derive `mm_per_px` and `rotation_deg` from two calibration clicks.
 *
 * The two pixels are a printed dimension whose real length is `knownMm`. When
 * `alongPlanAxis` is set, the same pair also fixes the plan rotation so a
 * printed horizontal or vertical run traces square.
 */
export function calibrateUnderlay(
  from: Vec2,
  to: Vec2,
  knownMm: number,
  alongPlanAxis: "x" | "y" | null,
): { readonly mm_per_px: number; readonly rotation_deg: number } | null {
  const pixelLength = Math.hypot(to.x - from.x, to.y - from.y);
  if (pixelLength < 1 || knownMm <= 0) return null;
  const rawAngle = Math.atan2(-(to.y - from.y), to.x - from.x);
  const target = alongPlanAxis === "y" ? Math.PI / 2 : 0;
  return {
    mm_per_px: knownMm / pixelLength,
    rotation_deg: alongPlanAxis === null ? 0 : ((target - rawAngle) * 180) / Math.PI,
  };
}

/**
 * Millimetres per screen pixel for a viewBox rendered with `xMidYMid meet`.
 *
 * The shorter axis is letterboxed, so the scale is the tighter of the two and a
 * pixel covers the larger of the two ratios. Getting this wrong once made a
 * point's grab radius 369 metres, which snapped every click onto one vertex.
 */
export function millimetresPerPixel(
  viewWidthMm: number,
  viewHeightMm: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
): number {
  const width = Math.max(canvasWidthPx, 1);
  const height = Math.max(canvasHeightPx, 1);
  return Math.max(viewWidthMm / width, viewHeightMm / height);
}

export type SnapRadii = { readonly pick: number; readonly drag: number };

/**
 * Grab and snap distances in millimetres for the current zoom.
 *
 * Picking is forgiving so a loop can be closed back onto its first point.
 * Dragging is tighter, because a point that sticks to a neighbour half a metre
 * away reads as the drag being ignored. Both are clamped so a very wide or very
 * tight zoom stays usable.
 */
export function snapRadii(mmPerPx: number): SnapRadii {
  return {
    pick: Math.min(Math.max(15 * mmPerPx, 120), 800),
    drag: Math.min(Math.max(9 * mmPerPx, 50), 250),
  };
}

/** The plan-frame bearing of true north, clockwise from plan +Y. */
export function northBearingInPlan(trueNorthDeg: number): number {
  return (-trueNorthDeg + 360) % 360;
}

/** A unit plan vector for a bearing measured clockwise from plan +Y. */
export function bearingVector(bearingDeg: number): Vec2 {
  const radians = (bearingDeg * Math.PI) / 180;
  return { x: Math.sin(radians), y: Math.cos(radians) };
}

export function formatMillimetres(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}

/** A dotted line drawn while dragging, showing what the drag lined up with. */
export type AlignmentGuide = {
  readonly axis: "column" | "row";
  /** The shared coordinate: plan x for a column, plan y for a row. */
  readonly atMm: number;
  /** The guide's span along the other axis, so it reaches every sharer. */
  readonly fromMm: number;
  readonly toMm: number;
  readonly tags: ReadonlyArray<string>;
};

export type AlignmentSnap = {
  /** The offset to add to the dragged set, on top of the grid-snapped one. */
  readonly dx: number;
  readonly dy: number;
  readonly guides: ReadonlyArray<AlignmentGuide>;
};

export type AlignmentMark = { readonly tag: string; readonly at: Vec2 };

/** The nudge that puts some moving value onto some fixed one, if one is close. */
function nearestPull(
  moving: ReadonlyArray<number>,
  fixed: ReadonlyArray<number>,
  toleranceMm: number,
): number {
  let pull = 0;
  let best = toleranceMm;
  for (const value of moving) {
    for (const target of fixed) {
      const offset = target - value;
      if (Math.abs(offset) <= best) {
        best = Math.abs(offset);
        pull = offset;
      }
    }
  }
  return pull;
}

/** Coordinates land on a snap target exactly; a hair of float drift is the same line. */
const SAME_AXIS_MM = 0.5;

function guidesOn(
  axis: "column" | "row",
  moving: ReadonlyArray<AlignmentMark>,
  fixed: ReadonlyArray<AlignmentMark>,
  along: (mark: AlignmentMark) => number,
  across: (mark: AlignmentMark) => number,
): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  for (const target of fixed) {
    const at = along(target);
    if (guides.some((guide) => Math.abs(guide.atMm - at) <= SAME_AXIS_MM)) continue;
    const dragged = moving.filter((mark) => Math.abs(along(mark) - at) <= SAME_AXIS_MM);
    if (dragged.length === 0) continue;
    const sharers = [...dragged, ...fixed.filter((mark) => Math.abs(along(mark) - at) <= SAME_AXIS_MM)];
    const positions = sharers.map(across);
    guides.push({
      axis,
      atMm: at,
      fromMm: Math.min(...positions),
      toMm: Math.max(...positions),
      tags: sharers.map((mark) => mark.tag),
    });
  }
  return guides;
}

/**
 * Pull a dragged set onto the rows and columns the other fixtures sit on, and
 * report the lines to draw.
 *
 * Each axis resolves on its own, so a light can take a neighbour's column while
 * keeping its own row. The tolerance is a screen distance, because lining
 * things up is something you do by eye: at a wide zoom a guide that only
 * reached a few millimetres would never catch.
 *
 * This is deliberately looser than the `bad_alignment` check, which only counts
 * an axis two fixtures already share. A snap lands exactly on the target, so it
 * can never leave the fixture inside the band that check reports.
 */
export function alignmentSnap(
  moving: ReadonlyArray<AlignmentMark>,
  fixed: ReadonlyArray<AlignmentMark>,
  toleranceMm: number,
): AlignmentSnap {
  if (moving.length === 0 || fixed.length === 0) return { dx: 0, dy: 0, guides: [] };
  const dx = nearestPull(moving.map((mark) => mark.at.x), fixed.map((mark) => mark.at.x), toleranceMm);
  const dy = nearestPull(moving.map((mark) => mark.at.y), fixed.map((mark) => mark.at.y), toleranceMm);
  const pulled = moving.map((mark) => ({ tag: mark.tag, at: { x: mark.at.x + dx, y: mark.at.y + dy } }));
  return {
    dx,
    dy,
    guides: [
      ...guidesOn("column", pulled, fixed, (mark) => mark.at.x, (mark) => mark.at.y),
      ...guidesOn("row", pulled, fixed, (mark) => mark.at.y, (mark) => mark.at.x),
    ],
  };
}

export type ResolvedDrag = {
  readonly moves: ReadonlyArray<{ readonly tag: string; readonly point: Point }>;
  readonly guides: ReadonlyArray<AlignmentGuide>;
};

/**
 * Where a dragged set of fixtures lands, and the lines that say why.
 *
 * The grid snaps the grabbed fixture and the whole set shifts by that one
 * offset, so a selection keeps its own spacing however far it travels. An
 * alignment pull runs on top and reaches half a grid step, so a neighbour
 * sitting off-grid is still catchable. The plan and the 3D view both call this,
 * because a light that snaps differently depending on the view is a light you
 * cannot place.
 */
export function resolveDrag(
  origins: ReadonlyMap<string, Point>,
  lead: string,
  offsetMm: Vec2,
  still: ReadonlyArray<AlignmentMark>,
  snapMm: number,
  alignToleranceMm: number,
): ResolvedDrag {
  const anchor = origins.get(lead);
  if (anchor === undefined) return { moves: [], guides: [] };
  const snap = Math.max(snapMm, 1);
  const dx = Math.round((anchor.x + offsetMm.x) / snap) * snap - anchor.x;
  const dy = Math.round((anchor.y + offsetMm.y) / snap) * snap - anchor.y;
  const moving = [...origins].map(([tag, point]) => ({
    tag,
    at: { x: point.x + dx, y: point.y + dy },
  }));
  const pull = alignmentSnap(moving, still, Math.max(alignToleranceMm, snap / 2));
  return {
    guides: pull.guides,
    moves: moving.map((mark) => ({
      tag: mark.tag,
      point: {
        x: mark.at.x + pull.dx,
        y: mark.at.y + pull.dy,
        z: origins.get(mark.tag)?.z ?? 0,
      },
    })),
  };
}

/** Lights that sit at a point. A rope light is a path, so it never drags. */
export type PlacedFixture = Extract<Fixture, { kind: "recessed_spotlight" | "pendant_bulb" }>;

export function placedFixtures(fixtures: ReadonlyArray<Fixture>): ReadonlyArray<PlacedFixture> {
  return fixtures.filter((fixture): fixture is PlacedFixture => fixture.kind !== "rope_light");
}
