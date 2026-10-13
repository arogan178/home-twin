import * as THREE from "three";
import type { ArchitecturalMaterials } from "./architecturalMaterials";
import { BOARD_M, FRONT_ARRIS_M, Joinery } from "./joineryGeometry";
import { addKitchenFronts, addToeKick, FACING_RADIANS, kitchenFronts, kitchenUnit, parseBays } from "./kitchenRendering";
import type { BuildingObject } from "./types";

const PLINTH_M = 0.112;
const FRONT_M = 0.022;
const STONE_ARRIS_M = 0.002;

/** A slab of `shape` with a 45 degree arris round both faces, filling exactly its shape and depth. */
function chamferedSlab(shape: THREE.Shape, depthM: number, arrisM: number): THREE.ExtrudeGeometry {
  const arris = Math.min(arrisM, depthM / 4);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depthM - arris * 2,
    bevelEnabled: true,
    bevelThickness: arris,
    bevelSize: arris,
    bevelOffset: -arris,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, arris);
  return geometry;
}

/** Remove the display worktop/carcass caps over an authored sink envelope. */
export function renderSinkSurround(
  object: BuildingObject,
  neighbours: readonly BuildingObject[],
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T,
  content: THREE.Group,
): boolean {
  const role = object.properties["Pset_HomeTwinKitchen.Role"];
  if (role !== "worktop" && role !== "base") return false;
  const a = object.bounds.minimum;
  const b = object.bounds.maximum;
  const sink = neighbours.find((other) => other.properties["Pset_HomeTwinKitchen.Appliance"] === "sink"
    && other.bounds.minimum.x > a.x && other.bounds.maximum.x < b.x
    && other.bounds.minimum.y > a.y && other.bounds.maximum.y < b.y);
  if (!sink) return false;
  const x = (a.x + b.x) / 2000;
  const y = (a.y + b.y) / 2000;
  const h = (b.z - a.z) / 1000;
  const group = new THREE.Group();
  group.position.set(x, y, a.z / 1000);
  group.name = object.name;
  content.add(group);
  const joinery = new Joinery();
  if (role === "worktop") {
    const w = (b.x - a.x) / 1000;
    const d = (b.y - a.y) / 1000;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, -d / 2); shape.lineTo(w / 2, -d / 2);
    shape.lineTo(w / 2, d / 2); shape.lineTo(-w / 2, d / 2); shape.closePath();
    const c = sink.bounds.minimum;
    const e = sink.bounds.maximum;
    const hole = new THREE.Path();
    // A 10 mm overlap hides the edge of the undermounted metal rim.
    const x0 = c.x / 1000 - x + 0.01;
    const y0 = c.y / 1000 - y + 0.01;
    const x1 = e.x / 1000 - x - 0.01;
    const y1 = e.y / 1000 - y - 0.01;
    hole.moveTo(x0, y0); hole.lineTo(x0, y1); hole.lineTo(x1, y1); hole.lineTo(x1, y0); hole.closePath();
    shape.holes.push(hole);
    // The same 2 mm eased arris as the other worktops, round the aperture too.
    joinery.add("Worktop with sink aperture", finishes.worktop, chamferedSlab(shape, h, STONE_ARRIS_M));
  } else {
    // Drawn as the rest of the run is, less the carcass top and the dark
    // interior box: the bowl hangs down into this cupboard.
    // The role was read above, so the unit always parses.
    const unit = kitchenUnit(object)!;
    const facing = unit.facing;
    const turned = facing === "east" || facing === "west";
    const w = (turned ? b.y - a.y : b.x - a.x) / 1000;
    const d = (turned ? b.x - a.x : b.y - a.y) / 1000;
    group.rotation.z = FACING_RADIANS[facing] ?? 0;
    const walnut = finishes.joineryWood;
    const carcassY0 = -d / 2 + FRONT_M;
    const carcassDepth = d / 2 - carcassY0;
    const carcassY = (carcassY0 + d / 2) / 2;
    const body = h - PLINTH_M;
    addToeKick(joinery, w, d, finishes);
    for (const side of [-1, 1]) {
      joinery.board("Veneer end panel", walnut, [BOARD_M, carcassDepth, body], [side * (w - BOARD_M) / 2, carcassY, PLINTH_M + body / 2],
        FRONT_ARRIS_M, "-y");
    }
    joinery.board("Sink cabinet floor", walnut, [w - 2 * BOARD_M, carcassDepth, BOARD_M], [0, carcassY, PLINTH_M + BOARD_M / 2],
      FRONT_ARRIS_M, "-y");
    joinery.board("Sink cabinet back", walnut, [w - 2 * BOARD_M, BOARD_M, body - BOARD_M], [0, d / 2 - BOARD_M / 2, PLINTH_M + (body + BOARD_M) / 2]);
    // A dark sheet just behind the doors, so the shadow gaps read as gaps.
    joinery.board("Recessed interior", finishes.plinth, [w - 2 * BOARD_M, 0.004, body - BOARD_M - 0.02],
      [0, carcassY0 + 0.006, PLINTH_M + BOARD_M + (body - BOARD_M - 0.02) / 2]);
    const bays = parseBays(object.properties["Pset_HomeTwinKitchen.Bays"])
      .map((bay) => ({ kind: bay.kind, z0: (bay.z0 - a.z) / 1000, z1: (bay.z1 - a.z) / 1000 }));
    addKitchenFronts(joinery, kitchenFronts(unit, w, h, bays).fronts, d, finishes);
  }
  joinery.build(group, track);
  return true;
}
