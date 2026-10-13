/**
 * Display meshes for the split-system units, built once per envelope and shared.
 *
 * Both are brand-neutral forms of the two candidate ranges, Gree Pular and
 * Midea Xtreme SavE, fitted inside the authored envelope. The local frame is
 * the IFC unit's: `x` across the width from its centre, `-y` the front, and
 * `z` up from the underside.
 */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { softExtrudeGeometry } from "./architecturalMaterials";

export type Envelope = { readonly widthM: number; readonly depthM: number; readonly heightM: number };
/** Outside diameters of the liquid and gas lines, in millimetres. */
export type PipePairMm = readonly [liquid: number, gas: number];

export type OutdoorPart = "cabinet" | "plastic" | "coil" | "copper";
export type IndoorPart = "shell" | "throat";

/** Every outdoor unit stands on 150 mm feet, below its envelope. */
export const FEET_M = 0.15;
/** The authored line set lands this far above the underside, 10 mm off the valve side, at mid-depth. */
const VALVE_Z_M = 0.15;
/** One coil texture tile: sixteen fins at 1.8 mm across, two 21 mm tube rows up. */
export const COIL_TILE_M = [0.029, 0.042] as const;

const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number) =>
  new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);

const roundedBox = (sx: number, sy: number, sz: number, radius: number, x: number, y: number, z: number) =>
  new RoundedBoxGeometry(sx, sy, sz, 2, radius).translate(x, y, z);

/** A ring facing the front, around the fan's axis along local y. */
const facingFront = (geometry: THREE.TorusGeometry, x: number, y: number, z: number) =>
  geometry.rotateX(Math.PI / 2).translate(x, y, z);

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((part) => (part.index === null ? part : part.toNonIndexed()));
  const merged = mergeGeometries(flat);
  for (const geometry of new Set([...parts, ...flat])) geometry.dispose();
  if (merged === null) throw new Error("AC unit parts do not share attributes");
  return merged;
}

/** Shape-plane (x, y) onto unit (x, z), extruded towards the front. */
const FRONT_BASIS = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, -1, 0),
);

/** A coil face with its texture tiled at the real fin pitch. */
function coilFace(across: number, up: number): THREE.PlaneGeometry {
  const plane = new THREE.PlaneGeometry(across, up);
  const uv = plane.attributes.uv!;
  for (let index = 0; index < uv.count; index += 1) {
    uv.setXY(index, (uv.getX(index) * across) / COIL_TILE_M[0], (uv.getY(index) * up) / COIL_TILE_M[1]);
  }
  return plane.rotateX(Math.PI / 2);
}

/** A swept, twisted blade as a surface over radius and chord. */
function fanBlade(centreAngle: number, hubM: number, tipM: number): THREE.BufferGeometry {
  const radial = 8;
  const chordwise = 5;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i <= radial; i += 1) {
    const t = i / radial;
    const r = hubM + (tipM - hubM) * t;
    // Wide at the tip and rounded off there, as an axial condenser fan is.
    const roundTip = t > 0.8 ? 0.35 + 0.65 * Math.sqrt(1 - ((t - 0.8) / 0.2) ** 2) : 1;
    const chord = (0.75 + 0.55 * t) * roundTip;
    const lead = centreAngle + 0.5 + 0.55 * t ** 1.4;
    const pitch = THREE.MathUtils.degToRad(36 - 14 * t);
    for (let j = 0; j <= chordwise; j += 1) {
      const s = j / chordwise;
      const angle = lead - chord * s;
      positions.push(r * Math.cos(angle), (s - 0.5) * chord * r * Math.sin(pitch), r * Math.sin(angle));
      uvs.push(s, t);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < radial; i += 1) {
    for (let j = 0; j < chordwise; j += 1) {
      const a = i * (chordwise + 1) + j;
      const b = a + chordwise + 1;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * An outdoor condenser: a powder-coated cabinet with one fan on the left of its
 * front, the compressor bay on the right, and the valve cover on the right side.
 * Both makers' 24k units have one fan too, only larger. The coil wraps the back
 * and the left side behind a wire guard and louvres. The cabinet fills the
 * envelope with its valve cover, and the feet stand under it.
 */
export function outdoorUnitParts(size: Envelope, pipes: PipePairMm): Record<OutdoorPart, THREE.BufferGeometry> {
  const { widthM: w, depthM: d, heightM: h } = size;
  const front = -d / 2;
  const back = d / 2;
  // Gree's valve cover stands 57 mm off a 732 cabinet and 69 mm off a 958 one.
  const valveCover = 0.075 * w;
  const left = -w / 2;
  const right = w / 2 - valveCover;
  const mid = (left + right) / 2;
  const span = right - left;
  const pan = 0.045;
  const top = h - 0.03;
  const panelY = front + 0.012;
  // The fan opening is 0.70 of the height on Midea's small unit and 0.78 on Gree's.
  const radius = (0.74 * h) / 2;
  const fanX = left + 0.09 * h + radius;
  const fanZ = 0.52 * h;
  const bay = fanX + radius + 0.03;
  const footSpan = 0.67 * span;

  const panel = new THREE.Shape();
  panel.moveTo(left, pan).lineTo(right, pan).lineTo(right, top).lineTo(left, top).closePath();
  panel.holes.push(new THREE.Path().absarc(fanX, fanZ, radius, 0, Math.PI * 2, false));
  const frontPanel = softExtrudeGeometry(panel, 0.008, 0.003, 24).applyMatrix4(FRONT_BASIS).translate(0, panelY + 0.008, 0);
  const bayPanel = new THREE.Shape();
  const [px0, px1, pz0, pz1, corner] = [bay + 0.04, right - 0.04, 0.2 * h, 0.8 * h, 0.02];
  bayPanel
    .moveTo(px0 + corner, pz0)
    .lineTo(px1 - corner, pz0)
    .quadraticCurveTo(px1, pz0, px1, pz0 + corner)
    .lineTo(px1, pz1 - corner)
    .quadraticCurveTo(px1, pz1, px1 - corner, pz1)
    .lineTo(px0 + corner, pz1)
    .quadraticCurveTo(px0, pz1, px0, pz1 - corner)
    .lineTo(px0, pz0 + corner)
    .quadraticCurveTo(px0, pz0, px0 + corner, pz0);
  const mouldedPanel = softExtrudeGeometry(bayPanel, 0.003, 0.001, 4).applyMatrix4(FRONT_BASIS).translate(0, panelY, 0);

  const guardY = front + 0.005;
  const rings = [0.3, 0.48, 0.66, 0.84].map((fraction) =>
    facingFront(new THREE.TorusGeometry(radius * fraction, 0.0022, 4, 48), fanX, guardY, fanZ),
  );
  const rim = facingFront(new THREE.TorusGeometry(radius + 0.004, 0.005, 4, 56), fanX, guardY, fanZ);
  const boss = 0.12 * radius;
  const spokes = Array.from({ length: 16 }, (_, index) => {
    const start = (index / 16) * Math.PI * 2;
    const at = (r: number, angle: number) => new THREE.Vector3(fanX + r * Math.cos(angle), guardY + 0.002, fanZ + r * Math.sin(angle));
    const curve = new THREE.QuadraticBezierCurve3(at(boss, start), at(radius * 0.6, start + 0.3), at(radius + 0.004, start + 0.45));
    return new THREE.TubeGeometry(curve, 8, 0.0025, 3, false);
  });
  const guardBoss = new THREE.CylinderGeometry(boss + 0.004, boss + 0.004, 0.006, 24).translate(fanX, guardY + 0.002, fanZ);

  const slats = Math.round((top - pan) / 0.06);
  const louvres = Array.from({ length: slats }, (_, index) =>
    box(0.003, d - 0.06, 0.035, 0, 0, 0)
      .rotateY(THREE.MathUtils.degToRad(-35))
      .translate(left + 0.0115, (front + 0.02 + back - 0.03) / 2, pan + (index + 0.5) * ((top - pan) / slats)),
  );
  const wires = Math.round((top - pan) / 0.05);
  const guardWires = [
    ...Array.from({ length: wires }, (_, index) =>
      new THREE.CylinderGeometry(0.002, 0.002, bay - left - 0.04, 4)
        .rotateZ(Math.PI / 2)
        .translate((left + 0.02 + bay - 0.02) / 2, back - 0.003, pan + (index + 0.5) * ((top - pan) / wires)),
    ),
    ...[0.2, 0.5, 0.8].map((fraction) =>
      new THREE.CylinderGeometry(0.002, 0.002, top - pan, 4)
        .rotateX(Math.PI / 2)
        .translate(left + 0.02 + (bay - left - 0.04) * fraction, back - 0.005, (pan + top) / 2),
    ),
  ];

  // The flare connections leave the valve cover's back and run into the end of
  // the authored trunking, which stops at mid-depth beside the unit.
  const coverBack = -0.07;
  const coverFront = front + 0.03;
  const coverTop = 0.23;
  const stubX = w / 2 - 0.009;
  const stubs = pipes.flatMap((diameterMm, index) => {
    const r = (diameterMm / 1000) / 2;
    const z = index === 0 ? VALVE_Z_M + 0.025 : VALVE_Z_M - 0.025;
    return [
      new THREE.CylinderGeometry(r, r, 0.02 - coverBack, 12).translate(stubX, coverBack / 2, z),
      new THREE.CylinderGeometry(r * 1.7, r * 1.7, 0.018, 6).translate(stubX, coverBack + 0.009, z),
    ];
  });

  const bladeY = panelY + 0.05;
  const hub = 0.09 * 2 * radius;
  const spinner = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.001, -0.028),
      new THREE.Vector2(hub * 0.55, -0.024),
      new THREE.Vector2(hub * 0.92, -0.01),
      new THREE.Vector2(hub, 0.004),
      new THREE.Vector2(hub, 0.03),
      new THREE.Vector2(0.001, 0.03),
    ],
    24,
  ).translate(fanX, bladeY, fanZ);

  return {
    cabinet: merge([
      roundedBox(span, d - 0.006, h - top, 0.005, mid, (front + 0.006 + back) / 2, (top + h) / 2),
      box(span, d - 0.012, pan - 0.012, mid, (front + 0.012 + back) / 2, (pan + 0.012) / 2),
      ...[-1, 1].map((side) => box(0.05, d - 0.02, 0.012, mid + (side * footSpan) / 2, (front + 0.012 + back) / 2, 0.006)),
      frontPanel,
      mouldedPanel,
      box(0.006, d - 0.012, top - pan, right - 0.003, (front + 0.012 + back) / 2, (pan + top) / 2),
      box(right - bay, 0.006, top - pan, (bay + right) / 2, back - 0.003, (pan + top) / 2),
      box(0.004, d - 0.03, top - pan, bay, (front + 0.012 + back) / 2, (pan + top) / 2),
      box(0.025, 0.025, top - pan, left + 0.0125, back - 0.0125, (pan + top) / 2),
      roundedBox(valveCover + 0.002, coverBack - coverFront, coverTop - 0.04, 0.006, right + valveCover / 2 - 0.001, (coverFront + coverBack) / 2, (0.04 + coverTop) / 2),
      roundedBox(0.016, 0.3 * d, 0.18 * h, 0.004, right + 0.007, -0.2 * d, 0.72 * h),
      ...rings,
      rim,
      ...spokes,
      guardBoss,
      ...louvres,
      ...guardWires,
    ]),
    plastic: merge([
      new THREE.CylinderGeometry(radius + 0.003, radius + 0.003, 0.09, 48, 1, true).translate(fanX, panelY + 0.053, fanZ),
      ...[0, 1, 2].map((index) => fanBlade((index * Math.PI * 2) / 3, hub, 0.94 * radius).translate(fanX, bladeY, fanZ)),
      spinner,
      new THREE.CylinderGeometry(0.055, 0.055, 0.06, 20).translate(fanX, bladeY + 0.06, fanZ),
      box(0.035, 0.008, top - pan, fanX, bladeY + 0.094, (pan + top) / 2),
      box(0.003, 0.2 * d, 0.04, right + 0.0015, 0.25 * d, 0.83 * h),
      ...[-1, 1].map((side) => box(0.09, d - 0.01, FEET_M, mid + (side * footSpan) / 2, 0, -FEET_M / 2)),
    ]),
    coil: merge([
      coilFace(bay - left - 0.025, top - pan).translate((left + 0.025 + bay) / 2, back - 0.01, (pan + top) / 2),
      coilFace(back - front - 0.045, top - pan)
        .rotateZ(Math.PI / 2)
        .translate(left + 0.022, (front + 0.02 + back - 0.025) / 2, (pan + top) / 2),
    ]),
    copper: merge(stubs),
  };
}

type Point = readonly [u: number, v: number];

/**
 * The indoor unit's section, as (u from the wall, v up from the underside):
 * a flat top, a near-flat front, and a large curve under it to the outlet on
 * the underside. Midea's drawing puts that curve over about 45% of the height.
 */
export function indoorProfile(depthM: number, heightM: number): { shell: Point[]; flap: Point[]; throat: Point[] } {
  const d = depthM;
  const h = heightM;
  const rounding = 0.015;
  const curveFrom: Point = [d, 0.5 * h];
  const control: Point = [d, 0];
  const lip: Point = [0.36 * d, 0];
  const bottom = (t: number): Point => [
    (1 - t) ** 2 * curveFrom[0] + 2 * t * (1 - t) * control[0] + t ** 2 * lip[0],
    (1 - t) ** 2 * curveFrom[1] + 2 * t * (1 - t) * control[1] + t ** 2 * lip[1],
  ];
  const samples = (from: number, to: number, count: number) =>
    Array.from({ length: count + 1 }, (_, index) => bottom(from + ((to - from) * index) / count));
  // The flap closes the lower, rearward part of the curve.
  const flapFrom = 0.42;
  const outlet = bottom(flapFrom);

  const shell: Point[] = [
    [0, h],
    [d - 0.004 - rounding, h],
    [d - 0.004 - rounding * 0.3, h - rounding * 0.3],
    [d - 0.004, h - rounding],
    [d - 0.0015, 0.75 * h],
    ...samples(0, flapFrom, 7),
    lip,
    [0.06 * d, 0],
    [0, 0.05 * h],
  ];

  // Open 20 degrees about its rear edge, as it sits when the unit runs.
  const pivot = bottom(0.97);
  const open = THREE.MathUtils.degToRad(-20);
  const turn = ([u, v]: Point): Point => [
    pivot[0] + (u - pivot[0]) * Math.cos(open) - (v - pivot[1]) * Math.sin(open),
    pivot[1] + (u - pivot[0]) * Math.sin(open) + (v - pivot[1]) * Math.cos(open),
  ];
  const outer = samples(flapFrom + 0.03, 0.97, 8);
  const inner = outer.map(([u, v], index): Point => {
    const [nu, nv] = outer[Math.min(index + 1, outer.length - 1)]!;
    const [pu, pv] = outer[Math.max(index - 1, 0)]!;
    const length = Math.hypot(nu - pu, nv - pv);
    return [u - ((nv - pv) / length) * 0.004, v + ((nu - pu) / length) * 0.004];
  });
  let flap = [...outer, ...inner.reverse()].map(turn);
  const low = Math.min(...flap.map(([, v]) => v));
  if (low < 0.001) flap = flap.map(([u, v]) => [u, v - low + 0.001]);

  const chord = Math.hypot(lip[0] - outlet[0], lip[1] - outlet[1]);
  const down: Point = [(lip[1] - outlet[1]) / chord, (outlet[0] - lip[0]) / chord];
  const throat: Point[] = [outlet, lip, [lip[0] + down[0] * 0.006, lip[1] + down[1] * 0.006], [outlet[0] + down[0] * 0.006, outlet[1] + down[1] * 0.006]];
  return { shell, flap, throat };
}

/** Shape-plane (y, z) onto the unit, extruded across its width. */
const SECTION_BASIS = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0),
);

function section(points: readonly Point[], depthM: number, lengthM: number, arrisM: number, x = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(depthM / 2 - u, v)));
  return softExtrudeGeometry(shape, lengthM, arrisM, 4).applyMatrix4(SECTION_BASIS).translate(x - lengthM / 2, 0, 0);
}

/** A wall-hung indoor unit filling its envelope exactly: the body and open louvre flap, and the dark outlet with its vanes. */
export function indoorUnitParts(size: Envelope): Record<IndoorPart, THREE.BufferGeometry> {
  const { widthM: w, depthM: d, heightM: h } = size;
  const { shell, flap, throat } = indoorProfile(d, h);
  const vanes = Math.max(4, Math.round(w / 0.09));
  const [outlet, lip] = throat;
  const vane: Point[] = [outlet!, lip!, [(outlet![0] + lip![0]) / 2, Math.min(outlet![1], lip![1]) + 0.004]];
  return {
    shell: merge([section(shell, d, w, 0.008), section(flap, d, w - 0.03, 0.0015)]),
    throat: merge([
      section(throat, d, w - 0.02, 0.001),
      ...Array.from({ length: vanes }, (_, index) =>
        section(vane, d, 0.002, 0.0004, -w / 2 + 0.04 + ((w - 0.08) * index) / (vanes - 1)),
      ),
    ]),
  };
}
