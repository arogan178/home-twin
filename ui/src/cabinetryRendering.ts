import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { ArchitecturalMaterials } from "./architecturalMaterials";
import type { BuildingObject } from "./types";
import { renderSinkSurround } from "./kitchenSinkRendering";
import { renderKitchenObject } from "./kitchenRendering";
import { renderBedroomObject } from "./bedroomRendering";
import { renderFurniture } from "./furnitureRendering";
import { renderHvacObject } from "./hvacRendering";
import { renderWetRoomObject } from "./wetRoomRendering";
import { BOARD_M, FRONT_ARRIS_M, FRONT_GAP_M, Joinery } from "./joineryGeometry";
import { panelCourses, panelSpans } from "./wallPanelGeometry";

const MM = 0.001;

// One pass of the walnut figure, so the grain keeps one scale across the room.
const GRAIN_TILE_M = 0.5;
const GRAIN_RUN_M = 2.4;

function finishMesh(mesh: THREE.Mesh): THREE.Mesh {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** One panel's walnut, scaled to the piece and with the grain standing vertical.
 *
 * Every panel shared one unscaled material, so a 1 m panel and a 3.4 m run wore
 * the same stretched texture and the wall read as a slab. A box's side faces
 * also carry swapped UV axes, so a run along Y drew the grain lying down.
 */
function panelFaceMaterial(
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T) => T,
  widthM: number,
  heightM: number,
  runsAlongY: boolean,
): THREE.MeshStandardMaterial {
  const source = finishes.joineryWood;
  if (source.map === null) return source;
  const map = track(source.map.clone());
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.center.set(0.5, 0.5);
  // The texture varies across U, so U has to lie across the panel's width.
  map.rotation = runsAlongY ? Math.PI / 2 : 0;
  const across = Math.max(widthM / GRAIN_TILE_M, 0.25);
  const along = Math.max(heightM / GRAIN_RUN_M, 0.25);
  map.repeat.set(runsAlongY ? along : across, runsAlongY ? across : along);
  map.needsUpdate = true;
  return track(new THREE.MeshStandardMaterial({ map, color: source.color, roughness: source.roughness }));
}

/**
 * A piece of loose joinery facing -Y: carcass edges showing round inset
 * leaves, a back, and an optional recessed plinth, drawn as one mesh a material.
 */
function freeStandingCabinet(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T) => T,
  content: THREE.Group,
  options: { plinthM: number; leaves: number; handles: boolean },
): void {
  const min = object.bounds.minimum;
  const max = object.bounds.maximum;
  const w = (max.x - min.x) * MM;
  const d = (max.y - min.y) * MM;
  const h = (max.z - min.z) * MM;
  const group = new THREE.Group();
  group.name = object.name;
  group.position.set(((min.x + max.x) / 2) * MM, ((min.y + max.y) / 2) * MM, min.z * MM);
  content.add(group);
  const joinery = new Joinery();
  const walnut = finishes.joineryWood;
  const base = options.plinthM;
  if (base > 0) {
    // The kick stands 40 mm back so the carcass reads as standing on shadow.
    joinery.board("Recessed plinth", finishes.plinth, [w - 0.08, d - 0.06, base], [0, 0.01, base / 2]);
  }
  const body = h - base;
  for (const side of [-1, 1]) {
    joinery.board("Carcass side", walnut, [BOARD_M, d, body], [side * (w - BOARD_M) / 2, 0, base + body / 2], FRONT_ARRIS_M, "-y");
  }
  for (const z of [base + BOARD_M / 2, h - BOARD_M / 2]) {
    joinery.board("Carcass top and bottom", walnut, [w - 2 * BOARD_M, d, BOARD_M], [0, 0, z], FRONT_ARRIS_M, "-y");
  }
  const back = 0.008;
  joinery.board("Back panel", walnut, [w - 2 * BOARD_M, back, body - 2 * BOARD_M], [0, d / 2 - back / 2, base + body / 2]);
  const innerW = w - 2 * BOARD_M;
  const innerH = body - 2 * BOARD_M;
  const front = 0.019;
  // Dark behind the leaves, so each shadow gap reads as a gap and not as wall.
  joinery.board("Recessed interior", finishes.plinth, [innerW - 0.002, 0.004, innerH - 0.002], [0, -d / 2 + front + 0.004, base + body / 2]);
  const leafW = innerW / options.leaves;
  const leafH = innerH - FRONT_GAP_M * 2;
  const z = base + body / 2;
  for (let leaf = 0; leaf < options.leaves; leaf += 1) {
    const x = -innerW / 2 + (leaf + 0.5) * leafW;
    joinery.board("Door front", walnut, [leafW - FRONT_GAP_M * 2, front, leafH], [x, -d / 2 + front / 2, z], FRONT_ARRIS_M, "-y");
  }
  if (options.handles) {
    // A 160 mm bar on two stand-offs either side of the meeting edges.
    const length = 0.16;
    for (const side of [-1, 1]) {
      const x = side * 0.03;
      const bar = new THREE.CylinderGeometry(0.006, 0.006, length + 0.02, 16).rotateX(Math.PI / 2).translate(x, -d / 2 - 0.03, z);
      joinery.add("Bar handle", finishes.chrome, bar);
      for (const end of [-1, 1]) {
        const post = new THREE.CylinderGeometry(0.005, 0.005, 0.03, 12).translate(x, -d / 2 - 0.015, z + end * length / 2);
        joinery.add("Bar handle", finishes.chrome, post);
      }
    }
  }
  joinery.build(group, track as <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T);
}

/**
 * Renders architectural building objects with realistic details, materials,
 * and dimensional depth (plinth reveals, door seams, worktop overhangs, appliances).
 */
export function renderDetailedBuildingObject(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T) => T,
  content: THREE.Group,
  neighbours: readonly BuildingObject[] = [],
  tableClosed = false,
  openCarcass = false,
): boolean {
  if (renderBedroomObject(object, finishes, track, content)) return true;
  if (renderWetRoomObject(object, finishes, track, content)) return true;
  if (renderHvacObject(object, finishes, track, content)) return true;
  if (renderSinkSurround(object, neighbours, finishes, track, content)) return true;
  if (renderKitchenObject(object, finishes, track, content, openCarcass)) return true;
  if (renderFurniture(object, finishes, track, content, tableClosed)) return true;

  const min = object.bounds.minimum;
  const max = object.bounds.maximum;
  const name = object.name.toLowerCase();

  const width = Math.max(max.x - min.x, 20) * MM;
  const depth = Math.max(max.y - min.y, 20) * MM;
  const tall = Math.max(max.z - min.z, 20) * MM;
  const centreX = ((min.x + max.x) / 2) * MM;
  const centreY = ((min.y + max.y) / 2) * MM;

  // 0. Beams (Plenum structural beams)
  if (name.includes("beam") || object.kind === "beam") {
    // If the beam is located in the ceiling plenum above the finished ceiling (min.z >= 3650),
    // it is hidden behind the gypsum ceiling and must not be rendered as a floating box in the room.
    if (min.z >= 3650) {
      return true;
    }
    const beamGeom = track(new THREE.BoxGeometry(width, depth, tall));
    const beam = finishMesh(new THREE.Mesh(beamGeom, finishes.gypsum));
    beam.position.set(centreX, centreY, ((min.z + max.z) / 2) * MM);
    content.add(beam);
    return true;
  }

  if (name.includes("crema di roccia")) {
    const mesh = finishMesh(new THREE.Mesh(track(new THREE.BoxGeometry(width, depth, tall)), finishes.stair));
    mesh.position.set(centreX, centreY, ((min.z + max.z) / 2) * MM);
    content.add(mesh);
    return true;
  }

  if (name.includes("partition")) {
    const mesh = finishMesh(new THREE.Mesh(track(new THREE.BoxGeometry(width, depth, tall)), finishes.gypsum));
    mesh.position.set(centreX, centreY, ((min.z + max.z) / 2) * MM);
    content.add(mesh);
    return true;
  }

  // 13. Walnut panel wall (laminate-faced MDF on battens, shadow gaps between)
  if (name.includes("panel wall")) {
    const battenDepth = 0.018;
    const panelDepth = 0.019;
    const gap = 0.006;
    const targetWidth = 1.0;
    // Egger boards are 2800 long with the grain running the length, so a taller
    // run cannot be one vertical-grain piece.
    const boardLength = 2.8;
    // The panel hangs clear of what is under it. The dark ground runs on down
    // past it, or the reveal shows pale wall and reads as a gap, not a shadow.
    const baseReveal = 0.012;
    // The panel is a thin box against a wall, so its short side is the build-up.
    const runsAlongY = depth > width;
    const runM = runsAlongY ? depth : width;
    const faceX = max.x * MM;
    const faceY = max.y * MM;
    const baseZ = min.z * MM;

    const groundHeight = tall + baseReveal;
    const battenGeom = track(
      runsAlongY
        ? new THREE.BoxGeometry(battenDepth, depth, groundHeight)
        : new THREE.BoxGeometry(width, battenDepth, groundHeight),
    );
    const battens = finishMesh(new THREE.Mesh(battenGeom, finishes.plinth));
    battens.position.set(
      runsAlongY ? faceX - battenDepth / 2 : centreX,
      runsAlongY ? centreY : faceY - battenDepth / 2,
      baseZ - baseReveal + groundHeight / 2,
    );
    content.add(battens);

    const panelFaceX = faceX - battenDepth - panelDepth / 2;
    const panelFaceY = faceY - battenDepth - panelDepth / 2;
    for (const course of panelCourses(tall, boardLength, gap)) {
      const courseHeight = course.toM - course.fromM;
      for (const span of panelSpans(runM, targetWidth, gap)) {
        const spanWidth = span.toM - span.fromM;
        const geometry = track(
          runsAlongY
            ? new THREE.BoxGeometry(panelDepth, spanWidth, courseHeight)
            : new THREE.BoxGeometry(spanWidth, panelDepth, courseHeight),
        );
        const panel = finishMesh(
          new THREE.Mesh(geometry, panelFaceMaterial(finishes, track, spanWidth, courseHeight, runsAlongY)),
        );
        panel.position.set(
          runsAlongY ? panelFaceX : min.x * MM + span.fromM + spanWidth / 2,
          runsAlongY ? min.y * MM + span.fromM + spanWidth / 2 : panelFaceY,
          baseZ + course.fromM + courseHeight / 2,
        );
        content.add(panel);
      }
    }

    return true;
  }

  // 14. Kitchen Splashback
  if (name.includes("splashback")) {
    const stoneGeom = track(new RoundedBoxGeometry(width, depth, tall, 2, Math.min(0.002, width / 4, depth / 4, tall / 4)));
    const stone = finishMesh(new THREE.Mesh(stoneGeom, finishes.worktop));
    stone.position.set(centreX, centreY, ((min.z + max.z) / 2) * MM);
    content.add(stone);
    return true;
  }

  // 15. Television
  if (
    name.includes("television") ||
    (name.includes("tv") && !name.includes("console") && !name.includes("bench") && !name.includes("unit"))
  ) {
    // Ultra-slim charcoal chassis
    const chassisDepth = 0.035;
    const chassisGeom = track(new RoundedBoxGeometry(width, chassisDepth, tall, 2, 0.004));
    const chassis = finishMesh(new THREE.Mesh(chassisGeom, finishes.plinth));
    chassis.position.set(centreX, centreY, ((min.z + max.z) / 2) * MM);
    content.add(chassis);

    // Deep glossy black OLED display on south face
    const screenGeom = track(new THREE.BoxGeometry(width - 0.024, 0.004, tall - 0.024));
    const screen = finishMesh(new THREE.Mesh(screenGeom, finishes.tvScreen));
    screen.position.set(centreX, min.y * MM - 0.002, ((min.z + max.z) / 2) * MM);
    content.add(screen);

    // Slim bottom aluminum bezel trim
    const trimGeom = track(new THREE.BoxGeometry(width, 0.008, 0.012));
    const trim = finishMesh(new THREE.Mesh(trimGeom, finishes.stainless));
    trim.position.set(centreX, min.y * MM - 0.002, min.z * MM + 0.006);
    content.add(trim);
    return true;
  }

  // 16. TV media console, wall-hung: the authored envelope starts 230 mm off the
  // floor, so there is no plinth to draw. Push-to-open, so no handles.
  if (
    name.includes("media console") ||
    name.includes("tv console") ||
    name.includes("tv bench") ||
    name.includes("credenza")
  ) {
    freeStandingCabinet(object, finishes, track, content, { plinthM: 0, leaves: 3, handles: false });
    return true;
  }

  // 20. Drinks cabinet: a pair of leaves on a recessed plinth, with bar handles
  // at the meeting edges. Door split and handles are display allowances.
  if (name.includes("drinks cabinet") || name.includes("bar cabinet")) {
    freeStandingCabinet(object, finishes, track, content, { plinthM: 0.08, leaves: 2, handles: true });
    return true;
  }

  // 21. General Cabinet fallback (joinery wood with plinth)
  if (object.kind === "cabinet" || name.includes("cabinet")) {
    const plinthH = Math.min(0.1, tall * 0.1);
    const carcassH = tall - plinthH;

    const plinthGeom = track(new THREE.BoxGeometry(Math.max(width - 0.06, 0.05), Math.max(depth - 0.06, 0.05), plinthH));
    const plinth = finishMesh(new THREE.Mesh(plinthGeom, finishes.plinth));
    plinth.position.set(centreX, centreY, min.z * MM + plinthH / 2);
    content.add(plinth);

    const carcassGeom = track(new RoundedBoxGeometry(width, depth, carcassH, 2, Math.min(0.003, width / 4, depth / 4, carcassH / 4)));
    const carcass = finishMesh(new THREE.Mesh(carcassGeom, finishes.joineryWood));
    carcass.position.set(centreX, centreY, min.z * MM + plinthH + carcassH / 2);
    content.add(carcass);

    return true;
  }

  return false;
}
