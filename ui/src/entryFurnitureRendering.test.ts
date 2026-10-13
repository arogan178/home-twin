import * as THREE from "three";
import { expect, it } from "vitest";
import { createArchitecturalMaterials } from "./architecturalMaterials";
import { renderEntryFurniture } from "./entryFurnitureRendering";
import type { BuildingObject } from "./types";

it("keeps the upholstered shoe bench within its native IFC envelope", () => {
  const object: BuildingObject = {
    id: "bench", name: "Shoe changing bench", ifc_class: "IfcFurniture", kind: "furniture", room_ids: [],
    bounds: { minimum: { x: 21450, y: 4900, z: 1050 }, maximum: { x: 22030, y: 5280, z: 1500 } },
    properties: { "Pset_HomeTwinFurniture.Role": "shoe_bench" },
  };
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    expect(renderEntryFurniture(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.x).toBeCloseTo(21.45, 4);
    expect(bounds.max.x).toBeCloseTo(22.03, 4);
    expect(bounds.min.y).toBeCloseTo(4.9, 4);
    expect(bounds.max.y).toBeCloseTo(5.28, 4);
    expect(bounds.min.z).toBeCloseTo(1.05, 4);
    expect(bounds.max.z).toBeCloseTo(1.5, 4);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});

it("renders a vented threshold cabinet from its authored pose", () => {
  const object: BuildingObject = {
    id: "cabinet", name: "Shoe changing bench", ifc_class: "IfcFurniture", kind: "furniture", room_ids: [],
    bounds: { minimum: { x: 500, y: 1500, z: 1050 }, maximum: { x: 1200, y: 2300, z: 1500 } },
    properties: {
      "Pset_HomeTwinFurniture.Role": "shoe_bench",
      "Pset_HomeTwinFurniture.WidthMm": 580,
      "Pset_HomeTwinFurniture.DepthMm": 380,
      "Pset_HomeTwinFurniture.HeightMm": 450,
      "Pset_HomeTwinFurniture.CentreXMm": 900,
      "Pset_HomeTwinFurniture.CentreYMm": 1900,
      "Pset_HomeTwinFurniture.RotationDegrees": 37,
      "Pset_HomeTwinFurniture.Vented": true,
    },
  };
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    expect(renderEntryFurniture(object, finishes, track, group)).toBe(true);
    const cabinet = group.children[0];
    if (cabinet === undefined) return;
    expect(cabinet).toBeInstanceOf(THREE.Group);
    expect(cabinet.rotation.z).toBeCloseTo(37 * Math.PI / 180, 6);
    expect(cabinet.children.length).toBeGreaterThan(4);
    expect(cabinet.children.some((child) => child instanceof THREE.Mesh && child.material === finishes.stainless)).toBe(true);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});
