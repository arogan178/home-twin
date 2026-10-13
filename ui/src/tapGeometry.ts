import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { ArchitecturalMaterials } from "./architecturalMaterials";
import type { BuildingObject } from "./types";

type Track = <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T;

const MM = 0.001;

/**
 * A tap's display parts in its own frame: metres, the body axis on the deck at
 * the origin, +Z up, the spout reaching along -Y. Each part list is merged so a
 * tap costs two draw calls whatever its detail.
 */
export type TapParts = { readonly metal: THREE.BufferGeometry; readonly insert: THREE.BufferGeometry };

/** The authored envelope: body radius, reach from the body axis to the spout tip, and overall height. */
export type TapEnvelope = { readonly bodyRadius: number; readonly reach: number; readonly height: number };

export type TapModel = "grohe-euroeco-xl" | "bridgepoint-bp02" | "generic-mixer" | "shower-system";

export type TapFinish = "chrome" | "gunmetal";

/** Products the model names. An unnamed tap gets the generic mixer rather than a guessed product. */
const PRODUCT_MODELS: Readonly<Record<string, TapModel>> = {
  "GROHE Euroeco XL 24273001": "grohe-euroeco-xl",
};

export function tapModelFor(product: unknown): TapModel {
  return (typeof product === "string" ? PRODUCT_MODELS[product] : undefined) ?? "generic-mixer";
}

export function tapFinishFor(finish: unknown): TapFinish {
  return finish === "gunmetal" ? "gunmetal" : "chrome";
}

type Profile = ReadonlyArray<readonly [number, number]>;

/**
 * A lathe about +Z from [radius, height] pairs in millimetres. Walk the profile
 * with the solid on the left so the faces point out; a repeated point keeps the
 * edge there crisp instead of averaging its normals.
 */
function lathe(profile: Profile, segments: number, scaleR = 1, scaleZ = 1): THREE.BufferGeometry {
  const points = profile.map(([r, z]) => new THREE.Vector2(r * scaleR * MM, z * scaleZ * MM));
  const geometry = new THREE.LatheGeometry(points, segments);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function merge(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((part) => {
    const geometry = part.index ? part.toNonIndexed() : part;
    geometry.deleteAttribute("uv");
    return geometry;
  });
  const merged = mergeGeometries(flat);
  if (merged === null) throw new Error("Tap parts could not be merged");
  return merged;
}

/** A circular arc in the YZ plane about (cy, cz), from angle `start` to `end` measured from +Y towards +Z. */
class ArcYZ extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly cy: number,
    private readonly cz: number,
    private readonly radius: number,
    private readonly start: number,
    private readonly end: number,
  ) {
    super();
  }

  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const angle = this.start + (this.end - this.start) * t;
    return target.set(0, this.cy + this.radius * Math.cos(angle), this.cz + this.radius * Math.sin(angle));
  }
}

export type Section = { readonly halfWidth: number; readonly halfHeight: number };

/**
 * A spout swept along a path in the YZ plane, its superelliptic section varying
 * with arc length `t`. A section of zero closes the end. Width lies along X.
 */
export function sweptSection(
  path: THREE.Curve<THREE.Vector3>,
  section: (t: number) => Section,
  stations: readonly number[],
  around: number,
  exponent = 2.4,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const side = new THREE.Vector3(1, 0, 0);
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (const t of stations) {
    path.getPointAt(t, point);
    path.getTangentAt(t, tangent);
    up.crossVectors(tangent, side).normalize();
    const { halfWidth, halfHeight } = section(t);
    for (let j = 0; j < around; j += 1) {
      const phi = (j / around) * Math.PI * 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const across = halfWidth * Math.sign(c) * Math.abs(c) ** (2 / exponent);
      const lift = halfHeight * Math.sign(s) * Math.abs(s) ** (2 / exponent);
      positions.push(point.x + across, point.y + up.y * lift, point.z + up.z * lift);
    }
  }
  for (let i = 0; i < stations.length - 1; i += 1) {
    for (let j = 0; j < around; j += 1) {
      const a = i * around + j;
      const b = i * around + ((j + 1) % around);
      indices.push(a, b, a + around, b, b + around, a + around);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A flat outline round two circles and their outer tangents: a lever paddle, hub to tip. */
function paddleShape(hubV: number, hubRadius: number, tipV: number, tipRadius: number): THREE.Shape {
  const length = hubV - tipV;
  const beta = Math.asin((hubRadius - tipRadius) / length);
  const shape = new THREE.Shape();
  shape.moveTo(tipRadius * Math.cos(beta), tipV + tipRadius * Math.sin(beta));
  shape.lineTo(hubRadius * Math.cos(beta), hubV + hubRadius * Math.sin(beta));
  shape.absarc(0, hubV, hubRadius, beta, Math.PI - beta, false);
  shape.lineTo(-tipRadius * Math.cos(beta), tipV + tipRadius * Math.sin(beta));
  shape.absarc(0, tipV, tipRadius, Math.PI - beta, Math.PI * 2 + beta, false);
  return shape;
}

/** A paddle extruded `thickness` along +Z with a softened arris, centred on z = 0. Millimetres in, metres out. */
function paddle(hubV: number, hubRadius: number, tipV: number, tipRadius: number, thickness: number): THREE.BufferGeometry {
  const arris = Math.min(1.2, thickness / 4);
  const shape = paddleShape(hubV * MM, hubRadius * MM, tipV * MM, tipRadius * MM);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: (thickness - arris * 2) * MM,
    bevelEnabled: true,
    bevelThickness: arris * MM,
    bevelSize: arris * MM,
    bevelOffset: -arris * MM,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geometry.translate(0, 0, -(thickness / 2 - arris) * MM);
  return geometry;
}

/**
 * An aerator housing with its recessed face, about +Y, the face at y = 0 and
 * the housing reaching back to -6 mm. The dark insert is the recess floor.
 */
function aerator(radius: number, segments: number): { metal: THREE.BufferGeometry; insert: THREE.BufferGeometry } {
  const lip = radius * 0.84;
  const recess = 1.6;
  const housing = lathe([[radius, -6], [radius, -0.7], [radius - 0.7, 0], [radius - 0.7, 0], [lip, 0], [lip, 0], [lip, -recess]], segments);
  housing.rotateX(-Math.PI / 2);
  const insert = new THREE.CircleGeometry(lip * MM, segments);
  insert.rotateX(-Math.PI / 2);
  insert.translate(0, -recess * MM, 0);
  return { metal: housing, insert };
}

function placeAlong(geometry: THREE.BufferGeometry, axis: THREE.Vector3, origin: THREE.Vector3): THREE.BufferGeometry {
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
  return geometry.applyMatrix4(new THREE.Matrix4().compose(origin, rotation, new THREE.Vector3(1, 1, 1)));
}

/**
 * GROHE Euroeco XL 24273001, from GROHE's drawing: 351 overall, 319 to the
 * body top, the outlet at 243, a Ø49 tapering column and a spout falling to a
 * downturned aerator. The authored envelope is generic and wins: heights scale
 * to it, the body to its radius, and the spout runs to its reach.
 */
function euroecoXl(envelope: TapEnvelope): TapParts {
  const sz = envelope.height / MM / 351;
  const sr = envelope.bodyRadius / MM / 24.5;
  const reach = envelope.reach / MM;
  const body = lathe([
    [0, 0], [24.5, 0], [24.5, 0], [24.5, 2.5], [24.5, 2.5], [21.2, 2.5], [21.2, 2.5],
    [21.6, 60], [22.6, 140], [23.7, 220], [24.5, 280], [24.5, 296],
    [24.0, 304], [22.6, 310], [20, 314.5], [16, 317.4], [10, 318.8], [0, 319.3],
  ], 32, sr, sz);

  const path = new THREE.CubicBezierCurve3(
    new THREE.Vector3(0, 0, 290 * sz * MM),
    new THREE.Vector3(0, -0.35 * reach * MM, 288 * sz * MM),
    // A level end tangent, so the closing nose stops at the reach instead of leaning past it.
    new THREE.Vector3(0, -0.72 * reach * MM, 262 * sz * MM),
    new THREE.Vector3(0, -reach * MM, 262 * sz * MM),
  );
  const length = path.getLength() / MM;
  const tip = { halfWidth: 12.5 * sr, halfHeight: 9 * sz };
  const nose = (tip.halfWidth * 0.7) / length;
  const lerp = (a: number, b: number, u: number) => a + (b - a) * Math.min(Math.max(u, 0), 1);
  const section = (t: number): Section => {
    // The root is taller than the run, so the spout flows out of the column rather than butting into it.
    const run = t < 0.3
      ? { halfWidth: lerp(21, 15, t / 0.3) * sr, halfHeight: lerp(27, 11, t / 0.3) * sz }
      : { halfWidth: lerp(15 * sr, tip.halfWidth, (t - 0.3) / 0.7), halfHeight: lerp(11 * sz, tip.halfHeight, (t - 0.3) / 0.7) };
    const intoNose = (t - (1 - nose)) / nose;
    const close = intoNose > 0 ? Math.sqrt(Math.max(0, 1 - intoNose * intoNose)) : 1;
    return { halfWidth: run.halfWidth * close * MM, halfHeight: run.halfHeight * close * MM };
  };
  const stations = [
    ...Array.from({ length: 24 }, (_, i) => (i / 24) * (1 - nose)),
    ...Array.from({ length: 7 }, (_, i) => 1 - nose + nose * Math.sin(((i + 1) / 7) * Math.PI / 2)),
  ];
  const spout = sweptSection(path, section, stations, 24);

  // The aerator sits under the tip, turned 35 degrees forward as GROHE draws it.
  const outletT = 1 - nose - (14 * sr) / length;
  const centre = path.getPointAt(outletT);
  const tangent = path.getTangentAt(outletT);
  const down = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(1, 0, 0)).normalize().negate();
  const underside = centre.clone().addScaledVector(down, section(outletT).halfHeight);
  const jet = new THREE.Vector3(0, -Math.sin((35 * Math.PI) / 180), -Math.cos((35 * Math.PI) / 180));
  const outlet = aerator(10 * sr, 20);
  placeAlong(outlet.metal, jet, underside.clone().addScaledVector(jet, 4 * sz * MM));
  placeAlong(outlet.insert, jet, underside.clone().addScaledVector(jet, 4 * sz * MM));

  // The lever rises forward over the spout from a hub on the cartridge cap; its tip is the envelope's top.
  const tilt = (18 * Math.PI) / 180;
  const thickness = 5.5 * sz;
  const lever = paddle(6 * sr, 13.5 * sr, -70 * sr, 7 * sr, thickness);
  lever.rotateX(-tilt);
  lever.computeBoundingBox();
  const lift = envelope.height - (lever.boundingBox?.max.z ?? 0);
  lever.translate(0, 0, lift);
  const capTop = lift / MM - (thickness / 2) * Math.cos(tilt) + 1;
  const cap = lathe([[12.4 * sr, 312 * sz], [12.4 * sr, capTop - 1], [11.6 * sr, capTop], [0, capTop]], 24);

  return { metal: merge([body, spout, outlet.metal, lever, cap]), insert: outlet.insert };
}

/**
 * Bridgepoint BP02 pull-out mixer BP028303GM, from its drawing: a Ø35 pillar
 * 58 high, a Ø45 side body 125 long with the lever paddle 113 high at its end,
 * and a swivel gooseneck 400 high whose Ø28 pull-out head lands 245 out.
 */
function bridgepointBp02(): TapParts {
  const pillar = lathe([[0, 0], [22, 0], [22, 0], [22, 2.5], [21, 3.5], [21, 3.5], [17.5, 3.5], [17.5, 3.5], [17.5, 75], [0, 75]], 24);
  const body = lathe([[0, -36], [20.5, -36], [22.5, -34], [22.5, 86], [0, 86]], 24);
  body.rotateY(Math.PI / 2);
  body.translate(0, 0, 80.5 * MM);
  const collar = lathe([[15, 95], [15, 112], [14, 113], [0, 113]], 24);

  const tube = 14 * MM;
  const riserTop = 285 * MM;
  const riser = new THREE.CylinderGeometry(tube, tube, riserTop - 110 * MM, 16, 1, true);
  riser.rotateX(Math.PI / 2);
  riser.translate(0, 0, (riserTop + 110 * MM) / 2);
  const bendRadius = 101 * MM;
  const sweep = (170 * Math.PI) / 180;
  const arc = new ArcYZ(-bendRadius, riserTop, bendRadius, 0, sweep);
  const neck = new THREE.TubeGeometry(arc, 32, tube, 16, false);

  // The head hangs on the arc's end tangent, 10 degrees off vertical, face down.
  const end = arc.getPoint(1);
  const down = arc.getTangent(1).normalize();
  const headLength = 95;
  const face = end.clone().addScaledVector(down, headLength * MM);
  const head = lathe([
    [11, 1.8], [11, 0], [11, 0], [13, 0], [14, 1.2],
    [14, 30], [13.2, 30.6], [13.2, 31.6], [14, 32.2], [14, 62], [13.2, 62.6], [13.2, 63.6], [14, 64.2],
    [14, 93], [13.4, 94.4], [12.4, 95], [12.4, 95], [0, 95],
  ], 24);
  const spray = new THREE.CircleGeometry(11 * MM, 24);
  spray.rotateX(Math.PI);
  spray.translate(0, 0, 1.8 * MM);
  const headFrame = new THREE.Matrix4().compose(
    face,
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), down.clone().negate()),
    new THREE.Vector3(1, 1, 1),
  );
  head.applyMatrix4(headFrame);
  spray.applyMatrix4(headFrame);

  // The paddle stands on the body's +X end: a Ø45 hub rising to a rounded tip 171 above the deck.
  const lever = paddle(162, 9, 80.5, 22.5, 7);
  lever.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  lever.translate((86 + 3.5) * MM, 0, 0);

  return { metal: merge([pillar, body, collar, riser, neck, head, lever]), insert: spray };
}

/** The current generic tall mixer, for a tap the model names no product for: round body, bent spout, top lever. */
function genericMixer(envelope: TapEnvelope): TapParts {
  const r = envelope.bodyRadius / MM;
  const h = envelope.height / MM;
  const reach = envelope.reach / MM;
  const shoulder = 0.72 * h;
  const body = lathe([[0, 0], [r, 0], [r, 0], [r, shoulder - 3], [r - 2.5, shoulder], [r - 2.5, shoulder], [0, shoulder]], 24);

  const tube = 0.38 * r;
  const bend = 1.6 * tube;
  const spoutZ = 0.6 * h;
  const run = reach - tube - bend;
  const arm = new THREE.CylinderGeometry(tube * MM, tube * MM, run * MM, 16, 1, true);
  arm.translate(0, (-run / 2) * MM, spoutZ * MM);
  const elbow = new THREE.TubeGeometry(new ArcYZ(-run * MM, (spoutZ - bend) * MM, bend * MM, Math.PI / 2, Math.PI), 10, tube * MM, 16, false);
  const outlet = aerator(tube, 16);
  const outletAt = new THREE.Vector3(0, -(reach - tube) * MM, (spoutZ - bend - 3) * MM);
  placeAlong(outlet.metal, new THREE.Vector3(0, 0, -1), outletAt);
  placeAlong(outlet.insert, new THREE.Vector3(0, 0, -1), outletAt);

  const tilt = (15 * Math.PI) / 180;
  const thickness = Math.max(4, 0.12 * r);
  const lever = paddle(0, 0.45 * r, -1.6 * r, 0.25 * r, thickness);
  lever.rotateX(-tilt);
  lever.computeBoundingBox();
  const lift = envelope.height - (lever.boundingBox?.max.z ?? 0);
  lever.translate(0, 0, lift);
  const capTop = lift / MM - (thickness / 2) * Math.cos(tilt) + 1;
  const cap = lathe([[0.4 * r, shoulder - 1], [0.4 * r, capTop], [0, capTop]], 24);
  return { metal: merge([body, arm, elbow, outlet.metal, lever, cap]), insert: outlet.insert };
}

/**
 * A thermostatic shower system in the shower's west-wall frame: +X out of the
 * wall, origin on the wall at floor level. No product is named, so the form is
 * a generic chrome GROHE-style system on the viewer's existing positions: a bar
 * valve at 1050, the riser on its axis 40 mm off the wall, the arm at 0.9 of the
 * envelope height and a Ø200 head at 276 mm out.
 */
function showerSystem(envelope: TapEnvelope): TapParts {
  const height = envelope.height;
  const axisX = 0.04;
  const valveZ = 1.05;
  const armZ = height * 0.9 - 0.012;
  const headX = 0.276;
  const headTop = height * 0.88;
  const pipe = 0.011;

  // Grohtherm-style bar: flow handle, body and temperature handle along the wall, Ø50.
  const bar = lathe([
    [0, -100], [20, -100], [20, -100], [25, -97], [25, -88], [24, -87], [25, -86], [25, -77], [24, -76], [25, -75],
    [25, -60], [23, -58], [23, -55], [24.5, -54], [24.5, 54], [23, 55], [23, 58], [25, 60],
    [25, 75], [24, 76], [25, 77], [25, 86], [24, 87], [25, 88], [25, 97], [20, 100], [20, 100], [0, 100],
  ], 28);
  bar.rotateX(-Math.PI / 2);
  bar.translate(axisX, 0, valveZ);

  const wallUnion = (y: number, z: number, flangeRadius: number) => {
    const union = lathe([[0, 0], [flangeRadius, 0], [flangeRadius, 0], [flangeRadius, 5], [flangeRadius - 1.5, 6.5], [flangeRadius - 1.5, 6.5], [10, 6.5], [10, 6.5], [10, axisX / MM], [0, axisX / MM]], 20);
    union.rotateY(Math.PI / 2);
    union.translate(0, y, z);
    return union;
  };

  const bendRadius = 0.04;
  const riserBottom = valveZ;
  const riserTop = armZ - bendRadius;
  const riser = new THREE.CylinderGeometry(pipe, pipe, riserTop - riserBottom, 16, 1, true);
  riser.rotateX(Math.PI / 2);
  riser.translate(axisX, 0, (riserTop + riserBottom) / 2);
  const elbowCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(axisX, 0, riserTop),
    new THREE.Vector3(axisX, 0, armZ),
    new THREE.Vector3(axisX + bendRadius, 0, armZ),
  );
  const elbow = new THREE.TubeGeometry(elbowCurve, 10, pipe, 16, false);
  const armLength = headX - axisX - bendRadius;
  const arm = new THREE.CylinderGeometry(pipe, pipe, armLength, 16, 1, true);
  arm.rotateZ(Math.PI / 2);
  arm.translate(axisX + bendRadius + armLength / 2, 0, armZ);

  // The arm ends in a ball joint that carries the head below it.
  const joint = lathe([[0, -16], [9, -16], [9, -16], [9, -10], [13, -6], [16, 0], [13, 6], [6, 9], [0, 9.5]], 20);
  joint.translate(headX, 0, armZ);
  const neck = lathe([[0, headTop / MM - 1], [8, headTop / MM - 1], [8, (armZ - 0.012) / MM], [0, (armZ - 0.012) / MM]], 16);
  neck.translate(headX, 0, 0);
  const bottom = headTop / MM - 18;
  const head = lathe([
    [86, bottom + 1.5], [86, bottom], [86, bottom], [97, bottom], [100, bottom + 3], [100, bottom + 9],
    [96, bottom + 15], [60, headTop / MM], [0, headTop / MM],
  ], 48);
  head.translate(headX, 0, 0);
  const plate = new THREE.CircleGeometry(0.086, 48);
  plate.rotateX(Math.PI);
  plate.translate(headX, 0, bottom * MM + 0.0015);

  return {
    metal: merge([
      bar, wallUnion(-0.045, valveZ, 28), wallUnion(0.045, valveZ, 28), wallUnion(0, armZ - 0.3, 22),
      riser, elbow, arm, joint, neck, head,
    ]),
    insert: plate,
  };
}

const BUILDERS: Readonly<Record<TapModel, (envelope: TapEnvelope) => TapParts>> = {
  "grohe-euroeco-xl": euroecoXl,
  "bridgepoint-bp02": bridgepointBp02,
  "generic-mixer": genericMixer,
  "shower-system": showerSystem,
};

export function buildTapParts(model: TapModel, envelope: TapEnvelope): TapParts {
  return BUILDERS[model](envelope);
}

type Kit = {
  readonly finishes: Record<TapFinish, THREE.MeshStandardMaterial>;
  readonly insert: THREE.MeshStandardMaterial;
  readonly parts: Map<string, TapParts>;
};

/** One kit per scene build, keyed by its finishes, so identical taps share geometry and materials. */
const kits = new WeakMap<ArchitecturalMaterials, Kit>();

function kitFor(finishes: ArchitecturalMaterials, track: Track): Kit {
  let kit = kits.get(finishes);
  if (kit === undefined) {
    kit = {
      finishes: {
        // The scene's environment is a faint sheen, so a fully metallic finish has nothing to
        // mirror and renders black; part of the lit response stays diffuse instead.
        chrome: track(new THREE.MeshStandardMaterial({ color: 0xe4e7ea, metalness: 0.3, roughness: 0.14 })),
        // PVD gun metal is a satin dark warm grey, between brushed steel and black.
        gunmetal: track(new THREE.MeshStandardMaterial({ color: 0x77716b, metalness: 0.3, roughness: 0.3 })),
      },
      insert: track(new THREE.MeshStandardMaterial({ color: 0x343638, metalness: 0, roughness: 0.75 })),
      parts: new Map(),
    };
    kits.set(finishes, kit);
  }
  return kit;
}

export type TapSpec = {
  readonly model: TapModel;
  readonly envelope: TapEnvelope;
  readonly finish: TapFinish;
  readonly name: string;
  readonly position: THREE.Vector3;
  readonly rotation: number;
};

/** Add a tap's metal and insert meshes to `content`, turned anticlockwise by `rotation` about its body axis. */
export function addTap(finishes: ArchitecturalMaterials, track: Track, content: THREE.Object3D, spec: TapSpec): THREE.Mesh[] {
  const kit = kitFor(finishes, track);
  const { bodyRadius, reach, height } = spec.envelope;
  const key = `${spec.model}:${[bodyRadius, reach, height].map((value) => Math.round(value / MM * 10)).join(",")}`;
  let parts = kit.parts.get(key);
  if (parts === undefined) {
    const built = buildTapParts(spec.model, spec.envelope);
    parts = { metal: track(built.metal), insert: track(built.insert) };
    kit.parts.set(key, parts);
  }
  const metal = new THREE.Mesh(parts.metal, kit.finishes[spec.finish]);
  metal.name = spec.name;
  metal.castShadow = true;
  metal.receiveShadow = true;
  const insert = new THREE.Mesh(parts.insert, kit.insert);
  insert.name = `${spec.name} outlet`;
  for (const mesh of [metal, insert]) {
    mesh.position.copy(spec.position);
    mesh.rotation.z = spec.rotation;
    content.add(mesh);
  }
  return [metal, insert];
}

export type TapPlacement = { readonly position: THREE.Vector3; readonly envelope: TapEnvelope };

/**
 * The body axis and envelope of an authored tap: a disc of the body radius with
 * the spout reaching forward along the turned local -Y. The plan outline gives
 * them at any rotation; a box is only exact square to the axes.
 */
export function tapPlacement(object: BuildingObject, rotation: number): TapPlacement {
  const min = object.bounds.minimum;
  const max = object.bounds.maximum;
  const cx = (min.x + max.x) / 2;
  const cy = (min.y + max.y) / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const outline = object.plan_footprint?.outer ?? [];
  const local = outline.length >= 3
    ? outline.map((p) => ({ x: (p.x - cx) * cos + (p.y - cy) * sin, y: -(p.x - cx) * sin + (p.y - cy) * cos }))
    : (() => {
        const width = max.x - min.x;
        const depth = max.y - min.y;
        const across = Math.min(width, depth) / 2;
        const along = Math.max(width, depth) / 2;
        return [{ x: -across, y: -along }, { x: across, y: along }];
      })();
  const xs = local.map((p) => p.x);
  const ys = local.map((p) => p.y);
  const radius = (Math.max(...xs) - Math.min(...xs)) / 2;
  const axisX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const axisY = Math.max(...ys) - radius;
  const reach = axisY - Math.min(...ys);
  const position = new THREE.Vector3(
    (cx + axisX * cos - axisY * sin) * MM,
    (cy + axisX * sin + axisY * cos) * MM,
    min.z * MM,
  );
  return { position, envelope: { bodyRadius: radius * MM, reach: reach * MM, height: (max.z - min.z) * MM } };
}
