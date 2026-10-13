import * as THREE from "three";
import { expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import { renderDetailedBuildingObject } from "./cabinetryRendering";
import { joineryParts } from "./joineryGeometry";
import type { BuildingObject } from "./types";

function render(name: string, box: readonly [number, number, number, number, number, number]) {
  const [x0, y0, z0, x1, y1, z1] = box;
  const object: BuildingObject = {
    id: name, name, ifc_class: "IfcFurniture", kind: "cabinet", room_ids: [],
    bounds: { minimum: { x: x0, y: y0, z: z0 }, maximum: { x: x1, y: y1, z: z1 } },
    properties: { "Pset_HomeTwin.ObjectKind": "cabinet" },
  };
  const finishes = createArchitecturalMaterials();
  const group = new THREE.Group();
  expect(renderDetailedBuildingObject(object, finishes, (item) => item, group)).toBe(true);
  return { group, finishes };
}

it("hangs the media console with nothing under it and three inset doors", () => {
  const { group } = render("TV media console", [18600, 4930, 1280, 20600, 5280, 1600]);
  const bounds = new THREE.Box3().setFromObject(group);
  // The authored underside is 230 mm off the 1050 floor: no plinth is drawn into that air.
  expect(bounds.min.z).toBeCloseTo(1.28, 6);
  expect(bounds.max.z).toBeCloseTo(1.6, 6);
  expect(joineryParts(group, "Recessed plinth")).toHaveLength(0);
  const doors = joineryParts(group, "Door front").map((part) => part.box);
  expect(doors).toHaveLength(3);
  // Inset between the 18 mm carcass sides, with 3 mm gaps.
  expect(doors[0]!.min.x).toBeCloseTo(18.6 + 0.018 + 0.003, 6);
});

it("stands the drinks cabinet on a recessed plinth with chrome bar handles", () => {
  const { group, finishes } = render("Drinks cabinet", [20800, 4880, 1050, 21400, 5280, 2250]);
  const [plinth] = joineryParts(group, "Recessed plinth");
  expect((plinth!.box.max.z - plinth!.box.min.z) * 1000).toBeCloseTo(80, 3);
  expect(plinth!.box.min.y).toBeGreaterThan(4.88 + 0.03);
  expect(joineryParts(group, "Door front")).toHaveLength(2);
  expect(joineryParts(group, "Bar handle").every((part) => part.material === finishes.chrome)).toBe(true);
});
