/**
 * Pure edits on the reviewed plan source. Each takes a `PlanDocument` and
 * returns the next one, or the same object when nothing changed, so the
 * workspace's `edit` can skip recording a no-op.
 */

import { extentOf, formatMillimetres, insertionIndex, offsetAlongEdge, pointInPolygon, type Vec2 } from "./plan";
import { roundTenthMm } from "./traceDrawing";
import type { PlanAperture, PlanDocument, PlanPoint, PlanRoom, PlanUnderlay } from "./types";

export const SITE_EVIDENCE_ID = "site_survey";
export const UNDERLAY_EVIDENCE_ID = "underlay_reference";
export const HAND_EVIDENCE_ID = "hand_placed";
export const APERTURE_SNAP_MM = 5;
export const CURRENT_SCHEMA = "home-twin.plan/v3";
// The pre-rename v3 id stays current so an existing source keeps its first line.
const V3_SCHEMAS: ReadonlySet<string> = new Set([CURRENT_SCHEMA, "home-twin.m1-plan/v3"]);
export const POINT_IN_USE = "This point is used by a room, control, or opening";

/** The floor level most rooms sit on, for seeding a newly traced room. */
export function commonestFloor(rooms: ReadonlyArray<PlanRoom>): number {
  const tally = new Map<number, number>();
  for (const room of rooms) tally.set(room.floor_elevation_mm, (tally.get(room.floor_elevation_mm) ?? 0) + 1);
  let best = 0;
  let seen = 0;
  for (const [level, count] of tally) {
    if (count > seen) {
      seen = count;
      best = level;
    }
  }
  return best;
}

/** A traced point already at this spot, so a typed or dragged corner joins it rather than duplicating it. */
export function pointIdAt(document: PlanDocument, at: Vec2): string | null {
  for (const [id, point] of Object.entries(document.points)) {
    if (Math.abs(point.x_mm - at.x) <= 0.5 && Math.abs(point.y_mm - at.y) <= 0.5) return id;
  }
  return null;
}

export function nextId(prefix: string, taken: Iterable<string>): string {
  const existing = new Set(taken);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${prefix}${Date.now()}`;
}

export function withSchema(document: PlanDocument): PlanDocument {
  return V3_SCHEMAS.has(document.schema) ? document : { ...document, schema: CURRENT_SCHEMA };
}

export function withEvidence(document: PlanDocument, id: string, note: string, uncertaintyMm = 0): PlanDocument {
  if (document.evidence[id] !== undefined) return document;
  return {
    ...document,
    evidence: {
      ...document.evidence,
      [id]: { source: "owner_review_required", status: "assumed", uncertainty_mm: uncertaintyMm, note },
    },
  };
}

// An opening on a shared wall belongs to both rooms, so deleting one room must
// reassign it rather than take it away from the room that is still there.
export function withoutRoom(document: PlanDocument, roomId: string): PlanDocument {
  return {
    ...document,
    rooms: document.rooms.filter((room) => room.id !== roomId),
    apertures: document.apertures
      .filter((item) => item.room_ids.some((id) => id !== roomId))
      .map((item) =>
        item.room_ids.includes(roomId)
          ? { ...item, room_ids: item.room_ids.filter((id) => id !== roomId) }
          : item,
      ),
  };
}

// Counting apertures repeats a name as soon as one is deleted, so the number
// comes from the highest already used.
export function nextOpeningNumber(apertures: ReadonlyArray<{ readonly name: string }>): number {
  const used = apertures.map((item) => Number(/^Opening (\d+)$/.exec(item.name)?.[1] ?? 0));
  return Math.max(apertures.length, ...used) + 1;
}

export function withHandEvidence(document: PlanDocument): PlanDocument {
  // Clicking over a raster underlay is nowhere near as tight as a vector trace.
  return withEvidence(
    document,
    HAND_EVIDENCE_ID,
    "Placed by hand over the reference drawing, not traced from vectors.",
    75,
  );
}

export function referencedPointIds(document: PlanDocument): Set<string> {
  const used = new Set<string>();
  for (const room of document.rooms) room.point_ids.forEach((id) => used.add(id));
  for (const control of document.controls) {
    used.add(control.from_point);
    used.add(control.to_point);
  }
  for (const aperture of document.apertures) aperture.host_edge.forEach((id) => used.add(id));
  for (const source of document.daylight_sources) source.point_ids.forEach((id) => used.add(id));
  for (const override of document.wall_overrides) override.point_ids.forEach((id) => used.add(id));
  return used;
}

export function roomRing(document: PlanDocument, room: PlanRoom): Vec2[] {
  return room.point_ids
    .map((id) => document.points[id])
    .filter((point): point is NonNullable<typeof point> => point !== undefined)
    .map((point) => ({ x: point.x_mm, y: point.y_mm }));
}

export function allPoints(document: PlanDocument): Vec2[] {
  return Object.values(document.points).map((point) => ({ x: point.x_mm, y: point.y_mm }));
}

/** Room edges that an aperture can host, as ordered point-id pairs. */
export function hostEdges(document: PlanDocument): Array<{ roomId: string; edge: [string, string] }> {
  const edges: Array<{ roomId: string; edge: [string, string] }> = [];
  for (const room of document.rooms) {
    room.point_ids.forEach((first, index) => {
      const second = room.point_ids[(index + 1) % room.point_ids.length];
      if (second !== undefined) edges.push({ roomId: room.id, edge: [first, second] });
    });
  }
  return edges;
}

/** Every room edge, so a point can slide onto a wall someone already traced. */
export function tracedSegments(document: PlanDocument): Array<readonly [Vec2, Vec2]> {
  const out: Array<readonly [Vec2, Vec2]> = [];
  for (const room of document.rooms) {
    const ring = roomRing(document, room);
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      if (start !== undefined && end !== undefined) out.push([start, end] as const);
    }
  }
  return out;
}

/** The room outline nearest `at`, optionally limited to one room, and how far away it is. */
export function nearestRoomOutline(
  document: PlanDocument,
  at: Vec2,
  onlyRoomId: string | null,
): { roomId: string | null; distanceMm: number } {
  let bestRoom: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const room of document.rooms) {
    if (onlyRoomId !== null && room.id !== onlyRoomId) continue;
    const ring = roomRing(document, room);
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      if (a === undefined || b === undefined) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / lengthSquared));
      const distance = Math.hypot(at.x - (a.x + t * dx), at.y - (a.y + t * dy));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestRoom = room.id;
      }
    }
  }
  return { roomId: bestRoom, distanceMm: bestDistance };
}

/** Add hand-placed points, recording the hand-placement evidence they cite. */
export function withHandPoints(document: PlanDocument, created: PlanDocument["points"]): PlanDocument {
  const base = withHandEvidence(document);
  return { ...base, points: { ...base.points, ...created } };
}

/** Ids for each corner: an existing point at that spot, or a new hand-placed one listed in `created`. */
export function cornerPointIds(
  document: PlanDocument,
  corners: ReadonlyArray<Vec2>,
): { ids: string[]; created: PlanDocument["points"] } {
  const taken = new Set(Object.keys(document.points));
  const created: PlanDocument["points"] = {};
  const ids = corners.map((corner) => {
    const known = pointIdAt(document, corner);
    if (known !== null) return known;
    const id = nextId("p", taken);
    taken.add(id);
    created[id] = { x_mm: corner.x, y_mm: corner.y, evidence: HAND_EVIDENCE_ID };
    return id;
  });
  return { ids, created };
}

/** Insert a new hand-placed point into a room outline on the edge nearest to it. */
export function withInsertedRoomPoint(document: PlanDocument, roomId: string, id: string, at: Vec2): PlanDocument {
  const room = document.rooms.find((item) => item.id === roomId);
  if (room === undefined) return document;
  const ring = roomRing(document, room);
  const index = insertionIndex(ring, at);
  const base = withHandEvidence(document);
  return {
    ...base,
    points: { ...base.points, [id]: { x_mm: at.x, y_mm: at.y, evidence: HAND_EVIDENCE_ID } },
    rooms: base.rooms.map((item) =>
      item.id === roomId
        ? { ...item, point_ids: [...item.point_ids.slice(0, index), id, ...item.point_ids.slice(index)] }
        : item,
    ),
  };
}

export function withPointAt(document: PlanDocument, id: string, x: number, y: number): PlanDocument {
  const existing = document.points[id];
  if (existing === undefined || (existing.x_mm === x && existing.y_mm === y)) return document;
  return { ...document, points: { ...document.points, [id]: { ...existing, x_mm: x, y_mm: y } } };
}

/** Move both ends of a wall at once. */
export function withMovedWall(
  document: PlanDocument,
  startId: string,
  endId: string,
  startAt: Pick<PlanPoint, "x_mm" | "y_mm">,
  endAt: Pick<PlanPoint, "x_mm" | "y_mm">,
): PlanDocument {
  const a = document.points[startId];
  const b = document.points[endId];
  if (a === undefined || b === undefined) return document;
  const nextA = { ...a, ...startAt };
  const nextB = { ...b, ...endAt };
  if (a.x_mm === nextA.x_mm && a.y_mm === nextA.y_mm && b.x_mm === nextB.x_mm && b.y_mm === nextB.y_mm) {
    return document;
  }
  return { ...document, points: { ...document.points, [startId]: nextA, [endId]: nextB } };
}

export function withNudgedPoint(document: PlanDocument, id: string, direction: Vec2, stepMm: number): PlanDocument {
  const point = document.points[id];
  if (point === undefined) return document;
  const moved = {
    ...point,
    x_mm: roundTenthMm(point.x_mm + direction.x * stepMm),
    y_mm: roundTenthMm(point.y_mm + direction.y * stepMm),
  };
  return { ...document, points: { ...document.points, [id]: moved } };
}

/** Slide an opening along its wall by one step, clamped as a drag is. */
export function withNudgedAperture(document: PlanDocument, id: string, direction: Vec2, stepMm: number): PlanDocument {
  const aperture = document.apertures.find((item) => item.id === id);
  const from = aperture && document.points[aperture.host_edge[0]];
  const to = aperture && document.points[aperture.host_edge[1]];
  if (aperture === undefined || from === undefined || to === undefined) return document;
  const start = { x: from.x_mm, y: from.y_mm };
  const length = Math.hypot(to.x_mm - from.x_mm, to.y_mm - from.y_mm);
  if (length === 0) return document;
  const unit = { x: (to.x_mm - from.x_mm) / length, y: (to.y_mm - from.y_mm) / length };
  // The arrow's component along the wall picks the way; one square to the wall does nothing.
  const along = Math.sign(Math.round((direction.x * unit.x + direction.y * unit.y) * 1000));
  if (along === 0) return document;
  const offset = aperture.offset_mm ?? (length - aperture.width_mm) / 2;
  const centre = offset + along * stepMm + aperture.width_mm / 2;
  const next = offsetAlongEdge(start, { x: to.x_mm, y: to.y_mm }, { x: start.x + unit.x * centre, y: start.y + unit.y * centre }, aperture.width_mm, APERTURE_SNAP_MM);
  if (next === aperture.offset_mm) return document;
  return { ...document, apertures: document.apertures.map((item) => (item.id === id ? { ...item, offset_mm: next } : item)) };
}

export function withUpdatedAperture(document: PlanDocument, id: string, patch: Partial<PlanAperture>): PlanDocument {
  return {
    ...document,
    apertures: document.apertures.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
}

export function withoutPoint(document: PlanDocument, id: string): PlanDocument {
  const points = { ...document.points };
  delete points[id];
  return { ...document, points };
}

export function withoutShaft(document: PlanDocument, id: string): PlanDocument {
  return { ...document, daylight_sources: document.daylight_sources.filter((item) => item.id !== id) };
}

export function withoutSoffit(document: PlanDocument, id: string): PlanDocument {
  return { ...document, soffits: document.soffits.filter((item) => item.id !== id) };
}

export function withoutControl(document: PlanDocument, id: string): PlanDocument {
  return { ...document, controls: document.controls.filter((item) => item.id !== id) };
}

export function withoutAperture(document: PlanDocument, id: string): PlanDocument {
  return { ...document, apertures: document.apertures.filter((item) => item.id !== id) };
}

/** A dimension check between two points, seeded with their traced length until the printed one is entered. */
export function withControl(document: PlanDocument, id: string, points: [string, string]): PlanDocument {
  const from = document.points[points[0]];
  const to = document.points[points[1]];
  const traced =
    from === undefined || to === undefined ? 1000 : Math.hypot(to.x_mm - from.x_mm, to.y_mm - from.y_mm);
  return {
    ...document,
    controls: [
      ...document.controls,
      {
        id,
        from_point: points[0],
        to_point: points[1],
        expected_mm: Math.max(Math.round(traced), 1),
        tolerance_mm: 20,
      },
    ],
  };
}

/** Move a check onto other corners, keeping its printed dimension. */
export function withReanchoredControl(document: PlanDocument, id: string, points: [string, string]): PlanDocument {
  return {
    ...document,
    controls: document.controls.map((item) =>
      item.id === id ? { ...item, from_point: points[0], to_point: points[1] } : item,
    ),
  };
}

export function withShaft(document: PlanDocument, id: string, pointIds: string[]): PlanDocument {
  const base = withHandEvidence(document);
  return {
    ...base,
    daylight_sources: [
      ...base.daylight_sources,
      {
        id,
        name: `Shaft ${base.daylight_sources.length + 1}`,
        kind: "ventilation_shaft",
        point_ids: pointIds,
        daylight_role: "possible",
        geometry_evidence: HAND_EVIDENCE_ID,
      },
    ],
  };
}

/** The room whose outline contains the middle of these points' extent. */
export function soffitHost(document: PlanDocument, pointIds: ReadonlyArray<string>): PlanRoom | undefined {
  const centre = extentOf(
    pointIds
      .map((pointId) => document.points[pointId])
      .filter((point): point is NonNullable<typeof point> => point !== undefined)
      .map((point) => ({ x: point.x_mm, y: point.y_mm })),
  );
  const middle = { x: centre.minX + centre.width / 2, y: centre.minY + centre.height / 2 };
  return document.rooms.find((room) => pointInPolygon(middle, roomRing(document, room)));
}

export function withSoffit(document: PlanDocument, id: string, host: PlanRoom, pointIds: string[]): PlanDocument {
  const base = withHandEvidence(document);
  return {
    ...base,
    soffits: [
      ...base.soffits,
      {
        id,
        name: `Soffit ${base.soffits.length + 1}`,
        room_id: host.id,
        kind: "soffit",
        point_ids: pointIds,
        height_mm: Math.max(host.ceiling_height_mm - 300, 1800),
        geometry_evidence: HAND_EVIDENCE_ID,
      },
    ],
  };
}

export function withRoom(document: PlanDocument, id: string, pointIds: string[]): PlanDocument {
  const base = withHandEvidence(document);
  return {
    ...base,
    rooms: [
      ...base.rooms,
      {
        id,
        name: `Room ${base.rooms.length + 1}`,
        point_ids: pointIds,
        // The level most rooms are on, not whichever happens to be first: a
        // split-level home would otherwise put new rooms on the landing.
        floor_elevation_mm: commonestFloor(base.rooms),
        ceiling_height_mm: base.rooms[0]?.ceiling_height_mm ?? 2600,
        ceiling_evidence: base.rooms[0]?.ceiling_evidence ?? HAND_EVIDENCE_ID,
        geometry_evidence: HAND_EVIDENCE_ID,
      },
    ],
  };
}

/** A window on a room edge, with assumed heights flagged for confirmation. */
export function withAperture(document: PlanDocument, id: string, roomId: string, edge: [string, string]): PlanDocument {
  const from = document.points[edge[0]];
  const to = document.points[edge[1]];
  const hostLength =
    from === undefined || to === undefined ? 2000 : Math.hypot(to.x_mm - from.x_mm, to.y_mm - from.y_mm);
  const base = withHandEvidence(
    withEvidence(document, "opening_height_assumption", "Opening heights need site or elevation confirmation."),
  );
  return {
    ...base,
    apertures: [
      ...base.apertures,
      {
        id,
        name: `Opening ${nextOpeningNumber(base.apertures)}`,
        kind: "window" as const,
        host_edge: edge,
        width_mm: APERTURE_SNAP_MM * Math.round(Math.max(Math.min(1200, hostLength - 300), 300) / APERTURE_SNAP_MM),
        sill_height_mm: 900,
        height_mm: 1200,
        room_ids: [roomId],
        exposure: "exterior",
        geometry_evidence: HAND_EVIDENCE_ID,
        height_evidence: "opening_height_assumption",
        glazing_fraction: 0.8,
      },
    ],
  };
}

/** Attach a stored reference image, keeping any earlier placement but marking it uncalibrated. */
export function withUnderlay(
  document: PlanDocument,
  stored: Pick<PlanUnderlay, "file_name" | "sha256" | "width_px" | "height_px">,
): PlanDocument {
  return {
    ...withEvidence(
      withSchema(document),
      UNDERLAY_EVIDENCE_ID,
      "Reference drawing behind the tracing canvas; calibrate it before trusting any traced point.",
    ),
    underlay: {
      file_name: stored.file_name,
      sha256: stored.sha256,
      width_px: stored.width_px,
      height_px: stored.height_px,
      mm_per_px: document.underlay?.mm_per_px ?? 10,
      origin_px: document.underlay?.origin_px ?? { x: 0, y: stored.height_px },
      rotation_deg: document.underlay?.rotation_deg ?? 0,
      opacity: document.underlay?.opacity ?? 0.55,
      calibration_note: "Uncalibrated: set the scale from a printed dimension.",
      evidence: UNDERLAY_EVIDENCE_ID,
    },
  };
}

export function withUnderlayCalibration(
  document: PlanDocument,
  result: { readonly mm_per_px: number; readonly rotation_deg: number },
  knownMm: number,
): PlanDocument {
  return document.underlay === null || document.underlay === undefined
    ? document
    : {
        ...document,
        underlay: {
          ...document.underlay,
          mm_per_px: result.mm_per_px,
          rotation_deg: result.rotation_deg,
          calibration_note: `Calibrated from a ${formatMillimetres(knownMm)} mm printed dimension.`,
        },
      };
}

export function withUnderlayOrigin(document: PlanDocument, originPx: Vec2): PlanDocument {
  return document.underlay === null || document.underlay === undefined
    ? document
    : { ...document, underlay: { ...document.underlay, origin_px: originPx } };
}
