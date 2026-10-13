/**
 * The room's walls in the 3D view: their solids around each opening, the
 * skirting along them, and the frames, glass and doors set in the openings.
 */

import * as THREE from "three";

import { finishMesh, type ArchitecturalMaterials } from "./architecturalMaterials";
import type { DoorMotion } from "./doorAnimation";
import { doorSwingSign } from "./doorSwing";
import { featureWallMaterial, skirtingMaterialFor, wallMaterialFor } from "./finishMaterials";
import { markInspectable } from "./inspection";
import type { RoomView3DProps } from "./RoomView3D";
import { skirtingRuns } from "./skirtingGeometry";
import type { Opening } from "./types";
import { wallSolidRectangles } from "./wallGeometry";
import { trackWallForOcclusion } from "./wallOcclusion";

const MM = 0.001;

/** Walls are drawn at an indicative thickness; the IFC face line stays exact. */
const DISPLAY_WALL_THICKNESS_M = 0.12;

type Track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T) => T;

/** Add the room's walls and those of its lower levels, each standing on its own floor. */
export function addRoomWalls(
  content: THREE.Group,
  props: Pick<
    RoomView3DProps,
    | "walls"
    | "openings"
    | "lowerLevels"
    | "floorElevationMm"
    | "ceilingElevationMm"
    | "structuralCeilingElevationMm"
    | "wallFinish"
    | "featureWallId"
    | "featureWallColour"
    | "cladWallIds"
    | "skirting"
    | "skirtingHeightMm"
    | "skirtingThicknessMm"
  >,
  finishes: ArchitecturalMaterials,
  track: Track,
  pickable: THREE.Object3D[],
  wallMeshes: THREE.Mesh[],
  doorMotions: Map<string, DoorMotion>,
) {
  const floorZ = props.floorElevationMm;
  const structuralZ = props.structuralCeilingElevationMm ?? props.ceilingElevationMm;
const wallMaterial = wallMaterialFor(props.wallFinish, finishes, track);
const featureMaterial = props.featureWallColour ? featureWallMaterial(props.featureWallColour, track) : null;
// A face the joinery clads runs to its own base detail, so it takes none.
const cladWalls = new Set(props.cladWallIds);
const skirtingHeightM = (props.skirtingHeightMm ?? 0) * MM;
const skirtingThicknessM = (props.skirtingThicknessMm ?? 0) * MM;
const skirtingMaterial =
  props.skirting && skirtingHeightM > 0 && skirtingThicknessM > 0
    ? skirtingMaterialFor(props.skirting, finishes, track)
    : null;

const addBox = (
  lengthM: number,
  heightBoxM: number,
  centreX: number,
  centreY: number,
  centreZ: number,
  angle: number,
  material: THREE.Material,
  thicknessM = DISPLAY_WALL_THICKNESS_M,
) => {
  const geometry = track(new THREE.BoxGeometry(lengthM, thicknessM, heightBoxM));
  const mesh = finishMesh(new THREE.Mesh(geometry, material), material !== finishes.glass);
  mesh.rotation.z = angle;
  mesh.position.set(centreX, centreY, centreZ);
  content.add(mesh);
  return mesh;
};

// A lower level is part of the room, so its walls are drawn with the
// room's own; only the floor they stand on differs.
const buildWalls = (
  walls: RoomView3DProps["walls"],
  openings: RoomView3DProps["openings"],
  levelFloorZ: number,
) => {
  // Walls run to the slab, not to the gypsum: a perimeter reveal is a slot
  // through the gypsum, and it needs the wall and the soffit behind it.
  const levelHeightM = Math.max(structuralZ - levelFloorZ, 100) * MM;
  for (const wall of walls) {
    const wallStart = content.children.length;
    const startX = wall.start.x * MM;
    const startY = wall.start.y * MM;
    const endX = wall.end.x * MM;
    const endY = wall.end.y * MM;
    const lengthM = Math.hypot(endX - startX, endY - startY);
    if (lengthM < 0.05) continue;
    const angle = Math.atan2(endY - startY, endX - startX);
    const dirX = (endX - startX) / lengthM;
    const dirY = (endY - startY) / lengthM;
    const thicknessM = Math.max(wall.thickness_mm * MM, 0.04);
    const outX = -wall.inward_normal.x * (thicknessM / 2);
    const outY = -wall.inward_normal.y * (thicknessM / 2);

    const hosted = openings.filter((opening) => opening.host_wall_id === wall.wall_id);
    const gaps = hosted.map((opening) => {
      const from = (opening.start.x * MM - startX) * dirX + (opening.start.y * MM - startY) * dirY;
      const to = (opening.end.x * MM - startX) * dirX + (opening.end.y * MM - startY) * dirY;
      return [Math.max(0, Math.min(from, to)), Math.min(lengthM, Math.max(from, to))] as const;
    });
    const voids = hosted.map((opening, index) => ({
      fromM: gaps[index]?.[0] ?? 0,
      toM: gaps[index]?.[1] ?? 0,
      sillM: opening.sill_height_mm * MM,
      headM: opening.head_height_mm * MM,
    }));

    const face =
      featureMaterial !== null && wall.wall_id === props.featureWallId ? featureMaterial : wallMaterial;
    for (const solid of wallSolidRectangles(lengthM, levelHeightM, voids)) {
      const middle = (solid.fromM + solid.toM) / 2;
      trackWallForOcclusion(
        addBox(
          solid.toM - solid.fromM,
          solid.topM - solid.bottomM,
          startX + dirX * middle + outX,
          startY + dirY * middle + outY,
          levelFloorZ * MM + (solid.bottomM + solid.topM) / 2,
          angle,
          face,
          thicknessM,
        ),
        wallMeshes,
        wall.wall_id,
      );
    }

    if (skirtingMaterial !== null && !cladWalls.has(wall.wall_id)) {
      const insetX = wall.inward_normal.x * (skirtingThicknessM / 2);
      const insetY = wall.inward_normal.y * (skirtingThicknessM / 2);
      for (const run of skirtingRuns(lengthM, skirtingHeightM, voids)) {
        const middle = (run.fromM + run.toM) / 2;
        addBox(
          run.toM - run.fromM,
          skirtingHeightM,
          startX + dirX * middle + insetX,
          startY + dirY * middle + insetY,
          levelFloorZ * MM + skirtingHeightM / 2,
          angle,
          skirtingMaterial,
          skirtingThicknessM,
        );
      }
    }

    const buildOpening = (opening: Opening, index: number) => {
      const gap = gaps[index];
      if (gap === undefined) return;
      const span = gap[1] - gap[0];
      const middle = (gap[0] + gap[1]) / 2;
      const x = startX + dirX * middle + outX;
      const y = startY + dirY * middle + outY;
      const sill = (levelFloorZ + opening.sill_height_mm) * MM;
      const head = (levelFloorZ + opening.head_height_mm) * MM;
      const apertureHeight = Math.max(head - sill, 0.05);
      const frame = Math.min(0.05, span / 8, apertureHeight / 8);
      const edge = span / 2 - frame / 2;
      for (const side of [-1, 1]) {
        addBox(
          frame,
          apertureHeight,
          x + dirX * edge * side,
          y + dirY * edge * side,
          (sill + head) / 2,
          angle,
          finishes.frame,
          0.055,
        );
      }
      addBox(span, frame, x, y, head - frame / 2, angle, finishes.frame, 0.055);
      if (opening.kind === "unfilled") return;
      if (opening.kind === "door" || opening.kind === "sliding_door") {
        const leafSpan = Math.max(span - frame * 2, 0.03);
        const leafHeight = Math.max(apertureHeight - frame, 0.03);
        const group = new THREE.Group();
        const base = opening.kind === "door"
          ? new THREE.Vector3(
              startX + dirX * (gap[0] + frame) + outX,
              startY + dirY * (gap[0] + frame) + outY,
              0,
            )
          : new THREE.Vector3(x, y, 0);
        group.position.copy(base);
        group.rotation.z = angle;
        // Glass or timber is a question about glazing, not about how the
        // leaf moves. Reading it off "sliding" made the en-suite and
        // bathroom doors transparent -- they slide and they are solid -- so
        // the sun came through an internal door.
        const glazed = (opening.glazing_fraction ?? 0) > 0;
        const leaf = finishMesh(
          new THREE.Mesh(
            track(new THREE.BoxGeometry(leafSpan, 0.045, leafHeight)),
            glazed ? finishes.glass : finishes.timber,
          ),
          !glazed,
        );
        leaf.position.set(opening.kind === "door" ? leafSpan / 2 : 0, 0, sill + leafHeight / 2);
        leaf.userData.doorId = opening.id;
        group.add(leaf);
        content.add(group);
        pickable.push(leaf);
        doorMotions.set(opening.id, {
          kind: opening.kind,
          group,
          base,
          angle,
          swingSign: doorSwingSign(opening.swing, { x: dirX, y: dirY }, wall.inward_normal),
          dirX,
          dirY,
          span: leafSpan,
          amount: 0,
          target: 0,
        });
        return;
      }
      addBox(
        Math.max(span - frame * 2, 0.03),
        Math.max(apertureHeight - frame * 2, 0.03),
        x,
        y,
        (sill + head) / 2,
        angle,
        finishes.glass,
        0.025,
      );
    };
    hosted.forEach((opening, index) => {
      const openingStart = content.children.length;
      buildOpening(opening, index);
      for (const child of content.children.slice(openingStart)) {
        markInspectable(child, { kind: "opening", id: opening.id });
        // A door and its frame give way with the wall they stand in, or a
        // faded wall leaves its door standing in front of the room.
        child.traverse((node) => {
          if (node instanceof THREE.Mesh) trackWallForOcclusion(node, wallMeshes, wall.wall_id);
        });
      }
    });
    for (const child of content.children.slice(wallStart)) {
      markInspectable(child, { kind: "wall", id: wall.wall_id });
    }
  }
};

buildWalls(props.walls, props.openings, floorZ);
for (const level of props.lowerLevels) {
  if (level.walls === undefined) continue;
  buildWalls(level.walls, level.openings ?? [], level.elevationMm);
}
}
