import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  addPendant,
  addSpotlight,
  addSwitch,
  createFixtureMaterials,
  hiddenInCeilingVoid,
  pendantShadeCentre,
} from "./fixtureRendering";
import type { Fixture, WallSwitch } from "./types";

const keep = <T,>(value: T) => value;
const materials = createFixtureMaterials(keep);
const lamp = new THREE.MeshBasicMaterial();

const spotlight = {
  kind: "recessed_spotlight",
  tag: "SP01",
  room_id: "room",
  point: { x: 1000, y: 2000, z: 3450 },
  switching_group: "MAIN",
  direction: { x: 0, y: 0, z: -1 },
  notes: [],
  spec: {
    model: null,
    lumens: 575,
    beam_angle_deg: 60,
    cct_kelvin: 3000,
    cri: 90,
    dimmable: true,
    diameter_mm: 95,
    cutout_diameter_mm: 80,
    mounting_depth_mm: 90,
    ies_path: null,
    peak_candela: null,
  },
} as unknown as Extract<Fixture, { kind: "recessed_spotlight" }>;

const pendant = {
  kind: "pendant_bulb",
  tag: "PEN01",
  room_id: "room",
  point: { x: 0, y: 0, z: 3650 },
  switching_group: "DINING",
  notes: [],
  spec: {
    model: null,
    lumens: 1400,
    cct_kelvin: 2700,
    cri: 90,
    dimmable: true,
    drop_mm: 900,
    canopy_diameter_mm: 100,
    canopy_depth_mm: 30,
    bulb_diameter_mm: 420,
    ies_path: null,
  },
} as unknown as Extract<Fixture, { kind: "pendant_bulb" }>;

function bounds(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

describe("addSpotlight", () => {
  it("stands only its trim below the ceiling and puts the can in the void when the void is drawn", () => {
    const group = new THREE.Group();
    const handles = addSpotlight(group, spotlight, lamp, materials, keep, true);
    const box = bounds(group);
    // 3 mm of trim below a 3450 mm ceiling, and the 90 mm mounting depth above it.
    expect(box.min.z).toBeCloseTo(3.447, 6);
    expect(box.max.z).toBeCloseTo(3.54, 6);
    expect(box.max.x - box.min.x).toBeCloseTo(0.095, 3);
    expect(handles.map((mesh) => mesh.userData.tag)).toEqual(["SP01", "SP01"]);
  });

  it("closes at the ceiling plane with a trim-sized cap while the void is not drawn", () => {
    const group = new THREE.Group();
    const handles = addSpotlight(group, spotlight, lamp, materials, keep);
    // Only the 30 mm baffle rises above the ceiling plane; no can floats there.
    expect(bounds(group).max.z).toBeCloseTo(3.48, 6);
    const cap = handles[1]!;
    expect(cap.material).toBe(materials.cap);
    expect(cap.position.z).toBeCloseTo(3.48, 6);
    expect(bounds(cap).max.x - bounds(cap).min.x).toBeCloseTo(0.095, 3);
  });

  it("sets the lamp up inside the baffle instead of below the trim", () => {
    const group = new THREE.Group();
    addSpotlight(group, spotlight, lamp, materials, keep);
    const face = group.children.find((child) => child instanceof THREE.Mesh && child.material === lamp)!;
    expect(face.position.z).toBeCloseTo(3.479, 6);
  });
});

describe("addSpotlight with a stated aim", () => {
  const k2 = {
    ...spotlight,
    tag: "K2",
    point: { x: 18128, y: 7739, z: 3650 },
    direction: { x: 0.42261826174069944, y: 0, z: -0.9063077870366499 },
    spec: { ...spotlight.spec, model: "Radium RL-PAR16 80 DIM 930/60°/GU10 (44020758), 6.5 W, 50 x 54 mm", diameter_mm: 90, mounting_depth_mm: 60 },
  } as typeof spotlight;

  it("tilts the lamp cup and its lens onto the beam direction inside the trim", () => {
    const group = new THREE.Group();
    const [, cup] = addSpotlight(group, k2, lamp, materials, keep);
    const axis = new THREE.Vector3(0, 0, -1).applyQuaternion(cup!.quaternion);
    expect(axis.x).toBeCloseTo(0.422618, 6);
    expect(axis.y).toBeCloseTo(0, 9);
    expect(axis.z).toBeCloseTo(-0.906308, 6);
    const lens = group.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh && child.material === lamp)!;
    const facing = new THREE.Vector3().fromBufferAttribute(lens.geometry.getAttribute("normal"), 0).applyQuaternion(lens.quaternion);
    expect(facing.x).toBeCloseTo(0.422618, 6);
    expect(facing.z).toBeCloseTo(-0.906308, 6);
    // The tilted cup stays above the ceiling plane and inside the 80 mm cut-out.
    const reach = bounds(cup!);
    expect(reach.min.z).toBeGreaterThan(3.65);
    expect(reach.max.x - 18.128).toBeLessThan(0.036);
    expect(bounds(group).min.z).toBeCloseTo(3.647, 6);
  });
});

describe("addPendant", () => {
  it("hangs the shade on a cord that runs from the ceiling rose to the shade", () => {
    const group = new THREE.Group();
    const handles = addPendant(group, pendant, new THREE.MeshStandardMaterial(), materials, keep);
    const box = bounds(group);
    expect(box.max.z).toBeCloseTo(3.65, 6);
    // The shade's centre is the drop below the ceiling point, so its foot is a radius lower.
    expect(box.min.z).toBeCloseTo(2.54, 6);
    expect(pendantShadeCentre(pendant).toArray()).toEqual([0, 0, 2.75]);
    const cord = group.children.find((child) => child instanceof THREE.Mesh && child.material === materials.cord)!;
    const run = bounds(cord);
    expect(run.max.z).toBeCloseTo(3.62, 6);
    expect(run.min.z).toBeCloseTo(2.98, 6);
    expect(handles.map((mesh) => mesh.userData.tag)).toEqual(["PEN01", "PEN01"]);
  });
});

describe("addSwitch", () => {
  it("lays the plate along its wall and tags it with the group it previews", () => {
    const device = {
      tag: "SW01",
      switching_group: "MAIN",
      spec: { kind: "toggle", width_mm: 86, height_mm: 86, depth_mm: 10 },
    } as WallSwitch;
    const group = new THREE.Group();
    const plate = addSwitch(
      group,
      device,
      { start: { x: 0, y: 0 }, end: { x: 0, y: 4000 } },
      { x: 0, y: 1000, z: 2100 },
      materials.trim,
      materials.trim,
      keep,
    );
    expect(plate.rotation.z).toBeCloseTo(Math.PI / 2, 9);
    expect(plate.userData).toEqual({ switchTag: "SW01", controlGroup: "MAIN" });
    const box = bounds(plate);
    expect(box.max.y - box.min.y).toBeCloseTo(0.086, 6);
    expect(box.max.x - box.min.x).toBeCloseTo(0.01, 6);
  });
});

describe("hiddenInCeilingVoid", () => {
  const duct = { bounds: { minimum: { x: 0, y: 0, z: 3510 }, maximum: { x: 1, y: 1, z: 3690 } } };
  const fan = { bounds: { minimum: { x: 0, y: 0, z: 3425 }, maximum: { x: 1, y: 1, z: 3550 } } };

  it("hides a duct above a 3450 mm ceiling only while the gypsum is off", () => {
    expect(hiddenInCeilingVoid(duct, 3450, false)).toBe(true);
    expect(hiddenInCeilingVoid(duct, 3450, true)).toBe(false);
  });

  it("keeps a fan whose grille comes through the ceiling", () => {
    expect(hiddenInCeilingVoid(fan, 3450, false)).toBe(false);
  });
});
