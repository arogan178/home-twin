import { addMixerTap, addCooktopMarkings } from "./kitchenAppliances";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { ArchitecturalMaterials } from "./architecturalMaterials";
import { BOARD_M, FRONT_ARRIS_M, FRONT_GAP_M, hingeCount, Joinery, type Face } from "./joineryGeometry";
import type { BuildingObject } from "./types";

type KitchenUnit = {
  role: string;
  facing: string;
  front: string;
  finish: string;
  shape: string;
  edgeDepth: number;
  appliance: string;
  /** The hung edge as seen standing in front of the unit, as a carpenter hands a door. */
  hinge: string;
  carcass: boolean;
};

/** A front is the unit's local -Y face, so the rotation carries -Y onto the facing. */
export const FACING_RADIANS: Record<string, number> = {
  south: 0,
  east: Math.PI / 2,
  north: Math.PI,
  west: -Math.PI / 2,
};

export function kitchenUnit(object: BuildingObject): KitchenUnit | null {
  const read = (key: string): string => {
    const value = object.properties[`Pset_HomeTwinKitchen.${key}`];
    return typeof value === "string" ? value : "";
  };
  // EdgeDepth is authored as a number, and `read` only yields strings.
  const readNumber = (key: string): number => {
    const value = object.properties[`Pset_HomeTwinKitchen.${key}`];
    return typeof value === "number" ? value : Number(value) || 0;
  };
  const role = read("Role");
  if (role === "") return null;
  return {
    role,
    facing: read("Facing") || "south",
    front: read("Front") || "doors",
    finish: read("Finish") || "wood",
    shape: read("Shape") || "box",
    edgeDepth: readNumber("EdgeDepth"),
    appliance: read("Appliance"),
    hinge: read("Hinge") || "none",
    carcass: read("Carcass") !== "no",
  };
}

/** Display joinery inside the authored IFC envelope; door splits are design allowances. */
/** Bays as authored: `kind@z0+z1`, absolute millimetres, bottom to top. */
export function parseBays(value: unknown): Array<{ z0: number; z1: number; kind: string }> {
  if (typeof value !== "string" || value.length === 0) return [];
  const bays = [];
  for (const chunk of value.split(";")) {
    const match = /^([a-z]+)@(-?[\d.]+)\+(-?[\d.]+)$/.exec(chunk);
    if (match === null) continue;
    const z0 = Number(match[2]);
    const z1 = Number(match[3]);
    if (Number.isFinite(z0) && Number.isFinite(z1) && z1 > z0) bays.push({ z0, z1, kind: match[1]! });
  }
  return bays;
}

// Measured on site, not assumed: 112, not the 95 this drew before.
const PLINTH_M = 0.112;
// Gola L profile, 56.9 x 26 as sold. The fronts stop short of it; it is the opening.
const GOLA_M = 0.057;
const GOLA_HEAD_M = 0.015;
// Visible opening of a mid-rail C profile between fronts; a generic figure.
const MID_CHANNEL_M = 0.033;
// A tall leaf stops short of its latch edge by the vertical profile's opening.
const EDGE_CHANNEL_M = 0.022;
// The profile face stands just in front of the carcass edge it is fixed to.
const CHANNEL_FACE_M = 0.018;
const FRONT_M = 0.022;
const FLOOR_ROLES = new Set(["base", "tall", "island"]);

export type KitchenFrontKind = "door" | "drawer" | "false" | "flap" | "panel" | "blind";
type Rect = { x0: number; x1: number; z0: number; z1: number };
/** The profile a front is opened from: an L under stone or an appliance, a C between fronts, or a vertical edge. */
type Channel = Rect & { profile: "L" | "C" | "edge" };
/** One front as drawn, after its shadow gaps, with the channel it is opened by. */
export type KitchenFront = Rect & {
  kind: KitchenFrontKind;
  hinge: "left" | "right" | "top" | "bottom" | "none";
  grip: "top" | "edge" | "none";
  channel: Channel | null;
};
type LocalBay = { z0: number; z1: number; kind: string };
type Segment = { kind: "drawer" | "door" | "false" | "appliance"; z0: number; z1: number };

function drawerSegments(z0: number, z1: number): Segment[] {
  const levels = [z0, z0 + (z1 - z0) * 0.40, z0 + (z1 - z0) * 0.78, z1];
  return levels.slice(1).map((top, index) => ({ kind: "drawer", z0: levels[index]!, z1: top }));
}

/**
 * Where a closed unit's fronts fall, in its own frame: x across the front from
 * its centre, z up from its underside, metres. Bays decide the splits where the
 * model states them; door, drawer and appliance heights are otherwise the same
 * display allowances the run has always drawn.
 */
export function kitchenFronts(unit: KitchenUnit, w: number, h: number, bays: readonly LocalBay[]): {
  fronts: KitchenFront[];
  appliance: { z0: number; z1: number } | null;
} {
  const floor = FLOOR_ROLES.has(unit.role) ? PLINTH_M : 0;
  const counter = unit.role === "base" || unit.role === "island";
  const opens = unit.front === "doors" || unit.front === "drawers" || unit.front === "integrated";
  const top = counter ? h - GOLA_HEAD_M - (opens ? GOLA_M : 0) : h;
  const g = FRONT_GAP_M / 2;
  const front = (kind: KitchenFrontKind, rect: Rect, hinge: KitchenFront["hinge"], grip: KitchenFront["grip"],
    channel: Channel | null = null): KitchenFront =>
    ({ kind, x0: rect.x0 + g, x1: rect.x1 - g, z0: rect.z0 + g, z1: rect.z1 - g, hinge, grip, channel });
  const topChannel = (x0: number, x1: number, z0: number): Channel => ({ profile: "L", x0, x1, z0: z0 - g, z1: top + GOLA_M });
  const whole = { x0: -w / 2, x1: w / 2, z0: floor, z1: top };
  // A blind face is a statement that nothing opens there, so it carries no channel.
  if (unit.front === "none") return { fronts: [front("blind", whole, "none", "none")], appliance: null };
  // Push-to-open: the flap is one flush board with no rail and no handle.
  if (unit.front === "lift") return { fronts: [front("flap", whole, "top", "none")], appliance: null };
  if (unit.front === "integrated") {
    const hinge = unit.hinge === "bottom" ? "bottom" : "none";
    return { fronts: [front("panel", whole, hinge, "top", counter ? topChannel(-w / 2, w / 2, top) : null)], appliance: null };
  }

  let segments: Segment[];
  if (bays.length > 0) {
    segments = bays.map((bay): Segment => ({
      kind: bay.kind === "drawer" ? "drawer" : bay.kind === "appliance" ? (unit.appliance === "oven" ? "appliance" : "false") : "door",
      z0: bay.z0,
      z1: bay.z1,
    }));
  } else if (unit.appliance === "oven") {
    const high = Math.min(1.5, h - 0.15);
    segments = [...drawerSegments(floor, 0.9), { kind: "appliance", z0: 0.9, z1: high }, { kind: "door", z0: high + 0.008, z1: h }];
  } else {
    segments = unit.front === "drawers" ? drawerSegments(floor, top) : [{ kind: "door", z0: floor, z1: top }];
  }
  // Pull-outs and shelves behind one leaf are one door, not a door per bay.
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.kind === "door" && segment.kind === "door") last.z1 = segment.z1;
    else merged.push({ ...segment });
  }
  // A front closes up to the next one; only an appliance keeps its own opening.
  merged[0]!.z0 = merged[0]!.kind === "appliance" ? merged[0]!.z0 : floor;
  for (let i = 1; i < merged.length; i += 1) {
    if (merged[i - 1]!.kind !== "appliance") merged[i - 1]!.z1 = merged[i]!.z0;
  }
  const last = merged[merged.length - 1]!;
  if (last.kind !== "appliance") last.z1 = top;

  const fronts: KitchenFront[] = [];
  let appliance: { z0: number; z1: number } | null = null;
  const columns = Math.max(1, Math.round(w / 0.8));
  merged.forEach((segment, index) => {
    if (segment.kind === "appliance") {
      appliance = { z0: segment.z0, z1: segment.z1 };
      return;
    }
    const next = merged[index + 1];
    const grip: KitchenFront["grip"] =
      unit.role === "wall" ? "none" : segment.kind === "door" && unit.role === "tall" ? "edge" : "top";
    // A front under another is opened from a channel over it: an L profile
    // under an appliance, a C profile between two fronts.
    const head = grip !== "top" || next === undefined ? 0 : next.kind === "appliance" ? 0.02 + GOLA_M : MID_CHANNEL_M;
    const z1 = segment.z1 - head;
    const channelOver = (x0: number, x1: number): Channel | null => {
      if (grip !== "top") return null;
      if (next === undefined) return counter ? topChannel(x0, x1, z1) : null;
      if (next.kind === "appliance") return { profile: "L", x0, x1, z0: z1 - g, z1: segment.z1 - 0.02 };
      return { profile: "C", x0, x1, z0: z1 - g, z1: segment.z1 + g };
    };
    if (segment.kind !== "door") {
      for (let column = 0; column < columns; column += 1) {
        const x0 = -w / 2 + (column * w) / columns;
        const x1 = x0 + w / columns;
        fronts.push(front(segment.kind, { x0, x1, z0: segment.z0, z1 }, "none", grip, channelOver(x0, x1)));
      }
      return;
    }
    const single = unit.hinge === "left" || unit.hinge === "right";
    const leaves = unit.hinge === "pair" ? 2 : single ? 1
      : Math.max(1, Math.round(w / (unit.role === "wall" ? 0.55 : 0.6)));
    for (let leaf = 0; leaf < leaves; leaf += 1) {
      let x0 = -w / 2 + (leaf * w) / leaves;
      let x1 = x0 + w / leaves;
      const hinge: KitchenFront["hinge"] = single ? (unit.hinge as "left" | "right")
        : leaves === 1 ? "none" : leaf % 2 === 0 ? "left" : "right";
      let channel = channelOver(x0, x1);
      if (grip === "edge") {
        // Opened down the latch edge, because its head is out of reach.
        if (hinge === "right") {
          channel = { profile: "edge", x0, x1: x0 + EDGE_CHANNEL_M, z0: segment.z0, z1 };
          x0 += EDGE_CHANNEL_M;
        } else {
          channel = { profile: "edge", x0: x1 - EDGE_CHANNEL_M, x1, z0: segment.z0, z1 };
          x1 -= EDGE_CHANNEL_M;
        }
      }
      fronts.push(front("door", { x0, x1, z0: segment.z0, z1 }, hinge, grip, channel));
    }
  });
  return { fronts, appliance };
}

const CHANNEL_LABELS: Record<Channel["profile"], string> = {
  L: "Gola channel",
  C: "Gola mid channel",
  edge: "Gola edge channel",
};

const FRONT_LABELS: Record<KitchenFrontKind, string> = {
  door: "Door front",
  drawer: "Drawer front",
  false: "False front",
  flap: "Lift-up flap",
  panel: "Integrated decor panel",
  blind: "Blind panel",
};

/** The run's recessed kick: full width, so a run of units reads as one plinth line. */
export function addToeKick(joinery: Joinery, w: number, d: number, finishes: ArchitecturalMaterials): void {
  joinery.board("Recessed toe kick", finishes.plinth, [w, d - 0.075, PLINTH_M], [0, 0.02, PLINTH_M / 2]);
}

/** Fronts on a unit's local -Y face, each with the gola profile it is opened from. */
export function addKitchenFronts(joinery: Joinery, fronts: readonly KitchenFront[], d: number, finishes: ArchitecturalMaterials,
  material: THREE.Material = finishes.joineryWood, label?: string): void {
  for (const f of fronts) {
    joinery.board(label ?? FRONT_LABELS[f.kind], material, [f.x1 - f.x0, FRONT_M, f.z1 - f.z0],
      [(f.x0 + f.x1) / 2, -d / 2 + FRONT_M / 2, (f.z0 + f.z1) / 2], FRONT_ARRIS_M, "-y");
    const c = f.channel;
    if (c === null) continue;
    joinery.board(CHANNEL_LABELS[c.profile], finishes.anodisedBlack, [c.x1 - c.x0, 0.004, c.z1 - c.z0],
      [(c.x0 + c.x1) / 2, -d / 2 + CHANNEL_FACE_M + 0.002, (c.z0 + c.z1) / 2]);
  }
}

export function renderKitchenObject(
  object: BuildingObject,
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T,
  content: THREE.Group,
  openCarcass = false,
): boolean {
  const unit = kitchenUnit(object);
  if (unit === null) return false;
  const a = object.bounds.minimum;
  const b = object.bounds.maximum;
  const bays = parseBays(object.properties["Pset_HomeTwinKitchen.Bays"])
    .map((bay) => ({ kind: bay.kind, z0: (bay.z0 - a.z) / 1000, z1: (bay.z1 - a.z) / 1000 }));
  const turned = unit.facing === "east" || unit.facing === "west";
  const w = (turned ? b.y - a.y : b.x - a.x) / 1000;
  const d = (turned ? b.x - a.x : b.y - a.y) / 1000;
  const h = (b.z - a.z) / 1000;
  const group = new THREE.Group();
  group.name = object.name;
  group.position.set((a.x + b.x) / 2000, (a.y + b.y) / 2000, a.z / 1000);
  group.rotation.z = FACING_RADIANS[unit.facing] ?? 0;
  content.add(group);

  const joinery = new Joinery();
  const block = (label: string, width: number, depth: number, height: number, x: number, y: number, z: number,
    material: THREE.Material, chamfer = 0, face: Face | null = null) =>
    joinery.board(label, material, [width, depth, height], [x, y, z], chamfer, face);
  const walnut = finishes.joineryWood;
  const surface = (finish: string): THREE.Material => {
    if (finish === "stone") return finishes.worktop;
    if (finish === "gunmetal") return finishes.gunMetal;
    if (finish === "stainless") return finishes.stainless;
    if (finish === "glass" || finish === "grey_glass") return finishes.applianceGlass;
    return walnut;
  };
  const frontY = -d / 2 + FRONT_M / 2;
  // A frameless carcass stands behind its fronts, so a shadow gap shows its edge.
  const carcassY0 = -d / 2 + FRONT_M;
  const carcassDepth = d / 2 - carcassY0;
  const carcassY = (carcassY0 + d / 2) / 2;
  const floorStanding = FLOOR_ROLES.has(unit.role);
  const toe = () => addToeKick(joinery, w, d, finishes);
  const sides = (bottom: number, top: number) => {
    for (const side of [-1, 1]) {
      block("Veneer end panel", BOARD_M, carcassDepth, top - bottom, side * (w - BOARD_M) / 2, carcassY, (bottom + top) / 2,
        walnut, FRONT_ARRIS_M, "-y");
    }
  };
  const shell = (bottom: number, top: number) => {
    const interiorY0 = carcassY0 + 0.004;
    const interiorY1 = d / 2 - 0.02;
    block("Recessed interior", w - 2 * BOARD_M, interiorY1 - interiorY0, top - bottom - 2 * BOARD_M, 0,
      (interiorY0 + interiorY1) / 2, (bottom + top) / 2, finishes.plinth);
    sides(bottom, top);
    for (const z of [bottom + BOARD_M / 2, top - BOARD_M / 2]) {
      block("Carcass rail", w - 2 * BOARD_M, carcassDepth, BOARD_M, 0, carcassY, z, walnut, FRONT_ARRIS_M, "-y");
    }
  };
  const drawFronts = (fronts: readonly KitchenFront[], material: THREE.Material = walnut, label?: string) =>
    addKitchenFronts(joinery, fronts, d, finishes, material, label);

  if (unit.appliance === "cooktop") {
    block("Induction glass", w, d, Math.max(h, 0.006), 0, 0, h / 2, finishes.applianceGlass, 0.0015, "+z");
    addCooktopMarkings(w, d, h, finishes, track, group);
  } else if (unit.appliance === "sink") {
    // The basin hangs below the stone; the group sits at its underside, so the
    // worktop line is the top of this envelope.
    const skin = 0.012;
    block("Basin floor", w, d, skin, 0, 0, skin / 2, surface(unit.finish));
    for (const side of [-1, 1]) block("Basin side", skin, d, h, side * (w - skin) / 2, 0, h / 2, surface(unit.finish));
    for (const side of [-1, 1]) block("Basin end", w, skin, h, 0, side * (d - skin) / 2, h / 2, surface(unit.finish));
    addMixerTap(d, h, finishes, track, group);
  } else if (unit.role === "worktop") {
    // An eased 2 mm arris on the top edges; the stone's stated thickness is the envelope.
    block("Honed stone top", w, d, h, 0, 0, h / 2, surface(unit.finish), 0.002, "+z");
    // A built-up edge is a rim mitred under the slab, so it hangs below the
    // stone rather than thickening it. The mitre meets at the top arris, so the
    // face reads as one piece and only the rim's lower edge is eased.
    if (unit.edgeDepth > h * 1000) {
      const rim = unit.edgeDepth / 1000 - h;
      for (const [rw, rd, rx, ry] of [[w, 0.02, 0, -d / 2 + 0.01], [w, 0.02, 0, d / 2 - 0.01],
                                      [0.02, d, -w / 2 + 0.01, 0], [0.02, d, w / 2 - 0.01, 0]] as const) {
        block("Mitred edge rim", rw, rd, rim, rx, ry, -rim / 2, surface(unit.finish), 0.002, "-z");
      }
    }
  } else if (unit.role === "appliance") {
    // A bought appliance standing on the stone: its envelope in its finish, not a cabinet.
    block("Appliance body", w, d, h, 0, 0, h / 2, surface(unit.finish), 0.003, "-y");
  } else if (unit.role === "shelf") {
    block("Open display shelf", w, d, h, 0, 0, h / 2, surface(unit.finish), FRONT_ARRIS_M, "-y");
  } else if (unit.role === "gable") {
    // A gable stands on the floor rather than on the plinth, because it carries
    // the stone out where the carcass has stopped short of it.
    block("Support gable", w, d, h, 0, 0, h / 2, surface(unit.finish), FRONT_ARRIS_M, "-y");
  } else if (unit.role === "filler") {
    // A filler sits in a floor run, so it carries the same plinth line as its
    // neighbours, and the same reveal a door front does: drawn to its full width
    // it merges into whatever it fills between and stops reading as a piece.
    toe();
    block("Filler panel", w - FRONT_GAP_M, d, h - PLINTH_M, 0, 0, (h + PLINTH_M) / 2, surface(unit.finish), FRONT_ARRIS_M, "-y");
  } else if (unit.shape === "curved") {
    const shape = new THREE.Shape();
    shape.moveTo(w / 2, d / 2);
    shape.lineTo(-w / 2, d / 2);
    shape.quadraticCurveTo(-w / 2, -d / 2, w / 2, -d / 2);
    shape.closePath();
    const mesh = new THREE.Mesh(track(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 24 })), walnut);
    mesh.name = "Curved end panel";
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  } else if (unit.appliance === "fridge") {
    const greyGlass = track(finishes.applianceGlass.clone());
    greyGlass.color.set(0x55595d);
    greyGlass.roughness = 0.24;
    toe(); shell(PLINTH_M, h);
    // The freezer drawers' bay sets the split where the model states it.
    const freezer = bays.find((bay) => bay.kind === "drawer");
    const split = freezer?.z1 ?? h * 0.39;
    const bands: ReadonlyArray<readonly [number, number]> = [[PLINTH_M, split], [split + 0.012, h - 0.006]];
    const fronts: KitchenFront[] = [];
    for (const [low, high] of bands) {
      for (const side of [-1, 1]) {
        const x0 = side < 0 ? -w / 2 : 0;
        fronts.push({ kind: "door", x0: x0 + 0.0025, x1: x0 + w / 2 - 0.0025, z0: low, z1: high, hinge: "none", grip: "none", channel: null });
      }
    }
    drawFronts(fronts, greyGlass, "Grey glass fridge door");
    block("Fridge recessed grip", w - 0.07, 0.012, 0.012, 0, -d / 2 + 0.028, split + 0.006, finishes.chrome);
  } else if (unit.role === "wall" && unit.front === "open") {
    for (const side of [-1, 1]) block("Cup niche side", BOARD_M, d, h, side * (w - BOARD_M) / 2, 0, h / 2, walnut, FRONT_ARRIS_M, "-y");
    block("Cup niche back", w, BOARD_M, h, 0, d / 2 - BOARD_M / 2, h / 2, walnut);
    for (const z of [0.012, h / 2, h - 0.012]) block("Cup shelf", w - 2 * BOARD_M, d - 0.025, 0.024, 0, 0.0125, z, walnut, FRONT_ARRIS_M, "-y");
    const cup = new THREE.CylinderGeometry(0.036, 0.029, 0.075, 20, 1, true);
    cup.rotateX(Math.PI / 2);
    for (const x of [-w * 0.27, 0, w * 0.27]) {
      joinery.add("Illustrative cup", finishes.worktop, cup.clone().translate(x, -d * 0.15, h / 2 + 0.012 + 0.0375));
    }
    cup.dispose();
  } else if (openCarcass && bays.length > 0 && !unit.carcass) {
    // An integrated appliance stands in its opening on its own feet: there is no box to open.
    if (floorStanding) toe();
    for (const bay of bays) {
      if (bay.kind === "appliance") block("Appliance envelope", w - 0.05, d - 0.06, bay.z1 - bay.z0 - 0.03, 0, -0.01, (bay.z0 + bay.z1) / 2, finishes.applianceGlass);
    }
  } else if (openCarcass && bays.length > 0) {
    const bottom = floorStanding ? PLINTH_M : 0;
    if (floorStanding) toe();
    sides(bottom, h);
    block("Carcass back", w - 2 * BOARD_M, BOARD_M, h - bottom, 0, d / 2 - BOARD_M / 2, (h + bottom) / 2, walnut);
    block("Carcass top", w - 2 * BOARD_M, carcassDepth - BOARD_M, BOARD_M, 0, carcassY - BOARD_M / 2, h - BOARD_M / 2, walnut, FRONT_ARRIS_M, "-y");
    const inner = w - 2 * BOARD_M;
    const shelfDepth = carcassDepth - BOARD_M;
    const shelfY = carcassY - BOARD_M / 2;
    for (const bay of bays) {
      const low = bay.z0;
      const high = bay.z1;
      block("Bay shelf", inner, shelfDepth, BOARD_M, 0, shelfY, low + BOARD_M / 2, walnut, FRONT_ARRIS_M, "-y");
      const boxH = Math.max(high - low - 0.05, 0.04);
      const boxZ = low + BOARD_M + boxH / 2;
      const boxDepth = shelfDepth - 0.04;
      if (bay.kind === "drawer") {
        for (const side of [-1, 1]) {
          block("Drawer box side", 0.014, boxDepth, boxH, side * (inner - 0.04) / 2, shelfY, boxZ, finishes.plinth);
        }
        block("Drawer box front", inner - 0.054, 0.014, boxH, 0, shelfY - boxDepth / 2 + 0.007, boxZ, finishes.plinth);
        block("Drawer box back", inner - 0.054, 0.014, boxH, 0, shelfY + boxDepth / 2 - 0.007, boxZ, finishes.plinth);
        block("Drawer runner", inner, boxDepth, 0.006, 0, shelfY, low + BOARD_M + 0.003, finishes.chrome);
      } else if (bay.kind === "pullout") {
        // A larder pull-out is a frame with gallery rails, not a closed box.
        block("Pull-out tray", inner - 0.04, boxDepth, 0.012, 0, shelfY, low + BOARD_M + 0.012, finishes.plinth);
        for (const rail of [0.06, Math.min(boxH, 0.16)]) {
          for (const side of [-1, 1]) {
            block("Pull-out gallery rail", 0.008, boxDepth, 0.008, side * (inner - 0.05) / 2, shelfY, low + BOARD_M + rail, finishes.chrome);
          }
          block("Pull-out gallery rail", inner - 0.05, 0.008, 0.008, 0, shelfY - boxDepth / 2, low + BOARD_M + rail, finishes.chrome);
        }
      } else if (bay.kind === "appliance") {
        block("Appliance envelope", inner - 0.014, shelfDepth - 0.04, high - low - 0.03, 0, shelfY, (low + high) / 2, finishes.applianceGlass);
      }
    }
    // Concealed hinges stay on the carcass side the door is handed to.
    for (const f of kitchenFronts(unit, w, h, bays).fronts) {
      if (f.kind !== "door" || (f.hinge !== "left" && f.hinge !== "right")) continue;
      const x = f.hinge === "left" ? -w / 2 + BOARD_M + 0.006 : w / 2 - BOARD_M - 0.006;
      const count = hingeCount(f.z1 - f.z0);
      for (let i = 0; i < count; i += 1) {
        const z = f.z0 + 0.1 + (i * (f.z1 - f.z0 - 0.2)) / Math.max(1, count - 1);
        block("Hinge plate", 0.012, 0.05, 0.04, x, carcassY0 + 0.037, z, finishes.chrome);
      }
    }
  } else {
    const { fronts, appliance } = kitchenFronts(unit, w, h, bays);
    if (floorStanding) toe();
    shell(floorStanding ? PLINTH_M : 0, unit.role === "base" || unit.role === "island" ? h - 0.02 : h);
    drawFronts(fronts);
    if (appliance !== null && unit.appliance === "oven") {
      const { z0: low, z1: high } = appliance;
      block("Oven door glass", w - 0.025 - FRONT_GAP_M, FRONT_M, high - low - FRONT_GAP_M, 0, frontY, (low + high) / 2, finishes.applianceGlass);
      block("Oven window", w - 0.13, 0.005, (high - low) * 0.56, 0, -d / 2 - 0.001, low + (high - low) * 0.44, finishes.tvScreen);
      block("Oven control strip", w - 0.035, 0.005, 0.075, 0, -d / 2 - 0.001, high - 0.04, finishes.stainless);
      joinery.add("Oven handle", finishes.stainless,
        new RoundedBoxGeometry(w - 0.13, 0.032, 0.018, 2, 0.005).translate(0, -d / 2 - 0.016, high - 0.135));
      for (const x of [-w * 0.30, w * 0.30]) {
        joinery.add("Oven control", finishes.plinth, new RoundedBoxGeometry(0.024, 0.012, 0.024, 2, 0.006).translate(x, -d / 2 - 0.007, high - 0.04));
      }
    }
    // The island carcass ends at the overhang, so its back faces the stools and
    // wears a veneer panel rather than a carcass edge.
    if (unit.role === "island") {
      block("Seating side back panel", w - 2 * BOARD_M, FRONT_M, h - PLINTH_M - 0.008, 0, d / 2 - FRONT_M / 2, (h + PLINTH_M) / 2,
        walnut, FRONT_ARRIS_M, "+y");
    }
    if (unit.front === "integrated") block("Appliance control strip", w - 0.09, 0.006, 0.028, 0, frontY - 0.012, h - 0.05, finishes.stainless);
  }
  joinery.build(group, track);
  return true;
}
