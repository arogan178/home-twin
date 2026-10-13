import type { PlanRoomGeometry } from "./types";

type PlanPoint = PlanRoomGeometry["ceiling"]["polygon"]["outer"][number];

export type LowerLevelFloor = {
  readonly outline: ReadonlyArray<PlanPoint>;
  readonly elevationMm: number;
  /**
   * The level's own walls and the openings in them.
   *
   * A lower level is part of its room, not a room beside it, so the room's
   * `get_room_context` does not carry these: that stays the space's own
   * boundaries, which is what the plan compiler verifies a traced room against.
   * The whole-plan payload already has them, so the browser joins them up.
   */
  readonly walls?: PlanRoomGeometry["walls"];
  readonly openings?: PlanRoomGeometry["openings"];
};

export type RoomFloorLayer = LowerLevelFloor;

type RoomFloorLayersInput = {
  readonly upperOutline: ReadonlyArray<PlanPoint>;
  readonly upperElevationMm: number;
  readonly lowerLevels: ReadonlyArray<LowerLevelFloor>;
};

/** Floor slabs that belong in a single-room 3D scene. */
export function roomFloorLayers(input: RoomFloorLayersInput): ReadonlyArray<RoomFloorLayer> {
  const upper = { outline: input.upperOutline, elevationMm: input.upperElevationMm };
  const lower = input.lowerLevels
    .filter((level) => level.elevationMm < input.upperElevationMm)
    .sort((first, second) => second.elevationMm - first.elevationMm);
  return [upper, ...lower];
}

/**
 * Unify touching or overlapping stairwell holes and clamp/snap them to the room outline.
 *
 * In Three.js / Earcut polygon triangulation, multiple touching holes (like a stair flight
 * and its lower-level entrance landing) or a hole with coordinates projecting outside
 * the room boundary break hole triangulation, causing solid floor slabs to be rendered
 * over the void. This unifies touching voids into clean polygons and snaps them to the
 * room perimeter walls within tolerance.
 */
export function unifyStairwellHoles(
  roomRing: ReadonlyArray<PlanPoint>,
  holeRings: ReadonlyArray<ReadonlyArray<PlanPoint>>,
  toleranceMm = 50,
): ReadonlyArray<ReadonlyArray<PlanPoint>> {
  if (holeRings.length === 0) return [];

  const boxes = holeRings.map((ring) => {
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      ring,
    };
  });

  const clusters: Array<typeof boxes> = [];
  for (const b of boxes) {
    let merged = false;
    for (const c of clusters) {
      const touches = c.some(
        (cb) =>
          !(
            b.maxX < cb.minX - toleranceMm ||
            b.minX > cb.maxX + toleranceMm ||
            b.maxY < cb.minY - toleranceMm ||
            b.minY > cb.maxY + toleranceMm
          ),
      );
      if (touches) {
        c.push(b);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push([b]);
    }
  }

  const hEdges: Array<{ y: number; minX: number; maxX: number }> = [];
  const vEdges: Array<{ x: number; minY: number; maxY: number }> = [];
  for (let i = 0; i < roomRing.length; i++) {
    const p1 = roomRing[i]!;
    const p2 = roomRing[(i + 1) % roomRing.length]!;
    if (Math.abs(p1.y - p2.y) <= 2) {
      hEdges.push({ y: (p1.y + p2.y) / 2, minX: Math.min(p1.x, p2.x), maxX: Math.max(p1.x, p2.x) });
    }
    if (Math.abs(p1.x - p2.x) <= 2) {
      vEdges.push({ x: (p1.x + p2.x) / 2, minY: Math.min(p1.y, p2.y), maxY: Math.max(p1.y, p2.y) });
    }
  }

  const roomXs = roomRing.map((p) => p.x);
  const roomYs = roomRing.map((p) => p.y);
  const roomMinX = Math.min(...roomXs);
  const roomMaxX = Math.max(...roomXs);
  const roomMinY = Math.min(...roomYs);
  const roomMaxY = Math.max(...roomYs);

  const result: Array<ReadonlyArray<PlanPoint>> = [];
  for (const cluster of clusters) {
    if (cluster.length === 1 && cluster[0]!.ring.length > 4) {
      result.push(cluster[0]!.ring);
      continue;
    }
    let minX = Math.min(...cluster.map((b) => b.minX));
    let maxX = Math.max(...cluster.map((b) => b.maxX));
    let minY = Math.min(...cluster.map((b) => b.minY));
    let maxY = Math.max(...cluster.map((b) => b.maxY));

    for (const h of hEdges) {
      if (maxX >= h.minX - toleranceMm && minX <= h.maxX + toleranceMm) {
        if (Math.abs(minY - h.y) <= toleranceMm) minY = h.y;
        if (Math.abs(maxY - h.y) <= toleranceMm) maxY = h.y;
      }
    }
    for (const v of vEdges) {
      if (maxY >= v.minY - toleranceMm && minY <= v.maxY + toleranceMm) {
        if (Math.abs(minX - v.x) <= toleranceMm) minX = v.x;
        if (Math.abs(maxX - v.x) <= toleranceMm) maxX = v.x;
      }
    }

    minX = Math.max(minX, roomMinX);
    maxX = Math.min(maxX, roomMaxX);
    minY = Math.max(minY, roomMinY);
    maxY = Math.min(maxY, roomMaxY);

    result.push([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]);
  }

  return result;
}
