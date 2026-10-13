/**
 * The room's shell in the 3D view: its floor slabs, the structural ceiling and
 * the gypsum hung under it, with its bulkheads and reveals.
 */

import * as THREE from "three";

import { finishMesh, slabGeometry, type ArchitecturalMaterials } from "./architecturalMaterials";
import {
  fasciaEdges,
  insetRingAtReveals,
  renderBulkheadFascia,
  renderCeilingReveal,
  revealRuns,
} from "./ceilingGypsum";
import { roomFloorLayers, unifyStairwellHoles } from "./roomFloorGeometry";
import type { RoomView3DProps } from "./RoomView3D";

const MM = 0.001;

type Track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T) => T;

export function shapeFromRing(
  ring: ReadonlyArray<{ x: number; y: number }>,
  holes: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> = [],
): THREE.Shape {
  const shape = new THREE.Shape();
  ring.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x * MM, point.y * MM);
    else shape.lineTo(point.x * MM, point.y * MM);
  });
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    hole.forEach((point, index) => {
      if (index === 0) path.moveTo(point.x * MM, point.y * MM);
      else path.lineTo(point.x * MM, point.y * MM);
    });
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

export function flatMesh(
  ring: ReadonlyArray<{ x: number; y: number }>,
  elevationMm: number,
  material: THREE.Material,
  track: <T extends THREE.BufferGeometry>(geometry: T) => T,
  holes: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> = [],
  castShadow = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(track(new THREE.ShapeGeometry(shapeFromRing(ring, holes))), material);
  mesh.position.z = elevationMm * MM;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

export function addRoomShell(
  content: THREE.Group,
  props: Pick<
    RoomView3DProps,
    | "polygon"
    | "stairs"
    | "lowerLevels"
    | "objects"
    | "soffits"
    | "floorElevationMm"
    | "ceilingElevationMm"
    | "structuralCeilingElevationMm"
    | "isExternal"
    | "showCeiling"
    | "showGypsum"
  >,
  finishes: ArchitecturalMaterials,
  floorMaterial: THREE.Material,
  track: Track,
) {
  const floorZ = props.floorElevationMm;
  const ceilingZ = props.ceilingElevationMm;
  const structuralZ = props.structuralCeilingElevationMm ?? ceilingZ;

  // A flight arriving at this level comes up through the floor, so the slab
  // has to open over it or the whole run hides underneath.
  const rawStairwells = [
    ...props.stairs.filter((stair) => stair.base_elevation_mm < floorZ - 10).map((stair) => stair.footprint.outer),
    ...props.lowerLevels.map((level) => level.outline),
  ];
  const stairwells = unifyStairwellHoles(props.polygon.outer, rawStairwells);
  for (const layer of roomFloorLayers({
    upperOutline: props.polygon.outer,
    upperElevationMm: floorZ,
    lowerLevels: props.lowerLevels,
  })) {
    const isUpperFloor = layer.elevationMm === floorZ;
    const floor = finishMesh(
      new THREE.Mesh(
        track(slabGeometry(shapeFromRing(layer.outline, isUpperFloor ? stairwells : []))),
        floorMaterial,
      ),
    );
    floor.position.z = layer.elevationMm * MM - 0.08;
    content.add(floor);
  }

  const ceilingMaterial = track(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  // The slab and the soffit hung under it answer their own toggles -- but for
  // an enclosed room the slab is always built, because hiding it must not
  // change the lighting. There are four storeys over this flat; removing its
  // ceiling from the scene let the sun fall straight in and drew shadows that
  // cannot happen. Hidden, it writes no colour and no depth and still casts
  // into the shadow map, the trick blender/render_scene.py uses with
  // visible_camera.
  //
  // The yard is the exception and it matters: it is open sky, and a slab that
  // always casts roofed it over.
  if (!props.isExternal) {
    const slab = flatMesh(props.polygon.outer, structuralZ, ceilingMaterial, track);
    if (!props.showCeiling) {
      slab.material = track(
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide }),
      );
    }
    content.add(slab);
  }
  const reveals = revealRuns(props.objects);
  const gypsumRing = insetRingAtReveals(props.polygon.outer, reveals);
  if (props.showGypsum && structuralZ > ceilingZ + 1) {
    content.add(flatMesh(gypsumRing, ceilingZ, finishes.gypsum, track));
  }
  if (props.showGypsum) {
    // Gypsum drawn where it is, so a bulkhead reads as a bulkhead.
    for (const soffit of props.soffits) {
      content.add(flatMesh(soffit.footprint.outer, soffit.elevation_mm, finishes.gypsum, track));
      // Without its returns the drop reads as a floating plate.
      for (const edge of fasciaEdges(soffit.footprint.outer, props.polygon.outer)) {
        renderBulkheadFascia(edge, soffit.elevation_mm, ceilingZ, finishes, track, content);
      }
    }
    for (const run of reveals) {
      // The structural plane already closes the slot when it is being drawn.
      renderCeilingReveal(run, ceilingZ, props.showCeiling ? null : structuralZ, finishes, track, content);
    }
  }
}
