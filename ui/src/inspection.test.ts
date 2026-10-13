import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { describeInspection, inspectTargetOf, markInspectable, propertyRows, sameTarget } from "./inspection";
import type { BuildingObject, Opening, Wall } from "./types";

const cabinet: BuildingObject = {
  id: "219ANWNmTB7PKQu$mYPXhC",
  ifc_class: "IfcFurniture",
  kind: "cabinet",
  name: "Appliance tower",
  room_ids: ["room"],
  bounds: { minimum: { x: 18628, y: 6937, z: 1050 }, maximum: { x: 19228, y: 7537, z: 3450 } },
  properties: {
    "Pset_HomeTwinKitchen.Role": "tall",
    Tag: "KIT-T2",
    Name: "Appliance tower",
    "Pset_HomeTwin.ObjectKind": "cabinet",
  },
};

const wall: Wall = {
  wall_id: "3xWall",
  start: { x: 0, y: 0 },
  end: { x: 3000, y: 4000 },
  inward_normal: { x: 0, y: 1, z: 0 },
  thickness_mm: 115,
};

const door: Opening = {
  id: "0Door",
  name: "Kitchen door",
  kind: "door",
  room_ids: ["room"],
  host_wall_id: "3xWall",
  start: { x: 0, y: 0 },
  end: { x: 0, y: 820 },
  sill_height_mm: 0,
  head_height_mm: 2100,
  exposure: "internal",
  evidence: "traced",
  swing: "inward",
};

const sources = { objects: [cabinet], walls: [wall], openings: [door], stairs: [], floorElevationMm: 1050 };

describe("inspection", () => {
  it("reads an object's identity, IFC bounds and property sets", () => {
    const details = describeInspection({ kind: "object", id: cabinet.id }, sources);
    expect(details?.globalId).toBe("219ANWNmTB7PKQu$mYPXhC");
    expect(details?.tag).toBe("KIT-T2");
    expect(details?.facts[0]?.value).toBe("600 × 600 × 2,400 mm");
    expect(details?.facts[1]?.value).toBe("0 mm");
    expect(details?.properties.map((row) => row.group)).toEqual([
      "Attributes",
      "Attributes",
      "Pset_HomeTwin",
      "Pset_HomeTwinKitchen",
    ]);
  });

  it("reads a wall face and an opening", () => {
    const face = describeInspection({ kind: "wall", id: "3xWall" }, sources);
    expect(face?.facts[0]?.value).toBe("5,000 mm");
    expect(face?.facts.at(-1)?.value).toBe("1");
    const opening = describeInspection({ kind: "opening", id: "0Door" }, sources);
    expect(opening?.facts.map((fact) => fact.value)).toEqual(["820 mm", "0 mm", "2,100 mm", "inward"]);
  });

  it("returns nothing for an element the payload no longer holds", () => {
    expect(describeInspection({ kind: "stair", id: "gone" }, sources)).toBeNull();
  });

  it("marks a drawn object's meshes without overwriting a nested claim", () => {
    const root = new THREE.Group();
    const panel = new THREE.Mesh();
    const handle = new THREE.Mesh();
    handle.userData.inspect = { kind: "opening", id: "0Door" };
    root.add(panel, handle);
    markInspectable(root, { kind: "object", id: cabinet.id });
    expect(inspectTargetOf(panel.userData)).toEqual({ kind: "object", id: cabinet.id });
    expect(inspectTargetOf(handle.userData)).toEqual({ kind: "opening", id: "0Door" });
    expect(inspectTargetOf({ inspect: { kind: "furniture", id: "x" } })).toBeNull();
    expect(sameTarget({ kind: "wall", id: "a" }, { kind: "wall", id: "a" })).toBe(true);
  });

  it("formats property values for reading", () => {
    expect(propertyRows({ "Pset_A.Width": 600, "Pset_A.Ratio": 0.33333, "Pset_A.Lip": true })).toEqual([
      { group: "Pset_A", name: "Width", value: "600" },
      { group: "Pset_A", name: "Ratio", value: "0.333" },
      { group: "Pset_A", name: "Lip", value: "Yes" },
    ]);
  });
});
