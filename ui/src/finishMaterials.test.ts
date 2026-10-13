import * as THREE from "three";
import { expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import { floorMaterialFor, wallMaterialFor } from "./finishMaterials";

function harness() {
  const finishes = createArchitecturalMaterials();
  const tracked: Array<THREE.Material | THREE.BufferGeometry | THREE.Texture> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T): T => {
    tracked.push(item);
    return item;
  };
  const dispose = () => {
    for (const resource of [...tracked, ...finishes.resources]) resource.dispose();
  };
  return { finishes, tracked, track, dispose };
}

it("keeps the house floor and paint when a room states no finish", () => {
  const { finishes, tracked, track, dispose } = harness();
  try {
    expect(floorMaterialFor(null, finishes, track)).toBe(finishes.floor);
    expect(floorMaterialFor(undefined, finishes, track)).toBe(finishes.floor);
    expect(wallMaterialFor("something_unknown", finishes, track)).toBe(finishes.wall);
    expect(tracked).toHaveLength(0);
  } finally {
    dispose();
  }
});

it("lays walnut parquet from the house walnut and tiles from a tracked tile texture", () => {
  const { finishes, tracked, track, dispose } = harness();
  try {
    expect(floorMaterialFor("walnut_parquet_tile", finishes, track)).toBe(finishes.joineryWood);
    const floor = floorMaterialFor("light_grey_tile", finishes, track);
    const wall = wallMaterialFor("grey_tile", finishes, track);
    expect(floor).not.toBe(finishes.floor);
    expect(wall).not.toBe(finishes.wall);
    expect(floor.map).toBeInstanceOf(THREE.DataTexture);
    expect(wall.side).toBe(THREE.DoubleSide);
    expect(tracked).toContain(floor);
    expect(tracked).toContain(floor.map);
  } finally {
    dispose();
  }
});
