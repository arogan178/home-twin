import { describe, expect, it } from "vitest";

import {
  findWallSwitchSeat,
  projectPointToWall,
  switchPoint,
  wallSurfaceContainsPoint,
} from "./switchGeometry";
import type { RoomId, WallSwitch } from "./types";

const wall = {
  wall_id: "WALL-01",
  start: { x: 100, y: 200 },
  end: { x: 2100, y: 200 },
};

const device: WallSwitch = {
  tag: "SW01",
  room_id: "ROOM-01" as RoomId,
  host_wall_id: wall.wall_id,
  offset_mm: 750,
  mounting_height_mm: 1100,
  mounting_face: "room",
  switching_group: "MAIN",
  spec: { kind: "dimmer", width_mm: 86, height_mm: 86, depth_mm: 35 },
  notes: [],
};

describe("physical wall-switch geometry", () => {
  it("resolves a switch from its host-wall offset and mounting height", () => {
    expect(switchPoint(device, [wall], 250)).toEqual({ x: 850, y: 200, z: 1350 });
  });

  it("projects a 3D drag back into wall-relative placement", () => {
    expect(projectPointToWall({ x: 1425, y: 80, z: 1470 }, wall, 250, 86)).toEqual({
      host_wall_id: wall.wall_id,
      offset_mm: 1325,
      mounting_height_mm: 1220,
    });
  });

  it("keeps the whole switch plate on its wall segment", () => {
    expect(projectPointToWall({ x: -900, y: 200, z: 1250 }, wall, 0, 100)?.offset_mm).toBe(51);
    expect(projectPointToWall({ x: 4000, y: 200, z: 1250 }, wall, 0, 100)?.offset_mm).toBe(1949);
  });

  it("leaves enough end margin for values rounded to two decimals", () => {
    const shortWall = {
      wall_id: "WALL-SHORT",
      start: { x: 0, y: 0 },
      end: { x: 212.626550587, y: 212.626550587 },
    };

    const projected = projectPointToWall({ x: 999, y: 999, z: 1100 }, shortWall, 0, 86);
    const wallLength = Math.hypot(shortWall.end.x, shortWall.end.y);

    expect(projected).not.toBeNull();
    expect(Number(projected?.offset_mm.toFixed(2))).toBeLessThan(wallLength - 43);
  });

  it("rejects infinite wall-plane hits that miss the physical wall face", () => {
    expect(wallSurfaceContainsPoint({ x: 1100, y: 200, z: 1100 }, wall, 0, 2700, 86, 86)).toBe(true);
    expect(wallSurfaceContainsPoint({ x: 3000, y: 200, z: 1100 }, wall, 0, 2700, 86, 86)).toBe(false);
    expect(wallSurfaceContainsPoint({ x: 1100, y: 200, z: 2800 }, wall, 0, 2700, 86, 86)).toBe(false);
  });

  it("finds a default wall seat outside a door opening", () => {
    const seat = findWallSwitchSeat(
      [wall],
      [{ host_wall_id: wall.wall_id, start: { x: 700, y: 200 }, end: { x: 1500, y: 200 } }],
      { x: 1100, y: 900 },
      100,
    );

    expect(seat?.host_wall_id).toBe(wall.wall_id);
    expect((seat?.offset_mm ?? 0) < 550 || (seat?.offset_mm ?? 0) > 1450).toBe(true);
  });
});
