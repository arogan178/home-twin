/**
 * Display meshes for light fittings and switches, shared by both 3D views.
 *
 * Appearance only: the lights each view adds, their intensities, beams and
 * pools are built by the view and never read from these meshes.
 */

import * as THREE from "three";

import {
  buildSpotlightGeometries,
  MODULE_PIVOT_MM,
  spotlightAim,
  spotlightFitting,
  spotlightRadiiMm,
  TRIM_PROJECTION_MM,
  type SpotlightGeometries,
} from "./spotlightGeometry";
import type { BuildingObject, Fixture, WallSwitch } from "./types";

const MM = 0.001;

/** Trim projection below the finished ceiling, matching TRIM_PROJECTION_MM in ifc.py. */
export const TRIM_PROJECTION_M = TRIM_PROJECTION_MM * MM;
const CORD_RADIUS_M = 0.003;

/**
 * Whether an object lies wholly above the finished ceiling while the gypsum
 * layer is off. The void is only drawn with the ceiling construction: the slab
 * alone is faint, and seen from above it is not there at all, so a duct drawn
 * without the gypsum floats across the open room.
 */
export function hiddenInCeilingVoid(
  object: Pick<BuildingObject, "bounds">,
  finishedCeilingMm: number,
  gypsumShown: boolean,
): boolean {
  return !gypsumShown && object.bounds.minimum.z >= finishedCeilingMm - 1;
}

type Track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(value: T) => T;

type Spotlight = Extract<Fixture, { kind: "recessed_spotlight" }>;
type Pendant = Extract<Fixture, { kind: "pendant_bulb" }>;
type Rope = Extract<Fixture, { kind: "rope_light" }>;

export type FixtureMaterials = {
  /** Painted trim, canopy and switch rocker. */
  readonly trim: THREE.Material;
  /** An unlit lamp face. */
  readonly baffle: THREE.Material;
  /** The can in the ceiling void, drawn only with the gypsum, like the rest of the void. */
  readonly housing: THREE.Material;
  readonly cord: THREE.Material;
  /** The trim seen from above while the void is not drawn: one-sided, facing up. */
  readonly cap: THREE.Material;
};

/**
 * `exposure` is the view's tone-mapping exposure. The composer tone-maps every
 * pixel, `toneMapped: false` included, so an unlit colour is divided by it to
 * come out as itself.
 */
export function createFixtureMaterials(track: Track, exposure = 1): FixtureMaterials {
  return {
    // Two-sided, so a trim seen from above through an undrawn ceiling is still a ring at the ceiling plane.
    trim: track(new THREE.MeshStandardMaterial({ color: 0xf0ede7, roughness: 0.78, side: THREE.DoubleSide })),
    baffle: track(new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.92, side: THREE.DoubleSide })),
    housing: track(new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.42, metalness: 0.55 })),
    cord: track(new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.8 })),
    // Unlit: the back of a trim gets no light from the room below, and shaded it read as a dark puck.
    cap: track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe6e2da).multiplyScalar(1 / exposure) })),
  };
}

/** A mesh standing upright on +Z: a three.js cylinder runs along +Y. */
function upright(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

// One build's materials bound its lifetime, so they key the geometry its fittings share.
const spotlightGeometryCache = new WeakMap<FixtureMaterials, Map<string, SpotlightGeometries>>();

function sharedSpotlightGeometries(fixture: Spotlight, materials: FixtureMaterials, track: Track): SpotlightGeometries {
  const fitting = spotlightFitting(fixture);
  const radii = spotlightRadiiMm(fixture.spec);
  const key = [fitting, radii.trim, radii.cutout, fixture.spec.mounting_depth_mm].join("|");
  let byType = spotlightGeometryCache.get(materials);
  if (byType === undefined) spotlightGeometryCache.set(materials, (byType = new Map()));
  const existing = byType.get(key);
  if (existing !== undefined) return existing;
  const built = buildSpotlightGeometries(fitting, radii.trim, radii.cutout, fixture.spec.mounting_depth_mm);
  for (const geometry of [built.body, built.lens, built.module, built.housing, built.cap]) {
    if (geometry !== null) track(geometry);
  }
  byType.set(key, built);
  return built;
}

/**
 * A recessed downlight as it is installed: a white trim and throat with the
 * lamp set up inside it, an adjustable insert tilted onto the fitting's aim,
 * and, when the ceiling void is drawn, the clips and wiring above the board.
 *
 * Returns the meshes a pick or a selection should take.
 */
export function addSpotlight(
  parent: THREE.Object3D,
  fixture: Spotlight,
  lamp: THREE.Material,
  materials: FixtureMaterials,
  track: Track,
  showVoid = false,
): THREE.Mesh[] {
  const shapes = sharedSpotlightGeometries(fixture, materials, track);
  const origin = new THREE.Vector3(fixture.point.x * MM, fixture.point.y * MM, fixture.point.z * MM);
  const body = new THREE.Mesh(shapes.body, materials.trim);
  body.position.copy(origin);
  const lens = new THREE.Mesh(shapes.lens, lamp);
  lens.position.copy(origin).z += shapes.lensMm * MM;
  // Without the void, the fitting closes at its top, so from above it is a
  // trim-sized disc at the ceiling plane, not a hole or a can.
  const top = showVoid ? new THREE.Mesh(shapes.housing, materials.housing) : new THREE.Mesh(shapes.cap, materials.cap);
  top.position.copy(origin);
  if (!showVoid) top.position.z += shapes.capMm * MM;
  const handles = [body, top];

  if (shapes.module !== null) {
    const aim = spotlightAim(fixture.direction);
    const axis = new THREE.Vector3(0, 0, -1).applyQuaternion(aim);
    // The pins lie on the tilt axis, square to the aim in plan.
    body.rotation.z = Math.atan2(-axis.x, axis.y);
    const module = new THREE.Mesh(shapes.module, materials.trim);
    module.position.copy(origin).z += MODULE_PIVOT_MM * MM;
    module.quaternion.copy(aim);
    lens.position.copy(module.position).addScaledVector(axis, -shapes.moduleLensMm * MM);
    lens.quaternion.copy(aim);
    handles.splice(1, 0, module);
  }

  for (const handle of handles) handle.userData.tag = fixture.tag;
  parent.add(...handles, lens);
  return handles;
}

/** The opal glow of a pendant's shade, from its rated lumens over the shade's surface. */
export function pendantShadeMaterial(fixture: Pendant, active: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: active ? 0xfff6e6 : 0xe0d9cb,
    emissive: active ? 0xffdab0 : 0x000000,
    emissiveIntensity: active
      ? (fixture.spec.lumens ?? 800) / (4 * Math.PI ** 2 * (fixture.spec.bulb_diameter_mm * MM / 2) ** 2)
      : 0,
    roughness: 0.68,
  });
}

/** Where a pendant's shade hangs: its centre sits the drop below the ceiling point. */
export function pendantShadeCentre(fixture: Pendant): THREE.Vector3 {
  return new THREE.Vector3(fixture.point.x * MM, fixture.point.y * MM, (fixture.point.z - fixture.spec.drop_mm) * MM);
}

/**
 * A pendant: ceiling rose, cord, the gallery that holds the shade, and the
 * opal shade itself. Returns the meshes a pick or a selection should take.
 */
export function addPendant(
  parent: THREE.Object3D,
  fixture: Pendant,
  shade: THREE.Material,
  materials: FixtureMaterials,
  track: Track,
): THREE.Mesh[] {
  const x = fixture.point.x * MM;
  const y = fixture.point.y * MM;
  const ceilingM = fixture.point.z * MM;
  const roseRadiusM = (fixture.spec.canopy_diameter_mm * MM) / 2;
  const roseDepthM = fixture.spec.canopy_depth_mm * MM;
  const shadeRadiusM = (fixture.spec.bulb_diameter_mm * MM) / 2;
  const centre = pendantShadeCentre(fixture);
  const shadeTopM = centre.z + shadeRadiusM;

  const rose = upright(
    track(new THREE.CylinderGeometry(roseRadiusM * 0.85, roseRadiusM, roseDepthM, 28)),
    materials.trim,
    x,
    y,
    ceilingM - roseDepthM / 2,
  );
  const galleryHeightM = Math.min(0.04, shadeRadiusM * 0.25);
  const galleryRadiusM = Math.max(shadeRadiusM * 0.2, 0.02);
  const cordTopM = ceilingM - roseDepthM;
  const cordBottomM = shadeTopM + galleryHeightM * 0.5;
  const cordLengthM = Math.max(cordTopM - cordBottomM, 0.01);
  const cord = upright(
    track(new THREE.CylinderGeometry(CORD_RADIUS_M, CORD_RADIUS_M, cordLengthM, 8)),
    materials.cord,
    x,
    y,
    cordBottomM + cordLengthM / 2,
  );
  // Sunk half into the shade, the way a gallery grips the neck of a globe.
  const gallery = upright(
    track(new THREE.CylinderGeometry(galleryRadiusM * 0.7, galleryRadiusM, galleryHeightM, 24)),
    materials.cord,
    x,
    y,
    shadeTopM,
  );
  const globe = new THREE.Mesh(track(new THREE.SphereGeometry(shadeRadiusM, 32, 24)), shade);
  globe.position.copy(centre);
  for (const handle of [rose, globe]) handle.userData.tag = fixture.tag;
  parent.add(rose, cord, gallery, globe);
  return [rose, globe];
}

/** A rope light's run as a tube along its authored path. */
export function addRope(
  parent: THREE.Object3D,
  fixture: Rope,
  material: THREE.Material,
  track: Track,
  minimumRadiusM = 0.006,
): THREE.Mesh {
  const curve = new THREE.CurvePath<THREE.Vector3>();
  fixture.path.slice(1).forEach((point, index) => {
    const previous = fixture.path[index]!;
    curve.add(new THREE.LineCurve3(
      new THREE.Vector3(previous.x * MM, previous.y * MM, previous.z * MM),
      new THREE.Vector3(point.x * MM, point.y * MM, point.z * MM),
    ));
  });
  const rope = new THREE.Mesh(
    track(new THREE.TubeGeometry(
      curve,
      Math.max(8, fixture.path.length * 10),
      Math.max((fixture.spec.diameter_mm * MM) / 2, minimumRadiusM),
      10,
      false,
    )),
    material,
  );
  rope.userData.tag = fixture.tag;
  parent.add(rope);
  return rope;
}

/**
 * A wall switch: the plate on the wall face and its rocker. Returns the plate,
 * which carries the group a click previews.
 */
export function addSwitch(
  parent: THREE.Object3D,
  device: WallSwitch,
  wall: { readonly start: { readonly x: number; readonly y: number }; readonly end: { readonly x: number; readonly y: number } },
  point: { readonly x: number; readonly y: number; readonly z: number },
  plateMaterial: THREE.Material,
  rockerMaterial: THREE.Material,
  track: Track,
): THREE.Mesh {
  const widthM = device.spec.width_mm * MM;
  const depthM = device.spec.depth_mm * MM;
  const heightM = device.spec.height_mm * MM;
  const plate = new THREE.Mesh(track(new THREE.BoxGeometry(widthM, depthM, heightM)), plateMaterial);
  plate.position.set(point.x * MM, point.y * MM, point.z * MM);
  plate.rotation.z = Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
  plate.userData.switchTag = device.tag;
  plate.userData.controlGroup = device.switching_group;
  const rocker = new THREE.Mesh(track(new THREE.BoxGeometry(widthM * 0.48, depthM * 1.6, heightM * 0.62)), rockerMaterial);
  rocker.position.copy(plate.position);
  rocker.rotation.copy(plate.rotation);
  rocker.translateY(-depthM * 0.75);
  parent.add(plate, rocker);
  return plate;
}
