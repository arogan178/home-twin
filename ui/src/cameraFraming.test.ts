import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { extrudedOutlines, floorOverviewFrame, focusFrame, roomOverviewFrame, viewDirection, type Vec3 } from "./cameraFraming";
import type { CameraFrame } from "./cameraPresets";

/** The largest normalised screen coordinate any point lands on. */
function widestOnScreen(frame: CameraFrame, points: ReadonlyArray<Vec3>, aspect: number): number {
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 500);
  camera.up.set(0, 0, 1);
  camera.position.set(frame.position.x, frame.position.y, frame.position.z);
  camera.lookAt(frame.target.x, frame.target.y, frame.target.z);
  camera.updateMatrixWorld();
  return Math.max(...points.map((point) => {
    const ndc = new THREE.Vector3(point.x, point.y, point.z).project(camera);
    return Math.max(Math.abs(ndc.x), Math.abs(ndc.y));
  }));
}

const room = [
  { x: 0, y: 0 },
  { x: 8, y: 0 },
  { x: 8, y: 4 },
  { x: 0, y: 4 },
];

describe("viewDirection", () => {
  it("turns a plan bearing and an elevation into a unit vector", () => {
    const direction = viewDirection({ x: 3, y: -4 }, 30);
    expect(direction.x).toBeCloseTo(0.5196, 4);
    expect(direction.y).toBeCloseTo(-0.6928, 4);
    expect(direction.z).toBeCloseTo(0.5, 6);
  });
});

describe("extrudedOutlines", () => {
  it("raises each outline vertex to its floor and its ceiling", () => {
    expect(extrudedOutlines([{ ring: [{ x: 1, y: 2 }], fromZ: 1.05, toZ: 3.45 }])).toEqual([
      { x: 1, y: 2, z: 1.05 },
      { x: 1, y: 2, z: 3.45 },
    ]);
  });
});

describe("roomOverviewFrame", () => {
  const bathroom = extrudedOutlines([{
    ring: [{ x: 14, y: 9 }, { x: 16, y: 9 }, { x: 16, y: 12 }, { x: 14, y: 12 }],
    fromZ: 1.05,
    toZ: 3.45,
  }]);

  it("opens a small wet room at a three-quarter angle, not straight down", () => {
    const frame = roomOverviewFrame(bathroom, 45, 1.4);
    // Aimed 0.9 m above the floor, where the basin and the WC are.
    expect(frame.target.x).toBeCloseTo(15, 9);
    expect(frame.target.y).toBeCloseTo(10.5, 9);
    expect(frame.target.z).toBeCloseTo(1.95, 9);
    const rise = frame.position.z - frame.target.z;
    const run = Math.hypot(frame.position.x - frame.target.x, frame.position.y - frame.target.y);
    expect((Math.atan2(rise, run) * 180) / Math.PI).toBeCloseTo(36, 6);
    // From the south-south-east, 35 degrees east of south, and above the ceiling.
    const bearing = (Math.atan2(frame.position.x - frame.target.x, frame.target.y - frame.position.y) * 180) / Math.PI;
    expect(bearing).toBeCloseTo(35, 6);
    expect(frame.position.z).toBeGreaterThan(3.45);
  });

  it("takes the other corner when tall furniture would hide the floor from the first", () => {
    const floor = [{ x: 14.3, y: 9.3, z: 1.1 }, { x: 15.7, y: 9.3, z: 1.1 }, { x: 15, y: 10.5, z: 1.1 }];
    // A tall cabinet in the south-east corner, between that corner's camera and the floor.
    const cabinet = { minX: 15.4, maxX: 16, minY: 9, maxY: 9.6, minZ: 1.05, maxZ: 3.2 };
    const frame = roomOverviewFrame(bathroom, 45, 1.4, floor, [cabinet]);
    const bearing = (Math.atan2(frame.position.x - frame.target.x, frame.target.y - frame.position.y) * 180) / Math.PI;
    expect(bearing).toBeCloseTo(-35, 6);
  });

  it("puts the room's widest point at the frame edge, less the margin", () => {
    expect(widestOnScreen(roomOverviewFrame(bathroom, 45, 1.4), bathroom, 1.4)).toBeCloseTo(1 / 1.16, 3);
  });
});

describe("floorOverviewFrame", () => {
  // A strip running south-west to north-east, the way the flat's open plan lies.
  const strip = extrudedOutlines([{
    ring: [{ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 11, y: 9 }, { x: 10, y: 10 }],
    fromZ: 0,
    toZ: 3,
  }]);

  it("looks across a diagonal floor from the south-east rather than along it", () => {
    const frame = floorOverviewFrame(strip, 45, 1.6);
    const east = frame.position.x - frame.target.x;
    const north = frame.position.y - frame.target.y;
    expect(east).toBeGreaterThan(0);
    expect(north / east).toBeCloseTo(-1, 6);
  });

  it("fills the canvas: the widest point lands at the frame edge", () => {
    expect(widestOnScreen(floorOverviewFrame(strip, 45, 1.6), strip, 1.6)).toBeCloseTo(1 / 1.06, 3);
  });
});

describe("focusFrame", () => {
  const island = { minX: 5.5, maxX: 6.1, minY: 1, maxY: 3, minZ: 0, maxZ: 0.9 };

  it("stands on the open side of an island, inside the room and under the ceiling", () => {
    const frame = focusFrame(island, room, 0, 3, 45, 1.5);
    expect(frame.position.x).toBeCloseTo(3.2795, 3);
    expect(frame.position.y).toBeCloseTo(2, 9);
    expect(frame.position.z).toBeCloseTo(2.3, 9);
    expect(frame.target).toEqual({ x: 5.8, y: 2, z: 0.675 });
  });

  it("turns away rather than put a pendant shade in the foreground", () => {
    const pendant = { minX: 3.8, maxX: 4.2, minY: 1.8, maxY: 2.2, minZ: 1.8, maxZ: 2.2 };
    const frame = focusFrame(island, room, 0, 3, 45, 1.5, [pendant]);
    // Every westward view has the shade in front of the lens, so the camera
    // takes the other long side, stopped 0.45 m short of the east wall.
    expect(frame.position.x).toBeCloseTo(7.55, 6);
    expect(frame.position.y).toBeCloseTo(2, 6);
  });

  it("looks across a long island even when the long run is off its end", () => {
    const galley = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 12 },
      { x: 0, y: 12 },
    ];
    const frame = focusFrame({ minX: 1.7, maxX: 2.3, minY: 5, maxY: 7, minZ: 0, maxZ: 0.9 }, galley, 0, 3, 45, 1.5);
    expect(frame.position.x).toBeCloseTo(3.55, 6);
    expect(frame.position.y).toBeCloseTo(6, 6);
  });

  it("keeps clear of the wall when the open side is short", () => {
    const narrow = [
      { x: 4.5, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 4 },
      { x: 4.5, y: 4 },
    ];
    const frame = focusFrame(island, narrow, 0, 2.5, 45, 1.5);
    const back = Math.hypot(frame.position.x - 5.8, frame.position.y - 2);
    expect(back).toBeLessThan(2.4);
    expect(frame.position.x).toBeGreaterThan(4.5 + 0.3);
    expect(frame.position.z).toBeCloseTo(2.2, 9);
  });
});
