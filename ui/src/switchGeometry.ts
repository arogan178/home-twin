import type { Point, WallSwitch } from "./types";

export type WallSegment = {
  readonly wall_id: string;
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
};

type HostedOpening = {
  readonly host_wall_id: string;
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
};

/** Keeps two-decimal UI serialisation safely inside exact IFC wall bounds. */
const WALL_END_MARGIN_MM = 1;

export type WallSwitchPosition = Pick<
  WallSwitch,
  "host_wall_id" | "offset_mm" | "mounting_height_mm"
>;

function projectedOffsetMm(
  point: { readonly x: number; readonly y: number },
  wall: WallSegment,
): number | null {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return null;
  return ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / length;
}

export function switchPoint(
  device: WallSwitch,
  walls: ReadonlyArray<WallSegment>,
  floorElevationMm: number,
): Point | null {
  const wall = walls.find((candidate) => candidate.wall_id === device.host_wall_id);
  if (wall === undefined) return device.point ?? null;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return null;
  const fraction = device.offset_mm / length;
  return {
    x: wall.start.x + dx * fraction,
    y: wall.start.y + dy * fraction,
    z: floorElevationMm + device.mounting_height_mm,
  };
}

export function projectPointToWall(
  point: Point,
  wall: WallSegment,
  floorElevationMm: number,
  plateWidthMm: number,
): WallSwitchPosition | null {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return null;
  const rawOffset = projectedOffsetMm(point, wall);
  if (rawOffset === null) return null;
  const halfWidth = plateWidthMm / 2 + WALL_END_MARGIN_MM;
  if (length < halfWidth * 2) return null;
  return {
    host_wall_id: wall.wall_id,
    offset_mm: Math.max(halfWidth, Math.min(length - halfWidth, rawOffset)),
    mounting_height_mm: Math.max(plateWidthMm / 2, point.z - floorElevationMm),
  };
}

/** True only when a ray-plane hit lands on the usable face of a wall. */
export function wallSurfaceContainsPoint(
  point: Point,
  wall: WallSegment,
  floorElevationMm: number,
  ceilingElevationMm: number,
  plateWidthMm: number,
  plateHeightMm: number,
): boolean {
  const offset = projectedOffsetMm(point, wall);
  if (offset === null) return false;
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const horizontalMargin = plateWidthMm / 2 + WALL_END_MARGIN_MM;
  const verticalMargin = plateHeightMm / 2;
  return (
    offset >= horizontalMargin
    && offset <= length - horizontalMargin
    && point.z >= floorElevationMm + verticalMargin
    && point.z <= ceilingElevationMm - verticalMargin
  );
}

function offsetAlongWall(
  point: { readonly x: number; readonly y: number },
  wall: WallSegment,
): number {
  return projectedOffsetMm(point, wall) ?? 0;
}

/** Find a valid default seat without placing a new switch over an aperture. */
export function findWallSwitchSeat(
  walls: ReadonlyArray<WallSegment>,
  openings: ReadonlyArray<HostedOpening>,
  preferredPoint: { readonly x: number; readonly y: number },
  plateWidthMm: number,
): Pick<WallSwitchPosition, "host_wall_id" | "offset_mm"> | null {
  const halfWidth = plateWidthMm / 2 + WALL_END_MARGIN_MM;
  const candidates: Array<{ host_wall_id: string; offset_mm: number; distance: number }> = [];
  for (const wall of walls) {
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    if (length < plateWidthMm) continue;
    let free: Array<readonly [number, number]> = [[halfWidth, length - halfWidth]];
    for (const opening of openings.filter((item) => item.host_wall_id === wall.wall_id)) {
      const offsets = [offsetAlongWall(opening.start, wall), offsetAlongWall(opening.end, wall)];
      const blockedStart = Math.min(...offsets) - halfWidth - 1;
      const blockedEnd = Math.max(...offsets) + halfWidth + 1;
      free = free.flatMap(([start, end]) => {
        if (blockedEnd < start || blockedStart > end) return [[start, end] as const];
        const pieces: Array<readonly [number, number]> = [];
        if (blockedStart >= start) pieces.push([start, Math.min(blockedStart, end)]);
        if (blockedEnd <= end) pieces.push([Math.max(blockedEnd, start), end]);
        return pieces.filter(([from, to]) => to >= from);
      });
    }
    const preferredOffset = offsetAlongWall(preferredPoint, wall);
    for (const [start, end] of free) {
      const offset = Math.max(start, Math.min(end, preferredOffset));
      const ratio = offset / length;
      const x = wall.start.x + (wall.end.x - wall.start.x) * ratio;
      const y = wall.start.y + (wall.end.y - wall.start.y) * ratio;
      candidates.push({
        host_wall_id: wall.wall_id,
        offset_mm: offset,
        distance: Math.hypot(x - preferredPoint.x, y - preferredPoint.y),
      });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.host_wall_id.localeCompare(b.host_wall_id));
  const best = candidates[0];
  return best === undefined ? null : { host_wall_id: best.host_wall_id, offset_mm: best.offset_mm };
}
