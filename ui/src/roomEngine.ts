/**
 * The live state of one room view: the renderer, its scene and camera, and
 * the indexes a selection, a dimming preview or an inspection updates in place
 * without rebuilding the room.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";

import { configureOrbit } from "./cameraControls";
import { outputFraction, type DimLevels } from "./dimming";
import type { DoorMotion } from "./doorAnimation";
import type { InspectTarget } from "./inspection";
import { DEFAULT_REFERENCE_LUX, createComposer, createEnvironment, exposureForReferenceLux } from "./render";
import { createRenderScheduler, type RenderScheduler } from "./renderScheduler";
import type { FixtureTag } from "./types";
import { multisampleComposer, renderWithOverlay } from "./useViewerTools";
import { createSeeThroughWallMaterial } from "./wallOcclusion";

/** Share of the indirect term spent on environment reflections, for sheen only. */
export const ENVIRONMENT_SHEEN = 0.06;

/** A light or glowing surface whose display output follows a group's preview level. */
export type DimTarget = {
  readonly group: string;
  readonly dimmable: boolean;
  readonly apply: (fraction: number) => void;
};

export type Scene = {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly content: THREE.Group;
  readonly composer: EffectComposer;
  /** Drag feedback, kept out of `content` because a rebuild clears that. */
  readonly overlay: THREE.Group;
  readonly pickable: THREE.Object3D[];
  /** The wall solids, so the ones interrupting the view can become panes. */
  readonly walls: THREE.Mesh[];
  readonly seeThrough: THREE.MeshStandardMaterial;
  /** Where the last see-through test ran, so a still view costs nothing. */
  readonly veiledSince: { readonly from: THREE.Vector3; readonly to: THREE.Vector3 };
  seeThroughEnabled: boolean;
  /** The room's floor corners and middle, which the see-through fading keeps in view. */
  readonly floorProbes: THREE.Vector3[];
  /** Everything belonging to one spotlight, so a drag can shift it as a unit. */
  readonly fixtureGroups: Map<FixtureTag, THREE.Group>;
  readonly doorMotions: Map<string, DoorMotion>;
  readonly scheduler: RenderScheduler;
  /** The meshes a selection recolours, with the material each wears unselected. */
  readonly selectables: Map<string, Array<{ readonly mesh: THREE.Mesh; readonly normal: THREE.Material }>>;
  /** Beam volumes, drawn for the selected lights only. */
  readonly cones: Map<string, THREE.Object3D>;
  selectedMaterial: THREE.Material | null;
  readonly dimTargets: DimTarget[];
  /** Every mesh drawn for an inspectable element, keyed by kind and id. */
  readonly inspectIndex: Map<string, THREE.Object3D[]>;
  readonly hoverHelper: THREE.Box3Helper;
  readonly inspectHelper: THREE.Box3Helper;
  readonly render: () => void;
  /** The standing indirect term, and the least of it a dark room keeps. */
  ambient: {
    readonly sky: THREE.HemisphereLight;
    readonly fill: THREE.DirectionalLight;
    readonly indirect: number;
    readonly floor: number;
  } | null;
};

export const inspectKey = (target: InspectTarget) => `${target.kind}:${target.id}`;

/** Recolour the selected lights and show their beams, without a rebuild. */
export function applySelection(current: Scene, tags: ReadonlySet<string>) {
  for (const [tag, entries] of current.selectables) {
    const selected = tags.has(tag);
    for (const entry of entries) {
      entry.mesh.material = selected && current.selectedMaterial !== null ? current.selectedMaterial : entry.normal;
    }
  }
  for (const [tag, cone] of current.cones) cone.visible = tags.has(tag);
  current.scheduler.invalidate();
}

/**
 * Scale the bounce by the share of output that is on. Interreflection is
 * proportional to the flux put into the room, so a room with its lights off
 * goes dark instead of keeping the glow of a fully lit one.
 */
export function applyAmbient(current: Scene, share: number) {
  const ambient = current.ambient;
  if (ambient === null) return;
  const scale = Math.max(share, ambient.floor);
  ambient.sky.intensity = ambient.indirect * scale;
  ambient.fill.intensity = ambient.indirect * scale;
  current.scene.environmentIntensity = ambient.indirect * ENVIRONMENT_SHEEN * scale;
  current.scheduler.invalidate();
}

export function applyDimming(current: Scene, levels: DimLevels) {
  for (const target of current.dimTargets) target.apply(outputFraction(levels, target.group, target.dimmable));
  current.scheduler.invalidate();
}

/** Box an inspectable element, or hide the box. */
export function outlineTarget(current: Scene, helper: THREE.Box3Helper, target: InspectTarget | null) {
  const meshes = target === null ? undefined : current.inspectIndex.get(inspectKey(target));
  helper.visible = meshes !== undefined && meshes.length > 0;
  if (meshes !== undefined) {
    helper.box.makeEmpty();
    for (const mesh of meshes) helper.box.expandByObject(mesh);
    helper.box.expandByScalar(0.01);
  }
  current.scheduler.invalidate();
}

/** Set up a renderer for one room view; `dispose` frees everything this made. */
export function createRoomEngine(
  element: HTMLElement,
  renderer: THREE.WebGLRenderer,
): { readonly engine: Scene; readonly dispose: () => void } {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposureForReferenceLux(DEFAULT_REFERENCE_LUX);
  // RectAreaLight needs its lookup textures before any cove is built.
  RectAreaLightUniformsLib.init();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  element.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const environment = createEnvironment(renderer);
  scene.environment = environment;
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  configureOrbit(controls, { minDistanceM: 0.6, maxDistanceM: 80 });
  const seeThrough = createSeeThroughWallMaterial();
  const content = new THREE.Group();
  const overlay = new THREE.Group();
  scene.add(content);
  const overlayScene = new THREE.Scene();
  overlayScene.add(overlay);
  const composer = createComposer(renderer, scene, camera);
  multisampleComposer(composer);
  const scheduler = createRenderScheduler();
  const outline = (colour: number, opacity: number) => {
    const helper = new THREE.Box3Helper(new THREE.Box3(), colour);
    const material = helper.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = opacity;
    material.toneMapped = false;
    helper.renderOrder = 10;
    helper.visible = false;
    overlay.add(helper);
    return helper;
  };
  const hoverHelper = outline(0x275dad, 0.55);
  const inspectHelper = outline(0xff5a36, 0.95);
  const engine: Scene = {
    renderer,
    scene,
    camera,
    controls,
    content,
    composer,
    overlay,
    pickable: [],
    walls: [],
    seeThrough,
    veiledSince: { from: new THREE.Vector3(Infinity, 0, 0), to: new THREE.Vector3(Infinity, 0, 0) },
    seeThroughEnabled: true,
    floorProbes: [],
    fixtureGroups: new Map(),
    doorMotions: new Map(),
    scheduler,
    selectables: new Map(),
    cones: new Map(),
    selectedMaterial: null,
    dimTargets: [],
    inspectIndex: new Map(),
    hoverHelper,
    inspectHelper,
    render: () => renderWithOverlay(renderer, composer, overlayScene, camera),
    ambient: null,
  };

  const dispose = () => {
    for (const helper of [hoverHelper, inspectHelper]) {
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    seeThrough.dispose();
    controls.dispose();
    composer.dispose();
    environment.dispose();
    renderer.dispose();
    element.removeChild(renderer.domElement);
  };
  return { engine, dispose };
}
