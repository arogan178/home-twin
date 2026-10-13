import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";

import { isSeeThrough } from "./cameraControls";
import type { CameraFrame } from "./cameraPresets";
import { MeasureOverlay, measureBetween, type Measurement } from "./measureTool";
import type { RenderScheduler } from "./renderScheduler";
import { captionedCanvas, downloadCanvas, snapshotFilename } from "./screenshot";
import { SECTION_OFF, keptBySection, sectionPlane, sectionRange, type Section, type SectionMode, type ViewBounds } from "./sectionPlane";
import { viewerAction, type ViewerAction } from "./viewerShortcuts";

/** The parts of a 3D view the shared tools drive. */
export type ViewerEngine = {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly content: THREE.Object3D;
  readonly overlay: THREE.Object3D;
  readonly scheduler: RenderScheduler;
  /** Draw one frame: the scene through the composer, then the overlay on top. */
  readonly render: () => void;
};

type ViewerToolsOptions = {
  readonly engine: RefObject<ViewerEngine | null>;
  readonly bounds: ViewBounds;
  readonly snapshotLabel: string;
  /** The disclaimer the picture carries, the same text the view shows. */
  readonly caption: () => ReadonlyArray<string>;
  /** Actions only the view knows how to do; true when it handled one. */
  readonly onAction: (action: ViewerAction) => boolean;
  /** False while the keyboard belongs to something else, such as walking. */
  readonly shortcutsEnabled?: () => boolean;
};

const HINT_KEY = "home-twin.hint.model";

function readHintOpen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) !== "dismissed";
  } catch {
    return true;
  }
}

function storeHintOpen(open: boolean) {
  try {
    if (open) window.localStorage.removeItem(HINT_KEY);
    else window.localStorage.setItem(HINT_KEY, "dismissed");
  } catch {
    // Storage can be unavailable in private windows; the hint still toggles.
  }
}

/** A surface a pick should pass through: hidden, faded, or a drawn overlay. */
export function isPickThrough(object: THREE.Object3D): boolean {
  if (!(object instanceof THREE.Mesh) || !object.visible) return true;
  const material = Array.isArray(object.material) ? object.material[0] : object.material;
  if (material === undefined) return true;
  return material.colorWrite === false || material.depthWrite === false || isSeeThrough(object);
}

export function pointerNdc(element: HTMLElement, clientX: number, clientY: number): THREE.Vector2 {
  const rect = element.getBoundingClientRect();
  return new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
}

/**
 * Draw the overlay after the composer, straight to the canvas. Inside the
 * composer its lines were tone-mapped at the room's lux exposure and came out
 * black; drawn here, `toneMapped: false` holds and they keep their colour.
 */
export function renderWithOverlay(
  renderer: THREE.WebGLRenderer,
  composer: EffectComposer,
  overlayScene: THREE.Scene,
  camera: THREE.Camera,
) {
  composer.render();
  renderer.autoClear = false;
  renderer.render(overlayScene, camera);
  renderer.autoClear = true;
}

/**
 * Multisample the composer's buffers. The canvas's own antialiasing never
 * reaches the picture once a composer renders into offscreen targets, which
 * left every edge stair-stepped.
 */
export function multisampleComposer(composer: EffectComposer, samples = 4): void {
  composer.renderTarget1.samples = samples;
  composer.renderTarget2.samples = samples;
}

/** Move the orbit to a named frame. */
export function applyCameraFrame(engine: ViewerEngine, frame: CameraFrame): void {
  engine.camera.position.set(frame.position.x, frame.position.y, frame.position.z);
  engine.controls.target.set(frame.target.x, frame.target.y, frame.target.z);
  engine.controls.update();
  engine.scheduler.invalidate();
}

export function useViewerTools(options: ViewerToolsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const frameRef = useRef<HTMLDivElement>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [measureStarted, setMeasureStarted] = useState(false);
  const measureStart = useRef<THREE.Vector3 | null>(null);
  const measurementDone = useRef(false);
  const measureOverlay = useRef<MeasureOverlay | null>(null);
  const [section, setSection] = useState<Section>(SECTION_OFF);
  const [sectionOpen, setSectionOpen] = useState(false);
  const sectionOpenRef = useRef(sectionOpen);
  sectionOpenRef.current = sectionOpen;
  const [helpOpen, setHelpOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [hintOpen, setHintOpenState] = useState(readHintOpen);
  const setHintOpen = useCallback((open: boolean) => {
    storeHintOpen(open);
    setHintOpenState(open);
  }, []);
  const plane = useMemo(() => sectionPlane(section), [section]);
  const planeRef = useRef(plane);
  planeRef.current = plane;
  const measuringRef = useRef(measuring);
  measuringRef.current = measuring;

  useEffect(() => {
    const engine = optionsRef.current.engine.current;
    if (engine === null) return;
    engine.renderer.clippingPlanes = plane === null ? [] : [plane];
    engine.scheduler.invalidate();
  }, [plane]);

  useEffect(() => {
    if (status === null) return undefined;
    const timer = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current && frameRef.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => () => {
    measureOverlay.current?.dispose();
    measureOverlay.current = null;
  }, []);

  /** Whether a point survives the current section cut. */
  const kept = useCallback((point: THREE.Vector3) => keptBySection(planeRef.current, point), []);

  /** The first solid, uncut surface under the pointer. */
  const pickSurface = useCallback((clientX: number, clientY: number): THREE.Intersection | null => {
    const engine = optionsRef.current.engine.current;
    if (engine === null) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointerNdc(engine.renderer.domElement, clientX, clientY), engine.camera);
    for (const hit of raycaster.intersectObject(engine.content, true)) {
      if (isPickThrough(hit.object) || !keptBySection(planeRef.current, hit.point)) continue;
      return hit;
    }
    return null;
  }, []);

  const clearMeasurement = useCallback(() => {
    measureStart.current = null;
    measurementDone.current = false;
    setMeasurement(null);
    setMeasureStarted(false);
    measureOverlay.current?.clear();
    optionsRef.current.engine.current?.scheduler.invalidate();
  }, []);

  const toggleMeasuring = useCallback(() => {
    setMeasuring((value) => !value);
    clearMeasurement();
  }, [clearMeasurement]);

  /** A click while measuring places a point. True when the click was consumed. */
  const measureClick = useCallback((clientX: number, clientY: number, lockAxis: boolean): boolean => {
    if (!measuringRef.current) return false;
    const engine = optionsRef.current.engine.current;
    const hit = pickSurface(clientX, clientY);
    if (engine === null || hit === null) return true;
    if (measureOverlay.current === null) measureOverlay.current = new MeasureOverlay(engine.overlay);
    const start = measureStart.current;
    if (start === null || measurementDone.current) {
      measureStart.current = hit.point.clone();
      measurementDone.current = false;
      setMeasurement(null);
      setMeasureStarted(true);
      measureOverlay.current.show(hit.point, null);
    } else {
      const result = measureBetween(start, hit.point, lockAxis);
      measurementDone.current = true;
      setMeasurement(result);
      measureOverlay.current.show(start, result);
    }
    engine.scheduler.invalidate();
    return true;
  }, [pickSurface]);

  const chooseSection = useCallback((mode: SectionMode) => {
    if (mode === "off") {
      setSection(SECTION_OFF);
      return;
    }
    setSection((current) => (
      current.mode === mode ? current : { mode, atM: sectionRange(mode, optionsRef.current.bounds).initial, flip: false }
    ));
  }, []);

  const toggleSection = useCallback(() => {
    const open = sectionOpenRef.current;
    setSectionOpen(!open);
    if (open) setSection(SECTION_OFF);
    else setSection((current) => (
      current.mode === "off"
        ? { mode: "height", atM: sectionRange("height", optionsRef.current.bounds).initial, flip: false }
        : current
    ));
  }, []);

  const snapshot = useCallback(() => {
    const engine = optionsRef.current.engine.current;
    if (engine === null) return;
    // The drawing buffer is only readable in the task that drew it.
    engine.render();
    try {
      const canvas = captionedCanvas(engine.renderer.domElement, optionsRef.current.caption());
      downloadCanvas(canvas, snapshotFilename(optionsRef.current.snapshotLabel, new Date()));
      setStatus("Snapshot saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The snapshot failed");
    }
  }, []);

  const copyLink = useCallback(() => {
    const href = window.location.href;
    if (navigator.clipboard === undefined) {
      setStatus("Copy the address bar: this browser blocks clipboard access");
      return;
    }
    navigator.clipboard.writeText(href).then(
      () => setStatus("Link to this view copied"),
      () => setStatus("Copy the address bar: clipboard access was refused"),
    );
  }, []);

  const toggleFullscreen = useCallback(() => {
    const element = frameRef.current;
    if (element === null) return;
    if (document.fullscreenElement === element) void document.exitFullscreen();
    else void element.requestFullscreen?.().catch(() => setStatus("Full screen was refused"));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = viewerAction(event);
      if (action === null) return;
      const enabled = optionsRef.current.shortcutsEnabled?.() ?? true;
      if (!enabled && action !== "escape") return;
      let handled = true;
      switch (action) {
        case "measure":
          toggleMeasuring();
          break;
        case "section":
          toggleSection();
          break;
        case "fullscreen":
          toggleFullscreen();
          break;
        case "help":
          setHelpOpen((open) => !open);
          break;
        case "escape":
          setHelpOpen(false);
          if (measuringRef.current) clearMeasurement();
          handled = optionsRef.current.onAction(action) || measuringRef.current;
          break;
        default:
          handled = optionsRef.current.onAction(action);
      }
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearMeasurement, toggleFullscreen, toggleMeasuring, toggleSection]);

  return {
    frameRef,
    measuring,
    measureStarted,
    measurement,
    toggleMeasuring,
    clearMeasurement,
    measureClick,
    section,
    setSection,
    chooseSection,
    sectionOpen,
    toggleSection,
    plane,
    kept,
    pickSurface,
    helpOpen,
    setHelpOpen,
    hintOpen,
    setHintOpen,
    fullscreen,
    toggleFullscreen,
    snapshot,
    copyLink,
    status,
  };
}

export type ViewerTools = ReturnType<typeof useViewerTools>;
