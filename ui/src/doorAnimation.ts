import * as THREE from "three";

export function advanceDoor(current: number, target: number, elapsedMs: number): number {
  if (Math.abs(target - current) < 0.001) return target;
  const blend = 1 - Math.exp(-Math.max(0, elapsedMs) / 110);
  return current + (target - current) * blend;
}

/** A door leaf's animation state, shared by both 3D views. */
export type DoorMotion = {
  readonly kind: "door" | "sliding_door";
  readonly group: THREE.Group;
  readonly base: THREE.Vector3;
  readonly angle: number;
  readonly swingSign: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly span: number;
  amount: number;
  target: number;
};

/** Step every leaf towards its target. True while any of them moved. */
export function advanceDoorMotions(doors: Iterable<DoorMotion>, elapsedMs: number): boolean {
  let moved = false;
  for (const door of doors) {
    if (door.amount === door.target) continue;
    moved = true;
    door.amount = advanceDoor(door.amount, door.target, elapsedMs);
    if (door.kind === "door") {
      door.group.rotation.z = door.angle + door.amount * door.swingSign * Math.PI * 0.5;
    } else {
      door.group.position.copy(door.base).add(
        new THREE.Vector3(door.dirX, door.dirY, 0).multiplyScalar(door.amount * door.span * 0.78),
      );
    }
  }
  return moved;
}
