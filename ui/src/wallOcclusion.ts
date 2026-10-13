import * as THREE from "three";

/** Ignore a hit this close to either end, so a wall never occludes itself. */
const EPSILON_M = 0.02;

/**
 * How far around the aimed-at point to probe, in metres.
 *
 * A single centre ray clears the wall crossing the middle of the view and
 * leaves the rest of that same wall standing, which flickers as the view
 * turns. Probing a ring takes the whole wall with it.
 */
const DEFAULT_SPREAD_M = 0.6;

/**
 * Stop fading once the sightline tilts more than this from the horizontal.
 *
 * A near-plan view already looks over the wall heads, and the ceiling and
 * gypsum toggles are the controls for seeing in from above. Fading there
 * dissolves walls the viewer was reading as walls.
 */
const STEEPEST_FADED_SIGHTLINE_SIN = Math.sin(THREE.MathUtils.degToRad(60));

/** The parts of a 3D view the fading reads and writes. */
export type WallOcclusionView = {
  readonly camera: THREE.Camera;
  readonly controls: { readonly target: THREE.Vector3 };
  /** The wall solids, in the order they were built. */
  readonly walls: readonly THREE.Mesh[];
  readonly seeThrough: THREE.Material;
  /** Camera and target at the last verdict, so a still view costs nothing. */
  readonly veiledSince: { readonly from: THREE.Vector3; readonly to: THREE.Vector3 };
  readonly seeThroughEnabled: boolean;
  /**
   * Points on the floor the view is for, such as a room's corners and middle.
   * Each one's first wall gives way too, so a small room seen over two near
   * walls opens fully instead of through the one wall on the centre ray.
   */
  readonly floorProbes?: readonly THREE.Vector3[];
};

/**
 * The nearest wall interrupting the view, along the centre of the sightline
 * and around it.
 *
 * Only the first wall on each probe gives way. Fading everything in line
 * flattens the whole depth of the home into one pane, when what the viewer
 * asked to see past is the wall in front of them. Two can still come back
 * together, because near a corner each probe meets a different one first.
 *
 * A wall behind the target, and the wall the viewer is deliberately facing,
 * stay solid: the test is what interrupts the view, not what is near it.
 */
export function wallsInTheWay(
  cameraPosition: THREE.Vector3,
  target: THREE.Vector3,
  walls: readonly THREE.Object3D[],
  spreadM: number = DEFAULT_SPREAD_M,
  floorProbes: readonly THREE.Vector3[] = [],
): THREE.Object3D[] {
  if (walls.length === 0) return [];
  const view = target.clone().sub(cameraPosition);
  const reach = view.length();
  if (reach <= EPSILON_M) return [];
  view.divideScalar(reach);
  if (Math.abs(view.z) >= STEEPEST_FADED_SIGHTLINE_SIN) return [];

  // A ring in the plane facing the camera. Near that limit the sightline is
  // close to the world up, so fall back to a world axis rather than crossing
  // two parallel vectors.
  const side = new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 0, 1));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  else side.normalize();
  const up = new THREE.Vector3().crossVectors(side, view).normalize();

  const probes = [
    target,
    target.clone().addScaledVector(side, spreadM),
    target.clone().addScaledVector(side, -spreadM),
    target.clone().addScaledVector(up, spreadM),
    target.clone().addScaledVector(up, -spreadM),
    ...floorProbes,
  ];
  const raycaster = new THREE.Raycaster();
  const found = new Set<THREE.Object3D>();
  const targets = [...walls];
  for (const probe of probes) {
    const toProbe = probe.clone().sub(cameraPosition);
    const distance = toProbe.length();
    if (distance <= EPSILON_M * 2) continue;
    raycaster.set(cameraPosition, toProbe.divideScalar(distance));
    raycaster.near = EPSILON_M;
    raycaster.far = distance - EPSILON_M;
    const nearest = raycaster.intersectObjects(targets, false)[0];
    if (nearest !== undefined) found.add(nearest.object);
  }
  return [...found];
}

/**
 * A faint stand-in for a wall the viewer is looking through.
 *
 * Removing the wall outright would lose which rooms the view is crossing, so
 * it stays as a pane. It writes no depth, because a wall that hides what is
 * behind it is the whole problem.
 */
export function createSeeThroughWallMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xdbe2e6,
    transparent: true,
    opacity: 0.12,
    roughness: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Show each wall either solid or faint.
 *
 * A faint wall keeps casting its shadow. Veiling is for the camera, not the
 * lights: a wall that stopped blocking light let the room's spots pool on the
 * floor of the room next door.
 */
export function applyWallOcclusion(
  walls: readonly THREE.Mesh[],
  inTheWay: readonly THREE.Object3D[],
  faint: THREE.Material,
): void {
  const hidden = new Set(inTheWay);
  // A wall drawn in pieces, around a door, gives way as a whole: the lintel
  // and the leaf the probes missed still stood in front of the room.
  const groups = new Set(inTheWay.map((wall) => wall.userData.occlusionGroup).filter((key) => key !== undefined));
  for (const wall of walls) {
    const solid = wall.userData.solidMaterial as THREE.Material | undefined;
    if (solid === undefined) continue;
    const group = wall.userData.occlusionGroup;
    wall.material = hidden.has(wall) || (group !== undefined && groups.has(group)) ? faint : solid;
  }
}

/**
 * Remember a wall's own material, so the faint one can be swapped back out.
 * Pieces sharing a `group`, such as one wall's solids and the door in it, fade together.
 */
export function trackWallForOcclusion(wall: THREE.Mesh, walls: THREE.Mesh[], group?: string): void {
  wall.userData.solidMaterial = wall.material;
  if (group !== undefined) wall.userData.occlusionGroup = group;
  walls.push(wall);
}

/**
 * Forget the last verdict, so the next refresh recomputes.
 *
 * Needed whenever something other than the camera changes the answer: the
 * viewer turning the fading off, or a rebuild replacing every wall with a new
 * object.
 */
export function invalidateWallOcclusion(view: Pick<WallOcclusionView, "veiledSince">): void {
  view.veiledSince.from.set(Infinity, 0, 0);
}

/**
 * Refresh the see-through walls, doing nothing while the view is still.
 *
 * Recasting every frame of a static view is wasted work, and the answer
 * cannot change until the camera or the point it is aimed at moves.
 */
export function refreshWallOcclusion(view: WallOcclusionView): void {
  const { camera, walls, veiledSince } = view;
  const target = view.controls.target;
  if (walls.length === 0) return;
  if (
    veiledSince.from.distanceToSquared(camera.position) < 1e-8
    && veiledSince.to.distanceToSquared(target) < 1e-8
  ) {
    return;
  }
  veiledSince.from.copy(camera.position);
  veiledSince.to.copy(target);
  const inTheWay = view.seeThroughEnabled
    ? wallsInTheWay(camera.position, target, walls, DEFAULT_SPREAD_M, view.floorProbes)
    : [];
  applyWallOcclusion(walls, inTheWay, view.seeThrough);
}

/** How far a floor probe sits in from its corner, so it lands on the floor rather than the wall foot. */
const FLOOR_PROBE_INSET_M = 0.25;
const FLOOR_PROBE_LIFT_M = 0.05;

/**
 * The corners of a floor outline drawn in towards its middle, and the middle
 * itself, just above the floor: the points a view of the room has to reach.
 */
export function floorProbePoints(
  outline: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  floorZ: number,
): THREE.Vector3[] {
  if (outline.length === 0) return [];
  const middle = {
    x: outline.reduce((sum, point) => sum + point.x, 0) / outline.length,
    y: outline.reduce((sum, point) => sum + point.y, 0) / outline.length,
  };
  const z = floorZ + FLOOR_PROBE_LIFT_M;
  const corners = outline.map((point) => {
    const dx = middle.x - point.x;
    const dy = middle.y - point.y;
    const length = Math.hypot(dx, dy) || 1;
    const inset = Math.min(FLOOR_PROBE_INSET_M, length / 2);
    return new THREE.Vector3(point.x + (dx / length) * inset, point.y + (dy / length) * inset, z);
  });
  return [...corners, new THREE.Vector3(middle.x, middle.y, z)];
}
