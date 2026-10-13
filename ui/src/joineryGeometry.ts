import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Track = <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T;
type Vec3 = readonly [number, number, number];

/** The face of a board that carries its arris: the one you see and touch. */
export type Face = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

/** Shadow gap between neighbouring fronts. */
export const FRONT_GAP_M = 0.003;
/** Arris on a front's show face: an edge-banded board's eased edge, never a radius. */
export const FRONT_ARRIS_M = 0.0015;
export const BOARD_M = 0.018;

const AXES: Record<Face, { normal: 0 | 1 | 2; sign: 1 | -1 }> = {
  "+x": { normal: 0, sign: 1 },
  "-x": { normal: 0, sign: -1 },
  "+y": { normal: 1, sign: 1 },
  "-y": { normal: 1, sign: -1 },
  "+z": { normal: 2, sign: 1 },
  "-z": { normal: 2, sign: -1 },
};

/**
 * A square-edged board centred on the origin, with a 45 degree chamfer round
 * the perimeter of one face. Flat-shaded and non-indexed, so parts merge.
 *
 * No face, or no chamfer, gives a plain six-sided box.
 */
export function chamferedBoard(size: Vec3, chamferM = 0, face: Face | null = null): THREE.BufferGeometry {
  const half = size.map((value) => value / 2) as [number, number, number];
  const { normal, sign } = AXES[face ?? "+z"];
  const [a, b] = ([0, 1, 2] as const).filter((axis) => axis !== normal) as [0 | 1 | 2, 0 | 1 | 2];
  const c = face === null ? 0 : Math.max(0, Math.min(chamferM, half[a] / 2, half[b] / 2, half[normal]));
  const point = (u: number, v: number, n: number): THREE.Vector3 => {
    const p = [0, 0, 0];
    p[a] = u;
    p[b] = v;
    p[normal] = n;
    return new THREE.Vector3(p[0], p[1], p[2]);
  };
  const ring = (inset: number, n: number) => [
    point(-half[a] + inset, -half[b] + inset, n),
    point(half[a] - inset, -half[b] + inset, n),
    point(half[a] - inset, half[b] - inset, n),
    point(-half[a] + inset, half[b] - inset, n),
  ];
  const show = ring(c, sign * half[normal]);
  const shoulder = ring(0, sign * (half[normal] - c));
  const back = ring(0, -sign * half[normal]);
  const quads: THREE.Vector3[][] = [show, back];
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    if (c > 0) quads.push([show[i]!, show[j]!, shoulder[j]!, shoulder[i]!]);
    quads.push([shoulder[i]!, shoulder[j]!, back[j]!, back[i]!]);
  }
  const positions: number[] = [];
  const centre = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  for (const quad of quads) {
    const [p0, p1, p2, p3] = quad as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
    centre.copy(p0).add(p1).add(p2).add(p3).multiplyScalar(0.25);
    const facing = edge1.subVectors(p1, p0).cross(edge2.subVectors(p2, p0)).dot(centre);
    // The solid is convex about its centre, so outward is away from the origin.
    const ordered = facing >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
    for (const p of ordered) positions.push(p.x, p.y, p.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Metre-scaled UVs from each vertex's own position, in the unit's frame.
 *
 * The walnut map varies across U, so U lies along the run or the depth and V
 * runs up the board: a door's grain stands vertical, as a veneer leaf is laid.
 */
export function metreUVs(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = Math.abs(normal.getX(i));
    const nz = Math.abs(normal.getZ(i));
    uv[i * 2] = nz > 0.5 || nx <= 0.5 ? x : y;
    uv[i * 2 + 1] = nz > 0.5 ? y : z;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

export type JoineryPart = { readonly label: string; readonly box: THREE.Box3 };

/**
 * Collects a unit's boards and fittings, then draws them as one mesh per
 * material. A run of twenty units would otherwise be hundreds of draw calls.
 * Each merged mesh keeps its parts' labels and boxes in `userData.joineryParts`.
 */
export class Joinery {
  private readonly byMaterial = new Map<THREE.Material, { geometries: THREE.BufferGeometry[]; parts: JoineryPart[] }>();

  board(label: string, material: THREE.Material, size: Vec3, at: Vec3, chamferM = 0, face: Face | null = null): void {
    if (size.some((value) => !(value > 1e-6))) return;
    const geometry = chamferedBoard(size, chamferM, face);
    geometry.translate(at[0], at[1], at[2]);
    this.add(label, material, geometry);
  }

  /** Takes ownership of `geometry`, already placed in the unit's frame. */
  add(label: string, material: THREE.Material, geometry: THREE.BufferGeometry): void {
    const flat = geometry.index === null ? geometry : geometry.toNonIndexed();
    if (flat !== geometry) geometry.dispose();
    for (const name of Object.keys(flat.attributes)) {
      if (name !== "position" && name !== "normal") flat.deleteAttribute(name);
    }
    if (flat.getAttribute("normal") === undefined) flat.computeVertexNormals();
    flat.clearGroups();
    metreUVs(flat);
    flat.computeBoundingBox();
    let entry = this.byMaterial.get(material);
    if (entry === undefined) {
      entry = { geometries: [], parts: [] };
      this.byMaterial.set(material, entry);
    }
    entry.geometries.push(flat);
    entry.parts.push({ label, box: flat.boundingBox!.clone() });
  }

  /** Adds one mesh per material to `parent`, and returns them. */
  build(parent: THREE.Object3D, track: Track, castShadow = true): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [material, { geometries, parts }] of this.byMaterial) {
      const merged = geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries, false);
      if (merged !== geometries[0]) for (const geometry of geometries) geometry.dispose();
      const mesh = new THREE.Mesh(track(merged), material);
      mesh.name = [...new Set(parts.map((part) => part.label))].join(" + ");
      mesh.userData.joineryParts = parts;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.byMaterial.clear();
    return meshes;
  }
}

/** Every part of `root` drawn under `label`, boxed in world space. */
export function joineryParts(root: THREE.Object3D, label: string): Array<{ box: THREE.Box3; material: THREE.Material }> {
  root.updateMatrixWorld(true);
  const found: Array<{ box: THREE.Box3; material: THREE.Material }> = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const parts = node.userData.joineryParts as JoineryPart[] | undefined;
    for (const part of parts ?? []) {
      if (part.label === label) found.push({ box: part.box.clone().applyMatrix4(node.matrixWorld), material: node.material as THREE.Material });
    }
  });
  return found;
}

/** Every label drawn under `root`, once per part. */
export function joineryLabels(root: THREE.Object3D): string[] {
  const labels: string[] = [];
  root.traverse((node) => {
    for (const part of (node.userData.joineryParts as JoineryPart[] | undefined) ?? []) labels.push(part.label);
    if (node instanceof THREE.Mesh && node.userData.joineryParts === undefined && node.name !== "") labels.push(node.name);
  });
  return labels;
}

/** Concealed hinges a leaf of this height needs, by the hardware makers' usual table. */
export function hingeCount(leafHeightM: number): number {
  if (leafHeightM <= 0.9) return 2;
  if (leafHeightM <= 1.6) return 3;
  if (leafHeightM <= 2.0) return 4;
  return 5;
}
