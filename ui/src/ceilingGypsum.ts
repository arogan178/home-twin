import * as THREE from "three";

import type { ArchitecturalMaterials } from "./architecturalMaterials";
import type { BuildingObject } from "./types";

export type PlanPoint = { readonly x: number; readonly y: number };
export type Ring = ReadonlyArray<PlanPoint>;

export type RevealRun = {
  readonly tag: string;
  readonly start: PlanPoint;
  readonly end: PlanPoint;
  readonly widthMm: number;
  readonly depthMm: number;
};

/** Section inside the slot. Only the slot width is authored; these are allowances. */
const UPSTAND_MM = 12.5;
const UPSTAND_RISE_MM = 62.5;
const MM = 0.001;
const TOLERANCE_MM = 1;
/**
 * How far a corner may travel before the mitre is abandoned, as a multiple of
 * the inset. Two edges that meet at a shallow angle put their offset lines'
 * intersection a long way off - the open plan's slanting wall is three faces
 * about two degrees apart, and mitring one against an un-inset neighbour threw
 * a corner six metres out of the room.
 */
const MITRE_LIMIT = 3;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reveals the model authored, read back from their own property set. */
export function revealRuns(objects: ReadonlyArray<BuildingObject>): RevealRun[] {
  const runs: RevealRun[] = [];
  for (const object of objects) {
    const width = number(object.properties["Pset_HomeTwinReveal.WidthMm"]);
    const depth = number(object.properties["Pset_HomeTwinReveal.DepthMm"]);
    const startX = number(object.properties["Pset_HomeTwinReveal.StartX"]);
    const startY = number(object.properties["Pset_HomeTwinReveal.StartY"]);
    const endX = number(object.properties["Pset_HomeTwinReveal.EndX"]);
    const endY = number(object.properties["Pset_HomeTwinReveal.EndY"]);
    if (width === null || depth === null) continue;
    if (startX === null || startY === null || endX === null || endY === null) continue;
    const tag = typeof object.properties["Tag"] === "string" ? object.properties["Tag"] : object.id;
    runs.push({ tag, start: { x: startX, y: startY }, end: { x: endX, y: endY }, widthMm: width, depthMm: depth });
  }
  return runs;
}

/** A reveal is a void the gypsum renderer draws; its box is not a solid. */
export function isCeilingReveal(object: BuildingObject): boolean {
  return number(object.properties["Pset_HomeTwinReveal.WidthMm"]) !== null;
}

function signedArea(ring: Ring): number {
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

function sameEdge(a: PlanPoint, b: PlanPoint, run: RevealRun): boolean {
  const near = (p: PlanPoint, q: PlanPoint) => Math.hypot(p.x - q.x, p.y - q.y) <= TOLERANCE_MM;
  return (near(a, run.start) && near(b, run.end)) || (near(a, run.end) && near(b, run.start));
}

function intersect(p: PlanPoint, d: PlanPoint, q: PlanPoint, e: PlanPoint): PlanPoint | null {
  const denominator = d.x * e.y - d.y * e.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / denominator;
  return { x: p.x + d.x * t, y: p.y + d.y * t };
}

/**
 * Pull the gypsum back from the walls its reveals follow.
 *
 * Each reveal edge slides inward by its own width and the corners follow, so a
 * run that ends against a wall the gypsum still meets keeps that corner square.
 */
export function insetRingAtReveals(ring: Ring, reveals: ReadonlyArray<RevealRun>): Ring {
  if (ring.length < 3 || reveals.length === 0) return ring;
  const inwardSign = signedArea(ring) > 0 ? 1 : -1;
  const widest = Math.max(...reveals.map((run) => run.widthMm));
  const lines = ring.map((a, index) => {
    const b = ring[(index + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const run = reveals.find((candidate) => sameEdge(a, b, candidate));
    const offset = run ? run.widthMm : 0;
    const normal = { x: (-dy / length) * inwardSign, y: (dx / length) * inwardSign };
    return {
      point: { x: a.x + normal.x * offset, y: a.y + normal.y * offset },
      direction: { x: dx, y: dy },
      shift: { x: normal.x * offset, y: normal.y * offset },
      inset: offset > 0,
    };
  });
  return ring.map((vertex, index) => {
    const previous = lines[(index - 1 + ring.length) % ring.length]!;
    const current = lines[index]!;
    const mitre = intersect(previous.point, previous.direction, current.point, current.direction);
    if (mitre !== null && Math.hypot(mitre.x - vertex.x, mitre.y - vertex.y) <= widest * MITRE_LIMIT) {
      return mitre;
    }
    // Too shallow to mitre: step the corner straight off the edge that moved.
    const shift = current.inset ? current.shift : previous.inset ? previous.shift : { x: 0, y: 0 };
    return { x: vertex.x + shift.x, y: vertex.y + shift.y };
  });
}

function onRoomBoundary(a: PlanPoint, b: PlanPoint, roomRing: Ring): boolean {
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (let i = 0; i < roomRing.length; i += 1) {
    const start = roomRing[i]!;
    const end = roomRing[(i + 1) % roomRing.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const t = Math.max(0, Math.min(1, ((midpoint.x - start.x) * dx + (midpoint.y - start.y) * dy) / lengthSquared));
    const distance = Math.hypot(midpoint.x - (start.x + dx * t), midpoint.y - (start.y + dy * t));
    if (distance <= TOLERANCE_MM) return true;
  }
  return false;
}

/**
 * The edges of a soffit that face the room rather than die into a wall.
 *
 * A drop with no returns reads as a floating plate, because the room looks
 * straight through the step to the ceiling behind it.
 */
export function fasciaEdges(soffitRing: Ring, roomRing: Ring): Array<readonly [PlanPoint, PlanPoint]> {
  const edges: Array<readonly [PlanPoint, PlanPoint]> = [];
  for (let i = 0; i < soffitRing.length; i += 1) {
    const a = soffitRing[i]!;
    const b = soffitRing[(i + 1) % soffitRing.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) <= TOLERANCE_MM) continue;
    if (onRoomBoundary(a, b, roomRing)) continue;
    edges.push([a, b]);
  }
  return edges;
}

function strip(
  a: PlanPoint,
  b: PlanPoint,
  bottomZ: number,
  topZ: number,
  thicknessMm: number,
  material: THREE.Material,
  track: <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T,
  content: THREE.Group,
  name: string,
): void {
  const length = Math.hypot(b.x - a.x, b.y - a.y) * MM;
  const height = (topZ - bottomZ) * MM;
  if (length <= 0 || height <= 0) return;
  const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(length, thicknessMm * MM, height)), material);
  mesh.name = name;
  mesh.position.set(((a.x + b.x) / 2) * MM, ((a.y + b.y) / 2) * MM, ((bottomZ + topZ) / 2) * MM);
  mesh.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  content.add(mesh);
}

/** Close a bulkhead's exposed edge between its own underside and the ceiling. */
export function renderBulkheadFascia(
  edge: readonly [PlanPoint, PlanPoint],
  soffitZ: number,
  ceilingZ: number,
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T,
  content: THREE.Group,
): void {
  strip(edge[0], edge[1], soffitZ, ceilingZ, 20, finishes.gypsum, track, content, "Bulkhead fascia");
}

/**
 * The gypsum upstand that leaves a perimeter reveal, and the soffit over it.
 *
 * The slot width comes from the model and the upstand is a finish allowance.
 * Nothing inside the slot is drawn here: a strip is a fixture, and the run that
 * is actually installed draws its own profile through renderConcealedCove.
 */
export function renderCeilingReveal(
  run: RevealRun,
  gypsumZ: number,
  backingZ: number | null,
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T,
  content: THREE.Group,
): void {
  const dx = run.end.x - run.start.x;
  const dy = run.end.y - run.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return;
  const group = new THREE.Group();
  group.name = `${run.tag} reveal`;
  group.position.set(((run.start.x + run.end.x) / 2) * MM, ((run.start.y + run.end.y) / 2) * MM, gypsumZ * MM);
  group.rotation.z = Math.atan2(dy, dx);
  content.add(group);

  // Local +Y is into the room; the gypsum edge stands at the slot's inner face.
  const member = (name: string, depthMm: number, heightMm: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(
      track(new THREE.BoxGeometry(length * MM, depthMm * MM, heightMm * MM)),
      material,
    );
    mesh.name = name;
    mesh.position.set(0, y * MM, z * MM);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const edge = run.widthMm;
  // A reveal is building fabric: the gypsum edge and the slot it leaves. The
  // luminaire in it belongs to the fixture that is actually there, drawn by
  // renderConcealedCove, or the slot carries a channel with no strip in it and
  // a doubled one where there is.
  member("Reveal upstand", UPSTAND_MM, UPSTAND_RISE_MM, edge + UPSTAND_MM / 2, UPSTAND_RISE_MM / 2, finishes.gypsum);
  if (backingZ !== null) {
    // Without the soffit over it the slot is a hole, not a reveal.
    member("Reveal soffit", edge + UPSTAND_MM, 2, (edge + UPSTAND_MM) / 2, backingZ - gypsumZ - 1, finishes.ceiling);
  }
}
