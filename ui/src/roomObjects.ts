/**
 * The room's contents in the 3D view: its furniture and obstructions, drawn in
 * detail where a renderer knows the piece and as a bounding box otherwise, and
 * its stair flights with their skirting band.
 */

import * as THREE from "three";

import { finishMesh, type ArchitecturalMaterials } from "./architecturalMaterials";
import { renderDetailedBuildingObject } from "./cabinetryRendering";
import { isCeilingReveal } from "./ceilingGypsum";
import { skirtingMaterialFor } from "./finishMaterials";
import { hiddenInCeilingVoid } from "./fixtureRendering";
import { markInspectable } from "./inspection";
import type { RoomView3DProps } from "./RoomView3D";
import { buildStairFlightParts, stairBand } from "./stairGeometry";

const MM = 0.001;

type Track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T) => T;

/** Add each building object once, skipping reveals and anything the gypsum hides. */
export function addRoomObjects(
  content: THREE.Group,
  props: Pick<RoomView3DProps, "objects" | "ceilingElevationMm" | "showGypsum">,
  finishes: ArchitecturalMaterials,
  track: Track,
  tableClosed: boolean,
  openCarcass: boolean,
) {
  const ceilingZ = props.ceilingElevationMm;
const seen = new Set<string>();
for (const object of props.objects) {
  if (seen.has(object.id) || isCeilingReveal(object)) continue;
  seen.add(object.id);
  if (hiddenInCeilingVoid(object, ceilingZ, props.showGypsum)) continue;
  const objectStart = content.children.length;
  if (!renderDetailedBuildingObject(object, finishes, track, content, props.objects, tableClosed, openCarcass)) {
    const width = Math.max(object.bounds.maximum.x - object.bounds.minimum.x, 20) * MM;
    const depth = Math.max(object.bounds.maximum.y - object.bounds.minimum.y, 20) * MM;
    const tall = Math.max(object.bounds.maximum.z - object.bounds.minimum.z, 20) * MM;
    const geometry = track(new THREE.BoxGeometry(width, depth, tall));
    const mesh = finishMesh(new THREE.Mesh(geometry, finishes.object));
    mesh.position.set(
      ((object.bounds.minimum.x + object.bounds.maximum.x) / 2) * MM,
      ((object.bounds.minimum.y + object.bounds.maximum.y) / 2) * MM,
      ((object.bounds.minimum.z + object.bounds.maximum.z) / 2) * MM,
    );
    content.add(mesh);
  }
  for (const child of content.children.slice(objectStart)) {
    markInspectable(child, { kind: "object", id: object.id });
  }
}
}

export function addStairs(
  content: THREE.Group,
  props: Pick<RoomView3DProps, "stairs" | "walls">,
  finishes: ArchitecturalMaterials,
  track: Track,
) {
for (const stair of props.stairs) {
  const stairStart = content.children.length;
  const parts = buildStairFlightParts(stair);
  for (const part of [...parts.treads, ...(parts.landingRiser === null ? [] : [parts.landingRiser])]) {
    const geometry = track(new THREE.BoxGeometry(part.goingDepthM, part.widthM, part.heightM));
    const step = finishMesh(new THREE.Mesh(geometry, finishes.stair));
    step.position.set(part.centreXM, part.centreYM, part.centreZM);
    step.rotation.z = part.rotationZ;
    content.add(step);
  }
  const run = stairBand(stair, props.walls);
  if (run !== null) {
    // Tilt then swing: rotating the geometry rather than the mesh keeps the
    // two rotations in a fixed order, which an Euler triple would not.
    const geometry = track(new THREE.BoxGeometry(run.lengthM, run.thicknessM, run.heightM));
    geometry.rotateY(-run.pitchRad);
    geometry.rotateZ(run.rotationZ);
    const band = finishMesh(new THREE.Mesh(geometry, skirtingMaterialFor(stair.skirting, finishes, track)));
    band.position.set(run.centreXM, run.centreYM, run.centreZM);
    content.add(band);
  }
  for (const child of content.children.slice(stairStart)) {
    markInspectable(child, { kind: "stair", id: stair.id });
  }
}
}
