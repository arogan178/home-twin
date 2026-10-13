import { renderEntryFurniture } from "./entryFurnitureRendering";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { ArchitecturalMaterials } from "./architecturalMaterials";
import type { BuildingObject } from "./types";

export function renderFurniture(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T,
  content: THREE.Group,
  tableClosed = false,
): boolean {
  if (renderEntryFurniture(object, finishes, track, content)) return true;
  const name = object.name.toLowerCase();
  const role = object.properties["Pset_HomeTwinFurniture.Role"];
  const chair = role === "chair" || role === "stool" || name.startsWith("dining chair");
  const table = role === "table" || name.includes("table");
  const sofa = name.includes("sofa");
  const rug = name.includes("rug");
  if (!chair && !table && !sofa && !rug) return false;
  // A closed table is shorter and seats fewer, so a seat either moves to its
  // closed place or is stowed. Both layouts are authored; neither is derived here.
  if (tableClosed && chair && object.properties["Pset_HomeTwinFurniture.ClosedSeat"] === false) return true;

  const a = object.bounds.minimum;
  const b = object.bounds.maximum;
  const width = (b.x - a.x) / 1000;
  const depth = (b.y - a.y) / 1000;
  const height = (b.z - a.z) / 1000;
  const group = new THREE.Group();
  group.name = object.name;
  group.position.set((a.x + b.x) / 2000, (a.y + b.y) / 2000, a.z / 1000);
  content.add(group);

  const closedX = Number(object.properties["Pset_HomeTwinFurniture.ClosedCentreXMm"]);
  const closedY = Number(object.properties["Pset_HomeTwinFurniture.ClosedCentreYMm"]);
  const closedBearing = Number(object.properties["Pset_HomeTwinFurniture.ClosedBearingDeg"]);
  const closedDepth = Number(object.properties["Pset_HomeTwinFurniture.ClosedDepthMm"]);
  if (tableClosed && chair && Number.isFinite(closedX) && Number.isFinite(closedY)) {
    group.position.set(closedX / 1000, closedY / 1000, a.z / 1000);
  }
  const facing = object.properties["Pset_HomeTwinFurniture.Facing"];
  const authoredWidth = Number(object.properties["Pset_HomeTwinFurniture.WidthMm"]);
  const authoredDepth = Number(object.properties["Pset_HomeTwinFurniture.DepthMm"]);
  const authoredBearing = Number(object.properties["Pset_HomeTwinFurniture.BearingDeg"]);
  // The world box of a turned object is not its size, so use the authored plan
  // dimensions and bearing where they exist and fall back to the box where they do not.
  const authored = Number.isFinite(authoredWidth) && Number.isFinite(authoredDepth);
  const cardinal: Record<string, number> = { north: 90, east: 0, south: 270, west: 180 };
  const bearing = Number.isFinite(authoredBearing)
    ? authoredBearing
    : (typeof facing === "string" ? cardinal[facing] : undefined) ?? 90;
  const across = !authored && (facing === "east" || facing === "west");
  const shown = tableClosed && chair && Number.isFinite(closedBearing) ? closedBearing : bearing;
  const w = authored ? authoredWidth / 1000 : across ? depth : width;
  const openDepth = authored ? authoredDepth / 1000 : across ? width : depth;
  const d = tableClosed && table && Number.isFinite(closedDepth) ? closedDepth / 1000 : openDepth;
  if (chair || table) group.rotation.z = ((shown - 90) * Math.PI) / 180;

  const rounded = (w: number, d: number, h: number, x: number, y: number, z: number, material: THREE.Material, radius = 0.035) => {
    const mesh = new THREE.Mesh(track(new RoundedBoxGeometry(w, d, h, 3, Math.min(radius, w / 3, d / 3, h / 3))), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = !rug;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const leg = (x: number, y: number, h: number, radius: number, material = finishes.timber) => {
    const mesh = new THREE.Mesh(track(new THREE.CylinderGeometry(radius, radius * 0.72, h, 12)), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, h / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  if (rug) {
    rounded(width, depth, height, 0, 0, height / 2, finishes.rug, 0.005);
    return true;
  }
  if (chair) {
    // Matches _SEAT_RATIO in furniture.py: a stool's seat sits higher up its envelope.
    const seatZ = height * (role === "stool" ? 0.6 : 0.525);
    for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) {
      for (const y of [-d / 2 + 0.05, d / 2 - 0.05]) leg(x, y, seatZ, 0.019);
    }
    rounded(w - 0.02, d - 0.02, 0.035, 0, 0, seatZ, finishes.timber, 0.012);
    rounded(w, d, 0.045, 0, 0, seatZ + 0.0225, finishes.fabric, 0.02);
    const backH = height - seatZ - 0.045;
    rounded(w, 0.055, backH, 0, -d / 2 + 0.0275, seatZ + 0.045 + backH / 2, finishes.timber, 0.018);
    rounded(w - 0.07, 0.025, backH * 0.7, 0, -d / 2 + 0.062, height - backH / 2, finishes.fabric, 0.012);
    return true;
  }
  if (table) {
    const coffee = name.includes("coffee");
    const topH = coffee ? 0.028 : 0.035;
    const material = coffee ? finishes.worktop : finishes.timber;
    // A rounded plan outline, rather than a cuboid bevel limited by top thickness.
    const r = Math.min(w, d) * (coffee ? 0.24 : 0.18);
    const shape = new THREE.Shape();
    const x = -w / 2;
    const y = -d / 2;
    const outline = object.properties["Pset_HomeTwinFurniture.Shape"];
    const isRound = outline === "round";
    if (isRound) {
      shape.absellipse(0, 0, w / 2, d / 2, 0, Math.PI * 2, false, 0);
    } else if (outline === "oval") {
      // A stadium: two half-round ends joined by the straight run between them.
      const end = w / 2;
      const straight = Math.max(0, d / 2 - end);
      shape.absarc(0, straight, end, 0, Math.PI, false);
      shape.absarc(0, -straight, end, Math.PI, Math.PI * 2, false);
    } else {
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + d - r);
    shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
    shape.lineTo(x + r, y + d);
    shape.quadraticCurveTo(x, y + d, x, y + d - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    }
    const geometry = track(new THREE.ExtrudeGeometry(shape, { depth: topH, bevelEnabled: false, curveSegments: 10 }));
    const top = new THREE.Mesh(geometry, material);
    top.position.z = height - topH;
    top.castShadow = true;
    top.receiveShadow = true;
    group.add(top);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) leg(sx * (isRound || outline === "oval" ? w * 0.27 : w / 2 - 0.11), sy * (isRound || outline === "oval" ? d * 0.27 : d / 2 - 0.11), height - topH, coffee ? 0.04 : 0.035);
    }
    return true;
  }

  const footH = Math.min(0.09, height * 0.12);
  const cushionH = height * 0.19;
  const baseH = height * 0.28;
  const seatZ = footH + baseH + cushionH / 2;
  for (const x of [-width / 2 + 0.13, width / 2 - 0.13]) {
    for (const y of [-depth / 2 + 0.13, depth / 2 - 0.13]) leg(x, y, footH, 0.035, finishes.joineryWood);
  }
  rounded(width - 0.035, depth - 0.025, baseH, 0, 0, footH + baseH / 2, finishes.fabric, 0.06);
  const isReturn = name.includes("return");
  if (isReturn) {
    const west = name.includes("west");
    const armW = Math.min(0.16, width * 0.2);
    rounded(armW, depth, height - footH, (west ? -1 : 1) * (width - armW) / 2, 0, (height + footH) / 2, finishes.fabric, 0.05);
    rounded(width - armW - 0.03, depth - 0.025, cushionH, (west ? 1 : -1) * armW / 2, 0, seatZ, finishes.fabric, 0.055);
    return true;
  }
  const armW = Math.min(0.15, width * 0.07);
  const backD = Math.min(0.18, depth * 0.23);
  const backH = height - footH - baseH;
  rounded(width - 0.025, backD, backH, 0, -depth / 2 + backD / 2, height - backH / 2, finishes.fabric, 0.065);
  for (const side of [-1, 1]) {
    rounded(armW, depth - 0.035, height * 0.62, side * (width - armW) / 2, 0, footH + height * 0.31, finishes.fabric, 0.055);
  }
  const count = Math.max(2, Math.round(width / 0.8));
  const seatWidth = (width - 2 * armW) / count;
  const seatDepth = depth - backD - 0.02;
  for (let i = 0; i < count; i += 1) {
    const x = -width / 2 + armW + (i + 0.5) * seatWidth;
    rounded(seatWidth - 0.012, seatDepth, cushionH, x, backD / 2, seatZ, finishes.fabric, 0.055);
    rounded(seatWidth - 0.035, 0.14, backH * 0.65, x, -depth / 2 + backD + 0.05, height - backH * 0.35, finishes.fabric, 0.05);
  }
  for (const side of [-1, 1]) {
    rounded(0.33, 0.13, 0.29, side * (width / 2 - armW - 0.22), -depth / 2 + backD + 0.13, seatZ + cushionH / 2 + 0.145, finishes.pillow, 0.055);
  }
  return true;
}
