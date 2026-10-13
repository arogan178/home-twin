import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import { joineryLabels, joineryParts } from "./joineryGeometry";
import { kitchenFronts, kitchenUnit, parseBays, renderKitchenObject } from "./kitchenRendering";
import type { BuildingObject } from "./types";

type Unit = {
  name: string;
  role: string;
  facing: string;
  front?: string;
  finish?: string;
  shape?: string;
  appliance?: string;
  edgeDepth?: number;
  box: readonly [number, number, number, number, number, number];
};

/** A real kitchen schedule, in the world bounds its cabinetry script publishes. */
const UNITS: Unit[] = [
  { name: "Sink base cabinet", role: "base", facing: "south", box: [17567, 9139, 1050, 18467, 9739, 1920] },
  { name: "Integrated dishwasher", role: "base", facing: "south", front: "integrated", appliance: "dishwasher",
    box: [16967, 9139, 1050, 17567, 9739, 1920] },
  { name: "Corner filler panel", role: "filler", facing: "south", front: "none",
    box: [18467, 9139, 1050, 18628, 9739, 1920] },
  { name: "Kitchen run stone worktop", role: "worktop", facing: "south", front: "none", finish: "stone",
    box: [16967, 9119, 1920, 18628, 9739, 1950] },
  { name: "Open display shelf", role: "shelf", facing: "south", front: "open",
    box: [16967, 9419, 2400, 18628, 9719, 2440] },
  { name: "Upper wall cabinet, west end", role: "wall", facing: "south",
    box: [16967, 9389, 2960, 17467, 9739, 3450] },
  { name: "Upper wall cabinets", role: "wall", facing: "south", box: [17467, 9389, 2960, 18628, 9739, 3450] },
  { name: "Appliance tower, microwave on a pull-out", role: "tall", facing: "west",
    box: [18628, 7039, 1050, 19228, 7639, 3450] },
  { name: "Built-in oven tower cabinet", role: "tall", facing: "west", appliance: "oven",
    box: [18628, 6439, 1050, 19228, 7039, 3450] },
  { name: "Fridge, Midea Insta-Fit MDRF705BIE70", role: "tall", facing: "west", front: "glass",
    finish: "grey_glass", appliance: "fridge", box: [18628, 5437, 1050, 19228, 6270, 2960] },
  { name: "Coffee bar cup shelf cabinet", role: "wall", facing: "west", front: "open",
    box: [18628, 7639, 2960, 19228, 8639, 3450] },
  { name: "Corner base cupboard, blind, pull-out", role: "base", facing: "south",
    box: [18628, 9119, 1050, 19228, 9739, 1920] },
  { name: "Kitchen island", role: "island", facing: "east", front: "drawers",
    box: [17028, 5739, 1050, 17628, 8139, 1920] },
  { name: "Island stone worktop", role: "worktop", facing: "east", front: "none", finish: "stone",
    box: [16728, 5739, 1920, 17628, 8139, 1950] },
  { name: "Island south support gable", role: "gable", facing: "south", front: "none",
    box: [16728, 5739, 1050, 17028, 5757, 1920] },
  { name: "Induction cooktop with integrated downdraft", role: "appliance", facing: "east", front: "none",
    finish: "glass", appliance: "cooktop", box: [17048, 6939, 1950, 17568, 7739, 1970] },
];

function buildingObject(unit: Unit): BuildingObject {
  const [x0, y0, z0, x1, y1, z1] = unit.box;
  return {
    id: unit.name, ifc_class: "IfcFurniture", kind: "cabinet", name: unit.name, room_ids: ["room"],
    bounds: { minimum: { x: x0, y: y0, z: z0 }, maximum: { x: x1, y: y1, z: z1 } },
    properties: {
      "Pset_HomeTwinKitchen.Role": unit.role,
      "Pset_HomeTwinKitchen.Facing": unit.facing,
      "Pset_HomeTwinKitchen.Front": unit.front ?? "doors",
      "Pset_HomeTwinKitchen.Finish": unit.finish ?? "wood",
      "Pset_HomeTwinKitchen.Shape": unit.shape ?? "box",
      "Pset_HomeTwinKitchen.EdgeDepth": unit.edgeDepth ?? null,
      "Pset_HomeTwinKitchen.Appliance": unit.appliance ?? null,
    },
  };
}

function render(object: BuildingObject) {
  const materials = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  const group = new THREE.Group();
  const claimed = renderKitchenObject(object, materials, track, group);
  group.updateMatrixWorld(true);
  const dispose = () => { for (const resource of [...resources, ...materials.resources]) resource.dispose(); };
  return { claimed, group, materials, dispose };
}

describe("kitchen unit rendering", () => {
  // Handles and control strips stand proud of the front face by design.
  const PROUD_MM = 40;

  it.each(UNITS.map((unit) => [unit.name, unit] as const))("keeps %s within its IFC envelope", (_name, unit) => {
    const object = buildingObject(unit);
    const { claimed, group, dispose } = render(object);
    try {
      expect(claimed).toBe(true);
      const bounds = new THREE.Box3().setFromObject(group);
      const { minimum, maximum } = object.bounds;
      expect(bounds.min.x * 1000).toBeGreaterThanOrEqual(minimum.x - PROUD_MM);
      expect(bounds.min.y * 1000).toBeGreaterThanOrEqual(minimum.y - PROUD_MM);
      expect(bounds.min.z * 1000).toBeGreaterThanOrEqual(minimum.z - 0.1);
      expect(bounds.max.x * 1000).toBeLessThanOrEqual(maximum.x + PROUD_MM);
      expect(bounds.max.y * 1000).toBeLessThanOrEqual(maximum.y + PROUD_MM);
      expect(bounds.max.z * 1000).toBeLessThanOrEqual(maximum.z + 10);
    } finally {
      dispose();
    }
  });

  it.each([
    ["south", "Sink base cabinet", "minY"],
    ["west", "Built-in oven tower cabinet", "minX"],
    ["east", "Kitchen island", "maxX"],
  ] as const)("puts a %s unit's fronts on its facing side", (_facing, name, edge) => {
    const object = buildingObject(UNITS.find((unit) => unit.name === name)!);
    const { group, dispose } = render(object);
    try {
      const fronts = [...joineryParts(group, "Door front"), ...joineryParts(group, "Drawer front")].map((part) => part.box);
      expect(fronts.length).toBeGreaterThan(0);
      const { minimum, maximum } = object.bounds;
      for (const box of fronts) {
        const centre = box.getCenter(new THREE.Vector3());
        const expected = { minY: minimum.y, minX: minimum.x, maxX: maximum.x }[edge] / 1000;
        expect(Math.abs((edge === "minY" ? centre.y : centre.x) - expected)).toBeLessThan(0.03);
      }
    } finally {
      dispose();
    }
  });

  it("stands a support gable on the floor under the full stone depth", () => {
    const unit = UNITS.find((candidate) => candidate.name === "Island south support gable")!;
    const { claimed, group, dispose } = render(buildingObject(unit));
    try {
      expect(claimed).toBe(true);
      const [gable] = joineryParts(group, "Support gable");
      const box = gable!.box;
      // No plinth recess: it carries the stone, so it reaches the floor.
      expect(box.min.z * 1000).toBeCloseTo(1050, 3);
      expect(box.max.z * 1000).toBeCloseTo(1920, 3);
      // It runs the full 300 mm the stone overhangs by.
      expect((box.max.x - box.min.x) * 1000).toBeCloseTo(300, 3);
    } finally {
      dispose();
    }
  });

  it("still sweeps a curved end when a unit asks for one", () => {
    // This schedule has no curved unit: a carpenter may not be able to
    // fabricate one. The shape stays a choice the type offers, so it
    // keeps its own cover rather than riding on a unit.
    const curved: Unit = { name: "Curved end wall cabinet", role: "wall", facing: "south", shape: "curved",
      box: [16967, 9389, 2960, 17467, 9739, 3450] };
    const { claimed, group, dispose } = render(buildingObject(curved));
    try {
      expect(claimed).toBe(true);
      const panel = group.getObjectByName("Curved end panel") as THREE.Mesh;
      expect(panel).toBeDefined();
      const box = new THREE.Box3().setFromObject(panel);
      expect((box.max.x - box.min.x) * 1000).toBeCloseTo(500, 0);
    } finally {
      dispose();
    }
  });

  it("cuts a worktop from stone and a carcass from walnut", () => {
    const worktop = render(buildingObject(UNITS.find((unit) => unit.name === "Kitchen run stone worktop")!));
    try {
      const [slab] = joineryParts(worktop.group, "Honed stone top");
      expect(slab!.material).toBe(worktop.materials.worktop);
    } finally {
      worktop.dispose();
    }
    const base = render(buildingObject(UNITS.find((unit) => unit.name === "Sink base cabinet")!));
    try {
      const [door] = joineryParts(base.group, "Door front");
      expect(door!.material).toBe(base.materials.joineryWood);
    } finally {
      base.dispose();
    }
  });

  it("raises the mixer tap above the worktop line", () => {
    const sink: Unit = { name: "Undermount kitchen sink with mixer tap", role: "appliance", facing: "south",
      front: "none", finish: "stainless", appliance: "sink", box: [17717, 9214, 1750, 18317, 9664, 1950] };
    const { claimed, group, dispose } = render(buildingObject(sink));
    try {
      expect(claimed).toBe(true);
      const bounds = new THREE.Box3().setFromObject(group);
      expect(bounds.max.z).toBeGreaterThan(1.95 + 0.25);
      // The gooseneck reaches forward over the basin rather than across it. The
      // tap's own lever and base widen it, so the reach is compared, not a ratio.
      const tap = group.getObjectByName("Curved mixer tap")!;
      const size = new THREE.Box3().setFromObject(tap).getSize(new THREE.Vector3());
      expect(size.y).toBeGreaterThan(size.x);
    } finally {
      dispose();
    }
  });

  it("hangs a built-up edge below the slab instead of thickening it", () => {
    const flat = UNITS.find((u) => u.name === "Kitchen run stone worktop")!;
    const plain = render(buildingObject(flat));
    try {
      const names = joineryLabels(plain.group);
      expect(names).not.toContain("Mitred edge rim");
    } finally {
      plain.dispose();
    }

    const island = UNITS.find((u) => u.name === "Island stone worktop")!;
    const { group, dispose } = render(buildingObject({ ...island, edgeDepth: 60 }));
    try {
      const names = joineryLabels(group);
      expect(names.filter((name) => name === "Mitred edge rim")).toHaveLength(4);
      // The stone is still 30 mm; the rim is what reads 60.
      const bounds = new THREE.Box3().setFromObject(group);
      expect((bounds.max.z - bounds.min.z) * 1000).toBeCloseTo(60, 0);
      expect(bounds.max.z).toBeCloseTo(1.95, 2);
    } finally {
      dispose();
    }
  });

  it("opens a run with a black gola channel rather than a grip cut into the front", () => {
    const tall = UNITS.find((u) => u.name === "Built-in oven tower cabinet")!;
    const { group, dispose } = render(buildingObject(tall));
    try {
      const names = joineryLabels(group);
      expect(names).toContain("Gola channel");
      expect(names).not.toContain("Vertical grip recess");
    } finally {
      dispose();
    }
  });

  it("runs the plinth the full width so a run reads as one line", () => {
    const base = UNITS.find((u) => u.name === "Sink base cabinet")!;
    const { group, dispose } = render(buildingObject(base));
    try {
      const [kick] = joineryParts(group, "Recessed toe kick");
      const size = kick!.box.getSize(new THREE.Vector3());
      // 900 wide unit: anything narrower leaves a break at every cabinet join.
      expect(size.x * 1000).toBeCloseTo(900, 0);
    } finally {
      dispose();
    }
  });

  it("carries the run plinth across the fridge so the line does not break", () => {
    const fridge = UNITS.find((u) => u.appliance === "fridge")!;
    const { group, dispose } = render(buildingObject(fridge));
    try {
      const [kick] = joineryParts(group, "Recessed toe kick");
      expect(kick).toBeDefined();
      const box = kick!.box;
      // Same 112 mm line - measured on site - and the same 833 mm width as the
      // housing either side of it.
      expect((box.max.z - box.min.z) * 1000).toBeCloseTo(112, 0);
      expect((box.max.y - box.min.y) * 1000).toBeCloseTo(833, 0);
      // And the doors start on that line rather than 75 mm below it.
      const lowest = Math.min(...joineryParts(group, "Grey glass fridge door").map((part) => part.box.min.z));
      expect(lowest).toBeGreaterThanOrEqual(box.max.z - 0.005);
    } finally {
      dispose();
    }
  });

  it("grips a tall door down its edge, not at its head", () => {
    const tall = UNITS.find((u) => u.name === "Appliance tower, microwave on a pull-out")!;
    const { group, dispose } = render(buildingObject(tall));
    try {
      const names = joineryLabels(group);
      expect(names).toContain("Gola edge channel");
      expect(names).not.toContain("Gola channel");
      const edge = joineryParts(group, "Gola edge channel")[0]!.box;
      // It runs the door, so it is reachable at any height.
      expect(edge.max.z - edge.min.z).toBeGreaterThan(2.0);
    } finally {
      dispose();
    }
  });

  it("closes the gap between the top drawer front and the stone", () => {
    const island = UNITS.find((u) => u.name === "Kitchen island")!;
    const { group, dispose } = render(buildingObject(island));
    try {
      const channel = joineryParts(group, "Gola channel")[0]!.box;
      const highest = Math.max(...joineryParts(group, "Drawer front").map((part) => part.box.max.z));
      // The channel is the opening, so it starts where the fronts stop: it must
      // not cut across the top drawer, and must not leave a slot above it.
      const clearance = channel.min.z - highest;
      expect(clearance).toBeGreaterThanOrEqual(0);
      expect(clearance).toBeLessThanOrEqual(0.03);
      expect(channel.max.z * 1000).toBeGreaterThan(1900);
    } finally {
      dispose();
    }
  });

  it("reads authored bays and draws the carcass open on request", () => {
    expect(parseBays("drawer@1162+1500;shelf@1500+1900")).toEqual([
      { z0: 1162, z1: 1500, kind: "drawer" },
      { z0: 1500, z1: 1900, kind: "shelf" },
    ]);
    // Malformed or absent text must not stop a run drawing at all.
    expect(parseBays("nonsense")).toEqual([]);
    expect(parseBays(null)).toEqual([]);

    const base = UNITS.find((u) => u.name === "Sink base cabinet")!;
    const object = buildingObject(base);
    object.properties["Pset_HomeTwinKitchen.Bays"] = "shelf@1162+1500;void@1500+1900";

    const shut = render(object);
    try {
      const names = joineryLabels(shut.group);
      expect(names).toContain("Door front");
      expect(names).not.toContain("Bay shelf");
    } finally {
      shut.dispose();
    }

    const materials = createArchitecturalMaterials();
    const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
    const group = new THREE.Group();
    renderKitchenObject(object, materials, (i) => { resources.push(i); return i; }, group, true);
    try {
      const names = joineryLabels(group);
      // Fronts off, insides on: that is the whole point of the mode.
      expect(names).not.toContain("Door front");
      expect(names.filter((n) => n === "Bay shelf")).toHaveLength(2);
      expect(names).toContain("Recessed toe kick");
    } finally {
      for (const item of resources) item.dispose();
    }
  });

  it("leaves an object without kitchen properties to the generic renderers", () => {
    const object: BuildingObject = {
      id: "tv", ifc_class: "IfcFurniture", kind: "furniture", name: "Television 65 inch", room_ids: ["room"],
      bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 1450, y: 60, z: 840 } },
      properties: {},
    };
    const { claimed, group, dispose } = render(object);
    try {
      expect(claimed).toBe(false);
      expect(group.children).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("splits a drawer bank on its authored bays, each drawer opened from a channel over it", () => {
    const unit = kitchenUnit(buildingObject({ name: "Coffee bar base drawers", role: "base", facing: "west", front: "drawers",
      box: [18628, 7537, 1050, 19228, 8519, 1920] }))!;
    const bays = [[1162, 1450], [1450, 1700], [1700, 1910]].map(([z0, z1]) => ({ kind: "drawer", z0: (z0! - 1050) / 1000, z1: (z1! - 1050) / 1000 }));
    const { fronts } = kitchenFronts(unit, 0.982, 0.87, bays);
    expect(fronts.map((f) => [f.kind, +f.z0.toFixed(4), +f.z1.toFixed(4), f.channel?.profile])).toEqual([
      ["drawer", 0.1135, 0.3655, "C"],
      ["drawer", 0.4015, 0.6155, "C"],
      ["drawer", 0.6515, 0.7965, "L"],
    ]);
    // A 3 mm shadow gap either side, not a 4 mm one.
    expect(fronts[0]!.x1 - fronts[0]!.x0).toBeCloseTo(0.979, 6);
    expect(fronts[2]!.channel!.z1).toBeCloseTo(0.855, 6);
  });

  it("hangs one full-height leaf on its stated hand and grips it on the other edge", () => {
    const object = buildingObject(UNITS.find((u) => u.name === "Appliance tower, microwave on a pull-out")!);
    object.properties["Pset_HomeTwinKitchen.Hinge"] = "right";
    const bays = [[1162, 1500, "pullout"], [1500, 1950, "pullout"], [1975, 2480, "pullout"], [2500, 3430, "shelf"]]
      .map(([z0, z1, kind]) => ({ kind: kind as string, z0: ((z0 as number) - 1050) / 1000, z1: ((z1 as number) - 1050) / 1000 }));
    const { fronts } = kitchenFronts(kitchenUnit(object)!, 0.6, 2.4, bays);
    expect(fronts).toHaveLength(1);
    const [door] = fronts;
    expect(door!.hinge).toBe("right");
    expect([door!.x0, door!.x1, door!.z0, door!.z1].map((v) => +v.toFixed(4))).toEqual([-0.2765, 0.2985, 0.1135, 2.3985]);
    expect(door!.channel).toEqual({ profile: "edge", x0: -0.3, x1: expect.closeTo(-0.278, 6), z0: 0.112, z1: 2.4 });

    object.properties["Pset_HomeTwinKitchen.Bays"] = "pullout@1162+1500;shelf@2500+3430";
    const materials = createArchitecturalMaterials();
    const group = new THREE.Group();
    renderKitchenObject(object, materials, (item) => item, group, true);
    const plates = joineryParts(group, "Hinge plate");
    // A 2.3 m leaf takes five hinges, all on the right as you face it: south, for a west-facing run.
    expect(plates).toHaveLength(5);
    for (const plate of plates) expect(plate.box.getCenter(new THREE.Vector3()).y).toBeLessThan(7.039 + 0.03);
  });

  it("puts the oven in its authored bay, drawers under it and a door over it", () => {
    const unit = kitchenUnit(buildingObject(UNITS.find((u) => u.appliance === "oven")!))!;
    const bays = [[1162, 1450, "drawer"], [1450, 1700, "drawer"], [1700, 1930, "drawer"], [1950, 2550, "appliance"],
      [2570, 3000, "shelf"], [3000, 3430, "shelf"]]
      .map(([z0, z1, kind]) => ({ kind: kind as string, z0: ((z0 as number) - 1050) / 1000, z1: ((z1 as number) - 1050) / 1000 }));
    const { fronts, appliance } = kitchenFronts(unit, 0.6, 2.4, bays);
    expect(appliance).toEqual({ z0: expect.closeTo(0.9, 6), z1: expect.closeTo(1.5, 6) });
    expect(fronts.map((f) => [f.kind, +f.z0.toFixed(4), +f.z1.toFixed(4), f.channel?.profile])).toEqual([
      ["drawer", 0.1135, 0.3655, "C"],
      ["drawer", 0.4015, 0.6155, "C"],
      ["drawer", 0.6515, 0.8215, "L"],
      ["door", 1.5215, 2.3985, "edge"],
    ]);
  });

  it("closes a blind face flush and lifts a flap with no grip", () => {
    const blind = kitchenUnit(buildingObject({ name: "Corner store, blind", role: "wall", facing: "west", front: "none",
      box: [18628, 9119, 2400, 19228, 9739, 3450] }))!;
    expect(kitchenFronts(blind, 0.62, 1.05, []).fronts.map((f) => [f.kind, f.channel])).toEqual([["blind", null]]);
    const flap = kitchenUnit(buildingObject({ name: "Toaster garage", role: "wall", facing: "west", front: "lift",
      box: [18628, 9119, 1950, 19228, 9739, 2400] }))!;
    expect(kitchenFronts(flap, 0.62, 0.45, []).fronts.map((f) => [f.kind, f.hinge, f.grip])).toEqual([["flap", "top", "none"]]);
  });

  it("draws a unit as one mesh per material, not one per board", () => {
    const { group, dispose } = render(buildingObject(UNITS.find((u) => u.name === "Kitchen island")!));
    try {
      let meshes = 0;
      group.traverse((child) => { if (child instanceof THREE.Mesh) meshes += 1; });
      // Walnut, the dark plinth and interior, and the anodised channel.
      expect(meshes).toBe(3);
      // Three columns of three across the 2.4 m bank the test authors without bays.
      expect(joineryParts(group, "Drawer front")).toHaveLength(9);
    } finally {
      dispose();
    }
  });
});
