/**
 * The light a room view stands in besides its fixtures: a standing indirect
 * term so shadowed surfaces do not read black, and the sun with the patches
 * and shafts its direct beam makes. Both are display; neither carries lux.
 */

import * as THREE from "three";

import { indirectIrradianceLux } from "./render";
import { ENVIRONMENT_SHEEN, type Scene } from "./roomEngine";
import { flatMesh } from "./roomShell";
import type { RoomView3DProps } from "./RoomView3D";
import type { Opening, SunPatch } from "./types";

const MM = 0.001;

/**
 * The bounce a room keeps with every light off, so its geometry still reads.
 * Daylight's own diffuse is not modelled here, so a room with the sun up keeps
 * more. Both are display floors, not illuminance.
 */
const NIGHT_AMBIENT_SHARE = 0.03;
const DAYLIGHT_AMBIENT_SHARE = 0.35;
/** Daylight is drawn well above the electric target; it carries no lux value. */
const SUN_DISPLAY_RATIO = 4;

type Track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T) => T;

/** Add the indirect term, the sun and its patches, and record the ambient on the room view for dimming. */
export function addIndirectAndDaylight(
  current: Scene,
  props: Pick<
    RoomView3DProps,
    "baked" | "openings" | "sunPatches" | "sunDirection" | "sunAltitudeDeg" | "floorElevationMm" | "showLightRendering"
  >,
  centre: { readonly x: number; readonly y: number; readonly span: number },
  referenceLux: number,
  track: Track,
) {
  const { scene, content } = current;
  const floorZ = props.floorElevationMm;
// Shadow maps only subtract light, so the room needs a standing indirect
// term or every shadowed surface reads as black. Its size is the shadow
// pass's own room interreflection when there is one; the hemisphere split
// and the environment sheen are appearance, and say nothing about where
// the bounce actually lands.
const bounceLux = indirectIrradianceLux(
  props.baked?.interreflection?.lux ?? null,
  referenceLux,
);
const indirect = props.showLightRendering ? bounceLux : referenceLux;
scene.environmentIntensity = indirect * ENVIRONMENT_SHEEN;
const sky = track(new THREE.HemisphereLight(0xe4ecf7, 0x8d857a, indirect));
// A hemisphere light takes its sky axis from its position, which defaults
// to +Y. This frame is +Z up, so the default lit the room sideways.
sky.position.set(0, 0, 1);
sky.userData.transient = true;
scene.add(sky);
// A shaping light for the finishes, driven at the indirect level so it
// models the room without competing with the fixtures. Display only, and
// so it does not cast: it stands outside a room whose ceiling is cut away
// and whose near walls are veiled, so a shadow from it is a shadow from a
// sun that is not there.
const fill = track(new THREE.DirectionalLight(0xffedda, indirect));
fill.position.set(centre.x - 6, centre.y - 9, 7);
fill.target.position.set(centre.x, centre.y, 1);
fill.castShadow = false;
fill.userData.transient = true;
fill.target.userData.transient = true;
scene.add(fill);
scene.add(fill.target);
const sunUp = props.sunDirection !== null && (props.sunAltitudeDeg ?? -1) > 0;
current.ambient = {
  sky,
  fill,
  indirect,
  floor: !props.showLightRendering ? 1 : sunUp ? DAYLIGHT_AMBIENT_SHARE : NIGHT_AMBIENT_SHARE,
};

if (props.sunDirection !== null && (props.sunAltitudeDeg ?? -1) > 0) {
  const towards = new THREE.Vector3(
    props.sunDirection.x,
    props.sunDirection.y,
    props.sunDirection.z,
  ).normalize();
  const sun = track(new THREE.DirectionalLight(0xfff0d4, referenceLux * SUN_DISPLAY_RATIO));
  sun.position.set(
    centre.x + towards.x * 40,
    centre.y + towards.y * 40,
    Math.max(towards.z, 0.05) * 40,
  );
  sun.target.position.set(centre.x, centre.y, 0);
  const reach = Math.max(centre.span, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -reach;
  sun.shadow.camera.right = reach;
  sun.shadow.camera.top = reach;
  sun.shadow.camera.bottom = -reach;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0006;
  sun.userData.transient = true;
  sun.target.userData.transient = true;
  scene.add(sun);
  scene.add(sun.target);

  // The gizmo sits just outside the room so the sun direction reads at a glance.
  const gizmoDistance = Math.max(centre.span * 0.85, 5);
  const gizmoPosition = new THREE.Vector3(
    centre.x + towards.x * gizmoDistance,
    centre.y + towards.y * gizmoDistance,
    Math.max(towards.z * gizmoDistance, 0.4),
  );
  const gizmoGeometry = track(new THREE.SphereGeometry(Math.max(centre.span * 0.035, 0.18), 18, 12));
  const gizmoMaterial = track(new THREE.MeshBasicMaterial({ color: 0xffd25e }));
  const gizmo = new THREE.Mesh(gizmoGeometry, gizmoMaterial);
  gizmo.position.copy(gizmoPosition);
  content.add(gizmo);

  const rayGeometry = track(
    new THREE.BufferGeometry().setFromPoints([gizmoPosition, new THREE.Vector3(centre.x, centre.y, 0)]),
  );
  const rayMaterial = track(
    new THREE.LineDashedMaterial({ color: 0xd99b1f, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.7 }),
  );
  const ray = new THREE.Line(rayGeometry, rayMaterial);
  ray.computeLineDistances();
  content.add(ray);
}

const patchMaterial = track(
  new THREE.MeshBasicMaterial({
    color: 0xffe6a3,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
const shaftMaterial = track(
  new THREE.MeshBasicMaterial({
    color: 0xfff0c4,
    transparent: true,
    opacity: 0.11,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
for (const patch of props.sunPatches) {
  for (const piece of patch.pieces) {
    const mesh = flatMesh(piece.outer, patch.plane_elevation_mm + 3, patchMaterial, track, [], false);
    mesh.renderOrder = 5;
    content.add(mesh);
  }
  const opening = props.openings.find((item) => item.id === patch.opening_id);
  if (opening === undefined) continue;
  const shaft = sunShaft(opening, patch, floorZ);
  if (shaft !== null) {
    track(shaft);
    const mesh = new THREE.Mesh(shaft, shaftMaterial);
    mesh.renderOrder = 4;
    content.add(mesh);
  }
}
}

/** A translucent prism between an opening aperture and its sun patch. */
function sunShaft(opening: Opening, patch: SunPatch, floorElevationMm: number): THREE.BufferGeometry | null {
  const projected = patch.projected.outer;
  if (projected.length !== 4) return null;
  const sill = (floorElevationMm + opening.sill_height_mm) * MM;
  const head = (floorElevationMm + opening.head_height_mm) * MM;
  const plane = patch.plane_elevation_mm * MM;
  const aperture = [
    new THREE.Vector3(opening.start.x * MM, opening.start.y * MM, Math.max(sill, plane)),
    new THREE.Vector3(opening.end.x * MM, opening.end.y * MM, Math.max(sill, plane)),
    new THREE.Vector3(opening.end.x * MM, opening.end.y * MM, head),
    new THREE.Vector3(opening.start.x * MM, opening.start.y * MM, head),
  ];
  const landing = projected.map((point) => new THREE.Vector3(point.x * MM, point.y * MM, plane));
  const vertices: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const a = aperture[index];
    const b = aperture[(index + 1) % 4];
    const c = landing[(index + 1) % 4];
    const d = landing[index];
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    vertices.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}
