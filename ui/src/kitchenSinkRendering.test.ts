import * as THREE from "three";
import { expect, it } from "vitest";
import { createArchitecturalMaterials } from "./architecturalMaterials";
import { joineryParts } from "./joineryGeometry";
import { renderSinkSurround } from "./kitchenSinkRendering";
import type { BuildingObject } from "./types";

it("leaves a real opening through the worktop and cabinet above the sink", () => {
  const object = (name: string, role: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BuildingObject => ({
    id: name, name, ifc_class: "IfcFurniture", kind: "furniture", room_ids: [],
    bounds: { minimum: { x: x0, y: y0, z: z0 }, maximum: { x: x1, y: y1, z: z1 } },
    properties: { "Pset_HomeTwinKitchen.Role": role },
  });
  const top = object("Top", "worktop", 16967, 9119, 1920, 18628, 9739, 1950);
  const base = object("Base", "base", 17567, 9139, 1050, 18467, 9739, 1920);
  const sink = object("Sink", "appliance", 17717, 9214, 1750, 18317, 9664, 1950);
  sink.properties["Pset_HomeTwinKitchen.Appliance"] = "sink";
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    for (const obj of [top, base]) expect(renderSinkSurround(obj, [sink], finishes, track, group)).toBe(true);
    group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(18.017, 9.439, 2), new THREE.Vector3(0, 0, -1), 0, 0.25);
    expect(ray.intersectObject(group, true)).toHaveLength(0);
    ray.ray.origin.x = 17.2;
    expect(ray.intersectObject(group, true).length).toBeGreaterThan(0);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});

it("rounds the aperture worktop's arris inside its authored envelope", () => {
  const object = (name: string, role: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BuildingObject => ({
    id: name, name, ifc_class: "IfcFurniture", kind: "furniture", room_ids: [],
    bounds: { minimum: { x: x0, y: y0, z: z0 }, maximum: { x: x1, y: y1, z: z1 } },
    properties: { "Pset_HomeTwinKitchen.Role": role },
  });
  const top = object("Top", "worktop", 16967, 9119, 1920, 18628, 9739, 1950);
  const sink = object("Sink", "appliance", 17717, 9214, 1750, 18317, 9664, 1950);
  sink.properties["Pset_HomeTwinKitchen.Appliance"] = "sink";
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    renderSinkSurround(top, [sink], finishes, track, group);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.x).toBeCloseTo(16.967, 6);
    expect(bounds.max.x).toBeCloseTo(18.628, 6);
    expect(bounds.min.y).toBeCloseTo(9.119, 6);
    expect(bounds.max.y).toBeCloseTo(9.739, 6);
    expect(bounds.min.z).toBeCloseTo(1.92, 6);
    expect(bounds.max.z).toBeCloseTo(1.95, 6);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});

it("fronts the sink base like the rest of the run: 112 mm kick, paired doors and a gola under the stone", () => {
  const base: BuildingObject = {
    id: "KIT-B2", name: "Sink base cabinet", ifc_class: "IfcFurniture", kind: "cabinet", room_ids: [],
    bounds: { minimum: { x: 17567, y: 9139, z: 1050 }, maximum: { x: 18628, y: 9739, z: 1920 } },
    properties: {
      "Pset_HomeTwinKitchen.Role": "base", "Pset_HomeTwinKitchen.Facing": "south", "Pset_HomeTwinKitchen.Front": "doors",
      "Pset_HomeTwinKitchen.Hinge": "pair", "Pset_HomeTwinKitchen.Bays": "shelf@1162+1500;void@1500+1900",
    },
  };
  const sink = {
    id: "KIT-S1", name: "Sink", ifc_class: "IfcFurniture", kind: "furniture", room_ids: [],
    bounds: { minimum: { x: 17717, y: 9214, z: 1750 }, maximum: { x: 18317, y: 9664, z: 1950 } },
    properties: { "Pset_HomeTwinKitchen.Role": "appliance", "Pset_HomeTwinKitchen.Appliance": "sink" },
  } as BuildingObject;
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const group = new THREE.Group();
    expect(renderSinkSurround(base, [sink], finishes, track, group)).toBe(true);
    const [kick] = joineryParts(group, "Recessed toe kick");
    expect((kick!.box.max.z - kick!.box.min.z) * 1000).toBeCloseTo(112, 3);
    const doors = joineryParts(group, "Door front").map((part) => part.box);
    expect(doors).toHaveLength(2);
    // Two leaves meeting on a 3 mm gap, faced south on the run's front plane.
    expect((doors[1]!.min.x - doors[0]!.max.x) * 1000).toBeCloseTo(3, 3);
    for (const door of doors) expect(door.min.y).toBeCloseTo(9.139, 4);
    expect(joineryParts(group, "Gola channel")).toHaveLength(2);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});
