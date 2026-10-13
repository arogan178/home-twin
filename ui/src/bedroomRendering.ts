import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { ArchitecturalMaterials } from "./architecturalMaterials";
import { BOARD_M, FRONT_ARRIS_M, FRONT_GAP_M, Joinery } from "./joineryGeometry";
import type { BuildingObject } from "./types";

const MM = 0.001;
const ROLE = "Pset_HomeTwinBedroom.Role";
const ROTATION = "Pset_HomeTwinBedroom.RotationDegrees";
const OUTLINE = "Pset_HomeTwinBedroom.OutlineMm";

const BAYS = "Pset_HomeTwinBedroom.Bays";
const PLINTH = "Pset_HomeTwinBedroom.PlinthHeightMm";
const FRONT = "Pset_HomeTwinBedroom.Front";
const FRONT_BEARING = "Pset_HomeTwinBedroom.FrontBearingDeg";
const INTERIOR = "Pset_HomeTwinBedroom.InteriorFinish";

type Track = <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T;

/** A plan outline stored as "x,y;x,y" in millimetres, or null when absent or malformed. */
export function parseOutline(value: unknown): THREE.Vector2[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const points = value.split(";").map((pair) => pair.split(",").map(Number));
  if (points.length < 3 || points.some((point) => point.length !== 2 || point.some((n) => !Number.isFinite(n)))) {
    return null;
  }
  return points.map(([x, y]) => new THREE.Vector2((x ?? 0) * MM, (y ?? 0) * MM));
}

/** One bay of a run: where it starts, how wide, and what it carries. */
export type Bay = {
  role: string;
  startM: number;
  widthM: number;
  shelves: number[];
  rails: number[];
  drawers: number[];
  divider: number | null;
};

const heights = (field: string): number[] =>
  field
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .map((n) => n * MM);

/**
 * Bays as authored: `role@start+width|s=..|r=..|d=..|v=..`, millimetres.
 *
 * Without the fit-out a run can only be drawn as one solid extrusion, which is
 * how a floor-to-ceiling wardrobe came to read as a closed slab with doors on
 * it. Returns null when the string is absent or malformed, so a run with no
 * stated bays still draws as a carcass rather than not at all.
 */
export function parseBays(value: unknown): Bay[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const bays: Bay[] = [];
  for (const chunk of value.split(";")) {
    const [head, ...rest] = chunk.split("|");
    const match = /^(.*)@(-?[\d.]+)\+([\d.]+)$/.exec(head ?? "");
    if (!match) return null;
    const bay: Bay = {
      role: match[1] ?? "bay",
      startM: Number(match[2]) * MM,
      widthM: Number(match[3]) * MM,
      shelves: [],
      rails: [],
      drawers: [],
      divider: null,
    };
    if (!Number.isFinite(bay.startM) || !Number.isFinite(bay.widthM)) return null;
    for (const field of rest) {
      const body = field.slice(2);
      if (field.startsWith("s=")) bay.shelves = heights(body);
      else if (field.startsWith("r=")) bay.rails = heights(body);
      else if (field.startsWith("d=")) bay.drawers = heights(body);
      else if (field.startsWith("v=")) bay.divider = Number(body) * MM;
    }
    bays.push(bay);
  }
  return bays;
}

/**
 * The run's two long edges, ordered so that both start at the same end.
 *
 * Every run here is a quadrilateral with parallel ends, so a board spanning
 * part of it is found by interpolating along these two edges. That is exact and
 * avoids clipping a general polygon in the browser.
 */
export function runEdges(outline: THREE.Vector2[]): {
  alongY: boolean;
  lengthM: number;
  side: [THREE.Vector2, THREE.Vector2][];
} | null {
  if (outline.length !== 4) return null;
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const alongY = Math.max(...ys) - Math.min(...ys) >= Math.max(...xs) - Math.min(...xs);
  const along = (p: THREE.Vector2) => (alongY ? p.y : p.x);
  const sorted = [...outline].sort((a, b) => along(a) - along(b));
  const low = [sorted[0]!, sorted[1]!];
  const high = [sorted[2]!, sorted[3]!];
  const across = (p: THREE.Vector2) => (alongY ? p.x : p.y);
  low.sort((a, b) => across(a) - across(b));
  high.sort((a, b) => across(a) - across(b));
  return {
    alongY,
    lengthM: along(high[0]!) - along(low[0]!),
    side: [
      [low[0]!, high[0]!],
      [low[1]!, high[1]!],
    ],
  };
}

/**
 * Joinery scribed to an out-of-square wall, drawn from its authored outline
 * rather than its bounding box: a wardrobe's back follows a wall that runs
 * 314 mm out of square, so a box would either float off it or stand inside it.
 */
function extrudedOutline(outline: THREE.Vector2[], heightM: number, track: Track): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(outline);
  return track(new THREE.ExtrudeGeometry(shape, { depth: heightM, bevelEnabled: false }));
}

const BOARD = 0.018;
const BACK = 0.008;
// Two panels on two tracks: the doc's measured cost of a sliding front.
const SLIDING_ZONE = 0.08;
const RAIL_DROP = 0.06;

type Run = NonNullable<ReturnType<typeof runEdges>>;
type Fit = { front: string; interior: THREE.Material; frontBearingDeg: number | null };

/**
 * A run drawn with its fronts off: plinth, ends, base, top, back, and each
 * bay's own shelves, dividers, rails and drawers.
 *
 * The model authors these runs open on purpose -- a box says where the joinery
 * is and nothing about what it holds -- and drawing one solid extrusion threw
 * all of that away and made a wardrobe look like it had doors on it. The fronts
 * stay recorded rather than drawn; a sliding front still shows its tracks and
 * the depth it costs.
 */
function drawOpenCarcass(
  run: Run,
  bays: Bay[],
  baseZ: number,
  heightM: number,
  plinthM: number,
  fit: Fit,
  finishes: ArchitecturalMaterials,
  track: Track,
  content: THREE.Group,
): void {
  const lerp = (p: THREE.Vector2, q: THREE.Vector2, t: number) => new THREE.Vector2(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
  // Which long edge is the front: the one furthest along the stated bearing.
  let frontSide = 0;
  if (fit.frontBearingDeg !== null) {
    const n = new THREE.Vector2(Math.cos((fit.frontBearingDeg * Math.PI) / 180), Math.sin((fit.frontBearingDeg * Math.PI) / 180));
    const reach = (edge: [THREE.Vector2, THREE.Vector2]) => lerp(edge[0], edge[1], 0.5).dot(n);
    frontSide = reach(run.side[1]!) > reach(run.side[0]!) ? 1 : 0;
  }
  const frontEdge = run.side[frontSide]!;
  const backEdge = run.side[1 - frontSide]!;
  /** A point `t` along the run and `f` of the way from its front to its back. */
  const point = (t: number, f: number) => lerp(lerp(frontEdge[0], frontEdge[1], t), lerp(backEdge[0], backEdge[1], t), f);
  const depthAt = (t: number) => point(t, 0).distanceTo(point(t, 1));
  const joinery = new Joinery();
  const board = (label: string, material: THREE.Material, t0: number, t1: number, z: number, thickness: number,
    from = 0, to = 1) => {
    const a = Math.max(0, Math.min(1, t0));
    const b = Math.max(0, Math.min(1, t1));
    if (b - a < 1e-6 || to - from < 1e-6 || thickness <= 0) return;
    const shape = new THREE.Shape([point(a, from), point(b, from), point(b, to), point(a, to)]);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    joinery.add(label, material, geometry.translate(0, 0, z));
  };
  const walnut = finishes.joineryWood;
  const inside = fit.interior;
  const carcassZ = baseZ + plinthM;
  const inner = heightM - plinthM;
  const depth = depthAt(0.5);
  const sliding = fit.front.includes("sliding");
  const zone = sliding ? SLIDING_ZONE / depth : 0;
  const backFrom = 1 - BACK / depth;
  if (plinthM > 0) board("Recessed plinth", finishes.plinth, 0, 1, baseZ, plinthM, 0.04 / depth, 1);
  board("Base board", inside, 0, 1, carcassZ, BOARD);
  board("Top board", inside, 0, 1, baseZ + heightM - BOARD, BOARD);
  board("Back panel", inside, 0, 1, carcassZ + BOARD, inner - 2 * BOARD, backFrom, 1);

  const end = BOARD / run.lengthM;
  board("End panel", walnut, 0, end, carcassZ, inner);
  board("End panel", walnut, 1 - end, 1, carcassZ, inner);
  if (sliding) {
    // Twin tracks, bottom and head: the 80 mm the fronts are drawn without.
    const from = 0.01 / depth;
    board("Sliding track", finishes.anodisedBlack, end, 1 - end, carcassZ + BOARD, 0.01, from, zone - from);
    board("Sliding track", finishes.anodisedBlack, end, 1 - end, baseZ + heightM - BOARD - 0.045, 0.045, from, zone - from);
  }

  const frontFace = BOARD / depth;
  bays.forEach((bay, index) => {
    const low = bay.startM / run.lengthM;
    const high = low + bay.widthM / run.lengthM;
    const dividerTop = bay.divider ?? inner;
    if (index > 0) board("Divider", inside, low, low + end, carcassZ + BOARD, dividerTop - BOARD);
    const butts = (h: number) => (index > 0 && h <= dividerTop + 1e-6 ? low + end : low);
    for (const h of bay.shelves) board("Shelf", inside, butts(h), high, carcassZ + h - BOARD, BOARD, zone, backFrom);
    let below = BOARD;
    for (const h of [...bay.drawers].sort((p, q) => p - q)) {
      board("Drawer board", inside, butts(h), high, carcassZ + h - BOARD, BOARD, zone + frontFace, backFrom);
      // An internal drawer's front, in the interior finish, with its shadow gaps.
      const gap = FRONT_GAP_M / run.lengthM;
      board("Drawer front", inside, butts(h) + gap, high - gap, carcassZ + below + FRONT_GAP_M / 2,
        h - below - FRONT_GAP_M, zone, zone + frontFace);
      below = h;
    }
    // The rail takes its line from the run, not the bay, so a rail shared by
    // two bays reads as one and does not step at the joint.
    const middle = (zone + backFrom) / 2;
    for (const h of bay.rails) {
      const a = point(butts(h), middle);
      const b = point(high, middle);
      const p0 = new THREE.Vector3(a.x, a.y, carcassZ + h - RAIL_DROP);
      const p1 = new THREE.Vector3(b.x, b.y, carcassZ + h - RAIL_DROP);
      const rail = new THREE.CylinderGeometry(0.0125, 0.0125, p0.distanceTo(p1), 16);
      rail.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize()));
      rail.translate((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, p0.z);
      joinery.add("Hanging rail", finishes.chrome, rail);
      for (const t of [butts(h), high]) {
        const socket = new THREE.BoxGeometry(0.03, 0.03, 0.04);
        const at = point(t, middle);
        socket.translate(at.x, at.y, p0.z + 0.008);
        joinery.add("Rail socket", finishes.chrome, socket);
      }
    }
  });
  const group = new THREE.Group();
  content.add(group);
  joinery.build(group, track);
}

/** Interior boards take the stated interior finish; an oak interior draws in oak. */
function interiorFinish(value: unknown, finishes: ArchitecturalMaterials): THREE.Material {
  return typeof value === "string" && value.includes("oak") ? finishes.linenOak : finishes.joineryWood;
}

export function renderBedroomObject(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: Track,
  content: THREE.Group,
): boolean {
  const role = object.properties[ROLE];
  if (typeof role !== "string") return false;
  const min = object.bounds.minimum;
  const max = object.bounds.maximum;
  const height = (max.z - min.z) * MM;

  const outline = parseOutline(object.properties[OUTLINE]);
  if (outline) {
    const bays = parseBays(object.properties[BAYS]);
    const run = runEdges(outline);
    const plinthM = Number(object.properties[PLINTH]) * MM;
    if (bays && run) {
      const bearing = Number(object.properties[FRONT_BEARING]);
      const fit: Fit = {
        front: String(object.properties[FRONT] ?? ""),
        interior: interiorFinish(object.properties[INTERIOR], finishes),
        frontBearingDeg: Number.isFinite(bearing) && object.properties[FRONT_BEARING] !== undefined ? bearing : null,
      };
      drawOpenCarcass(run, bays, min.z * MM, height, plinthM || 0, fit, finishes, track, content);
      return true;
    }
    // No stated fit-out: a solid run is the honest fallback, not a guess at one.
    const carcass = new THREE.Mesh(extrudedOutline(outline, height, track), finishes.joineryWood);
    carcass.position.z = min.z * MM;
    carcass.castShadow = true;
    carcass.receiveShadow = true;
    content.add(carcass);
    const reveal = new THREE.Mesh(extrudedOutline(outline, 0.014, track), finishes.plinth);
    reveal.position.z = (max.z - 15) * MM;
    content.add(reveal);
    return true;
  }

  const bearing = Number(object.properties[ROTATION]);
  const turned = Number.isFinite(bearing) ? bearing : 0;
  const across = Math.abs(Math.round(turned / 90)) % 2 === 1;
  const boxWidth = (max.x - min.x) * MM;
  const boxDepth = (max.y - min.y) * MM;
  const width = across ? boxDepth : boxWidth;
  const depth = across ? boxWidth : boxDepth;

  const group = new THREE.Group();
  group.name = object.name;
  group.position.set((min.x + max.x) * MM / 2, (min.y + max.y) * MM / 2, min.z * MM);
  group.rotation.z = (turned * Math.PI) / 180;
  content.add(group);

  const rounded = (
    w: number,
    d: number,
    h: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    radius = 0.02,
  ) => {
    const mesh = new THREE.Mesh(
      track(new RoundedBoxGeometry(w, d, h, 3, Math.min(radius, w / 3, d / 3, h / 3))),
      material,
    );
    mesh.position.set(x, y, z + h / 2);
    mesh.castShadow = role !== "rug";
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  if (role === "bed") {
    const headboard = 0.08;
    const base = 0.25;
    const mattress = 0.2;
    const lying = depth - headboard;
    const lyingY = -headboard / 2;
    rounded(width, headboard, height, 0, (depth - headboard) / 2, 0, finishes.fabric, 0.012);
    rounded(width, lying, base, 0, lyingY, 0, finishes.joineryWood, 0.01);
    rounded(width - 0.06, lying - 0.06, mattress, 0, lyingY, base, finishes.pillow, 0.045);
    for (const side of [-1, 1]) {
      rounded(width / 2 - 0.09, 0.34, 0.12, (side * width) / 4, lying / 2 - 0.24, base + mattress, finishes.pillow, 0.05);
    }
    return true;
  }
  if (role === "bedside_table") {
    // Wall-hung on a concealed cleat: a square-edged carcass whose edges frame
    // one inset drawer, opened by a groove routed along its head.
    const joinery = new Joinery();
    const walnut = finishes.joineryWood;
    const board = Math.min(BOARD_M, width / 6, height / 6);
    for (const side of [-1, 1]) {
      joinery.board("Carcass side", walnut, [board, depth, height], [side * (width - board) / 2, 0, height / 2], FRONT_ARRIS_M, "-y");
    }
    for (const z of [board / 2, height - board / 2]) {
      joinery.board("Carcass top and bottom", walnut, [width - 2 * board, depth, board], [0, 0, z], FRONT_ARRIS_M, "-y");
    }
    joinery.board("Back panel", walnut, [width - 2 * board, 0.008, height - 2 * board], [0, depth / 2 - 0.004, height / 2]);
    const front = 0.019;
    const innerW = width - 2 * board - 2 * FRONT_GAP_M;
    const innerH = height - 2 * board - 2 * FRONT_GAP_M;
    const groove = Math.min(0.012, innerH / 6);
    joinery.board("Drawer front", walnut, [innerW, front, innerH - groove], [0, -depth / 2 + front / 2, board + FRONT_GAP_M + (innerH - groove) / 2],
      FRONT_ARRIS_M, "-y");
    joinery.board("Finger pull", finishes.plinth, [innerW + 2 * FRONT_GAP_M, front + 0.004, groove + FRONT_GAP_M],
      [0, -depth / 2 + front / 2 + 0.006, height - board - (groove + FRONT_GAP_M) / 2]);
    joinery.build(group, track);
    return true;
  }
  if (role === "stool") {
    const seat = new THREE.Mesh(
      track(new THREE.CylinderGeometry(width / 2, width / 2, height, 28)),
      finishes.fabric,
    );
    seat.rotation.x = Math.PI / 2;
    seat.position.z = height / 2;
    seat.castShadow = true;
    seat.receiveShadow = true;
    group.add(seat);
    return true;
  }
  if (role === "mirror") {
    // The glass stands proud of its backing, with the reveal on the two sides
    // only. Those are the strips, and they face the seat: a halo round the back
    // silhouettes the face this mirror is lit for.
    const reveal = 0.03;
    const glass = 0.008;
    rounded(width, depth - glass, height, 0, glass / 2, 0, finishes.joineryWood, 0.006);
    rounded(width - reveal * 2, glass, height, 0, -(depth - glass) / 2, 0, finishes.glass, 0.004);
    return true;
  }
  if (role === "bench") {
    const board = 0.04;
    rounded(width, depth, board, 0, 0, height - board, finishes.joineryWood, 0.008);
    for (const side of [-1, 1]) {
      rounded(board, depth, height - board, (side * (width - board)) / 2, 0, 0, finishes.joineryWood, 0.004);
    }
    rounded(width - 0.09, depth - 0.04, 0.02, 0, 0, height / 2 - 0.01, finishes.joineryWood, 0.004);
    return true;
  }
  if (role === "rug") {
    rounded(width, depth, height, 0, 0, 0, finishes.rug, 0.004);
    return true;
  }
  return false;
}
