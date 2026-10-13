import * as THREE from "three";
import { expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import { addTap, sweptSection, tapPlacement } from "./tapGeometry";
import type { BuildingObject } from "./types";

function tap(outline: Array<{ x: number; y: number }>, z0: number, z1: number): BuildingObject {
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  return {
    id: "tap", name: "tap", ifc_class: "IfcValve", kind: "sanitary_fixture", room_ids: [],
    bounds: { minimum: { x: Math.min(...xs), y: Math.min(...ys), z: z0 }, maximum: { x: Math.max(...xs), y: Math.max(...ys), z: z1 } },
    properties: {},
    plan_footprint: { outer: outline, holes: [] },
  };
}

it("finds a turned tap's body axis and reach from its plan outline", () => {
  // A 60 mm body with a 150 mm reach, turned 45 degrees about an axis at (1000, 2000).
  const turn = Math.PI / 4;
  const local = [{ x: -30, y: -150 }, { x: 30, y: -150 }, { x: 30, y: 30 }, { x: -30, y: 30 }];
  const outline = local.map((p) => ({
    x: 1000 + p.x * Math.cos(turn) - p.y * Math.sin(turn),
    y: 2000 + p.x * Math.sin(turn) + p.y * Math.cos(turn),
  }));
  const placement = tapPlacement(tap(outline, 1950, 2150), turn);
  expect(placement.position.x).toBeCloseTo(1, 6);
  expect(placement.position.y).toBeCloseTo(2, 6);
  expect(placement.position.z).toBeCloseTo(1.95, 6);
  expect(placement.envelope.bodyRadius).toBeCloseTo(0.03, 6);
  expect(placement.envelope.reach).toBeCloseTo(0.15, 6);
  expect(placement.envelope.height).toBeCloseTo(0.2, 6);
});

it("sweeps a closed spout whose faces point outward", () => {
  const path = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.1, 0));
  const section = (t: number) => {
    const close = t > 0.9 ? Math.sqrt(Math.max(0, 1 - ((t - 0.9) / 0.1) ** 2)) : 1;
    return { halfWidth: 0.012 * close, halfHeight: 0.008 * close };
  };
  const geometry = sweptSection(path, section, [0, 0.5, 0.9, 0.95, 1], 16, 2);
  try {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.x).toBeCloseTo(0.012, 6);
    expect(box.max.z).toBeCloseTo(0.008, 6);
    expect(box.min.y).toBeCloseTo(-0.1, 6);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    const down = new THREE.Raycaster(new THREE.Vector3(0, -0.05, 1), new THREE.Vector3(0, 0, -1));
    const hit = down.intersectObject(mesh)[0];
    expect(hit?.point.z).toBeCloseTo(0.008, 6);
    expect(hit?.face?.normal.z).toBeCloseTo(1, 1);
    // The tip is closed: a ray along the axis from in front meets the nose.
    const back = new THREE.Raycaster(new THREE.Vector3(0.001, -1, 0.001), new THREE.Vector3(0, 1, 0));
    expect(back.intersectObject(mesh)[0]?.point.y).toBeCloseTo(-0.1, 2);
  } finally {
    geometry.dispose();
  }
});

it("shares one geometry and material between two identical taps in a build", () => {
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    const envelope = { bodyRadius: 0.0225, reach: 0.17, height: 0.32 };
    const spec = { model: "grohe-euroeco-xl" as const, envelope, finish: "chrome" as const, rotation: Math.PI / 2 };
    const [first] = addTap(finishes, track, group, { ...spec, name: "TAP01", position: new THREE.Vector3(13.958, 10.8135, 1.9) });
    const [second] = addTap(finishes, track, group, { ...spec, name: "TAP02", position: new THREE.Vector3(14.314, 14.424, 1.9) });
    expect(second?.geometry).toBe(first?.geometry);
    expect(second?.material).toBe(first?.material);
    expect(group.children).toHaveLength(4);
    // Two geometries and three materials (chrome, gun metal, outlet insert) for the pair.
    expect(resources).toHaveLength(5);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});

it("keeps the generic mixer inside an unnamed tap's envelope", () => {
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    addTap(finishes, track, group, {
      model: "generic-mixer", envelope: { bodyRadius: 0.03, reach: 0.15, height: 0.2 }, finish: "chrome",
      name: "TAP03", position: new THREE.Vector3(0, 0, 0), rotation: 0,
    });
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(0, 6);
    expect(bounds.max.z).toBeCloseTo(0.2, 6);
    expect(bounds.min.y).toBeCloseTo(-0.15, 3);
    expect(bounds.max.y).toBeCloseTo(0.03, 3);
    expect(bounds.max.x).toBeCloseTo(0.03, 3);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});
