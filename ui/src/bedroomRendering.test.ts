import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import { parseBays, parseOutline, renderBedroomObject, runEdges } from "./bedroomRendering";
import { joineryLabels, joineryParts } from "./joineryGeometry";
import type { BuildingObject } from "./types";

function harness() {
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => {
    resources.push(item);
    return item;
  };
  const dispose = () => {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  };
  return { finishes, track, dispose };
}

it("draws the bed inside its authored envelope with the headboard on the wall side", () => {
  const object = {
    id: "bed",
    name: "Bed BD01",
    ifc_class: "IfcFurniture",
    kind: "furniture",
    room_ids: ["bedroom"],
    bounds: { minimum: { x: 13923, y: 16001, z: 1050 }, maximum: { x: 15543, y: 18081, z: 2150 } },
    properties: { "Pset_HomeTwinBedroom.Role": "bed", "Pset_HomeTwinBedroom.RotationDegrees": 180 },
  } as BuildingObject;
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderBedroomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.x).toBeGreaterThanOrEqual(13.923 - 1e-6);
    expect(bounds.max.x).toBeLessThanOrEqual(15.543 + 1e-6);
    expect(bounds.min.y).toBeGreaterThanOrEqual(16.001 - 1e-6);
    expect(bounds.max.y).toBeLessThanOrEqual(18.081 + 1e-6);
    expect(bounds.min.z).toBeCloseTo(1.05);
    // Only the headboard is full height, and a 180 degree bed puts it at min y.
    const tall = new THREE.Box3().setFromObject(
      group.children[0]!.children.find((child) => (child as THREE.Mesh).material === finishes.fabric)!,
    );
    expect(tall.max.z).toBeCloseTo(2.15);
    expect(tall.max.y).toBeCloseTo(16.081, 3);
  } finally {
    dispose();
  }
});

it("follows the scribed outline of a tapered wardrobe rather than its bounding box", () => {
  const object = {
    id: "wardrobe",
    name: "Wardrobe WR02",
    ifc_class: "IfcFurniture",
    kind: "cabinet",
    room_ids: ["bedroom"],
    bounds: { minimum: { x: 14733, y: 18681, z: 1050 }, maximum: { x: 16347, y: 19114.5, z: 3750 } },
    properties: {
      "Pset_HomeTwinBedroom.Role": "wardrobe",
      "Pset_HomeTwinBedroom.OutlineMm":
        "14733,18681;16347,18681;16347,19114.5;14733,18998.74",
    },
  } as BuildingObject;
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderBedroomObject(object, finishes, track, group)).toBe(true);
    const carcass = group.children[0] as THREE.Mesh;
    const position = carcass.geometry.getAttribute("position");
    const cornersAtWestEnd = [...Array(position.count).keys()]
      .filter((index) => Math.abs(position.getX(index) - 14.733) < 1e-6)
      .map((index) => position.getY(index));
    // The back of the run is 116 mm nearer the front at its west end than at its east.
    expect(Math.max(...cornersAtWestEnd)).toBeCloseTo(18.99874, 5);
    expect(new THREE.Box3().setFromObject(group).max.y).toBeCloseTo(19.1145, 4);
  } finally {
    dispose();
  }
});

it("reads a plan outline and rejects a malformed one", () => {
  expect(parseOutline("0,0;1000,0;1000,500")).toHaveLength(3);
  expect(parseOutline("0,0;1000,0")).toBeNull();
  expect(parseOutline("0,0;1000;1000,500")).toBeNull();
  expect(parseOutline(undefined)).toBeNull();
});

describe("parseBays", () => {
  it("reads a bay's fit-out, not just its width", () => {
    const bays = parseBays("long_hang@0+674.5|s=1486,1804|r=1468;return@674.5+600|d=266,514|v=670");
    expect(bays).not.toBeNull();
    expect(bays).toHaveLength(2);
    expect(bays![0]!.role).toBe("long_hang");
    expect(bays![0]!.shelves).toEqual([1.486, 1.804]);
    expect(bays![0]!.rails).toEqual([1.468]);
    expect(bays![0]!.divider).toBeNull();
    expect(bays![1]!.startM).toBeCloseTo(0.6745, 6);
    expect(bays![1]!.drawers).toEqual([0.266, 0.514]);
    expect(bays![1]!.divider).toBeCloseTo(0.67, 6);
  });

  it("refuses a malformed string rather than drawing half a run", () => {
    expect(parseBays("")).toBeNull();
    expect(parseBays("long_hang")).toBeNull();
    expect(parseBays(undefined)).toBeNull();
  });
});

describe("runEdges", () => {
  it("pairs the long edges of a tapered run so a board can span part of it", () => {
    // A run 2000 along x, its back sloping away by 100: the taper the north
    // wall puts on the wardrobe's return.
    const run = runEdges([
      new THREE.Vector2(0, 0),
      new THREE.Vector2(2, 0),
      new THREE.Vector2(2, 0.7),
      new THREE.Vector2(0, 0.6),
    ]);
    expect(run).not.toBeNull();
    expect(run!.alongY).toBe(false);
    expect(run!.lengthM).toBeCloseTo(2, 6);
    // Both edges must start at the same end, or a board spanning [0, t] twists.
    expect(run!.side[0]![0].x).toBeCloseTo(0, 6);
    expect(run!.side[1]![0].x).toBeCloseTo(0, 6);
    expect(run!.side[0]![1].x).toBeCloseTo(2, 6);
  });

  it("refuses an outline that is not a four-cornered run", () => {
    expect(runEdges([new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 1)])).toBeNull();
  });
});

it("draws a wardrobe open, with its fronts off, rather than as one solid slab", () => {
  const object = {
    id: "wr01",
    name: "Wardrobe WR01",
    ifc_class: "IfcFurniture",
    kind: "furniture",
    room_ids: ["bedroom"],
    bounds: { minimum: { x: 16347, y: 17051, z: 1050 }, maximum: { x: 16967, y: 18400, z: 3750 } },
    properties: {
      "Pset_HomeTwinBedroom.Role": "wardrobe",
      "Pset_HomeTwinBedroom.OutlineMm":
        "16967,17051;16347,17051;16347,18400;16967,18400",
      "Pset_HomeTwinBedroom.PlinthHeightMm": 80,
      "Pset_HomeTwinBedroom.Bays":
        "long_hang@0+674.5|s=1486,1804|r=1468;pull_down@674.5+674.5|s=1982|r=1964|d=266,514",
    },
  } as unknown as BuildingObject;
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderBedroomObject(object, finishes, track, group)).toBe(true);
    // Plinth, base, two ends, one divider, four boards and two rails: a solid
    // extrusion is two parts, and that is what made this read as a closed door.
    expect(joineryLabels(group).length).toBeGreaterThanOrEqual(10);
    // Drawn as one mesh a material, not one a board.
    let meshes = 0;
    group.traverse((child) => { if (child instanceof THREE.Mesh) meshes += 1; });
    expect(meshes).toBeLessThanOrEqual(5);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(1.05, 3);
    expect(bounds.max.z).toBeLessThanOrEqual(3.75 + 1e-6);
    expect(bounds.min.x).toBeGreaterThanOrEqual(16.347 - 1e-6);
    expect(bounds.max.x).toBeLessThanOrEqual(16.967 + 1e-6);
  } finally {
    dispose();
  }
});

it("falls back to a solid run when no bays are stated, rather than drawing nothing", () => {
  const object = {
    id: "wr9",
    name: "Wardrobe WR09",
    ifc_class: "IfcFurniture",
    kind: "furniture",
    room_ids: ["bedroom"],
    bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 600, y: 2000, z: 2000 } },
    properties: {
      "Pset_HomeTwinBedroom.Role": "wardrobe",
      "Pset_HomeTwinBedroom.OutlineMm": "0,0;600,0;600,2000;0,2000",
    },
  } as unknown as BuildingObject;
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderBedroomObject(object, finishes, track, group)).toBe(true);
    expect(group.children.length).toBe(2);
  } finally {
    dispose();
  }
});

it("keeps a sliding wardrobe's fit-out behind the 80 mm its tracks take, in the stated interior finish", () => {
  const object = {
    id: "wr01",
    name: "Wardrobe WR01",
    ifc_class: "IfcFurniture",
    kind: "cabinet",
    room_ids: ["bedroom"],
    bounds: { minimum: { x: 16347, y: 17051, z: 1050 }, maximum: { x: 16967, y: 18400, z: 3750 } },
    properties: {
      "Pset_HomeTwinBedroom.Role": "wardrobe",
      "Pset_HomeTwinBedroom.OutlineMm": "16967,17051;16347,17051;16347,18400;16967,18400",
      "Pset_HomeTwinBedroom.FrontBearingDeg": 180,
      "Pset_HomeTwinBedroom.PlinthHeightMm": 80,
      "Pset_HomeTwinBedroom.Front": "sliding_walnut_with_one_smoked_bronze_mirror_panel",
      "Pset_HomeTwinBedroom.InteriorFinish": "warm_linen_oak",
      "Pset_HomeTwinBedroom.Bays": "long_hang@0+674.5|s=1486|r=1468;pull_down@674.5+674.5|s=1982|r=1964|d=266,514",
    },
  } as unknown as BuildingObject;
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    renderBedroomObject(object, finishes, track, group);
    // The front faces west, so the shelves start 80 mm east of x = 16347.
    for (const shelf of joineryParts(group, "Shelf")) {
      expect(shelf.box.min.x).toBeCloseTo(16.427, 4);
      expect(shelf.material).toBe(finishes.linenOak);
    }
    expect(joineryParts(group, "Sliding track")).toHaveLength(2);
    expect(joineryParts(group, "Drawer front").map((part) => Math.round((part.box.max.z - part.box.min.z) * 1000))).toEqual([245, 245]);
    const [back] = joineryParts(group, "Back panel");
    expect(back!.box.max.x).toBeCloseTo(16.967, 4);
    expect(back!.box.max.x - back!.box.min.x).toBeCloseTo(0.008, 4);
    // Two ends of the run carry the walnut; the rest is the interior.
    expect(joineryParts(group, "End panel").every((part) => part.material === finishes.joineryWood)).toBe(true);
    expect(joineryParts(group, "Hanging rail").every((part) => part.material === finishes.chrome)).toBe(true);
  } finally {
    dispose();
  }
});

it("draws a bedside table as a carcass framing one inset drawer", () => {
  const object = {
    id: "bt01",
    name: "Bedside table BT01",
    ifc_class: "IfcFurniture",
    kind: "furniture",
    room_ids: ["bedroom"],
    bounds: { minimum: { x: 13106, y: 16020, z: 1390 }, maximum: { x: 13506, y: 16340, z: 1570 } },
    properties: { "Pset_HomeTwinBedroom.Role": "bedside_table", "Pset_HomeTwinBedroom.RotationDegrees": 180 },
  } as unknown as BuildingObject;
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    renderBedroomObject(object, finishes, track, group);
    const bounds = new THREE.Box3().setFromObject(group);
    expect([bounds.min.x, bounds.max.x, bounds.min.y, bounds.max.y, bounds.min.z, bounds.max.z].map((v) => +v.toFixed(4)))
      .toEqual([13.106, 13.506, 16.02, 16.34, 1.39, 1.57]);
    const [drawer] = joineryParts(group, "Drawer front");
    // 400 wide less two 18 mm sides and two 3 mm gaps; turned 180, so it faces +Y.
    expect((drawer!.box.max.x - drawer!.box.min.x) * 1000).toBeCloseTo(358, 3);
    expect(drawer!.box.max.y).toBeCloseTo(16.34, 4);
  } finally {
    dispose();
  }
});
