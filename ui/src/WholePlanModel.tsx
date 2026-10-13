/**
 * The whole floor in 3D, built from the same room geometry as the plan.
 *
 * Deliberately simpler than the single-room view: shells, openings, stairs and
 * fixture marks, with no beam volumes or baked surface. Its job is to show the
 * home as a whole, and a floor's worth of shadow-casting spotlights would be
 * both slow and unreadable.
 */

import { Footprints, Focus, MousePointerClick } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";

import { createArchitecturalMaterials, finishMesh, slabGeometry } from "./architecturalMaterials";
import { renderDetailedBuildingObject } from "./cabinetryRendering";
import { configureOrbit, focusOrbitOnPointer } from "./cameraControls";
import { extrudedOutlines, floorOverviewFrame, roomOverviewFrame } from "./cameraFraming";
import { openestDirection, planViewFrame, type CameraFrame } from "./cameraPresets";
import { DIMMING_METHOD, electricOutputShare, outputFraction, type DimLevels } from "./dimming";
import { createRenderScheduler, type RenderScheduler } from "./renderScheduler";
import { applyCameraFrame, multisampleComposer, renderWithOverlay, useViewerTools } from "./useViewerTools";
import { readCameraFrame, writeCameraFrame } from "./viewerUrl";
import {
  MeasureReadout,
  SectionPanel,
  ShortcutHelp,
  ViewerHint,
  ViewerRail,
  ViewerStatus,
} from "./ViewerTools";
import {
  addPendant,
  addRope,
  addSpotlight,
  addSwitch,
  createFixtureMaterials,
  hiddenInCeilingVoid,
} from "./fixtureRendering";
import "./viewer.css";
import { WALK_EYE_HEIGHT_M, walkStep } from "./walkPhysics";
import { floorMaterialFor } from "./finishMaterials";
import {
  applyWallOcclusion,
  createSeeThroughWallMaterial,
  invalidateWallOcclusion,
  refreshWallOcclusion,
  trackWallForOcclusion,
} from "./wallOcclusion";
import {
  fasciaEdges,
  insetRingAtReveals,
  isCeilingReveal,
  renderBulkheadFascia,
  renderCeilingReveal,
  revealRuns,
} from "./ceilingGypsum";
import {
  DEFAULT_REFERENCE_LUX,
  beamCandela,
  createComposer,
  createEnvironment,
  exposureForReferenceLux,
  fieldHalfAngle,
} from "./render";
import { advanceDoorMotions, type DoorMotion } from "./doorAnimation";
import { doorSwingSign } from "./doorSwing";
import { deepestInteriorPoint, extentOf } from "./plan";
import { unifyStairwellHoles } from "./roomFloorGeometry";
import { buildStairFlightParts } from "./stairGeometry";
import { switchPoint } from "./switchGeometry";
import type { PlanRoomGeometry, RoomId, WholePlan } from "./types";
import { wallSolidRectangles } from "./wallGeometry";

const MM = 0.001;
const DISPLAY_WALL_THICKNESS_M = 0.12;
/** Share of the daylight term spent on environment reflections, for sheen only. */
const ENVIRONMENT_SHEEN = 0.06;
const MAX_WHOLE_PLAN_REAL_LIGHTS = 64;

type WholePlanModelProps = {
  readonly plan: WholePlan;
  readonly selectedRoomId: RoomId | null;
  readonly onSelectRoom: (roomId: RoomId) => void;
  readonly showCeiling: boolean;
  readonly showGypsum: boolean;
  readonly seeThroughWalls: boolean;
  readonly offGroups: ReadonlySet<string>;
  readonly onToggleGroup: (group: string) => void;
  readonly hour: number;
  /** Preview output per switching group; display only. */
  readonly dimLevels?: DimLevels;
  readonly onToggleSeeThrough?: () => void;
};

const NO_DIMMING: DimLevels = new Map();

export function visualDaylight(hour: number): {
  daylight: number;
  sunAltitude: number;
  sunBearing: number;
  sunStrength: number;
} {
  const wrapped = ((hour % 24) + 24) % 24;
  const solar = Math.sin(((wrapped - 6) / 12) * Math.PI);
  return {
    daylight: Math.max(0.035, solar),
    sunAltitude: Math.max(0, solar) * (Math.PI / 2.35),
    sunBearing: ((wrapped - 6) / 24) * Math.PI * 2,
    sunStrength: Math.max(0, solar),
  };
}

const NIGHT_BACKDROP = [0x1d2733, 0x0b1017] as const;
const DAY_BACKDROP = [0xf2f6f5, 0xcbd8d5] as const;

function mixHex(from: number, to: number, share: number): string {
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * share).toString(16).padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * The page behind the canvas for an hour of the visual day.
 *
 * It is a CSS backdrop, not `scene.background`: the scene is tone-mapped at
 * the lux exposure, which took a daytime sky colour down to near black.
 */
export function skyBackdrop(hour: number): string {
  const share = Math.min(1, visualDaylight(hour).daylight * 1.35);
  const [nightTop, nightBottom] = NIGHT_BACKDROP;
  const [dayTop, dayBottom] = DAY_BACKDROP;
  return `radial-gradient(circle at 50% 30%, ${mixHex(nightTop, dayTop, share)}, ${mixHex(nightBottom, dayBottom, share)})`;
}

/** A warm display tint for the authored CCT; this is not a photometry claim. */
function cctToLinearRgb(kelvin: number): readonly [number, number, number] {
  const warmth = Math.min(1, Math.max(0, (6500 - kelvin) / 4000));
  return [1, 1 - 0.16 * warmth, 1 - 0.42 * warmth];
}

function shapeFrom(
  ring: ReadonlyArray<{ x: number; y: number }>,
  holes: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> = [],
): THREE.Shape {
  const shape = new THREE.Shape();
  ring.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x * MM, point.y * MM);
    else shape.lineTo(point.x * MM, point.y * MM);
  });
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    hole.forEach((point, index) => {
      if (index === 0) path.moveTo(point.x * MM, point.y * MM);
      else path.lineTo(point.x * MM, point.y * MM);
    });
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

/**
 * The stairwells that open through a floor at this level.
 *
 * A flight arriving at a level starts below it, so a solid floor slab hides it
 * entirely: the entrance stair sat under the living-room floor.
 */
export function stairwellsThrough(
  plan: WholePlan,
  floorZ: number,
  room?: PlanRoomGeometry,
): Array<ReadonlyArray<{ x: number; y: number }>> {
  const seen = new Set<string>();
  const wells: Array<ReadonlyArray<{ x: number; y: number }>> = [];
  for (const entry of plan.rooms as PlanRoomGeometry[]) {
    for (const stair of entry.stairs) {
      if (seen.has(stair.id) || stair.base_elevation_mm >= floorZ - 10) continue;
      seen.add(stair.id);
      wells.push(stair.footprint.outer);
    }
    if (room && entry.room.part_of === room.room.id && entry.room.elevation_mm < floorZ) {
      wells.push(entry.ceiling.polygon.outer);
    }
  }
  return room ? [...unifyStairwellHoles(room.ceiling.polygon.outer, wells)] : wells;
}

/** A room's outline in metres, from its floor to its finished ceiling. */
function roomOutline(entry: WholePlan["rooms"][number]) {
  return {
    ring: entry.ceiling.polygon.outer.map((point) => ({ x: point.x * MM, y: point.y * MM })),
    fromZ: entry.room.elevation_mm * MM,
    toZ: entry.ceiling.elevation_mm * MM,
  };
}

export function WholePlanModel({
  plan,
  selectedRoomId,
  onSelectRoom,
  showCeiling,
  seeThroughWalls,
  showGypsum,
  offGroups,
  onToggleGroup,
  hour,
  dimLevels = NO_DIMMING,
  onToggleSeeThrough,
}: WholePlanModelProps) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    content: THREE.Group;
    /** Measurement marks, kept out of `content` because a rebuild clears that. */
    overlay: THREE.Group;
    composer: EffectComposer;
    scheduler: RenderScheduler;
    pickable: THREE.Object3D[];
    /** The wall solids, so the ones interrupting the view can become panes. */
    walls: THREE.Mesh[];
    /** Floors and treads, which walking stands on. */
    walkables: THREE.Object3D[];
    /** Each room's floor with the finish it wears unselected. */
    floors: Map<string, { readonly mesh: THREE.Mesh; readonly normal: THREE.Material }>;
    selectedFloor: THREE.Material | null;
    dimTargets: Array<{ readonly group: string; readonly dimmable: boolean; readonly apply: (fraction: number) => void }>;
    seeThrough: THREE.MeshStandardMaterial;
    /** Where the last see-through test ran, so a still view costs nothing. */
    veiledSince: { readonly from: THREE.Vector3; readonly to: THREE.Vector3 };
    seeThroughEnabled: boolean;
    sun: THREE.DirectionalLight;
    sunTarget: THREE.Object3D;
    sky: THREE.HemisphereLight;
    keys: Set<string>;
    walk: boolean;
    yaw: number;
    pitch: number;
    /** The eye height walking is settling towards, after a tread or a level change. */
    eyeZ: number;
    doorMotions: Map<string, DoorMotion>;
    /** Set once the viewer moves the camera, so a resize stops reframing it. */
    userMoved: boolean;
    render: () => void;
  } | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [walkMode, setWalkMode] = useState(false);
  const walkRef = useRef(walkMode);
  walkRef.current = walkMode;
  const select = useRef(onSelectRoom);
  select.current = onSelectRoom;
  const toggle = useRef(onToggleGroup);
  toggle.current = onToggleGroup;
  const dimRef = useRef(dimLevels);
  dimRef.current = dimLevels;
  const selectedRoomRef = useRef(selectedRoomId);
  selectedRoomRef.current = selectedRoomId;
  // The address bar's camera belongs to the extent it was opened on. Re-running
  // the framing for that same extent, as a remount does, must keep it.
  const urlCamera = useRef<{ readonly frame: CameraFrame; key: string | null } | null>(
    (() => {
      const frame = readCameraFrame();
      return frame === null ? null : { frame, key: null };
    })(),
  );
  const walked = useRef(false);

  const centre = useMemo(() => {
    const points = plan.rooms.flatMap((entry) => entry.ceiling.polygon.outer);
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    if (xs.length === 0) return { x: 0, y: 0, span: 10 };
    return {
      x: ((Math.min(...xs) + Math.max(...xs)) / 2) * MM,
      y: ((Math.min(...ys) + Math.max(...ys)) / 2) * MM,
      span: Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * MM,
    };
  }, [plan]);

  const viewBounds = useMemo(() => {
    const points = plan.rooms.flatMap((entry) => entry.ceiling.polygon.outer);
    const extent = extentOf(points);
    const floors = plan.rooms.map((entry) => entry.room.elevation_mm);
    const tops = plan.rooms.map((entry) => entry.ceiling.structural_elevation_mm ?? entry.ceiling.elevation_mm);
    return {
      minX: extent.minX * MM,
      maxX: extent.maxX * MM,
      minY: extent.minY * MM,
      maxY: extent.maxY * MM,
      minZ: (floors.length === 0 ? 0 : Math.min(...floors)) * MM,
      maxZ: (tops.length === 0 ? 3000 : Math.max(...tops)) * MM + 0.05,
    };
  }, [plan]);

  const overviewPoints = useMemo(() => extrudedOutlines(plan.rooms.map(roomOutline)), [plan]);

  const frameRef = useRef<(() => void) | null>(null);
  const outputShare = useMemo(
    () => electricOutputShare(plan.rooms.flatMap((entry) => entry.fixtures), offGroups, dimLevels),
    [plan, offGroups, dimLevels],
  );

  const tools = useViewerTools({
    engine,
    bounds: viewBounds,
    snapshotLabel: "whole floor",
    caption: () => [
      `Whole floor · Home Twin 3D view · ${new Date().toLocaleString("en-GB")}`,
      disclaimerText(),
    ],
    shortcutsEnabled: () => !walkRef.current,
    onAction: (action) => {
      switch (action) {
        case "reset":
          resetView();
          return true;
        case "plan":
          planView();
          return true;
        case "eye":
          setWalkMode((active) => !active);
          return true;
        case "seeThrough":
          if (onToggleSeeThrough === undefined) return false;
          onToggleSeeThrough();
          return true;
        default:
          return false;
      }
    },
  });
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      setUnsupported(error instanceof Error ? error.message : "WebGL is unavailable in this browser");
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = exposureForReferenceLux(DEFAULT_REFERENCE_LUX);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const environment = createEnvironment(renderer);
    scene.environment = environment;
    scene.environmentIntensity = DEFAULT_REFERENCE_LUX * ENVIRONMENT_SHEEN;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 600);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    configureOrbit(controls, { minDistanceM: 1, maxDistanceM: 250 });
    const seeThrough = createSeeThroughWallMaterial();
    const content = new THREE.Group();
    const overlay = new THREE.Group();
    scene.add(content);
    const overlayScene = new THREE.Scene();
    overlayScene.add(overlay);
    // The massing view uses the same authored fixture groups as the room view.
    // They are display lights, not a replacement for the room's photometric
    // analysis, but they must still illuminate the house at night.
    const sky = new THREE.HemisphereLight(0xe9eef2, 0x766f66, DEFAULT_REFERENCE_LUX * 0.5);
    // A hemisphere light takes its sky axis from its position, which defaults
    // to +Y. This frame is +Z up, so the default lit the home sideways.
    sky.position.set(0, 0, 1);
    scene.add(sky);
    const sun = new THREE.DirectionalLight(0xffefd8, DEFAULT_REFERENCE_LUX);
    const sunTarget = new THREE.Object3D();
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    scene.add(sunTarget);
    sun.target = sunTarget;
    const composer = createComposer(renderer, scene, camera);
    multisampleComposer(composer);
    const scheduler = createRenderScheduler();
    engine.current = {
      renderer,
      scene,
      camera,
      controls,
      content,
      overlay,
      composer,
      scheduler,
      pickable: [],
      walls: [],
      walkables: [],
      floors: new Map(),
      selectedFloor: null,
      dimTargets: [],
      seeThrough,
      veiledSince: { from: new THREE.Vector3(Infinity, 0, 0), to: new THREE.Vector3(Infinity, 0, 0) },
      seeThroughEnabled: true,
      sun,
      sunTarget,
      sky,
      keys: new Set(),
      walk: false,
      yaw: 0,
      pitch: 0,
      eyeZ: 0,
      doorMotions: new Map(),
      userMoved: urlCamera.current !== null,
      render: () => renderWithOverlay(renderer, composer, overlayScene, camera),
    };

    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
      scheduler.invalidate();
      // Fit the floor to the canvas it opened in, until the viewer takes over.
      if (engine.current?.userMoved === false) frameRef.current?.();
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(element);

    const walkRaycaster = new THREE.Raycaster();
    let running = true;
    let previousFrame = performance.now();
    const animate = () => {
      if (!running) return;
      const now = performance.now();
      const elapsed = Math.min(now - previousFrame, 50);
      previousFrame = now;
      const current = engine.current;
      if (current !== null && advanceDoorMotions(current.doorMotions.values(), elapsed)) scheduler.invalidate();
      if (current?.walk) {
        const direction = new THREE.Vector3();
        current.camera.getWorldDirection(direction);
        direction.z = 0;
        if (direction.lengthSq() > 0) direction.normalize();
        const right = direction.clone().cross(current.camera.up).normalize();
        const distance = elapsed * (current.keys.has("ShiftLeft") || current.keys.has("ShiftRight") ? 0.006 : 0.003);
        const move = new THREE.Vector3();
        if (current.keys.has("KeyW")) move.addScaledVector(direction, distance);
        if (current.keys.has("KeyS")) move.addScaledVector(direction, -distance);
        if (current.keys.has("KeyD")) move.addScaledVector(right, distance);
        if (current.keys.has("KeyA")) move.addScaledVector(right, -distance);
        if (move.lengthSq() > 0) {
          const next = walkStep(walkRaycaster, current.walkables, current.walls, current.camera.position, move);
          current.camera.position.x = next.x;
          current.camera.position.y = next.y;
          current.eyeZ = next.z;
        }
        // Ease onto a tread rather than snapping a riser at a time.
        const rise = current.eyeZ - current.camera.position.z;
        if (Math.abs(rise) > 0.0005) current.camera.position.z += rise * Math.min(1, elapsed / 90);
      } else {
        controls.update();
      }
      if (current !== null && scheduler.consume(camera)) {
        if (!current.walk) refreshWallOcclusion(current);
        current.render();
      }
      requestAnimationFrame(animate);
    };
    animate();

    let cameraWrite = 0;
    const persistCamera = () => {
      if (engine.current?.walk) return;
      window.clearTimeout(cameraWrite);
      cameraWrite = window.setTimeout(() => {
        writeCameraFrame({
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        });
      }, 400);
    };
    const onControlStart = () => {
      if (engine.current !== null) engine.current.userMoved = true;
    };
    controls.addEventListener("change", persistCamera);
    controls.addEventListener("start", onControlStart);

    const pick = (event: PointerEvent) => {
      const current = engine.current;
      if (current === null) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        current.camera,
      );
      const hit = raycaster.intersectObjects(current.pickable, false)[0];
      const controlGroup = hit?.object.userData.controlGroup;
      if (typeof controlGroup === "string") {
        toggle.current(controlGroup);
        return;
      }
      const doorId = hit?.object.userData.doorId;
      if (typeof doorId === "string") {
        const door = current.doorMotions.get(doorId);
        if (door !== undefined) door.target = door.target > 0.5 ? 0 : 1;
        return;
      }
      const roomId = hit?.object.userData.roomId;
      if (typeof roomId === "string") select.current(roomId as RoomId);
    };
    // Measuring owns a still click; a drag still orbits.
    let press: { pointerId: number; x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (toolsRef.current.measuring && !engine.current?.walk) {
        if (event.button === 0) press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        return;
      }
      pick(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      const pressed = press;
      if (pressed === null || pressed.pointerId !== event.pointerId) return;
      press = null;
      if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) <= 4) {
        toolsRef.current.measureClick(event.clientX, event.clientY, event.shiftKey);
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const onKey = (event: KeyboardEvent) => {
      const current = engine.current;
      if (current === null || !current.walk) return;
      if (event.type === "keydown") current.keys.add(event.code);
      else current.keys.delete(event.code);
    };
    const onCanvasClick = () => {
      if (engine.current?.walk) void renderer.domElement.requestPointerLock();
    };
    const onMouseMove = (event: MouseEvent) => {
      const current = engine.current;
      if (current === null || !current.walk || document.pointerLockElement !== renderer.domElement) return;
      current.yaw -= event.movementX * 0.002;
      current.pitch = Math.max(-1.35, Math.min(1.35, current.pitch - event.movementY * 0.002));
      const look = new THREE.Vector3(
        Math.cos(current.pitch) * Math.cos(current.yaw),
        Math.cos(current.pitch) * Math.sin(current.yaw),
        Math.sin(current.pitch),
      );
      current.camera.lookAt(current.camera.position.clone().add(look));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    document.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("click", onCanvasClick);

    // Double-click to say "look at that", which is the gesture the wall
    // fading is for: pick the thing, and whatever stands in front gives way.
    const onDoubleClick = (event: MouseEvent) => {
      const current = engine.current;
      if (current === null || current.walk) return;
      const rect = renderer.domElement.getBoundingClientRect();
      focusOrbitOnPointer(
        current.camera,
        current.controls,
        current.content,
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        toolsRef.current.kept,
      );
    };
    renderer.domElement.addEventListener("dblclick", onDoubleClick);

    return () => {
      running = false;
      window.clearTimeout(cameraWrite);
      controls.removeEventListener("change", persistCamera);
      controls.removeEventListener("start", onControlStart);
      observer?.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      document.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("click", onCanvasClick);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
      seeThrough.dispose();
      sun.dispose();
      controls.dispose();
      composer.dispose();
      environment.dispose();
      renderer.dispose();
      element.removeChild(renderer.domElement);
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    current.seeThroughEnabled = seeThroughWalls;
    invalidateWallOcclusion(current);
    refreshWallOcclusion(current);
    current.scheduler.invalidate();
  }, [seeThroughWalls]);

  // Fit the floor to whichever field of view is narrower, so the home fills the
  // canvas instead of sitting in the middle of it.
  const frame = useCallback(() => {
    const current = engine.current;
    if (current === null) return;
    applyCameraFrame(current, floorOverviewFrame(overviewPoints, current.camera.fov, current.camera.aspect));
  }, [overviewPoints]);
  frameRef.current = frame;

  function resetView() {
    const current = engine.current;
    if (current === null || current.walk) return;
    current.userMoved = false;
    frame();
  }

  function planView() {
    const current = engine.current;
    if (current === null || current.walk) return;
    current.userMoved = true;
    applyCameraFrame(current, planViewFrame(viewBounds, viewBounds.minZ, viewBounds.maxZ, current.camera.fov, current.camera.aspect));
  }

  const selectedRoom = plan.rooms.find((entry) => entry.room.id === selectedRoomId) ?? null;
  function frameSelectedRoom() {
    const current = engine.current;
    if (current === null || current.walk || selectedRoom === null) return;
    current.userMoved = true;
    applyCameraFrame(
      current,
      roomOverviewFrame(extrudedOutlines([roomOutline(selectedRoom)]), current.camera.fov, current.camera.aspect),
    );
  }

  // Frame the floor when its extent is first known or actually changes, not
  // when an unchanged plan arrives as new objects.
  const frameKey = [viewBounds.minX, viewBounds.maxX, viewBounds.minY, viewBounds.maxY]
    .map((value) => value.toFixed(3))
    .join(":");
  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    const saved = urlCamera.current;
    if (saved !== null && (saved.key === null || saved.key === frameKey)) {
      saved.key = frameKey;
      current.userMoved = true;
      applyCameraFrame(current, saved.frame);
      return;
    }
    urlCamera.current = null;
    current.userMoved = false;
    frameRef.current?.();
  }, [frameKey]);

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    const light = visualDaylight(hour);
    const radius = Math.max(centre.span, 18);
    current.sun.position.set(
      centre.x + Math.cos(light.sunBearing) * radius,
      centre.y + Math.sin(light.sunBearing) * radius,
      Math.max(2, Math.sin(light.sunAltitude) * radius),
    );
    current.sunTarget.position.set(centre.x, centre.y, 0.8);
    current.sun.intensity = DEFAULT_REFERENCE_LUX * light.sunStrength;
    current.sun.castShadow = light.sunStrength > 0.001;
    // The night floor of the sky term was the lights' bounce standing in for
    // itself, so switching everything off left the home glowing. It now scales
    // with the output that is on, and daylight carries the rest.
    current.sky.intensity = DEFAULT_REFERENCE_LUX * (0.01 + light.daylight * 0.42 + outputShare * 0.07);
    current.scene.environmentIntensity =
      DEFAULT_REFERENCE_LUX * ENVIRONMENT_SHEEN * (0.05 + light.daylight * 0.85 + outputShare * 0.1);
    const reach = Math.max(centre.span * 0.65, 8);
    current.sun.shadow.camera.left = -reach;
    current.sun.shadow.camera.right = reach;
    current.sun.shadow.camera.top = reach;
    current.sun.shadow.camera.bottom = -reach;
    current.sun.shadow.camera.near = 1;
    current.sun.shadow.camera.far = 100;
    current.sun.shadow.camera.updateProjectionMatrix();
    current.scheduler.invalidate();
  }, [centre, hour, outputShare]);

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    current.walk = walkMode;
    current.controls.enabled = !walkMode;
    current.keys.clear();
    if (walkMode) {
      if (toolsRef.current.measuring) toolsRef.current.toggleMeasuring();
      // Standing inside, the wall being faced is the view, so every wall goes
      // back to solid rather than keeping whatever the last orbit faded.
      applyWallOcclusion(current.walls, [], current.seeThrough);
      // Start in the highlighted room, or the largest one, rather than at the
      // middle of the plan's bounding box, which can be inside a wall.
      const start = selectedRoomRef.current === null
        ? null
        : plan.rooms.find((entry) => entry.room.id === selectedRoomRef.current) ?? null;
      const room = start ?? [...plan.rooms]
        .filter((entry) => !entry.room.is_external)
        .sort((a, b) => {
          const area = (entry: typeof a) => {
            const extent = extentOf(entry.ceiling.polygon.outer);
            return extent.width * extent.height;
          };
          return area(b) - area(a);
        })[0];
      const standing = room === undefined
        ? { x: centre.x / MM, y: centre.y / MM }
        : deepestInteriorPoint(room.ceiling.polygon.outer);
      const floorM = (room?.room.elevation_mm ?? Math.min(...plan.rooms.map((entry) => entry.room.elevation_mm))) * MM;
      const facing = room === undefined ? { x: 0, y: 1 } : openestDirection(standing, room.ceiling.polygon.outer);
      current.eyeZ = floorM + WALK_EYE_HEIGHT_M;
      current.camera.position.set(standing.x * MM, standing.y * MM, current.eyeZ);
      current.yaw = Math.atan2(facing.y, facing.x);
      current.pitch = 0;
      current.camera.lookAt(standing.x * MM + facing.x, standing.y * MM + facing.y, current.eyeZ);
    } else if (walked.current) {
      // Only leaving a walk reframes; on mount the framing above has already
      // chosen, and reframing here overwrote a camera from the address bar.
      if (document.pointerLockElement === current.renderer.domElement) document.exitPointerLock();
      frame();
    }
    walked.current = walkMode;
    current.scheduler.invalidate();
  }, [walkMode, centre, frame, plan.rooms]);

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    for (const [roomId, floor] of current.floors) {
      floor.mesh.material = roomId === selectedRoomId && current.selectedFloor !== null ? current.selectedFloor : floor.normal;
    }
    current.scheduler.invalidate();
  }, [selectedRoomId]);

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    for (const target of current.dimTargets) target.apply(outputFraction(dimLevels, target.group, target.dimmable));
    current.scheduler.invalidate();
  }, [dimLevels]);

  function disclaimerText(): string {
    const dimmed = dimLevels.size > 0 ? ` ${DIMMING_METHOD}` : "";
    return (
      "Whole-floor massing view: display lights by switch group, no beam volumes or shadow pass. Daylight here is a " +
      `visual time-of-day model, not the site's solar geometry. Finishes are illustrative display materials.${dimmed}`
    );
  }

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    const disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light> = [];
    const track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T): T => {
      disposables.push(value);
      return value;
    };
    const pickable: THREE.Object3D[] = [];
    const wallMeshes: THREE.Mesh[] = [];
    const walkables: THREE.Object3D[] = [];
    current.content.clear();
    current.doorMotions.clear();
    current.floors.clear();
    current.dimTargets.length = 0;

    const finishes = createArchitecturalMaterials();
    disposables.push(...finishes.resources);
    current.selectedFloor = finishes.selectedFloor;
    const dimLight = (
      fixture: PlanRoomGeometry["fixtures"][number],
      light: THREE.Light,
    ) => {
      const base = light.intensity;
      current.dimTargets.push({
        group: fixture.switching_group,
        dimmable: fixture.spec.dimmable,
        apply: (fraction) => {
          light.intensity = base * fraction;
        },
      });
    };
    const fixtureMaterial = track(new THREE.MeshStandardMaterial({ color: 0xffb44d, emissive: 0x7a3d08 }));
    const fixtureOffMaterial = track(new THREE.MeshStandardMaterial({ color: 0x4f5558, roughness: 0.8 }));
    const switchMaterial = track(new THREE.MeshStandardMaterial({ color: 0xf3eee4, roughness: 0.35 }));
    const fixtureMaterials = createFixtureMaterials(track, current.renderer.toneMappingExposure);
    const dimGlow = (fixture: PlanRoomGeometry["fixtures"][number], material: THREE.MeshStandardMaterial) => {
      const base = material.emissiveIntensity;
      current.dimTargets.push({
        group: fixture.switching_group,
        dimmable: fixture.spec.dimmable,
        apply: (fraction) => {
          material.emissiveIntensity = base * fraction;
        },
      });
    };
    // One lamp face per group, so a dimmed group's apertures dim with it.
    const lampMaterials = new Map<string, THREE.MeshBasicMaterial>();
    const lampMaterialFor = (fixture: PlanRoomGeometry["fixtures"][number]) => {
      const key = `${fixture.switching_group}\u0000${fixture.spec.dimmable}`;
      const existing = lampMaterials.get(key);
      if (existing !== undefined) return existing;
      const lamp = track(new THREE.MeshBasicMaterial({ color: 0xfff2cf, toneMapped: false }));
      const base = lamp.color.clone();
      current.dimTargets.push({
        group: fixture.switching_group,
        dimmable: fixture.spec.dimmable,
        apply: (fraction) => {
          lamp.color.copy(base).multiplyScalar(0.15 + 0.85 * fraction);
        },
      });
      lampMaterials.set(key, lamp);
      return lamp;
    };
    const switchOffMaterial = track(new THREE.MeshStandardMaterial({ color: 0x5c6265, roughness: 0.75 }));
    let realLightCount = 0;

    const addBox = (
      lengthM: number,
      heightM: number,
      x: number,
      y: number,
      z: number,
      angle: number,
      material: THREE.Material,
      thicknessM = DISPLAY_WALL_THICKNESS_M,
    ) => {
      const mesh = finishMesh(
        new THREE.Mesh(track(new THREE.BoxGeometry(lengthM, thicknessM, heightM)), material),
        material !== finishes.glass,
      );
      mesh.rotation.z = angle;
      mesh.position.set(x, y, z);
      current.content.add(mesh);
      return mesh;
    };


    // One physical wall, drawn once. A wall traced from both sides appears in
    // both rooms' faces with the same id, and drawing each face put two walls
    // where the home has one.
    const wallFaces = new Map<string, { walls: (typeof plan.rooms)[number]["walls"]; entries: PlanRoomGeometry[] }>();
    for (const entry of plan.rooms as PlanRoomGeometry[]) {
      if (entry.room.is_external) continue;
      for (const wall of entry.walls) {
        const seen = wallFaces.get(wall.wall_id);
        if (seen === undefined) wallFaces.set(wall.wall_id, { walls: [wall], entries: [entry] });
        else {
          seen.walls.push(wall);
          seen.entries.push(entry);
        }
      }
    }

    for (const { walls: faces, entries } of wallFaces.values()) {
      const wall = faces[0];
      if (wall === undefined) continue;
      // A wall beside the entrance stair runs below the floor of every room it
      // faces, so its own extent wins where the model carries one.
      const floorZ = wall.base_elevation_mm
        ?? Math.min(...entries.map((entry) => entry.room.elevation_mm));
      // To the slab rather than the gypsum, so a perimeter reveal has a wall
      // and a soffit behind it instead of opening onto nothing.
      const topZ = wall.top_elevation_mm
        ?? Math.max(
          ...entries.map((entry) => entry.ceiling.structural_elevation_mm ?? entry.ceiling.elevation_mm),
        );
      const heightM = Math.max(topZ - floorZ, 100) * MM;
      const thicknessM = Math.max(wall.thickness_mm * MM, 0.04);
      const sx = wall.start.x * MM;
      const sy = wall.start.y * MM;
      const ex = wall.end.x * MM;
      const ey = wall.end.y * MM;
      const lengthM = Math.hypot(ex - sx, ey - sy);
      if (lengthM < 0.05) continue;
      const angle = Math.atan2(ey - sy, ex - sx);
      const dirX = (ex - sx) / lengthM;
      const dirY = (ey - sy) / lengthM;
      // Every room resolves its own face of a shared wall from its own
      // outline, so one room's face can stop short of the joint while the
      // other's runs past it. The drawn box spans the union of all faces --
      // one honest wall, drawn whole -- capped so a stray face cannot run away.
      let spanFromM = 0;
      let spanToM = lengthM;
      for (const face of faces) {
        const a = (face.start.x * MM - sx) * dirX + (face.start.y * MM - sy) * dirY;
        const b = (face.end.x * MM - sx) * dirX + (face.end.y * MM - sy) * dirY;
        spanFromM = Math.min(spanFromM, Math.max(Math.min(a, b), -0.4));
        spanToM = Math.max(spanToM, Math.min(Math.max(a, b), lengthM + 0.4));
      }
      const spanLengthM = spanToM - spanFromM;
      const outX = -wall.inward_normal.x * (thicknessM / 2);
      const outY = -wall.inward_normal.y * (thicknessM / 2);
      const hosted = [
        ...new Map(
          entries
            .flatMap((entry) => entry.openings)
            .filter((opening) => opening.host_wall_id === wall.wall_id)
            .map((opening) => [opening.id, opening] as const),
        ).values(),
      ];
      const gaps = hosted.map((opening) => {
        const from = (opening.start.x * MM - sx) * dirX + (opening.start.y * MM - sy) * dirY - spanFromM;
        const to = (opening.end.x * MM - sx) * dirX + (opening.end.y * MM - sy) * dirY - spanFromM;
        return [Math.max(0, Math.min(from, to)), Math.min(spanLengthM, Math.max(from, to))] as const;
      });
      const voids = hosted.map((opening, index) => ({
        fromM: gaps[index]?.[0] ?? 0,
        toM: gaps[index]?.[1] ?? 0,
        sillM: opening.sill_height_mm * MM,
        headM: opening.head_height_mm * MM,
      }));
      for (const solid of wallSolidRectangles(spanLengthM, heightM, voids)) {
        const middle = (solid.fromM + solid.toM) / 2;
        trackWallForOcclusion(
          addBox(
            solid.toM - solid.fromM,
            solid.topM - solid.bottomM,
            sx + dirX * (middle + spanFromM) + outX,
            sy + dirY * (middle + spanFromM) + outY,
            floorZ * MM + (solid.bottomM + solid.topM) / 2,
            angle,
            finishes.wall,
            thicknessM,
          ),
          wallMeshes,
        );
      }
      hosted.forEach((opening, index) => {
        const gap = gaps[index];
        if (gap === undefined) return;
        const middle = (gap[0] + gap[1]) / 2;
        const x = sx + dirX * (middle + spanFromM) + outX;
        const y = sy + dirY * (middle + spanFromM) + outY;
        const sill = (floorZ + opening.sill_height_mm) * MM;
        const head = (floorZ + opening.head_height_mm) * MM;
        const span = gap[1] - gap[0];
        const apertureHeight = Math.max(head - sill, 0.05);
        const frame = Math.min(0.05, span / 8, apertureHeight / 8);
        const edge = span / 2 - frame / 2;
        for (const side of [-1, 1]) {
          addBox(
            frame,
            apertureHeight,
            x + dirX * edge * side,
            y + dirY * edge * side,
            (sill + head) / 2,
            angle,
            finishes.frame,
            0.055,
          );
        }
        addBox(span, frame, x, y, head - frame / 2, angle, finishes.frame, 0.055);
        if (opening.kind === "unfilled") return;
        if (opening.kind === "door" || opening.kind === "sliding_door") {
          const leafSpan = Math.max(span - frame * 2, 0.03);
          const leafHeight = Math.max(apertureHeight - frame, 0.03);
          const group = new THREE.Group();
          const base = opening.kind === "door"
            ? new THREE.Vector3(
                sx + dirX * (gap[0] + frame) + outX,
                sy + dirY * (gap[0] + frame) + outY,
                0,
              )
            : new THREE.Vector3(x, y, 0);
          group.position.copy(base);
          group.rotation.z = angle;
          const leaf = finishMesh(
            new THREE.Mesh(track(new THREE.BoxGeometry(leafSpan, 0.045, leafHeight)), opening.kind === "door" ? finishes.timber : finishes.glass),
            opening.kind === "door",
          );
          leaf.position.set(opening.kind === "door" ? leafSpan / 2 : 0, 0, sill + leafHeight / 2);
          leaf.userData.doorId = opening.id;
          group.add(leaf);
          current.content.add(group);
          pickable.push(leaf);
          current.doorMotions.set(opening.id, {
            kind: opening.kind,
            group,
            base,
            angle,
            swingSign: doorSwingSign(
              opening.swing,
              { x: dirX, y: dirY },
              entries.find((entry) => opening.room_ids.includes(entry.room.id))
                ?.walls.find((candidate) => candidate.wall_id === wall.wall_id)?.inward_normal
                ?? wall.inward_normal,
            ),
            dirX,
            dirY,
            span: leafSpan,
            amount: 0,
            target: 0,
          });
          return;
        }
        addBox(
          Math.max(span - frame * 2, 0.03),
          Math.max(apertureHeight - frame * 2, 0.03),
          x,
          y,
          (sill + head) / 2,
          angle,
          finishes.glass,
          0.025,
        );
      });
    }

    const seenStairs = new Set<string>();
    const seenObjects = new Set<string>();
    const seenShafts = new Set<string>();
    for (const entry of plan.rooms as PlanRoomGeometry[]) {
      const floorZ = entry.room.elevation_mm;

      const floorFinish = entry.room.is_external
        ? finishes.ground
        : floorMaterialFor(entry.room.floor_finish, finishes, track);
      const floor = finishMesh(new THREE.Mesh(
        track(slabGeometry(shapeFrom(entry.ceiling.polygon.outer, stairwellsThrough(plan, floorZ, entry)))),
        floorFinish,
      ));
      floor.position.z = floorZ * MM - 0.08;
      floor.userData.roomId = entry.room.id;
      current.content.add(floor);
      pickable.push(floor);
      walkables.push(floor);
      current.floors.set(entry.room.id, { mesh: floor, normal: floorFinish });

      // A ventilation shaft is a void between rooms, not a room, so the loop
      // above gives it no floor and the massing view looks straight through
      // the world there. Cap it once at the carrying rooms' floor level.
      for (const source of entry.daylight_sources) {
        if (source.kind !== "ventilation_shaft" || seenShafts.has(source.id)) continue;
        seenShafts.add(source.id);
        const cap = new THREE.Mesh(track(new THREE.ShapeGeometry(shapeFrom(source.footprint.outer))), finishes.object);
        cap.position.z = floorZ * MM - 0.08;
        cap.castShadow = true;
        cap.receiveShadow = true;
        current.content.add(cap);
        walkables.push(cap);
      }

      if (!entry.room.is_external) {
        const wells = stairwellsThrough(plan, floorZ);
        const structural = entry.ceiling.structural_elevation_mm ?? entry.ceiling.elevation_mm;
        const dropped = structural > entry.ceiling.elevation_mm + 1;
        const reveals = revealRuns(entry.obstructions);
        const gypsumRing = insetRingAtReveals(entry.ceiling.polygon.outer, reveals);
        // The slab is one level; the gypsum soffit hangs below it where the
        // finished ceiling is lower, so each answers its own toggle.
        for (const [visible, elevation, material] of [
          [showCeiling, structural, finishes.ceiling],
          [showGypsum && dropped, entry.ceiling.elevation_mm, finishes.gypsum],
        ] as const) {
          if (!visible) continue;
          const ring = material === finishes.gypsum ? gypsumRing : entry.ceiling.polygon.outer;
          const plane = new THREE.Mesh(track(new THREE.ShapeGeometry(shapeFrom(ring, wells))), material);
          plane.position.z = elevation * MM;
          plane.castShadow = true;
          plane.receiveShadow = true;
          current.content.add(plane);
        }
        // Gypsum drawn where it is, rather than as a whole-room plane.
        if (showGypsum) {
          for (const soffit of entry.soffits) {
            const patch = new THREE.Mesh(
              track(new THREE.ShapeGeometry(shapeFrom(soffit.footprint.outer))),
              finishes.gypsum,
            );
            patch.position.z = soffit.elevation_mm * MM;
            patch.castShadow = true;
            patch.receiveShadow = true;
            current.content.add(patch);
            for (const edge of fasciaEdges(soffit.footprint.outer, entry.ceiling.polygon.outer)) {
              renderBulkheadFascia(edge, soffit.elevation_mm, entry.ceiling.elevation_mm, finishes, track, current.content);
            }
          }
          for (const run of reveals) {
            renderCeilingReveal(
              run,
              entry.ceiling.elevation_mm,
              showCeiling ? null : structural,
              finishes,
              track,
              current.content,
            );
          }
        }
      }

      for (const stair of entry.stairs) {
        if (seenStairs.has(stair.id)) continue;
        seenStairs.add(stair.id);
        const parts = buildStairFlightParts(stair);
        for (const part of [...parts.treads, ...(parts.landingRiser === null ? [] : [parts.landingRiser])]) {
          const step = finishMesh(
            new THREE.Mesh(
              track(new THREE.BoxGeometry(part.goingDepthM, part.widthM, part.heightM)),
              finishes.stair,
            ),
          );
          step.position.set(part.centreXM, part.centreYM, part.centreZM);
          step.rotation.z = part.rotationZ;
          current.content.add(step);
          walkables.push(step);
        }
      }

      for (const object of [...entry.furniture, ...entry.obstructions]) {
        if (seenObjects.has(object.id) || isCeilingReveal(object)) continue;
        seenObjects.add(object.id);
        if (hiddenInCeilingVoid(object, entry.ceiling.elevation_mm, showGypsum)) continue;
        if (renderDetailedBuildingObject(object, finishes, track, current.content)) {
          continue;
        }
        const width = Math.max(object.bounds.maximum.x - object.bounds.minimum.x, 20) * MM;
        const depth = Math.max(object.bounds.maximum.y - object.bounds.minimum.y, 20) * MM;
        const tall = Math.max(object.bounds.maximum.z - object.bounds.minimum.z, 20) * MM;
        const geometry = track(new THREE.BoxGeometry(width, depth, tall));
        const mesh = finishMesh(new THREE.Mesh(geometry, finishes.object));
        mesh.position.set(
          ((object.bounds.minimum.x + object.bounds.maximum.x) / 2) * MM,
          ((object.bounds.minimum.y + object.bounds.maximum.y) / 2) * MM,
          ((object.bounds.minimum.z + object.bounds.maximum.z) / 2) * MM,
        );
        current.content.add(mesh);
      }

      for (const fixture of entry.fixtures) {
        const active = !offGroups.has(fixture.switching_group);
        const material = active ? fixtureMaterial : fixtureOffMaterial;
        if (active && realLightCount < MAX_WHOLE_PLAN_REAL_LIGHTS) {
          if (fixture.kind === "recessed_spotlight" && fixture.spec.lumens !== null) {
            const source = new THREE.Vector3(
              fixture.point.x * MM,
              fixture.point.y * MM,
              fixture.point.z * MM - 0.03,
            );
            const direction = new THREE.Vector3(fixture.direction.x, fixture.direction.y, fixture.direction.z);
            if (direction.lengthSq() === 0) direction.set(0, 0, -1);
            else direction.normalize();
            const light = track(new THREE.SpotLight(
              new THREE.Color(...cctToLinearRgb(fixture.spec.cct_kelvin ?? 3000)),
              beamCandela(fixture.spec.lumens, fixture.spec.beam_angle_deg),
              0,
              fieldHalfAngle(fixture.spec.beam_angle_deg),
              0.55,
              2,
            ));
            light.position.copy(source);
            light.target.position.copy(source).addScaledVector(direction, 3);
            light.castShadow = false;
            current.content.add(light);
            current.content.add(light.target);
            dimLight(fixture, light);
            realLightCount += 1;
          } else if (fixture.kind === "pendant_bulb" && fixture.spec.lumens !== null) {
            const light = track(new THREE.PointLight(
              new THREE.Color(...cctToLinearRgb(fixture.spec.cct_kelvin ?? 2700)),
              fixture.spec.lumens / (4 * Math.PI),
              0,
              2,
            ));
            light.position.set(
              fixture.point.x * MM,
              fixture.point.y * MM,
              fixture.point.z * MM - fixture.spec.drop_mm * MM,
            );
            light.castShadow = false;
            current.content.add(light);
            dimLight(fixture, light);
            realLightCount += 1;
          } else if (fixture.kind === "rope_light" && fixture.spec.lumens_per_m !== null) {
            const centre = fixture.path.reduce<THREE.Vector3>(
              (sum, point) => sum.add(new THREE.Vector3(point.x, point.y, point.z)),
              new THREE.Vector3(),
            ).multiplyScalar(MM / fixture.path.length);
            const pathLengthM = fixture.path.slice(1).reduce((length, point, index) => {
              const previous = fixture.path[index];
              return previous === undefined
                ? length
                : length + Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) * MM;
            }, 0);
            const light = track(new THREE.PointLight(
              new THREE.Color(...cctToLinearRgb(fixture.spec.cct_kelvin ?? 3000)),
              (fixture.spec.lumens_per_m * Math.max(pathLengthM, 0.5)) / (4 * Math.PI),
              0,
              2,
            ));
            light.position.copy(centre);
            light.castShadow = false;
            current.content.add(light);
            dimLight(fixture, light);
            realLightCount += 1;
          }
        }
        if (fixture.kind === "rope_light") {
          // A concealed strip sits in the ceiling reveal, so it draws with the gypsum.
          if (fixture.spec.mounting !== "concealed" || showGypsum) addRope(current.content, fixture, material, track, 0.008);
        } else if (fixture.kind === "pendant_bulb") {
          // The massing view's own pendant mark, dimmed with its group like the light inside it.
          const shade = active ? track(fixtureMaterial.clone()) : fixtureOffMaterial;
          if (shade instanceof THREE.MeshStandardMaterial && active) dimGlow(fixture, shade);
          addPendant(current.content, fixture, shade, fixtureMaterials, track);
        } else {
          addSpotlight(
            current.content,
            fixture,
            active ? lampMaterialFor(fixture) : fixtureMaterials.baffle,
            fixtureMaterials,
            track,
            showGypsum,
          );
        }
      }

      for (const device of entry.switches) {
        const point = switchPoint(device, entry.walls, entry.room.elevation_mm);
        const wall = entry.walls.find((candidate) => candidate.wall_id === device.host_wall_id);
        if (point === null || wall === undefined) continue;
        const plate = addSwitch(
          current.content,
          device,
          wall,
          point,
          offGroups.has(device.switching_group) ? switchOffMaterial : switchMaterial,
          fixtureMaterials.trim,
          track,
        );
        pickable.push(plate);
      }
    }

    const shadowSize = Math.max(centre.span * 1.4, 12);
    const shadowCatcher = new THREE.Mesh(
      track(new THREE.PlaneGeometry(shadowSize, shadowSize)),
      track(new THREE.ShadowMaterial({ color: 0x313638, opacity: 0.16, transparent: true })),
    );
    shadowCatcher.position.set(
      centre.x,
      centre.y,
      Math.min(...plan.rooms.map((entry) => entry.room.elevation_mm)) * MM - 0.085,
    );
    shadowCatcher.receiveShadow = true;
    current.content.add(shadowCatcher);

    current.pickable.length = 0;
    current.pickable.push(...pickable);
    current.walls.length = 0;
    current.walls.push(...wallMeshes);
    current.walkables.length = 0;
    current.walkables.push(...walkables);
    for (const [roomId, floor] of current.floors) {
      floor.mesh.material = roomId === selectedRoomRef.current ? finishes.selectedFloor : floor.normal;
    }
    for (const target of current.dimTargets) {
      target.apply(outputFraction(dimRef.current, target.group, target.dimmable));
    }
    // These are new objects, so the previous verdict cannot apply. Settle them
    // in this paint: waiting for the next frame shows every wall solid again
    // for a moment on each rebuild, which a switch click causes. The new
    // meshes have no world matrices until a render, and the sightline test
    // against unplaced walls found none and cached that verdict.
    current.content.updateMatrixWorld(true);
    invalidateWallOcclusion(current);
    refreshWallOcclusion(current);
    current.scheduler.invalidate();
    return () => {
      current.selectedFloor = null;
      for (const item of disposables) item.dispose();
    };
  }, [centre, plan, showCeiling, showGypsum, offGroups]);

  if (unsupported !== null) {
    return (
      <div className="model-view model-view--unsupported" role="img" aria-label="3D view unavailable">
        <p>
          <strong>This browser cannot open a WebGL view.</strong>
          {unsupported}
        </p>
        <p>The 2D whole-floor plan carries the same geometry.</p>
      </div>
    );
  }

  const gestures =
    "Drag to orbit, middle or right drag to pan, the wheel zooms where the pointer is, and a double-click looks at " +
    "what it lands on. Click a room to highlight it and a switch to preview its group. Walk mode uses WASD, the " +
    "mouse to look, and Shift to move faster; it follows floors and stairs and stops at walls.";

  return (
    <div className="model-view" ref={tools.frameRef} style={{ background: skyBackdrop(hour) }}>
      <div className="model-canvas" ref={host} role="img" aria-label="Whole floor 3D view" />
      <div className="model-overlay" role="toolbar" aria-label="3D view options">
        <button
          className={walkMode ? "tool-button tool-button--tight tool-button--active" : "tool-button tool-button--tight"}
          type="button"
          aria-pressed={walkMode}
          onClick={() => setWalkMode((active) => !active)}
          title="Walk through the floor at eye height (E)"
        >
          <Footprints size={15} aria-hidden="true" /> Walk
        </button>
        {selectedRoom !== null && !walkMode ? (
          <button
            className="tool-button tool-button--tight viewer-frame-room"
            type="button"
            onClick={frameSelectedRoom}
            aria-label={`Frame ${selectedRoom.room.name}`}
            title={`Frame ${selectedRoom.room.name}`}
          >
            <Focus size={15} aria-hidden="true" /> <span className="viewer-label">Frame {selectedRoom.room.name}</span>
          </button>
        ) : null}
      </div>
      <ViewerRail
        tools={tools}
        onReset={resetView}
        onPlan={planView}
        onEye={() => setWalkMode((active) => !active)}
        eyeLabel="Walk at eye level"
        eyeActive={walkMode}
      />
      <div className="viewer-cards">
        <SectionPanel tools={tools} bounds={viewBounds} />
        <MeasureReadout tools={tools} />
        <ShortcutHelp tools={tools} gestures={gestures} omit={onToggleSeeThrough === undefined ? ["seeThrough"] : []} />
      </div>
      <ViewerStatus tools={tools} />
      {walkMode ? (
        <p className="model-hint">
          <MousePointerClick size={14} aria-hidden="true" />
          <span>
            Click the view, then use WASD to move, the mouse to look, Shift to go faster and Esc to release the
            pointer. Floors and stairs carry you and walls stop you.
          </span>
        </p>
      ) : (
        <ViewerHint tools={tools}>
          Click a room to highlight it and a switch to preview its group. Use the room list to open one. Press ? for
          more.
        </ViewerHint>
      )}
      <div className="viewer-footer">
        <p className="model-disclaimer">{disclaimerText()}</p>
      </div>
    </div>
  );
}
