import * as THREE from "three";
import { expect, it } from "vitest";
import { createArchitecturalMaterials } from "./architecturalMaterials";
import { renderConcealedCove } from "./coveRendering";
import { FixtureTagSchema, RoomIdSchema, type Fixture } from "./types";

it("puts the strip inside the reveal slot, on the side the wall is on", () => {
  const fixture: Extract<Fixture, { kind: "rope_light" }> = {
    id: "led", tag: FixtureTagSchema.parse("LED01"), kind: "rope_light", room_id: RoomIdSchema.parse("room"), switching_group: "COVE", notes: [],
    path: [{ x: 1000, y: 2000, z: 3650 }, { x: 3000, y: 2000, z: 3650 }],
    spec: { model: null, lumens_per_m: 1200, cct_kelvin: 3000, cri: 90, dimmable: true,
      diameter_mm: 16, minimum_bend_radius_mm: 60, mounting: "concealed" },
  };
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    // The wall lies to plan +Y of a run going along +X, so the strip leans -Y.
    const [emitter] = renderConcealedCove(fixture, finishes.stainless, finishes, track, group, { x: 0, y: 1 });
    group.updateMatrixWorld(true);
    expect(emitter).toBeDefined();
    if (!emitter) throw new Error("Missing emitter");
    const bounds = new THREE.Box3().setFromObject(emitter);
    // Above the 3.650 gypsum and below the 3.750 concrete: concealed in the slot.
    expect(bounds.min.z).toBeGreaterThan(3.65);
    expect(bounds.max.z).toBeLessThan(3.75);
    // Within the 70 mm slot, leaning off-centre away from the wall face.
    const centreY = (bounds.min.y + bounds.max.y) / 2;
    expect(centreY).toBeLessThan(2.0);
    expect(centreY).toBeGreaterThan(2.0 - 0.035);
    expect(bounds.min.x).toBeCloseTo(1);
    expect(bounds.max.x).toBeCloseTo(3);
    expect(emitter.userData.tag).toBe("LED01");
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});

it("draws nothing of the strip without the gypsum, and its profile still casts", () => {
  const fixture: Extract<Fixture, { kind: "rope_light" }> = {
    id: "led", tag: FixtureTagSchema.parse("LED01"), kind: "rope_light", room_id: RoomIdSchema.parse("room"), switching_group: "COVE", notes: [],
    path: [{ x: 1000, y: 2000, z: 3650 }, { x: 3000, y: 2000, z: 3650 }],
    spec: { model: null, lumens_per_m: 1200, cct_kelvin: 3000, cri: 90, dimmable: true,
      diameter_mm: 16, minimum_bend_radius_mm: 60, mounting: "concealed" },
  };
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    const emitters = renderConcealedCove(fixture, finishes.stainless, finishes, track, group, { x: 0, y: 1 }, false);
    const meshes: THREE.Mesh[] = [];
    group.traverse((node) => { if (node instanceof THREE.Mesh) meshes.push(node); });
    expect(emitters).toEqual([]);
    expect(meshes).toHaveLength(2);
    expect(meshes.map((mesh) => [(mesh.material as THREE.Material).colorWrite, mesh.castShadow])).toEqual([
      [false, true],
      [false, true],
    ]);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});
