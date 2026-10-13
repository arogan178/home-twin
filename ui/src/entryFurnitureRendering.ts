import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { ArchitecturalMaterials } from "./architecturalMaterials";
import { FRONT_ARRIS_M, Joinery } from "./joineryGeometry";
import type { BuildingObject } from "./types";

const MM = 0.001;
const ROLE = "Pset_HomeTwinFurniture.Role";
const WIDTH = "Pset_HomeTwinFurniture.WidthMm";
const DEPTH = "Pset_HomeTwinFurniture.DepthMm";
const HEIGHT = "Pset_HomeTwinFurniture.HeightMm";
const CENTRE_X = "Pset_HomeTwinFurniture.CentreXMm";
const CENTRE_Y = "Pset_HomeTwinFurniture.CentreYMm";
const ROTATION = "Pset_HomeTwinFurniture.RotationDegrees";
const VENTED = "Pset_HomeTwinFurniture.Vented";

type Track = <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T;

function authoredPositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function authoredFinite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isVented(value: unknown): boolean {
  return value === true || value === "true" || value === "TRUE";
}

/** Render an authored threshold shoe cabinet, including its louvred carcass. */
export function renderEntryFurniture(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: Track,
  content: THREE.Group,
): boolean {
  if (object.properties[ROLE] !== "shoe_bench") return false;

  const a = object.bounds.minimum;
  const b = object.bounds.maximum;
  const fallbackWidth = b.x - a.x;
  const fallbackDepth = b.y - a.y;
  const fallbackHeight = b.z - a.z;
  const width = authoredPositive(object.properties[WIDTH]) ?? fallbackWidth;
  const depth = authoredPositive(object.properties[DEPTH]) ?? fallbackDepth;
  const height = authoredPositive(object.properties[HEIGHT]) ?? fallbackHeight;
  const centreX = authoredFinite(object.properties[CENTRE_X]) ?? (a.x + b.x) / 2;
  const centreY = authoredFinite(object.properties[CENTRE_Y]) ?? (a.y + b.y) / 2;
  const rotation = authoredFinite(object.properties[ROTATION]) ?? 0;
  const w = width * MM;
  const d = depth * MM;
  const h = height * MM;
  const board = Math.min(0.025, w / 8, d / 8, h / 8);
  const group = new THREE.Group();
  group.name = object.name;
  group.position.set(centreX * MM, centreY * MM, a.z * MM);
  group.rotation.z = (rotation * Math.PI) / 180;
  content.add(group);

  const part = (
    widthM: number,
    depthM: number,
    heightM: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    radius = 0.008,
  ) => {
    const mesh = new THREE.Mesh(
      track(new RoundedBoxGeometry(widthM, depthM, heightM, 2, Math.min(radius, heightM / 4))),
      material,
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  if (isVented(object.properties[VENTED])) {
    const foot = Math.min(0.05, h / 8);
    const body = Math.max(h - foot, board * 3);
    const metal = finishes.stainless;
    const dark = finishes.plinth;
    part(w, d, board, 0, 0, h - board / 2, metal);
    part(Math.max(w - board * 2, board), Math.max(d - board, board), board, 0, board / 2, foot + board / 2, metal);
    part(Math.max(w - board * 2, board), board, Math.max(body - board, board), 0, (d - board) / 2, foot + (body - board) / 2, metal);
    for (const side of [-1, 1]) {
      part(board, d, Math.max(body - board, board), side * (w - board) / 2, 0, foot + (body - board) / 2, metal);
      part(foot, foot, foot, side * (w - foot) * 0.4, 0, foot / 2, dark);
    }

    const slat = Math.min(0.04, Math.max(body - board * 2, board));
    const gap = 0.018;
    const courses = Math.max(1, Math.floor(Math.max(body - board * 2, slat) / (slat + gap)));
    for (let course = 0; course < courses; course += 1) {
      part(
        Math.max(w - board * 2, board),
        Math.min(0.018, Math.max(d / 6, 0.004)),
        slat,
        0,
        -(d - 0.018) / 2,
        foot + board + course * (slat + gap) + slat / 2,
        dark,
        0.003,
      );
    }
    return true;
  }

  // Keep old IFCs readable as indoor upholstered benches. New threshold units
  // carry Vented=true and cannot be mistaken for a seat.
  // Square-edged walnut with an arris on the faces you see; only the
  // upholstered pad is soft.
  const joinery = new Joinery();
  const walnut = finishes.joineryWood;
  const supportH = Math.max(h - 0.04, 0.02);
  for (const side of [-1, 1]) {
    joinery.board("Side support", walnut, [0.03, d, supportH], [side * (w - 0.03) / 2, 0, supportH / 2], FRONT_ARRIS_M, "-y");
  }
  joinery.board("Shoe shelf", walnut, [Math.max(w - 0.06, 0.02), Math.max(d - 0.03, 0.02), 0.025], [0, 0.015, 0.1125], FRONT_ARRIS_M, "-y");
  joinery.board("Seat base", walnut, [w, d, 0.018], [0, 0, h - 0.031], FRONT_ARRIS_M, "+z");
  joinery.build(group, track);
  part(w, d, 0.022, 0, 0, h - 0.011, finishes.fabric);
  return true;
}
