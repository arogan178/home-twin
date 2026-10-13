import * as THREE from "three";

import { softExtrudeGeometry, type ArchitecturalMaterials } from "./architecturalMaterials";
import { addTap, tapFinishFor, tapModelFor, tapPlacement } from "./tapGeometry";
import type { BuildingObject } from "./types";
import { parseRoute } from "./serviceRoutes";

const MM = 0.001;
const ROLE = "Pset_HomeTwinWetRoom.Role";
const FINISH = "Pset_HomeTwinWetRoom.Finish";
const ROTATION = "Pset_HomeTwinWetRoom.RotationDegrees";
const ROUTE = "Pset_HomeTwinWetRoom.RouteMm";
const BACKLIGHT = "Pset_HomeTwinWetRoom.BacklightCctKelvin";
const PRODUCT = "Pset_HomeTwinWetRoom.Product";

type Track = <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T;

/** Display tints for authored finish names. IFC carries the name; the colour is a viewer allowance. */
const MARBLE_TINTS: Readonly<Record<string, number>> = {
  grey_marble: 0x9c9c9a,
  grey_stone_marble: 0x9c9c9a,
  travertine_marble: 0xd6c1a1,
  pale_yellow_marble: 0xe9dcb9,
};

/** Flexible duct ridge pitch; the profile texture carries one ridge a tile. */
const DUCT_RIDGE_PITCH_M = 0.01;

/** A tube whose U coordinate counts ridges along its length, so the ridge pitch holds on any run. */
export function corrugatedTube(curve: THREE.Curve<THREE.Vector3>, radius: number): THREE.TubeGeometry {
  const tube = new THREE.TubeGeometry(curve, 48, radius, 16, false);
  const ridges = curve.getLength() / DUCT_RIDGE_PITCH_M;
  const uv = tube.getAttribute("uv");
  for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * ridges);
  return tube;
}

function footprintShape(object: BuildingObject): THREE.Shape | null {
  const outer = object.plan_footprint?.outer;
  if (!outer || outer.length < 3) return null;
  const shape = new THREE.Shape();
  outer.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x * MM, point.y * MM);
    else shape.lineTo(point.x * MM, point.y * MM);
  });
  shape.closePath();
  return shape;
}

export function renderWetRoomObject(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: Track,
  content: THREE.Group,
): boolean {
  const role = object.properties[ROLE];
  if (typeof role !== "string") return false;
  const finish = object.properties[FINISH];
  const min = object.bounds.minimum;
  const max = object.bounds.maximum;
  const width = (max.x - min.x) * MM;
  const depth = (max.y - min.y) * MM;
  const height = (max.z - min.z) * MM;
  const x = (min.x + max.x) * MM / 2;
  const y = (min.y + max.y) * MM / 2;
  const z = min.z * MM;
  const white = track(new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.34 }));
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, px: number, py: number, pz: number) => {
    const mesh = new THREE.Mesh(track(geometry), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(px, py, pz);
    content.add(mesh);
    return mesh;
  };
  /** A solid standing on the object's own plan outline, so a turned unit keeps its true shape. */
  const prism = (material: THREE.Material, bottom: number, top: number, arris = 0) => {
    const shape = footprintShape(object);
    if (shape === null) {
      add(new THREE.BoxGeometry(width, depth, top - bottom), material, x, y, (bottom + top) / 2);
      return;
    }
    const geometry = arris > 0
      ? softExtrudeGeometry(shape, top - bottom, arris, 1)
      : new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false });
    const mesh = add(geometry, material, 0, 0, bottom);
    mesh.position.set(0, 0, bottom);
  };

  if (role === "bath") {
    const rim = 0.07;
    const base = 0.1;
    add(new THREE.BoxGeometry(width, depth, base), white, x, y, z + base / 2);
    // One-piece rim ring with rounded outer corners instead of four seamed boxes.
    const corner = Math.min(rim, 0.05);
    const hw = width / 2;
    const hd = depth / 2;
    const ring = new THREE.Shape();
    ring.moveTo(-hw + corner, -hd);
    ring.lineTo(hw - corner, -hd);
    ring.absarc(hw - corner, -hd + corner, corner, -Math.PI / 2, 0, false);
    ring.lineTo(hw, hd - corner);
    ring.absarc(hw - corner, hd - corner, corner, 0, Math.PI / 2, false);
    ring.lineTo(-hw + corner, hd);
    ring.absarc(-hw + corner, hd - corner, corner, Math.PI / 2, Math.PI, false);
    ring.lineTo(-hw, -hd + corner);
    ring.absarc(-hw + corner, -hd + corner, corner, Math.PI, Math.PI * 1.5, false);
    const inner = new THREE.Path();
    const iw = hw - rim;
    const id = hd - rim;
    inner.moveTo(-iw, -id);
    inner.lineTo(iw, -id);
    inner.lineTo(iw, id);
    inner.lineTo(-iw, id);
    inner.closePath();
    ring.holes.push(inner);
    add(softExtrudeGeometry(ring, height - base, 0.015), white, x, y, z + base);
    const drain = add(new THREE.CylinderGeometry(0.023, 0.023, 0.003, 24), finishes.stainless, x + width * 0.32, y, z + base + 0.002);
    drain.rotation.x = Math.PI / 2;
    return true;
  }
  if (role === "shower") {
    add(new THREE.BoxGeometry(width, depth, 0.07), white, x, y, z + 0.035);
    const frontY = y - depth / 2;
    // Fixed and sliding panes overlap in depth along the long entry edge.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(width / 2, 0.012, height - 0.07), finishes.glass, x + side * width / 4, frontY + (side < 0 ? 0.006 : 0.018), z + 0.07 + (height - 0.07) / 2);
    }
    const chrome = finishes.stainless;
    for (const railZ of [z + 0.082, z + height - 0.012]) {
      add(new THREE.BoxGeometry(width, 0.024, 0.024), chrome, x, frontY + 0.012, railZ);
    }
    add(new THREE.BoxGeometry(0.016, 0.016, 0.24), chrome, x + 0.06, frontY + 0.035, z + 1.05);
    addTap(finishes, track, content, {
      model: "shower-system",
      envelope: { bodyRadius: 0, reach: 0, height },
      finish: "chrome",
      name: "Shower valve, riser and head",
      position: new THREE.Vector3(x - width / 2, y, z),
      rotation: 0,
    });
    return true;
  }
  if (role === "toilet") {
    const firstMesh = content.children.length;
    const panHeight = Math.min(height * 0.55, 0.42);
    const cistDepth = depth * 0.28;
    const cistHeight = height - panHeight;
    const hw = width / 2;
    const hd = depth / 2;

    // 1. Floor-standing D-shape pan skirted flush to the wall
    const panShape = new THREE.Shape();
    panShape.moveTo(-hw, -hd);
    panShape.lineTo(hw, -hd);
    panShape.lineTo(hw, hd - hw);
    panShape.absarc(0, hd - hw, hw, 0, Math.PI, false);
    panShape.lineTo(-hw, -hd);
    add(softExtrudeGeometry(panShape, panHeight, 0.012, 24), white, x, y, z);

    // 2. Monolithic back-to-wall cistern flush against the wall
    add(new THREE.BoxGeometry(width, cistDepth, cistHeight), white, x, y - hd + cistDepth / 2, z + panHeight + cistHeight / 2);

    // 3. Slimline soft-close seat & lid
    const seatHw = hw * 0.96;
    const seatFrontY = hd - 0.005;
    // Tucked 5 mm into the cistern face: a back-to-wall seat meets the china
    // with a contact line, not a shadow slot that reads as a detached bowl.
    const seatBackY = -hd + cistDepth - 0.005;
    const seatShape = new THREE.Shape();
    seatShape.moveTo(-seatHw, seatBackY);
    seatShape.lineTo(seatHw, seatBackY);
    seatShape.lineTo(seatHw, seatFrontY - seatHw);
    seatShape.absarc(0, seatFrontY - seatHw, seatHw, 0, Math.PI, false);
    seatShape.lineTo(-seatHw, seatBackY);
    add(softExtrudeGeometry(seatShape, 0.025, 0.006, 20), white, x, y, z + panHeight);

    // 4. Dual-flush chrome actuator button on cistern lid
    const button = add(new THREE.CylinderGeometry(0.025, 0.025, 0.004, 20), finishes.stainless, x, y - hd + cistDepth / 2, z + height + 0.002);
    button.rotation.x = Math.PI / 2;

    const rotation = Number(object.properties[ROTATION] ?? 0) * Math.PI / 180;
    const axis = new THREE.Vector3(0, 0, 1);
    for (const mesh of content.children.slice(firstMesh)) {
      mesh.position.sub(new THREE.Vector3(x, y, z)).applyAxisAngle(axis, rotation).add(new THREE.Vector3(x, y, z));
      mesh.rotateOnWorldAxis(axis, rotation);
    }
    return true;
  }
  if (role === "basin") {
    const tint = typeof finish === "string" ? MARBLE_TINTS[finish] : undefined;
    const marble = track(new THREE.MeshStandardMaterial({
      map: finishes.worktop.map,
      color: tint ?? 0xfbfaf8,
      roughness: 0.3,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }));
    const radius = Math.min(width, depth) / 2;
    // Lathed bowl: outer wall up, flat rim, inner curve down to the waste.
    const profile = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(radius * 0.86, 0),
      new THREE.Vector2(radius, height * 0.55),
      new THREE.Vector2(radius, height),
      new THREE.Vector2(radius * 0.82, height),
      new THREE.Vector2(radius * 0.6, height * 0.35),
      new THREE.Vector2(0, height * 0.3),
    ];
    const bowl = add(new THREE.LatheGeometry(profile, 32), marble, x, y, z);
    bowl.rotation.x = Math.PI / 2;
    return true;
  }
  if (role === "tap") {
    const rotation = Number(object.properties[ROTATION] ?? 0) * Math.PI / 180;
    const { position, envelope } = tapPlacement(object, rotation);
    addTap(finishes, track, content, {
      model: tapModelFor(object.properties[PRODUCT]),
      envelope,
      finish: tapFinishFor(finish),
      name: object.name,
      position,
      rotation,
    });
    return true;
  }
  if (role === "mirror") {
    const thin = Math.min(width, depth);
    const face = Math.max(width, depth);
    const thinAlongX = width < depth;
    const glass = track(new THREE.MeshStandardMaterial({ color: 0xd3dde2, roughness: 0.04, metalness: 0.95 }));
    // A cylinder's axis is local Y; turn it onto the thin direction so the disc stands on the wall.
    const plate = add(new THREE.CylinderGeometry(face / 2, face / 2, thin, 48), glass, x, y, z + height / 2);
    plate.rotation.z = thinAlongX ? Math.PI / 2 : 0;
    plate.scale.set(1, 1, height / face);
    if (typeof object.properties[BACKLIGHT] === "number") {
      const rotation = Number(object.properties[ROTATION] ?? 0) * Math.PI / 180;
      const frontX = Math.sin(rotation);
      const frontY = -Math.cos(rotation);
      const halo = track(new THREE.MeshBasicMaterial({ color: 0xfff0d2, side: THREE.DoubleSide }));
      // The lit ring sits just proud of the wall face, behind the plate's edge.
      const ring = add(
        new THREE.RingGeometry(face / 2 * 0.9, face / 2 * 1.06, 48),
        halo,
        x - frontX * (thin / 2 - 0.004),
        y - frontY * (thin / 2 - 0.004),
        z + height / 2,
      );
      if (thinAlongX) {
        ring.rotation.y = Math.PI / 2;
        ring.scale.set(height / face, 1, 1);
      } else {
        ring.rotation.x = Math.PI / 2;
        ring.scale.set(1, height / face, 1);
      }
    }
    return true;
  }
  if (role === "ledge") {
    const tile = track(new THREE.MeshStandardMaterial({ color: 0x9e9b96, roughness: 0.5 }));
    prism(tile, z, z + height);
    return true;
  }
  if (role === "vanity" || role === "tall_cupboard") {
    const carcass = finish === "walnut" ? finishes.joineryWood : finishes.object;
    if (role === "vanity") {
      prism(carcass, z, z + height - 0.02);
      prism(finishes.worktop, z + height - 0.02, z + height, 0.002);
    } else {
      prism(carcass, z, z + height);
    }
    const rotation = Number(object.properties[ROTATION] ?? 0) * Math.PI / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const outline = object.plan_footprint?.outer;
    const projected = outline?.map((point) => ({
      x: (point.x * MM - x) * cos + (point.y * MM - y) * sin,
      y: -(point.x * MM - x) * sin + (point.y * MM - y) * cos,
    }));
    const localWidth = projected?.length ? Math.max(...projected.map((p) => p.x)) - Math.min(...projected.map((p) => p.x)) : width;
    const front = projected?.length ? Math.min(...projected.map((p) => p.y)) : -depth / 2;
    // Recessed joints separate the two drawer fronts or cupboard doors.
    const jointZ = role === "vanity" ? z + (height - 0.02) / 2 : z + height * 0.55;
    const joint = add(new THREE.BoxGeometry(localWidth - 0.008, 0.002, 0.004), finishes.plinth, x - sin * (front - 0.001), y + cos * (front - 0.001), jointZ);
    joint.rotation.z = rotation;
    return true;
  }
  if (role === "extractor") {
    // The grille face is the envelope's underside, with its slots recessed into it.
    const grille = new THREE.Mesh(track(new THREE.CylinderGeometry(width / 2, width / 2, 0.014, 24)), white);
    grille.rotation.x = Math.PI / 2;
    grille.position.set(x, y, z + 0.013);
    content.add(grille);
    const slots = track(new THREE.MeshBasicMaterial({ color: 0x798584 }));
    for (let index = -2; index <= 2; index += 1) {
      add(new THREE.BoxGeometry(width * 0.62, 0.008, 0.006), slots, x, y + index * 0.025, z + 0.003);
    }
    if (height > 0.03) {
      const housing = track(new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.6 }));
      const body = add(new THREE.CylinderGeometry(width * 0.42, width * 0.42, height - 0.02, 24), housing, x, y, z + 0.02 + (height - 0.02) / 2);
      body.rotation.x = Math.PI / 2;
    }
    return true;
  }
  if (role === "duct") {
    const route = parseRoute(object.properties[ROUTE]);
    const radius = Math.min(width, depth, height) / 2;
    if (route === null) {
      const pvc = track(new THREE.MeshStandardMaterial({ color: 0xf3f3f1, roughness: 0.55 }));
      add(new THREE.BoxGeometry(width, depth, height), pvc, x, y, z + height / 2);
      return true;
    }
    const curve = new THREE.CatmullRomCurve3(
      route.map((point) => new THREE.Vector3(point.x, point.y, point.z)), false, "centripetal", 0.35,
    );
    add(corrugatedTube(curve, radius), finishes.flexibleDuct, 0, 0, 0);
    return true;
  }
  if (role === "exhaust_terminal") {
    const alongX = width > depth;
    const radius = Math.min(width, depth) / 2;
    const length = Math.max(width, depth);
    const core = track(new THREE.MeshStandardMaterial({ color: 0xe1e1df, roughness: 0.6 }));
    const tube = add(new THREE.CylinderGeometry(radius, radius, length, 24), core, x, y, z + height / 2);
    tube.rotation.z = alongX ? Math.PI / 2 : 0;
    return true;
  }
  return false;
}
