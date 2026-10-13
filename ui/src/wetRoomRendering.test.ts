import * as THREE from "three";
import { expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import type { BuildingObject } from "./types";
import { corrugatedTube, renderWetRoomObject } from "./wetRoomRendering";
import { parseRoute } from "./serviceRoutes";

it("renders a bath inside its native IFC envelope", () => {
  const object: BuildingObject = {
    id: "bath",
    name: "Bath BATH01",
    ifc_class: "IfcSanitaryTerminal",
    kind: "sanitary_fixture",
    room_ids: ["bathroom"],
    bounds: { minimum: { x: 14000, y: 9000, z: 1050 }, maximum: { x: 15500, y: 9700, z: 1600 } },
    properties: { "Pset_HomeTwinWetRoom.Role": "bath" },
  };
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => {
    resources.push(item);
    return item;
  };
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.x).toBeGreaterThanOrEqual(14 - 1e-6);
    expect(bounds.max.x).toBeLessThanOrEqual(15.5 + 1e-6);
    expect(bounds.min.y).toBeGreaterThanOrEqual(9 - 1e-6);
    expect(bounds.max.y).toBeLessThanOrEqual(9.7 + 1e-6);
    expect(bounds.min.z).toBeCloseTo(1.05);
    expect(bounds.max.z).toBeCloseTo(1.6);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});

it("gives the shower a visible tray, glass sides, riser, and head", () => {
  const object = {
    id: "shower",
    name: "Shower SH01",
    ifc_class: "IfcSanitaryTerminal",
    kind: "sanitary_fixture",
    room_ids: ["ensuite"],
    bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 1100, y: 700, z: 2000 } },
    properties: { "Pset_HomeTwinWetRoom.Role": "shower" },
  } as BuildingObject;
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => {
    resources.push(item);
    return item;
  };
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    expect(group.children.length).toBeGreaterThanOrEqual(6);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});

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

function wetRoomObject(
  role: string,
  bounds: BuildingObject["bounds"],
  extra: Record<string, unknown> = {},
  plan_footprint: BuildingObject["plan_footprint"] = null,
): BuildingObject {
  return {
    id: role,
    name: role,
    ifc_class: "IfcFurniture",
    kind: "furniture",
    room_ids: ["room"],
    bounds,
    properties: { "Pset_HomeTwinWetRoom.Role": role, ...extra },
    plan_footprint,
  };
}

it("stands a turned cupboard on its own plan outline rather than its bounding box", () => {
  // A 600 by 350 unit at 45 degrees: its box is 672 square, its outline is not.
  const outline = [
    { x: 5064, y: 600 },
    { x: 5400, y: 264 },
    { x: 5736, y: 600 },
    { x: 5400, y: 936 },
  ];
  const object = wetRoomObject(
    "tall_cupboard",
    { minimum: { x: 5064, y: 264, z: 0 }, maximum: { x: 5736, y: 936, z: 2100 } },
    { "Pset_HomeTwinWetRoom.Finish": "walnut", "Pset_HomeTwinWetRoom.RotationDegrees": 45 },
    { outer: outline, holes: [] },
  );
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(0);
    expect(bounds.max.z).toBeCloseTo(2.1);
    expect(bounds.max.x).toBeLessThanOrEqual(5.736 + 1e-6);
    const corner = new THREE.Raycaster(new THREE.Vector3(5.1, 0.3, 1), new THREE.Vector3(0, 0, 1));
    expect(corner.intersectObjects(group.children, true)).toHaveLength(0);
    const centre = new THREE.Raycaster(new THREE.Vector3(5.4, 0.6, -1), new THREE.Vector3(0, 0, 1));
    expect(centre.intersectObjects(group.children, true).length).toBeGreaterThan(0);
  } finally {
    dispose();
  }
});

it("draws a flexible duct as a tube along its stored route", () => {
  const object = wetRoomObject(
    "duct",
    { minimum: { x: 14910, y: 11750, z: 3550 }, maximum: { x: 15010, y: 12169, z: 3650 } },
    { "Pset_HomeTwinWetRoom.RouteMm": "14960,11800,3550;14960,11800,3600;14960,12169,3600" },
  );
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.y).toBeCloseTo(11.75, 1);
    expect(bounds.max.y).toBeCloseTo(12.169, 1);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(0.1, 1);
    expect((group.children[0] as THREE.Mesh).geometry).toBeInstanceOf(THREE.TubeGeometry);
  } finally {
    dispose();
  }
});

it("rejects a malformed route and falls back to the envelope", () => {
  expect(parseRoute("1,2;3,4")).toBeNull();
  expect(parseRoute("")).toBeNull();
  expect(parseRoute(undefined)).toBeNull();
  expect(parseRoute("0,0,0;1000,0,0")?.[1]?.x).toBeCloseTo(1);
});

it("counts one duct ridge every 10 mm along the run", () => {
  const tube = corrugatedTube(new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)), 0.05);
  try {
    const uv = tube.getAttribute("uv");
    const along = Array.from({ length: uv.count }, (_, index) => uv.getX(index));
    expect(Math.min(...along)).toBe(0);
    expect(Math.max(...along)).toBeCloseTo(100, 6);
  } finally {
    tube.dispose();
  }
});

it("hangs a backlit round mirror flat on its wall", () => {
  const object = wetRoomObject(
    "mirror",
    { minimum: { x: 13902, y: 10341, z: 2250 }, maximum: { x: 13932, y: 11041, z: 2950 } },
    { "Pset_HomeTwinWetRoom.RotationDegrees": 90, "Pset_HomeTwinWetRoom.BacklightCctKelvin": 3000 },
  );
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    expect(group.children).toHaveLength(2);
    const plate = new THREE.Box3().setFromObject(group.children[0]!);
    expect(plate.max.x - plate.min.x).toBeCloseTo(0.03, 2);
    expect(plate.max.y - plate.min.y).toBeCloseTo(0.7, 2);
    expect(plate.max.z - plate.min.z).toBeCloseTo(0.7, 2);
    const halo = new THREE.Box3().setFromObject(group.children[1]!);
    expect(halo.max.x - halo.min.x).toBeLessThan(0.002);
    expect(halo.min.x).toBeGreaterThan(13.902);
  } finally {
    dispose();
  }
});

it("gives the extractor a grille under the ceiling and a body in the void", () => {
  const object = wetRoomObject("extractor", {
    minimum: { x: 14870, y: 11710, z: 3425 },
    maximum: { x: 15050, y: 11890, z: 3550 },
  });
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(3.425, 2);
    expect(bounds.max.z).toBeCloseTo(3.55, 2);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(0.18, 2);
  } finally {
    dispose();
  }
});

it("runs the exhaust core through the wall along its long axis", () => {
  const object = wetRoomObject("exhaust_terminal", {
    minimum: { x: 14898, y: 12169, z: 3538 },
    maximum: { x: 15022, y: 12319, z: 3662 },
  });
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.y).toBeCloseTo(12.169, 2);
    expect(bounds.max.y).toBeCloseTo(12.319, 2);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(0.124, 2);
  } finally {
    dispose();
  }
});

it("tints a marble bowl by its authored finish and keeps it on the vanity top", () => {
  const object = wetRoomObject(
    "basin",
    { minimum: { x: 13987, y: 10506, z: 1900 }, maximum: { x: 14357, y: 10876, z: 2040 } },
    { "Pset_HomeTwinWetRoom.Finish": "pale_yellow_marble" },
  );
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(1.9, 2);
    expect(bounds.max.z).toBeCloseTo(2.04, 2);
    const material = (group.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(material.color.getHex()).toBe(0xe9dcb9);
    expect((group.children[0] as THREE.Mesh).geometry).toBeInstanceOf(THREE.LatheGeometry);
  } finally {
    dispose();
  }
});

it("renders a recessed bath with continuous sides at the authored 400 mm top", () => {
  const object = wetRoomObject("bath", {
    minimum: { x: 0, y: 0, z: 1050 }, maximum: { x: 1800, y: 800, z: 1450 },
  });
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    renderWetRoomObject(object, finishes, track, group);
    group.updateMatrixWorld(true);
    const side = new THREE.Raycaster(new THREE.Vector3(0.9, -1, 1.3), new THREE.Vector3(0, 1, 0));
    expect(side.intersectObjects(group.children).length).toBeGreaterThan(0);
    const down = new THREE.Raycaster(new THREE.Vector3(0.9, 0.4, 2), new THREE.Vector3(0, 0, -1));
    expect(down.intersectObjects(group.children)[0]?.point.z).toBeCloseTo(1.15);
    expect(new THREE.Box3().setFromObject(group).max.z).toBeCloseTo(1.45);
    // One-piece rim ring, not seamed boxes.
    const rings = group.children.filter((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.ExtrudeGeometry);
    expect(rings).toHaveLength(1);
  } finally { dispose(); }
});

it("puts the shower glass across the 1500 mm entrance and the head at the west wall", () => {
  const object = wetRoomObject("shower", {
    minimum: { x: 0, y: 0, z: 1050 }, maximum: { x: 1500, y: 800, z: 3050 },
  });
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    renderWetRoomObject(object, finishes, track, group);
    const panes = group.children.filter((child) => child instanceof THREE.Mesh && child.material === finishes.glass);
    expect(panes).toHaveLength(2);
    const glass = new THREE.Box3();
    for (const pane of panes) glass.union(new THREE.Box3().setFromObject(pane));
    expect(glass.max.x - glass.min.x).toBeCloseTo(1.5);
    expect(glass.max.y).toBeLessThan(0.03);
    const plate = group.children.find((child) => child.name === "Shower valve, riser and head outlet");
    if (plate === undefined) throw new Error("Missing shower head");
    const head = new THREE.Box3().setFromObject(plate);
    expect((head.min.x + head.max.x) / 2).toBeCloseTo(0.276, 3);
    expect((head.min.y + head.max.y) / 2).toBeCloseTo(0.4, 3);
    expect(head.max.x - head.min.x).toBeCloseTo(0.172, 3);
    const fittings = group.children.find((child) => child.name === "Shower valve, riser and head");
    if (fittings === undefined) throw new Error("Missing shower fittings");
    // The wall unions and riser bracket land on the west wall, nothing passes behind it.
    expect(new THREE.Box3().setFromObject(fittings).min.x).toBeCloseTo(0, 6);
  } finally { dispose(); }
});

it.each(["vanity", "tall_cupboard"])("keeps %s clear of the floor at its authored underside", (role) => {
  const object = wetRoomObject(role, {
    minimum: { x: 0, y: 0, z: 1350 }, maximum: { x: 900, y: 500, z: 1900 },
  });
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    renderWetRoomObject(object, finishes, track, group);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(1.35);
    expect(bounds.max.z).toBeCloseTo(1.9);
  } finally { dispose(); }
});

it("stands the GROHE basin mixer on its body axis, centred on the bowl, inside its envelope", () => {
  // TAP01 as the IFC states it: the body axis at x 13958 on the bowl's centre line, facing east.
  const object = wetRoomObject(
    "tap",
    { minimum: { x: 13935.66, y: 10791, z: 1900 }, maximum: { x: 14128, y: 10836, z: 2220 } },
    { "Pset_HomeTwinWetRoom.RotationDegrees": 90, "Pset_HomeTwinWetRoom.Product": "GROHE Euroeco XL 24273001", "Pset_HomeTwinWetRoom.Finish": "chrome" },
  );
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const mixer = group.children.find((child) => child.name === "tap");
    if (!(mixer instanceof THREE.Mesh)) throw new Error("Missing mixer");
    expect(mixer.position.x).toBeCloseTo(13.958, 3);
    expect(mixer.position.y).toBeCloseTo(10.8135, 4);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(1.9, 6);
    expect(bounds.max.z).toBeCloseTo(2.22, 6);
    expect(bounds.max.x).toBeCloseTo(14.128, 3);
    expect(bounds.min.x).toBeGreaterThanOrEqual(13.9355);
    expect((bounds.min.y + bounds.max.y) / 2).toBeCloseTo(10.8135, 4);
    expect(bounds.max.y - bounds.min.y).toBeLessThanOrEqual(0.045 + 1e-6);
  } finally {
    dispose();
  }
});

it("renders a floor-standing back-to-wall toilet touching the floor and rear wall", () => {  const object = wetRoomObject(
    "toilet",
    { minimum: { x: 15125, y: 11469, z: 1050 }, maximum: { x: 15505, y: 12169, z: 1810 } },
    { "Pset_HomeTwinWetRoom.RotationDegrees": 180 },
  );
  const { finishes, track, dispose } = harness();
  try {
    const group = new THREE.Group();
    expect(renderWetRoomObject(object, finishes, track, group)).toBe(true);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.min.z).toBeCloseTo(1.05);
    expect(bounds.max.y).toBeCloseTo(12.169);
    expect(bounds.min.y).toBeCloseTo(11.469);
    expect(group.children.length).toBeGreaterThanOrEqual(4);
  } finally {
    dispose();
  }
});
