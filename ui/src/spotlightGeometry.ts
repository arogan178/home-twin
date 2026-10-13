/**
 * The recessed spotlight fittings as installed. Profiles are in millimetres
 * about the fitting's axis: `r` out from its centre, `z` up from the finished
 * ceiling plane. Display only; the beam a view draws never reads them.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Point, RecessedSpotlight } from "./types";

const MM = 0.001;
const SEGMENTS = 32;

/** Trim projection below the finished ceiling, matching TRIM_PROJECTION_MM in ifc.py. */
export const TRIM_PROJECTION_MM = 3;
/** Where a fixed fitting closes above the lamp face it holds up in its throat. */
export const LAMP_SETBACK_MM = 30;
/** A GU10 PAR16 lamp is 50 mm across; its lens sits inside a 3 mm rim. */
const LAMP_RADIUS_MM = 25;
const LENS_RADIUS_MM = 22;
const BOARD_MM = 12.5;
const TERMINAL_BLOCK_MM = 10;
const MIN_TILT_RAD = (0.5 * Math.PI) / 180;

/** The adjustable insert: a lamp cup pivoting on two pins inside the sleeve. */
export const MODULE_PIVOT_MM = 25;
const MODULE_RADIUS_MM = 28;
const MODULE_HALF_HEIGHT_MM = 12;
const MODULE_LENS_MM = -MODULE_HALF_HEIGHT_MM + 4;
const PIN_RADIUS_MM = 2.5;

/**
 * Which fitting a spotlight is. A stated aim off vertical needs an adjustable
 * insert; the IFC names a deep baffle in its model text; the rest are the
 * generic white recessed bowl the sourcing shortlist prefers.
 */
export type SpotlightFitting = "recessed_bowl" | "deep_baffle" | "adjustable";

export function spotlightFitting(fixture: Pick<RecessedSpotlight, "spec" | "direction">): SpotlightFitting {
  if (spotlightTiltRad(fixture.direction) > MIN_TILT_RAD) return "adjustable";
  return /deep[- ]baffle/i.test(fixture.spec.model ?? "") ? "deep_baffle" : "recessed_bowl";
}

function unit(direction: Point): THREE.Vector3 {
  const vector = new THREE.Vector3(direction.x, direction.y, direction.z);
  return vector.lengthSq() === 0 ? vector.set(0, 0, -1) : vector.normalize();
}

/** The angle between a fitting's aim and straight down. */
export function spotlightTiltRad(direction: Point): number {
  return Math.acos(THREE.MathUtils.clamp(-unit(direction).z, -1, 1));
}

/** Turns a fitting's straight-down axis onto its aim, the same unit direction the beam follows. */
export function spotlightAim(direction: Point): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), unit(direction));
}

/** Trim and cut-out radii as stated, with floors that keep the lamp inside the throat. */
export function spotlightRadiiMm(spec: RecessedSpotlight["spec"]): { trim: number; cutout: number } {
  const trim = Math.max(spec.diameter_mm / 2, 40);
  return { trim, cutout: Math.min(Math.max(spec.cutout_diameter_mm / 2, 32), trim - 4) };
}

type RunPoint = readonly [r: number, z: number];
/** Smooth runs of a cross-section; a sharp corner falls between runs. */
export type Profile = readonly (readonly RunPoint[])[];

/** The top of the fitting: the stated mounting depth, with room above the lamp. */
function topMm(mountingMm: number): number {
  return Math.max(mountingMm, LAMP_SETBACK_MM + 20);
}

/**
 * The trim and throat as one white moulding: a rolled lip at the flange edge,
 * the fitting's own throat up to the lamp, and the body wall back down through
 * the cut-out.
 */
export function spotlightBodyProfile(fitting: SpotlightFitting, trimMm: number, cutoutMm: number, mountingMm: number): Profile {
  const R = trimMm;
  const C = cutoutMm;
  const S = LAMP_SETBACK_MM;
  const T = TRIM_PROJECTION_MM;
  const flange: RunPoint[] = [[R, 0], [R, -1.5], [R - 0.6, -2.5], [R - 1.5, -T]];
  // The flange's back lies on the board, so only the wall through the cut-out is drawn.
  const wall = (top: number): RunPoint[][] => [[[C - 0.5, top], [C - 0.5, 0]]];
  // The top is closed by the cap or the can, never by the body, so nothing above lies coplanar with it.
  const seat = (from: number): RunPoint[][] => [[[from, S - 1], [LENS_RADIUS_MM, S - 1]]];

  if (fitting === "recessed_bowl") {
    const lip = C - 3;
    const throatFoot = C - 4.5;
    const throatTop = LAMP_RADIUS_MM + 1;
    const bowl: RunPoint[] = [[lip, -T], [C - 4.2, -2.2]];
    for (let step = 0; step <= 4; step += 1) {
      const angle = (step / 4) * (Math.PI / 2);
      bowl.push([throatTop + (throatFoot - throatTop) * Math.cos(angle), -1 + S * Math.sin(angle)]);
    }
    return [flange, [[R - 1.5, -T], [lip, -T]], bowl, ...seat(throatTop), ...wall(S)];
  }

  if (fitting === "deep_baffle") {
    // Three downward-facing steps between aperture and lamp: the anti-glare rings.
    const rings: RunPoint[][] = [];
    let radius = C - 3;
    let z = -2;
    for (const rise of [7, 15, 23]) {
      rings.push([[radius, z], [radius, rise]], [[radius, rise], [radius - 3, rise]]);
      radius -= 3;
      z = rise;
    }
    rings.push([[radius, z], [radius, S - 1]]);
    return [flange, [[R - 1.5, -T], [C - 2, -T]], [[C - 2, -T], [C - 3, -2]], ...rings, ...seat(radius), ...wall(S)];
  }

  const top = topMm(mountingMm) - TERMINAL_BLOCK_MM;
  return [
    flange,
    [[R - 1.5, -T], [C - 3, -T]],
    [[C - 3, -T], [C - 4, -2]],
    [[C - 4, -2], [C - 4, top - 1]],
    [[C - 4, top - 1], [0, top - 1]],
    ...wall(top),
  ];
}

/** The adjustable lamp cup about its pivot, pointing down: a concentric lip and the lamp rim inside it. */
export function spotlightModuleProfile(): Profile {
  const M = MODULE_RADIUS_MM;
  const H = MODULE_HALF_HEIGHT_MM;
  return [
    [[0, H], [M, H]],
    [[M, H], [M, -H]],
    [[M, -H], [M - 2.5, -H]],
    [[M - 2.5, -H], [M - 2.5, MODULE_LENS_MM]],
    [[M - 2.5, MODULE_LENS_MM], [LENS_RADIUS_MM, MODULE_LENS_MM]],
  ];
}

function lathe(profile: Profile, segments = SEGMENTS): THREE.BufferGeometry {
  const runs = profile.map((run) => new THREE.LatheGeometry(run.map(([r, z]) => new THREE.Vector2(r * MM, z * MM)), segments));
  const merged = mergeGeometries(runs)!;
  for (const run of runs) run.dispose();
  // A lathe turns about +Y; the building frame stands on +Z.
  return merged.rotateX(Math.PI / 2);
}

function box(widthMm: number, depthMm: number, heightMm: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(widthMm * MM, depthMm * MM, heightMm * MM).translate(x * MM, y * MM, z * MM);
}

/**
 * Two torsion clips gripping the board, and the mains terminal block on top.
 * A GU10 mains lamp needs no driver, so none is drawn.
 */
function voidParts(trimMm: number, cutoutMm: number, mountingMm: number, can: boolean): THREE.BufferGeometry {
  const top = topMm(mountingMm);
  const wallR = cutoutMm - 0.5;
  const parts: THREE.BufferGeometry[] = [];
  if (!can) {
    parts.push(new THREE.CircleGeometry(wallR * MM, 24).translate(0, 0, (top - TERMINAL_BLOCK_MM) * MM));
  } else {
    const height = top - TERMINAL_BLOCK_MM - LAMP_SETBACK_MM;
    parts.push(
      new THREE.CylinderGeometry(wallR * 0.92 * MM, wallR * MM, height * MM, 24)
        .rotateX(Math.PI / 2)
        .translate(0, 0, (LAMP_SETBACK_MM + height / 2) * MM),
    );
  }
  for (const side of [-1, 1]) {
    const armLength = trimMm - 1 - wallR;
    const coilZ = BOARD_MM + 4;
    parts.push(
      box(0.8, 6, coilZ - 2, side * (wallR + 0.4), 0, 2 + (coilZ - 2) / 2),
      new THREE.CylinderGeometry(2.5 * MM, 2.5 * MM, 8 * MM, 10).translate(side * (wallR + 2.5) * MM, 0, coilZ * MM),
      box(armLength, 6, 0.8, side * (wallR + armLength / 2), 0, BOARD_MM + 0.4),
    );
  }
  parts.push(box(22, 12, TERMINAL_BLOCK_MM, 0, 0, top - TERMINAL_BLOCK_MM / 2));
  const merged = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  return merged;
}

function pins(cutoutMm: number): THREE.BufferGeometry {
  const length = cutoutMm - 4 - MODULE_RADIUS_MM;
  const parts = [-1, 1].map((side) =>
    new THREE.CylinderGeometry(PIN_RADIUS_MM * MM, PIN_RADIUS_MM * MM, length * MM, 10)
      .rotateZ(Math.PI / 2)
      .translate(side * (MODULE_RADIUS_MM + length / 2) * MM, 0, MODULE_PIVOT_MM * MM),
  );
  const merged = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  return merged;
}

export type SpotlightGeometries = {
  /** Trim, throat and body wall; for an adjustable fitting also its pivot pins along local X. */
  readonly body: THREE.BufferGeometry;
  /** The lamp lens, facing down at the local origin. */
  readonly lens: THREE.BufferGeometry;
  /** Where the lens sits above the ceiling plane in a fixed fitting. */
  readonly lensMm: number;
  /** The tilting lamp cup about its pivot, or null for a fixed fitting. */
  readonly module: THREE.BufferGeometry | null;
  /** Lens offset along the cup's own axis from the pivot. */
  readonly moduleLensMm: number;
  /** Everything above the board: drawn only with the ceiling void. */
  readonly housing: THREE.BufferGeometry;
  /** A trim-sized disc facing up, closing the fitting from above while the void is not drawn. */
  readonly cap: THREE.BufferGeometry;
  readonly capMm: number;
};

/** One fitting type's geometry in metres about its ceiling point, to share across every fitting of that type. */
export function buildSpotlightGeometries(
  fitting: SpotlightFitting,
  trimMm: number,
  cutoutMm: number,
  mountingMm: number,
): SpotlightGeometries {
  const adjustable = fitting === "adjustable";
  const shell = lathe(spotlightBodyProfile(fitting, trimMm, cutoutMm, mountingMm));
  const body = adjustable ? mergeGeometries([shell, pins(cutoutMm)])! : shell;
  if (body !== shell) shell.dispose();
  return {
    body,
    lens: new THREE.CircleGeometry(LENS_RADIUS_MM * MM, 24).rotateX(Math.PI),
    lensMm: LAMP_SETBACK_MM - 1,
    module: adjustable ? lathe(spotlightModuleProfile(), 28) : null,
    moduleLensMm: MODULE_LENS_MM,
    housing: voidParts(trimMm, cutoutMm, mountingMm, !adjustable),
    cap: new THREE.CircleGeometry(trimMm * MM, SEGMENTS),
    capMm: adjustable ? topMm(mountingMm) - TERMINAL_BLOCK_MM : LAMP_SETBACK_MM,
  };
}
