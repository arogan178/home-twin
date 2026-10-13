import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import { renderDetailedBuildingObject } from "./cabinetryRendering";
import type { BuildingObject } from "./types";

const cases: Array<[string, number, number, number, string, string]> = [
  ["Dining table DT01", 800, 1400, 750, "table", "north"],
  ["Round dining table DT01", 1100, 1100, 750, "table", "north"],
  ["Dining chair DC01", 500, 500, 800, "chair", "east"],
  ["Dining chair DC02", 500, 500, 800, "chair", "west"],
  ["Breakfast bar stool BS01", 400, 400, 1000, "stool", "east"],
  ["Sofa back run", 2400, 850, 750, "", "north"],
  ["Japandi coffee table", 900, 450, 380, "", "north"],
];

describe("IFC furniture rendering", () => {
  it.each(cases)("keeps %s inside its IFC envelope with upright legs", (name, w, d, h, role, facing) => {
    const object: BuildingObject = {
      id: "test-furniture", ifc_class: "IfcFurniture", kind: "furniture", name, room_ids: ["room"],
      bounds: { minimum: { x: 1000, y: 2000, z: 1050 }, maximum: { x: 1000 + w, y: 2000 + d, z: 1050 + h } },
      properties: { "Pset_HomeTwinFurniture.Role": role, "Pset_HomeTwinFurniture.Facing": facing,
        "Pset_HomeTwinFurniture.Shape": name.startsWith("Round") ? "round" : "rounded_rectangle" },
    };
    const materials = createArchitecturalMaterials();
    const resources: Array<THREE.Material | THREE.BufferGeometry | THREE.Texture> = [];
    const track = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T): T => { resources.push(item); return item; };
    const group = new THREE.Group();
    try {
      expect(renderDetailedBuildingObject(object, materials, track, group)).toBe(true);
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(group);
      expect(bounds.min.x).toBeGreaterThanOrEqual(0.9999);
      expect(bounds.min.y).toBeGreaterThanOrEqual(1.9999);
      expect(bounds.min.z).toBeCloseTo(1.05, 4);
      expect(bounds.max.x).toBeLessThanOrEqual(1 + w / 1000 + 0.0001);
      expect(bounds.max.y).toBeLessThanOrEqual(2 + d / 1000 + 0.0001);
      expect(bounds.max.z).toBeLessThanOrEqual(1.05 + h / 1000 + 0.0001);
      let legs = 0;
      group.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry instanceof THREE.CylinderGeometry) {
          legs += 1;
          const leg = new THREE.Box3().setFromObject(child).getSize(new THREE.Vector3());
          expect(leg.z).toBeGreaterThan(leg.x);
          expect(leg.z).toBeGreaterThan(leg.y);
        }
      });
      expect(legs).toBe(4);
    } finally {
      for (const resource of [...resources, ...materials.resources]) resource.dispose();
    }
  });
});

describe("a table turned off the cardinal axes", () => {
  it("renders the oval at its bearing rather than as an axis-aligned box", () => {
    // The option A table: a 1200 x 2000 stadium on the 138 deg slanting-wall axis,
    // whose world box is therefore 1794 x 1735, not 1200 x 2000.
    const object: BuildingObject = {
      id: "DT01", ifc_class: "IfcFurniture", kind: "furniture", name: "Dining table DT01", room_ids: ["room"],
      bounds: { minimum: { x: 14096, y: 6610, z: 1050 }, maximum: { x: 15890, y: 8345, z: 1800 } },
      properties: {
        "Pset_HomeTwinFurniture.Role": "table",
        "Pset_HomeTwinFurniture.Shape": "oval",
        "Pset_HomeTwinFurniture.BearingDeg": 138,
        "Pset_HomeTwinFurniture.WidthMm": 1200,
        "Pset_HomeTwinFurniture.DepthMm": 2000,
      },
    };
    const materials = createArchitecturalMaterials();
    const resources: Array<THREE.Material | THREE.BufferGeometry | THREE.Texture> = [];
    const track = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T): T => { resources.push(item); return item; };
    const group = new THREE.Group();
    try {
      expect(renderDetailedBuildingObject(object, materials, track, group)).toBe(true);
      group.updateMatrixWorld(true);
      // Precise: a turned shape has to be measured from its vertices, not from the
      // rotated corners of its geometry's own box.
      const bounds = new THREE.Box3().setFromObject(group, true);
      expect(bounds.min.x).toBeGreaterThanOrEqual(14.095);
      expect(bounds.min.y).toBeGreaterThanOrEqual(6.609);
      expect(bounds.max.x).toBeLessThanOrEqual(15.891);
      expect(bounds.max.y).toBeLessThanOrEqual(8.346);
      // Turned, not merely shrunk: it fills the box it was given.
      expect(bounds.max.x - bounds.min.x).toBeCloseTo(1.794, 2);
      expect(bounds.max.y - bounds.min.y).toBeCloseTo(1.735, 2);
    } finally {
      for (const item of resources) item.dispose();
    }
  });
});

describe("the open/closed table toggle", () => {
  const materials = createArchitecturalMaterials();
  const render = (object: BuildingObject, closed: boolean) => {
    const resources: Array<THREE.Material | THREE.BufferGeometry | THREE.Texture> = [];
    const track = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T): T => { resources.push(item); return item; };
    const group = new THREE.Group();
    const drew = renderDetailedBuildingObject(object, materials, track, group, [], closed);
    group.updateMatrixWorld(true);
    const bounds = group.children.length > 0 ? new THREE.Box3().setFromObject(group, true) : null;
    for (const item of resources) item.dispose();
    return { drew, bounds, meshes: group.children.length };
  };

  const table: BuildingObject = {
    id: "DT01", ifc_class: "IfcFurniture", kind: "furniture", name: "Dining table DT01", room_ids: ["room"],
    bounds: { minimum: { x: 14096, y: 6610, z: 1050 }, maximum: { x: 15890, y: 8345, z: 1800 } },
    properties: {
      "Pset_HomeTwinFurniture.Role": "table", "Pset_HomeTwinFurniture.Shape": "oval",
      "Pset_HomeTwinFurniture.BearingDeg": 138, "Pset_HomeTwinFurniture.WidthMm": 1200,
      "Pset_HomeTwinFurniture.DepthMm": 2000, "Pset_HomeTwinFurniture.ClosedDepthMm": 1200,
    },
  };
  const chair = (extra: Record<string, unknown>): BuildingObject => ({
    id: "DC", ifc_class: "IfcFurniture", kind: "furniture", name: "Dining chair DC", room_ids: ["room"],
    bounds: { minimum: { x: 14100, y: 8100, z: 1050 }, maximum: { x: 14600, y: 8600, z: 1850 } },
    properties: { "Pset_HomeTwinFurniture.Role": "chair", "Pset_HomeTwinFurniture.BearingDeg": 273, ...extra },
  });

  it("shrinks the table to its closed size, keeping the same centre", () => {
    const open = render(table, false).bounds!;
    const closed = render(table, true).bounds!;
    expect(open.max.x - open.min.x).toBeCloseTo(1.794, 2);
    // A 1200 stadium closed to 1200 is a circle, so both world extents are 1.2.
    expect(closed.max.x - closed.min.x).toBeCloseTo(1.2, 2);
    expect(closed.max.y - closed.min.y).toBeCloseTo(1.2, 2);
    expect(closed.getCenter(new THREE.Vector3()).x).toBeCloseTo(open.getCenter(new THREE.Vector3()).x, 3);
    expect(closed.getCenter(new THREE.Vector3()).y).toBeCloseTo(open.getCenter(new THREE.Vector3()).y, 3);
  });

  it("stows a seat the closed table has no room for", () => {
    const stowed = chair({ "Pset_HomeTwinFurniture.ClosedSeat": false });
    expect(render(stowed, false).meshes).toBeGreaterThan(0);
    const shut = render(stowed, true);
    expect(shut.drew).toBe(true);
    expect(shut.meshes).toBe(0);
  });

  it("moves a kept seat to its authored closed place", () => {
    const moved = chair({
      "Pset_HomeTwinFurniture.ClosedSeat": true,
      "Pset_HomeTwinFurniture.ClosedCentreXMm": 14925,
      "Pset_HomeTwinFurniture.ClosedCentreYMm": 8196,
      "Pset_HomeTwinFurniture.ClosedBearingDeg": 273,
    });
    const centre = render(moved, true).bounds!.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(14.925, 2);
    expect(centre.y).toBeCloseTo(8.196, 2);
  });
});
