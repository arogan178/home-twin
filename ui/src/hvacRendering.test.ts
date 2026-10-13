import * as THREE from "three";
import { expect, it } from "vitest";

import { indoorProfile } from "./acUnitGeometry";
import { type ArchitecturalMaterials, createArchitecturalMaterials } from "./architecturalMaterials";
import { renderHvacObject } from "./hvacRendering";
import { parseLegs } from "./hvacProperties";
import type { BuildingObject } from "./types";

function rendered(object: BuildingObject, finishes: ArchitecturalMaterials = createArchitecturalMaterials()): THREE.Group | null {
  const resources: Array<THREE.Material | THREE.BufferGeometry | THREE.Texture> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T): T => {
    resources.push(item);
    return item;
  };
  const group = new THREE.Group();
  const drawn = renderHvacObject(object, finishes, track, group);
  group.updateMatrixWorld(true);
  return drawn ? group : null;
}

const run = (route: string, legs: string): BuildingObject => ({
  id: "run",
  name: "Line set LS03A",
  ifc_class: "IfcPipeSegment",
  kind: "pipe",
  room_ids: ["spare"],
  bounds: { minimum: { x: 0, y: 0, z: 3300 }, maximum: { x: 3000, y: 150, z: 3750 } },
  properties: {
    "Pset_HomeTwinHvac.Role": "line_set",
    "Pset_HomeTwinHvac.RouteMm": route,
    "Pset_HomeTwinHvac.Legs": legs,
  },
});

it("draws a ceiling box against the wall and the ceiling it is fixed to", () => {
  const group = rendered(run("0,75,3675;3000,75,3675", "gypsum_box"));
  const bounds = new THREE.Box3().setFromObject(group!);

  expect(bounds.min.y).toBeCloseTo(0);
  expect(bounds.max.y).toBeCloseTo(0.15);
  expect(bounds.max.z).toBeCloseTo(3.75);
  expect(bounds.min.z).toBeCloseTo(3.6);
});

it("keeps a trunking drop's wide face on the wall it came down", () => {
  const group = rendered(run("0,30,3500;1000,30,3500;1000,30,1350", "trunking;trunking"));
  const drop = group!.children[1] as THREE.Mesh;
  const bounds = new THREE.Box3().setFromObject(drop);

  expect(bounds.max.x - bounds.min.x).toBeCloseTo(0.1);
  expect(bounds.max.y - bounds.min.y).toBeCloseTo(0.06);
});

it("draws clipped copper as a slim bundle on the wall, 30 mm off it", () => {
  const group = rendered(run("0,15,3500;1000,15,3500", "clipped"));
  const bounds = new THREE.Box3().setFromObject(group!);

  expect(bounds.min.y).toBeCloseTo(0);
  expect(bounds.max.y).toBeCloseTo(0.03);
  expect(bounds.max.z - bounds.min.z).toBeCloseTo(0.055);
});

it("refuses legs that do not match the route instead of guessing", () => {
  expect(parseLegs("gypsum_box", 2)).toBeNull();
  expect(parseLegs("gypsum_box;conduit", 2)).toBeNull();
  expect(rendered(run("0,75,3675;3000,75,3675", "gypsum_box;trunking"))).toBeNull();
});

const unit = (role: string, [w, d, h]: readonly [number, number, number], rotation = 0, kw = 2.6): BuildingObject => ({
  id: `${role}-${w}`,
  name: `AC ${role}`,
  ifc_class: "IfcUnitaryEquipment",
  kind: "ac",
  room_ids: ["yard"],
  bounds: { minimum: { x: 0, y: 0, z: 1200 }, maximum: { x: w, y: d, z: 1200 + h } },
  properties: {
    "Pset_HomeTwinHvac.Role": role,
    "Pset_HomeTwinHvac.RotationDegrees": rotation,
    "Pset_HomeTwinHvac.WidthMm": w,
    "Pset_HomeTwinHvac.DepthMm": d,
    "Pset_HomeTwinHvac.HeightMm": h,
    "Pset_HomeTwinHvac.NominalCapacityKw": kw,
  },
});

it("turns an outdoor unit to face the yard it discharges into", () => {
  const group = rendered(unit("outdoor_unit", [870, 370, 735], 90));
  const bounds = new THREE.Box3().setFromObject(group!);

  // Turned a quarter, its 870 mm width runs along Y.
  expect(bounds.max.y - bounds.min.y).toBeCloseTo(0.87, 2);
  // It stands on its 150 mm feet, under the envelope.
  expect(bounds.min.z).toBeCloseTo(1.05);
  expect(bounds.max.z).toBeCloseTo(1.935);
});

it("fills an outdoor unit's envelope with its valve cover, and stands it on 150 mm feet", () => {
  const bounds = new THREE.Box3().setFromObject(rendered(unit("outdoor_unit", [732, 330, 555]))!);

  expect(bounds.min.x).toBeCloseTo(0, 3);
  expect(bounds.max.x).toBeCloseTo(0.732, 3);
  expect(bounds.min.y).toBeCloseTo(0, 3);
  expect(bounds.max.y).toBeCloseTo(0.33, 3);
  expect(bounds.min.z).toBeCloseTo(1.05, 3);
  expect(bounds.max.z).toBeCloseTo(1.755, 3);
});

it("runs the copper stubs from the valve cover into the end of the authored trunking", () => {
  // The line set lands 10 mm off the valve side, at mid-depth, 150 above the
  // underside, in 60 x 100 trunking that runs back from there along the side.
  const group = rendered(unit("outdoor_unit", [732, 330, 555]))!;
  const copper = group.children[0]!.children.find(
    (mesh) => ((mesh as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex() === 0xb87333,
  )!;
  const stubs = new THREE.Box3().setFromObject(copper);

  expect(stubs.min.x).toBeGreaterThan(0.732 - 0.02);
  expect(stubs.max.x).toBeLessThan(0.732 + 0.04);
  expect(stubs.min.z).toBeGreaterThan(1.3);
  expect(stubs.max.z).toBeLessThan(1.4);
  // Past the trunking's open end at mid-depth, 10 mm in front of the centre.
  expect(stubs.max.y).toBeGreaterThan(0.165);
});

it("shares one set of meshes between units of a size, and draws a larger unit its own", () => {
  const finishes = createArchitecturalMaterials();
  const geometries = (object: BuildingObject) =>
    (rendered(object, finishes)!.children[0]!.children as THREE.Mesh[]).map((mesh) => mesh.geometry);
  const first = geometries(unit("outdoor_unit", [732, 330, 555]));
  const second = geometries(unit("outdoor_unit", [732, 330, 555]));
  const large = geometries(unit("outdoor_unit", [995, 402, 740], 0, 7));

  expect(first).toHaveLength(4);
  expect(second).toEqual(first);
  expect(large.some((geometry) => first.includes(geometry))).toBe(false);
});

it("keeps an indoor unit exactly inside its envelope", () => {
  const bounds = new THREE.Box3().setFromObject(rendered(unit("indoor_unit", [835, 210, 295]))!);

  expect(bounds.max.x - bounds.min.x).toBeCloseTo(0.835, 3);
  expect(bounds.max.y - bounds.min.y).toBeCloseTo(0.21, 3);
  expect(bounds.min.z).toBeCloseTo(1.2, 3);
  expect(bounds.max.z).toBeCloseTo(1.495, 3);
});

it("draws the indoor unit's open flap inside the section, clear of the body's front", () => {
  const { shell, flap } = indoorProfile(0.21, 0.295);
  const us = flap.map(([u]) => u);
  const vs = flap.map(([, v]) => v);

  expect(Math.max(...shell.map(([u]) => u))).toBeCloseTo(0.21);
  expect(Math.max(...shell.map(([, v]) => v))).toBeCloseTo(0.295);
  expect(Math.min(...vs)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...us)).toBeLessThan(0.21);
  // The flap's front edge drops below where the body's curve ends, opening the outlet.
  expect(Math.max(...vs)).toBeLessThan(0.07);
});
