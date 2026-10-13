import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { advanceDoor, advanceDoorMotions, type DoorMotion } from "./doorAnimation";
import { doorSwingSign } from "./doorSwing";

describe("door animation", () => {
  it("moves toward either state without overshooting", () => {
    expect(advanceDoor(0, 1, 100)).toBeGreaterThan(0);
    expect(advanceDoor(0, 1, 100)).toBeLessThan(1);
    expect(advanceDoor(1, 0, 100)).toBeGreaterThan(0);
    expect(advanceDoor(1, 0, 100)).toBeLessThan(1);
  });

  it("opens a stated outward swing on the opposite side of the wall", () => {
    expect(doorSwingSign("inward", { x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(doorSwingSign("outward", { x: 1, y: 0 }, { x: 0, y: 1 })).toBe(-1);
  });

  it("reports motion only while a leaf is travelling", () => {
    const door: DoorMotion = {
      kind: "door",
      group: new THREE.Group(),
      base: new THREE.Vector3(),
      angle: 0,
      swingSign: 1,
      dirX: 1,
      dirY: 0,
      span: 0.8,
      amount: 0,
      target: 0,
    };
    expect(advanceDoorMotions([door], 16)).toBe(false);
    door.target = 1;
    expect(advanceDoorMotions([door], 16)).toBe(true);
    expect(door.group.rotation.z).toBeGreaterThan(0);
    for (let frame = 0; frame < 200; frame += 1) advanceDoorMotions([door], 16);
    expect(door.amount).toBe(1);
    expect(door.group.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(advanceDoorMotions([door], 16)).toBe(false);
  });
});
