import * as THREE from "three";

import {
  type Envelope,
  type IndoorPart,
  indoorUnitParts,
  type OutdoorPart,
  outdoorUnitParts,
  type PipePairMm,
} from "./acUnitGeometry";
import type { ArchitecturalMaterials } from "./architecturalMaterials";
import type { BuildingObject } from "./types";
import { ENCLOSURE_MM, LEGS, ROUTE, parseLegs } from "./hvacProperties";
import { parseRoute } from "./serviceRoutes";

const MM = 0.001;
const ROLE = "Pset_HomeTwinHvac.Role";
const ROTATION = "Pset_HomeTwinHvac.RotationDegrees";
const WIDTH = "Pset_HomeTwinHvac.WidthMm";
const DEPTH = "Pset_HomeTwinHvac.DepthMm";
const HEIGHT = "Pset_HomeTwinHvac.HeightMm";
const CAPACITY = "Pset_HomeTwinHvac.NominalCapacityKw";

type Track = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T) => T;

// The larger maker's pipes: 1/4" + 3/8" up to the 12k, and Midea's 3/8" + 5/8" for the 24k.
const SMALL_PIPES: PipePairMm = [6.35, 9.52];
const LARGE_PIPES: PipePairMm = [9.52, 15.88];

/** Aluminium fins in columns, with the copper tube rows faintly behind them. */
function coilTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const fin = [150, 205, 225, 180];
  for (let y = 0; y < size; y += 1) {
    const tube = Math.abs((y % 32) - 16) < 3 ? 0.82 : 1;
    for (let x = 0; x < size; x += 1) {
      const value = Math.round(fin[x % 4]! * tube);
      data.set([value, value, Math.min(255, value + 4), 255], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

type Kit = {
  readonly materials: Record<OutdoorPart | IndoorPart, THREE.Material>;
  readonly outdoor: Map<string, Record<OutdoorPart, THREE.BufferGeometry>>;
  readonly indoor: Map<string, Record<IndoorPart, THREE.BufferGeometry>>;
};

/** One kit per scene's finishes, so every unit of a size shares its geometry and every unit its materials. */
const kits = new WeakMap<ArchitecturalMaterials, Kit>();

function kitFor(finishes: ArchitecturalMaterials, track: Track): Kit {
  const existing = kits.get(finishes);
  if (existing !== undefined) return existing;
  const fins = track(coilTexture());
  const kit: Kit = {
    materials: {
      cabinet: track(new THREE.MeshStandardMaterial({ color: 0xf0efea, roughness: 0.5 })),
      plastic: track(new THREE.MeshStandardMaterial({ color: 0x2e3133, roughness: 0.6, side: THREE.DoubleSide })),
      coil: track(
        new THREE.MeshStandardMaterial({ map: fins, bumpMap: fins, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide }),
      ),
      copper: track(new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.35, metalness: 0.8 })),
      shell: track(new THREE.MeshStandardMaterial({ color: 0xf4f4f1, roughness: 0.35 })),
      throat: track(new THREE.MeshStandardMaterial({ color: 0x2c2e30, roughness: 0.7 })),
    },
    outdoor: new Map(),
    indoor: new Map(),
  };
  kits.set(finishes, kit);
  return kit;
}

function shared<Part extends string>(
  cache: Map<string, Record<Part, THREE.BufferGeometry>>,
  key: string,
  build: () => Record<Part, THREE.BufferGeometry>,
  track: Track,
): Record<Part, THREE.BufferGeometry> {
  let parts = cache.get(key);
  if (parts === undefined) {
    parts = build();
    for (const geometry of Object.values<THREE.BufferGeometry>(parts)) track(geometry);
    cache.set(key, parts);
  }
  return parts;
}

function drawRun(object: BuildingObject, finishes: ArchitecturalMaterials, track: Track, content: THREE.Group): boolean {
  const route = parseRoute(object.properties[ROUTE])?.map((point) => new THREE.Vector3(point.x, point.y, point.z)) ?? null;
  const legs = route === null ? null : parseLegs(object.properties[LEGS], route.length - 1);
  if (route === null || legs === null) return false;
  const trunking = track(new THREE.MeshStandardMaterial({ color: 0xf1f0ec, roughness: 0.5 }));
  // Closed-cell insulation, the face clipped copper shows outside.
  const insulation = track(new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.85 }));
  // A core is inside the wall, so it only shows in a section; copper says what it is when it does.
  const copper = track(new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.4, metalness: 0.6 }));
  legs.forEach((leg, index) => {
    const start = route[index]!;
    const end = route[index + 1]!;
    const axis = end.clone().sub(start);
    const length = axis.length();
    axis.normalize();
    const [acrossMm, verticalMm] = ENCLOSURE_MM[leg]!;
    // Lap into the neighbouring legs, as the IFC body does, so a turn is one box.
    const lap = (Math.max(acrossMm, verticalMm) * MM) / 2;
    const before = index > 0 ? lap : 0;
    const after = index < legs.length - 1 ? lap : 0;
    const centre = start.clone().addScaledVector(axis, (length + after - before) / 2);
    const run = length + before + after;
    // Local +Y runs along the leg. A drop keeps the face it had on the wall before it turned down.
    const flat = new THREE.Vector3(axis.x, axis.y, 0);
    const vertical = flat.length() < 0.1;
    const across = new THREE.Vector3(flat.y, -flat.x, 0);
    if (vertical) {
      const neighbour = route[index > 0 ? index - 1 : Math.min(index + 2, route.length - 1)]!;
      across.set(start.x - neighbour.x, start.y - neighbour.y, 0);
      if (across.length() < 1e-6) across.set(1, 0, 0);
    }
    across.normalize();
    const lift = new THREE.Vector3().crossVectors(across, axis).normalize();
    const [x, z] = vertical ? [verticalMm, acrossMm] : [acrossMm, verticalMm];
    const geometry =
      leg === "wall_core"
        ? new THREE.CylinderGeometry((acrossMm * MM) / 2, (acrossMm * MM) / 2, run, 16)
        : new THREE.BoxGeometry(x * MM, run, z * MM);
    const mesh = new THREE.Mesh(
      track(geometry),
      leg === "gypsum_box"
        ? finishes.gypsum
        : leg === "trunking"
          ? trunking
          : leg === "clipped"
            ? insulation
            : copper,
    );
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, axis, lift));
    mesh.position.copy(centre);
    mesh.castShadow = leg !== "wall_core";
    mesh.receiveShadow = true;
    content.add(mesh);
  });
  return true;
}

export function renderHvacObject(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: Track,
  content: THREE.Group,
): boolean {
  const role = object.properties[ROLE];
  if (role === "line_set") return drawRun(object, finishes, track, content);
  if (role !== "indoor_unit" && role !== "outdoor_unit") return false;
  const width = Number(object.properties[WIDTH]) * MM;
  const depth = Number(object.properties[DEPTH]) * MM;
  const height = Number(object.properties[HEIGHT]) * MM;
  if (![width, depth, height].every((value) => Number.isFinite(value) && value > 0)) return false;
  const bearing = Number(object.properties[ROTATION]);
  const min = object.bounds.minimum;
  const max = object.bounds.maximum;

  const group = new THREE.Group();
  group.name = object.name;
  group.position.set(((min.x + max.x) / 2) * MM, ((min.y + max.y) / 2) * MM, min.z * MM);
  group.rotation.z = ((Number.isFinite(bearing) ? bearing : 0) * Math.PI) / 180;
  content.add(group);
  const kit = kitFor(finishes, track);
  const size: Envelope = { widthM: width, depthM: depth, heightM: height };
  const key = `${width},${depth},${height}`;
  const pipes = Number(object.properties[CAPACITY]) >= 5 ? LARGE_PIPES : SMALL_PIPES;
  const parts: Record<string, THREE.BufferGeometry> =
    role === "indoor_unit"
      ? shared(kit.indoor, key, () => indoorUnitParts(size), track)
      : shared(kit.outdoor, `${key},${pipes[1]}`, () => outdoorUnitParts(size, pipes), track);
  for (const [part, geometry] of Object.entries(parts)) {
    const mesh = new THREE.Mesh(geometry, kit.materials[part as OutdoorPart | IndoorPart]);
    mesh.castShadow = part !== "copper";
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return true;
}
