/**
 * A WebGL view of one room, built from the same IFC-derived geometry the plan
 * uses. It is a derived visualisation: nothing here is a second building model,
 * and the rendered light is a visual reading of the labelled lumen and
 * beam-cone approximation, not a photometric image.
 */

import { Compass, Eye } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import { focusOrbitOnPointer } from "./cameraControls";
import { extrudedOutlines, focusFrame, roomOverviewFrame, type Box } from "./cameraFraming";
import { eyeLevelFrame, openestDirection, planViewFrame, type CameraFrame } from "./cameraPresets";
import { DIMMING_METHOD, electricOutputShare, type DimLevels } from "./dimming";
import {
  describeInspection,
  inspectTargetOf,
  sameTarget,
  type InspectTarget,
} from "./inspection";
import { ObjectInspector } from "./ObjectInspector";
import { addIndirectAndDaylight } from "./roomDaylight";
import { addCoverage } from "./roomCoverage";
import { addRoomObjects, addStairs } from "./roomObjects";
import { addRoomShell } from "./roomShell";
import { MAX_REAL_LIGHTS, addRoomFixtures } from "./roomFixtures";
import { addRoomWalls } from "./roomWalls";
import {
  applyAmbient,
  applyDimming,
  applySelection,
  createRoomEngine,
  inspectKey,
  outlineTarget,
  type Scene,
} from "./roomEngine";
import {
  applyCameraFrame,
  isPickThrough,
  pointerNdc,
  useViewerTools,
} from "./useViewerTools";
import { readCameraFrame, writeCameraFrame } from "./viewerUrl";
import {
  MeasureReadout,
  SectionPanel,
  ShortcutHelp,
  ViewerHint,
  ViewerRail,
  ViewerStatus,
  ViewsMenu,
  type NamedView,
} from "./ViewerTools";
import { hiddenInCeilingVoid, pendantShadeCentre } from "./fixtureRendering";
import "./viewer.css";
import { floorMaterialFor } from "./finishMaterials";
import {
  invalidateWallOcclusion,
  floorProbePoints,
  refreshWallOcclusion,
} from "./wallOcclusion";
import { advanceDoorMotions } from "./doorAnimation";
import {
  isCeilingReveal,
} from "./ceilingGypsum";
import {
  deepestInteriorPoint,
  placedFixtures,
  resolveDrag,
  type AlignmentGuide,
  type RenderableLightSurface,
  type Vec2,
} from "./plan";
import { exposureForReferenceLux } from "./render";
import { type LowerLevelFloor } from "./roomFloorGeometry";
import {
  projectPointToWall,
  wallSurfaceContainsPoint,
  type WallSwitchPosition,
} from "./switchGeometry";
import { classifyPick } from "./pick";
import { pressSelection, releaseSelection } from "./selection";
import type {
  BakedLighting,
  BuildingObject,
  DarkZone,
  Design,
  Fixture,
  FixtureTag,
  Opening,
  Point,
  Sensor,
  Soffit,
  Stair,
  SunPatch,
  WallSwitch,
} from "./types";

const MM = 0.001;

export type RoomView3DProps = {
  readonly polygon: Design["ceiling"]["polygon"];
  readonly walls: Design["walls"];
  readonly openings: ReadonlyArray<Opening>;
  readonly objects: ReadonlyArray<BuildingObject>;
  readonly fixtures: ReadonlyArray<Fixture>;
  readonly switches: ReadonlyArray<WallSwitch>;
  readonly sensors?: ReadonlyArray<Sensor>;
  readonly offGroups: ReadonlySet<string>;
  readonly illuminance: RenderableLightSurface | null;
  readonly baked: BakedLighting | null;
  readonly stairs: ReadonlyArray<Stair>;
  readonly darkZones: ReadonlyArray<DarkZone>;
  readonly sunPatches: ReadonlyArray<SunPatch>;
  readonly sunDirection: Point | null;
  readonly sunAltitudeDeg: number | null;
  readonly trueNorthDeg: number;
  readonly floorElevationMm: number;
  readonly ceilingElevationMm: number;
  readonly structuralCeilingElevationMm: number | null;
  readonly floorFinish: string | null;
  readonly wallFinish: string | null;
  readonly featureWallId: string | null;
  readonly featureWallColour: string | null;
  readonly skirting: string | null;
  readonly skirtingHeightMm: number | null;
  readonly skirtingThicknessMm: number | null;
  readonly cladWallIds: readonly string[];
  readonly showCeiling: boolean;
  readonly isExternal: boolean;
  /** Outdoor space: open sky, so no slab and nothing over it to cast a shadow. */
  readonly showGypsum: boolean;
  readonly soffits: ReadonlyArray<Soffit>;
  /** Footprints of this room's own lower levels, which the floor opens over. */
  readonly lowerLevels: ReadonlyArray<LowerLevelFloor>;
  readonly taskPlaneElevationMm: number;
  /** The layout's target illuminance, which the view exposes for. */
  readonly targetLux: number;
  /** The same utilization factor the illuminance grid applies. */
  readonly utilizationFactor: number;
  readonly selectedTags: ReadonlySet<FixtureTag>;
  readonly showLightRendering: boolean;
  readonly showCoverage: boolean;
  readonly showDarkZones: boolean;
  /** Spacing a dragged spotlight lands on, in millimetres. */
  readonly snapMm: number;
  readonly onSelect: (tags: ReadonlySet<FixtureTag>) => void;
  readonly onMove: (moves: ReadonlyArray<{ readonly tag: FixtureTag; readonly point: Point }>) => void;
  readonly onMoveSwitch: (tag: FixtureTag, position: WallSwitchPosition) => void;
  readonly onToggleGroup: (group: string) => void;
  /** Preview output per switching group; display only. */
  readonly dimLevels?: DimLevels;
  /** Names the view in a snapshot. */
  readonly viewLabel?: string;
};

const NO_DIMMING: DimLevels = new Map();

type Surface = RenderableLightSurface;

type FixtureDrag = {
  readonly pointerId: number;
  readonly lead: FixtureTag;
  /** Where the drag began on the plane, in plan millimetres. */
  readonly grabbedAt: Vec2;
  readonly origins: ReadonlyMap<FixtureTag, Point>;
  readonly additive: boolean;
  moved: boolean;
  moves: ReadonlyArray<{ readonly tag: FixtureTag; readonly point: Point }>;
};

/** The dotted lines a drag lined up with, drawn just under the ceiling. */
function drawGuides(overlay: THREE.Group, guides: ReadonlyArray<AlignmentGuide>, planeZ: number) {
  clearGuides(overlay);
  for (const guide of guides) {
    const reach = 0.14;
    const from = guide.fromMm * MM - reach;
    const to = guide.toMm * MM + reach;
    const at = guide.atMm * MM;
    const ends =
      guide.axis === "column"
        ? [new THREE.Vector3(at, from, planeZ), new THREE.Vector3(at, to, planeZ)]
        : [new THREE.Vector3(from, at, planeZ), new THREE.Vector3(to, at, planeZ)];
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ends),
      new THREE.LineDashedMaterial({ color: 0xff4d8d, dashSize: 0.06, gapSize: 0.05, depthTest: false }),
    );
    line.computeLineDistances();
    line.renderOrder = 9;
    line.userData.guide = true;
    overlay.add(line);
  }
}

/** Remove the drag guides, leaving the measurement and outlines that share the overlay. */
function clearGuides(overlay: THREE.Group) {
  for (const child of [...overlay.children]) {
    if (child instanceof THREE.Line && child.userData.guide === true) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
      overlay.remove(child);
    }
  }
}

export function RoomView3D(props: RoomView3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Scene | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [tableClosed, setTableClosed] = useState(false);
  const [openCarcass, setOpenCarcass] = useState(false);
  const [seeThroughWalls, setSeeThroughWalls] = useState(true);
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;
  const onMoveSwitch = useRef(props.onMoveSwitch);
  onMoveSwitch.current = props.onMoveSwitch;
  const onToggleGroup = useRef(props.onToggleGroup);
  onToggleGroup.current = props.onToggleGroup;
  const interaction = useRef({
    walls: props.walls,
    switches: props.switches,
    floorElevationMm: props.floorElevationMm,
    ceilingElevationMm: props.ceilingElevationMm,
  });
  interaction.current = {
    walls: props.walls,
    switches: props.switches,
    floorElevationMm: props.floorElevationMm,
    ceilingElevationMm: props.ceilingElevationMm,
  };
  const onMove = useRef(props.onMove);
  onMove.current = props.onMove;
  const selectionRef = useRef(props.selectedTags);
  selectionRef.current = props.selectedTags;
  const fixturesRef = useRef(props.fixtures);
  fixturesRef.current = props.fixtures;
  const dragRef = useRef<FixtureDrag | null>(null);
  const [inspected, setInspected] = useState<InspectTarget | null>(null);
  const inspectedRef = useRef(inspected);
  inspectedRef.current = inspected;
  const dimLevels = props.dimLevels ?? NO_DIMMING;
  const dimRef = useRef(dimLevels);
  dimRef.current = dimLevels;
  const outputShare = useMemo(
    () => electricOutputShare(props.fixtures, props.offGroups, dimLevels),
    [props.fixtures, props.offGroups, dimLevels],
  );
  const outputShareRef = useRef(outputShare);
  outputShareRef.current = outputShare;
  // The address bar's camera belongs to the extent it was opened on. Re-running
  // the framing for that same extent, as a remount does, must keep it.
  const urlCamera = useRef<{ readonly frame: CameraFrame; key: string | null } | null>(
    (() => {
      const frame = readCameraFrame();
      return frame === null ? null : { frame, key: null };
    })(),
  );
  /** Set once the viewer or a named view moves the camera, so a resize stops reframing it. */
  const userMoved = useRef(urlCamera.current !== null);

  function resolveMove(drag: FixtureDrag, cursorMm: Vec2) {
    const still = placedFixtures(props.fixtures)
      .filter((fixture) => !drag.origins.has(fixture.tag))
      .map((fixture) => ({ tag: fixture.tag, at: { x: fixture.point.x, y: fixture.point.y } }));
    const resolved = resolveDrag(
      drag.origins,
      drag.lead,
      { x: cursorMm.x - drag.grabbedAt.x, y: cursorMm.y - drag.grabbedAt.y },
      still,
      props.snapMm,
      // The plan widens the pull to catch a neighbour at a wide zoom. Here the
      // room is always at arm's length, so half a grid step is enough.
      0,
    );
    return {
      guides: resolved.guides,
      moves: resolved.moves.map((move) => ({ tag: move.tag as FixtureTag, point: move.point })),
    };
  }
  const resolveMoveRef = useRef(resolveMove);
  resolveMoveRef.current = resolveMove;

  const centre = useMemo(() => {
    const points = [
      ...props.polygon.outer,
      ...props.stairs.flatMap((stair) => stair.footprint.outer),
    ];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      x: ((Math.min(...xs) + Math.max(...xs)) / 2) * MM,
      y: ((Math.min(...ys) + Math.max(...ys)) / 2) * MM,
      span: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * MM,
    };
  }, [props.polygon, props.stairs]);

  const viewBounds = useMemo(() => {
    const points = [...props.polygon.outer, ...props.stairs.flatMap((stair) => stair.footprint.outer)];
    const xs = points.map((point) => point.x * MM);
    const ys = points.map((point) => point.y * MM);
    const levels = [props.floorElevationMm, ...props.lowerLevels.map((level) => level.elevationMm)];
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      minZ: Math.min(...levels) * MM,
      maxZ: Math.max(props.structuralCeilingElevationMm ?? props.ceilingElevationMm, props.ceilingElevationMm) * MM + 0.05,
    };
  }, [
    props.polygon,
    props.stairs,
    props.lowerLevels,
    props.floorElevationMm,
    props.ceilingElevationMm,
    props.structuralCeilingElevationMm,
  ]);

  const overviewPoints = useMemo(() => {
    const metres = (ring: ReadonlyArray<Point | { x: number; y: number }>) =>
      ring.map((point) => ({ x: point.x * MM, y: point.y * MM }));
    const floorM = props.floorElevationMm * MM;
    // To the wall heads, which stand to the slab: fitting the finished ceiling cut their tops off.
    const ceilingM = Math.max(props.structuralCeilingElevationMm ?? 0, props.ceilingElevationMm) * MM;
    return extrudedOutlines([
      { ring: metres(props.polygon.outer), fromZ: floorM, toZ: ceilingM },
      ...props.stairs.map((stair) => ({
        ring: metres(stair.footprint.outer),
        fromZ: Math.min(stair.base_elevation_mm * MM, floorM),
        toZ: ceilingM,
      })),
      ...props.lowerLevels.map((level) => ({ ring: metres(level.outline), fromZ: level.elevationMm * MM, toZ: ceilingM })),
    ]);
  }, [
    props.polygon,
    props.stairs,
    props.lowerLevels,
    props.floorElevationMm,
    props.ceilingElevationMm,
    props.structuralCeilingElevationMm,
  ]);

  const tools = useViewerTools({
    engine,
    bounds: viewBounds,
    snapshotLabel: props.viewLabel ?? "room",
    caption: () => [
      `${props.viewLabel ?? "Room"} · Home Twin 3D view · ${new Date().toLocaleString("en-GB")}`,
      disclaimerText(),
    ],
    onAction: (action) => {
      switch (action) {
        case "reset":
          resetView();
          return true;
        case "plan":
          planView();
          return true;
        case "eye":
          eyeView();
          return true;
        case "seeThrough":
          setSeeThroughWalls((value) => !value);
          return true;
        case "escape":
          if (inspectedRef.current === null) return false;
          setInspected(null);
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
    const created = createRoomEngine(element, renderer);
    engine.current = created.engine;
    const { camera, controls, composer, scheduler } = created.engine;

    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
      scheduler.invalidate();
      // Fit the room to the canvas it opened in, until the viewer takes over.
      if (!userMoved.current) frameRoomRef.current();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    let running = true;
    let previousFrame = performance.now();
    const animate = () => {
      if (!running) return;
      const now = performance.now();
      const elapsed = Math.min(now - previousFrame, 50);
      previousFrame = now;
      const current = engine.current;
      if (current !== null && advanceDoorMotions(current.doorMotions.values(), elapsed)) scheduler.invalidate();
      controls.update();
      if (current !== null && scheduler.consume(camera)) {
        refreshWallOcclusion(current);
        current.render();
      }
      requestAnimationFrame(animate);
    };
    animate();

    // The camera rides in the address bar, so a reload, a link, or a trip to
    // the 2D plan and back returns to the same angle.
    let cameraWrite = 0;
    const persistCamera = () => {
      window.clearTimeout(cameraWrite);
      cameraWrite = window.setTimeout(() => {
        writeCameraFrame({
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        });
      }, 400);
    };
    controls.addEventListener("change", persistCamera);
    const onControlStart = () => {
      userMoved.current = true;
    };
    controls.addEventListener("start", onControlStart);

    const pointerAt = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const raycaster = new THREE.Raycaster();

    /** The ray under the cursor, or null before the scene exists. */
    const pointerRay = (event: PointerEvent): THREE.Raycaster | null => {
      const current = engine.current;
      if (current === null) return null;
      raycaster.setFromCamera(pointerAt(event), current.camera);
      return raycaster;
    };

    /** Where the cursor meets the horizontal plane a drag runs on, in metres. */
    const onDragPlane = (event: PointerEvent, planeZ: number): THREE.Vector3 | null => {
      if (pointerRay(event) === null) return null;
      const hit = new THREE.Vector3();
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
      return raycaster.ray.intersectPlane(plane, hit) === null ? null : hit;
    };

    /** The inspectable element under the cursor, past glass, faded walls and a section cut. */
    const inspectableUnder = (clientX: number, clientY: number): InspectTarget | null => {
      const current = engine.current;
      if (current === null) return null;
      raycaster.setFromCamera(pointerNdc(renderer.domElement, clientX, clientY), current.camera);
      for (const hit of raycaster.intersectObject(current.content, true)) {
        if (isPickThrough(hit.object) || !toolsRef.current.kept(hit.point)) continue;
        return inspectTargetOf(hit.object.userData);
      }
      return null;
    };

    // A press that lifts where it went down is a click; anything else was an orbit.
    let press: { pointerId: number; x: number; y: number; kind: "measure" | "empty" } | null = null;

    let hovered: InspectTarget | null = null;
    let hoverQueued = false;
    const hoverAt = { x: 0, y: 0 };
    const setHovered = (target: InspectTarget | null) => {
      const current = engine.current;
      if (current === null) return;
      const shown = sameTarget(target, inspectedRef.current) ? null : target;
      if (sameTarget(shown, hovered)) return;
      hovered = shown;
      outlineTarget(current, current.hoverHelper, shown);
    };
    const updateHover = () => {
      hoverQueued = false;
      const current = engine.current;
      if (current === null || !running) return;
      if (toolsRef.current.measuring) {
        renderer.domElement.style.cursor = "crosshair";
        setHovered(null);
        return;
      }
      raycaster.setFromCamera(pointerNdc(renderer.domElement, hoverAt.x, hoverAt.y), current.camera);
      const onControl = raycaster.intersectObjects(current.pickable, false).length > 0;
      const target = onControl ? null : inspectableUnder(hoverAt.x, hoverAt.y);
      renderer.domElement.style.cursor = onControl || target !== null ? "pointer" : "";
      setHovered(target);
    };
    const onPointerLeave = () => {
      renderer.domElement.style.cursor = "";
      setHovered(null);
    };

    // A switch slides along its wall and a light slides along the ceiling, so
    // the two drags share the button and each keeps its own state.
    let switchDrag: {
      tag: FixtureTag;
      group: string;
      pointerId: number;
      x: number;
      y: number;
      moved: boolean;
    } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      const current = engine.current;
      if (current === null || event.button !== 0) return;
      if (toolsRef.current.measuring) {
        // Measuring still orbits on a drag; only a still click places a point.
        press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind: "measure" };
        return;
      }
      const ray = pointerRay(event);
      if (ray === null) return;
      const hit = ray.intersectObjects(current.pickable, false)[0];
      const doorId = hit?.object.userData.doorId;
      if (typeof doorId === "string") {
        const door = current.doorMotions.get(doorId);
        if (door !== undefined) door.target = door.target > 0.5 ? 0 : 1;
        return;
      }
      const picked = classifyPick(hit?.object.userData);
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;

      if (picked.kind === "switch") {
        const tag = picked.tag as FixtureTag;
        switchDrag = {
          tag,
          group: picked.group,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          moved: false,
        };
        renderer.domElement.setPointerCapture(event.pointerId);
        current.controls.enabled = false;
        onSelect.current(new Set([tag]));
        return;
      }

      if (picked.kind === "empty") {
        // An empty click orbits the room, and clears the selection unless the
        // modifier says the selection is being built up. Lifted in place, it
        // also reads back the element under it.
        if (!additive) onSelect.current(new Set());
        press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind: "empty" };
        return;
      }
      const tag = picked.tag as FixtureTag;

      const next = pressSelection(selectionRef.current, tag, additive);
      onSelect.current(next);
      const lead = fixturesRef.current.find((fixture) => fixture.tag === tag);
      // A rope light is a path, not a point, so it selects but does not drag.
      if (lead === undefined || lead.kind === "rope_light" || !next.has(tag)) return;
      const grabbedAt = onDragPlane(event, lead.point.z * MM);
      if (grabbedAt === null) return;
      // Orbiting and dragging both own the left button, so one stands down.
      current.controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        lead: tag,
        grabbedAt: { x: grabbedAt.x / MM, y: grabbedAt.y / MM },
        origins: new Map(
          placedFixtures(fixturesRef.current)
            .filter((fixture) => next.has(fixture.tag))
            .map((fixture) => [fixture.tag, fixture.point]),
        ),
        additive,
        moved: false,
        moves: [],
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const current = engine.current;
      if (current === null) return;
      if (event.buttons === 0 && switchDrag === null && dragRef.current === null) {
        hoverAt.x = event.clientX;
        hoverAt.y = event.clientY;
        if (!hoverQueued) {
          hoverQueued = true;
          requestAnimationFrame(updateHover);
        }
        return;
      }

      const held = switchDrag;
      if (held !== null && held.pointerId === event.pointerId) {
        if (Math.hypot(event.clientX - held.x, event.clientY - held.y) > 4) held.moved = true;
        if (!held.moved) return;
        const ray = pointerRay(event);
        if (ray === null) return;
        const state = interaction.current;
        const device = state.switches.find((candidate) => candidate.tag === held.tag);
        if (device === undefined) return;
        let nearest: { distance: number; position: WallSwitchPosition } | null = null;
        for (const wall of state.walls) {
          const normal = new THREE.Vector3(wall.inward_normal.x, wall.inward_normal.y, 0).normalize();
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
            normal,
            new THREE.Vector3(wall.start.x * MM, wall.start.y * MM, 0),
          );
          const wallHit = ray.ray.intersectPlane(plane, new THREE.Vector3());
          if (wallHit === null) continue;
          const hitPoint = { x: wallHit.x / MM, y: wallHit.y / MM, z: wallHit.z / MM };
          if (!wallSurfaceContainsPoint(
            hitPoint,
            wall,
            state.floorElevationMm,
            state.ceilingElevationMm,
            device.spec.width_mm,
            device.spec.height_mm,
          )) continue;
          const proposed = projectPointToWall(
            hitPoint,
            wall,
            state.floorElevationMm,
            device.spec.width_mm,
          );
          if (proposed === null) continue;
          const height = Math.max(
            device.spec.height_mm / 2,
            Math.min(
              state.ceilingElevationMm - state.floorElevationMm - device.spec.height_mm / 2,
              proposed.mounting_height_mm,
            ),
          );
          const distance = ray.ray.origin.distanceTo(wallHit);
          if (nearest === null || distance < nearest.distance) {
            nearest = { distance, position: { ...proposed, mounting_height_mm: height } };
          }
        }
        if (nearest !== null) onMoveSwitch.current(held.tag, nearest.position);
        return;
      }

      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const lead = drag.origins.get(drag.lead);
      if (lead === undefined) return;
      const cursor = onDragPlane(event, lead.z * MM);
      if (cursor === null) return;
      const resolved = resolveMoveRef.current(drag, { x: cursor.x / MM, y: cursor.y / MM });
      drag.moved = true;
      drag.moves = resolved.moves;
      for (const move of resolved.moves) {
        const origin = drag.origins.get(move.tag);
        const group = current.fixtureGroups.get(move.tag);
        if (origin === undefined || group === undefined) continue;
        group.position.set((move.point.x - origin.x) * MM, (move.point.y - origin.y) * MM, 0);
      }
      drawGuides(current.overlay, resolved.guides, lead.z * MM);
    };

    const onPointerUp = (event: PointerEvent) => {
      const current = engine.current;

      const pressed = press;
      if (pressed !== null && pressed.pointerId === event.pointerId) {
        press = null;
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) <= 4) {
          if (pressed.kind === "measure") toolsRef.current.measureClick(event.clientX, event.clientY, event.shiftKey);
          else setInspected(inspectableUnder(event.clientX, event.clientY));
        }
        return;
      }

      const held = switchDrag;
      if (held !== null && held.pointerId === event.pointerId) {
        // A switch pressed rather than dragged is a switch being flicked.
        if (!held.moved) onToggleGroup.current(held.group);
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId);
        }
        if (current !== null) current.controls.enabled = true;
        switchDrag = null;
        return;
      }

      const drag = dragRef.current;
      if (current === null || drag === null || drag.pointerId !== event.pointerId) return;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      dragRef.current = null;
      current.controls.enabled = true;
      clearGuides(current.overlay);
      if (drag.moves.length > 0) onMove.current(drag.moves);
      const narrowed = releaseSelection(selectionRef.current, drag.lead, drag.additive, drag.moved);
      if (narrowed !== null) onSelect.current(narrowed);
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    // Double-click to say "look at that", which is the gesture the wall
    // fading is for: pick the thing, and whatever stands in front gives way.
    const onDoubleClick = (event: MouseEvent) => {
      const current = engine.current;
      if (current === null || !current.controls.enabled) return;
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
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
      created.dispose();
      engine.current = null;
    };
  }, []);

  const frameRoom = useCallback(() => {
    const current = engine.current;
    if (current === null) return;
    const floor = floorProbePoints(
      props.polygon.outer.map((point) => ({ x: point.x * MM, y: point.y * MM })),
      props.floorElevationMm * MM,
    );
    // Tall pieces only: a bath or a bed does not hide the floor beyond it.
    const furniture: Box[] = props.objects
      .filter((object) => !isCeilingReveal(object) && object.bounds.maximum.z - object.bounds.minimum.z > 1200)
      .filter((object) => !hiddenInCeilingVoid(object, props.ceilingElevationMm, props.showGypsum))
      .map((object) => ({
        minX: object.bounds.minimum.x * MM,
        maxX: object.bounds.maximum.x * MM,
        minY: object.bounds.minimum.y * MM,
        maxY: object.bounds.maximum.y * MM,
        minZ: object.bounds.minimum.z * MM,
        maxZ: object.bounds.maximum.z * MM,
      }));
    applyCameraFrame(
      current,
      roomOverviewFrame(overviewPoints, current.camera.fov, current.camera.aspect, floor, furniture),
    );
  }, [
    overviewPoints,
    props.polygon,
    props.floorElevationMm,
    props.objects,
    props.ceilingElevationMm,
    props.showGypsum,
  ]);
  const frameRoomRef = useRef(frameRoom);
  frameRoomRef.current = frameRoom;

  // Frame the room when its extent is first known or actually changes. Keyed
  // on the values, not the arrays: a save reloads the same room as new
  // objects, and reframing on that threw away the angle mid-edit.
  const frameKey = [
    centre.x.toFixed(3),
    centre.y.toFixed(3),
    centre.span.toFixed(3),
    props.floorElevationMm,
    props.ceilingElevationMm,
  ].join(":");
  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    const saved = urlCamera.current;
    if (saved !== null && (saved.key === null || saved.key === frameKey)) {
      saved.key = frameKey;
      userMoved.current = true;
      applyCameraFrame(current, saved.frame);
      return;
    }
    urlCamera.current = null;
    userMoved.current = false;
    frameRoomRef.current();
  }, [frameKey]);

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    current.seeThroughEnabled = seeThroughWalls;
    invalidateWallOcclusion(current);
    refreshWallOcclusion(current);
    current.scheduler.invalidate();
  }, [seeThroughWalls]);

  useEffect(() => {
    const current = engine.current;
    if (current === null) return;
    const { scene, content, doorMotions } = current;
    const disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light> = [];
    const pickable: THREE.Object3D[] = [];
    const wallMeshes: THREE.Mesh[] = [];
    content.clear();
    doorMotions.clear();
    current.selectables.clear();
    current.cones.clear();
    current.dimTargets.length = 0;
    current.inspectIndex.clear();
    scene.children.filter((child) => child.userData.transient === true).forEach((child) => scene.remove(child));

    const floorZ = props.floorElevationMm;

    // Lights are driven in lux and candela, so the view is exposed for the
    // layout's own target rather than scaled per fixture.
    const surface: Surface | null = props.baked ?? props.illuminance;
    const referenceLux = surface?.threshold_lux ?? props.targetLux;
    current.renderer.toneMappingExposure = exposureForReferenceLux(referenceLux);

    const track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T): T => {
      disposables.push(value);
      return value;
    };
    const finishes = createArchitecturalMaterials();
    const floorMaterial = floorMaterialFor(props.floorFinish, finishes, track);
    disposables.push(...finishes.resources);

    addRoomShell(content, props, finishes, floorMaterial, track);
    addRoomWalls(content, props, finishes, track, pickable, wallMeshes, doorMotions);
    addRoomObjects(content, props, finishes, track, tableClosed, openCarcass);
    addStairs(content, props, finishes, track);
    addCoverage(content, props, surface, track);
    addRoomFixtures(current, props, finishes, track, pickable, centre);
    addIndirectAndDaylight(current, props, centre, referenceLux, track);

    current.pickable.length = 0;
    current.pickable.push(...pickable);
    current.walls.length = 0;
    current.walls.push(...wallMeshes);
    current.floorProbes.length = 0;
    // At the floor and at worktop height, so a wall in front of a basin or a WC
    // gives way even where the sightline to the floor clears its head.
    const outlineM = props.polygon.outer.map((point) => ({ x: point.x * MM, y: point.y * MM }));
    current.floorProbes.push(
      ...floorProbePoints(outlineM, floorZ * MM),
      ...floorProbePoints(outlineM, floorZ * MM + 0.85),
    );
    content.traverse((node) => {
      const target = inspectTargetOf(node.userData);
      if (target === null || !(node instanceof THREE.Mesh)) return;
      const key = inspectKey(target);
      const meshes = current.inspectIndex.get(key);
      if (meshes === undefined) current.inspectIndex.set(key, [node]);
      else meshes.push(node);
    });
    applySelection(current, selectionRef.current);
    applyDimming(current, dimRef.current);
    applyAmbient(current, outputShareRef.current);
    current.hoverHelper.visible = false;
    outlineTarget(current, current.inspectHelper, inspectedRef.current);
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
      current.selectedMaterial = null;
      for (const item of disposables) item.dispose();
    };
  }, [
    centre,
    props.polygon,
    props.walls,
    props.openings,
    props.objects,
    props.fixtures,
    props.switches,
    props.sensors,
    props.offGroups,
    props.illuminance,
    props.baked,
    props.stairs,
    props.darkZones,
    props.sunPatches,
    props.sunDirection,
    props.sunAltitudeDeg,
    props.floorElevationMm,
    props.ceilingElevationMm,
    props.taskPlaneElevationMm,
    props.targetLux,
    props.utilizationFactor,
    props.showLightRendering,
    tableClosed,
    openCarcass,
    props.showCoverage,
    props.showDarkZones,
    props.structuralCeilingElevationMm,
    props.showCeiling,
    props.isExternal,
    props.showGypsum,
    props.soffits,
    props.lowerLevels,
    props.floorFinish,
    props.wallFinish,
    props.featureWallId,
    props.featureWallColour,
    props.skirting,
    props.skirtingHeightMm,
    props.skirtingThicknessMm,
    props.cladWallIds,
  ]);

  useEffect(() => {
    const current = engine.current;
    if (current !== null) applySelection(current, props.selectedTags);
  }, [props.selectedTags]);

  useEffect(() => {
    const current = engine.current;
    if (current !== null) applyDimming(current, dimLevels);
  }, [dimLevels]);

  useEffect(() => {
    const current = engine.current;
    if (current !== null) applyAmbient(current, outputShare);
  }, [outputShare]);

  useEffect(() => {
    const current = engine.current;
    if (current !== null) outlineTarget(current, current.inspectHelper, inspected);
  }, [inspected]);

  // A capped light is a hole in the picture, not in the layout, so say so.
  const ratedFixtures = props.fixtures.filter(
    (fixture) => fixture.kind !== "rope_light" && fixture.spec.lumens !== null,
  ).length;
  const unlitFixtures = props.showLightRendering ? Math.max(ratedFixtures - MAX_REAL_LIGHTS, 0) : 0;

  function resetView() {
    userMoved.current = false;
    frameRoom();
  }

  function planView() {
    const current = engine.current;
    if (current === null) return;
    userMoved.current = true;
    applyCameraFrame(
      current,
      planViewFrame(viewBounds, props.floorElevationMm * MM, viewBounds.maxZ, current.camera.fov, current.camera.aspect),
    );
  }

  function eyeView() {
    const current = engine.current;
    if (current === null) return;
    userMoved.current = true;
    const standing = deepestInteriorPoint(props.polygon.outer);
    applyCameraFrame(
      current,
      eyeLevelFrame(
        { x: standing.x * MM, y: standing.y * MM },
        openestDirection(standing, props.polygon.outer),
        props.floorElevationMm * MM,
      ),
    );
  }

  function disclaimerText(): string {
    const lit = props.baked === null
      ? "Rendered light is a visual reading of the lumen and beam-cone approximation."
      : `Surface shows ${props.baked.method}: the same approximation with shadow rays against cabinetry, services and stairs.`;
    const capped = unlitFixtures > 0
      ? ` WebGL lights only ${MAX_REAL_LIGHTS} of ${ratedFixtures} rated spotlights, so ${unlitFixtures} contribute nothing to this image. The coverage surface and every check include all of them.`
      : "";
    const dimmed = dimLevels.size > 0 ? ` ${DIMMING_METHOD}` : "";
    const cut = tools.section.mode === "off" ? "" : " A section cut hides part of the room; its lighting is unchanged.";
    return `${lit} Shadows here are rendering, not photometry. Sun patches are direct-beam geometry. Architectural finishes are illustrative display materials.${capped}${dimmed}${cut}`;
  }

  const inspection = useMemo(
    () => inspected === null
      ? null
      : describeInspection(inspected, {
          objects: props.objects,
          walls: [...props.walls, ...props.lowerLevels.flatMap((level) => level.walls ?? [])],
          openings: [...props.openings, ...props.lowerLevels.flatMap((level) => level.openings ?? [])],
          stairs: props.stairs,
          floorElevationMm: props.floorElevationMm,
        }),
    [inspected, props.objects, props.walls, props.openings, props.stairs, props.lowerLevels, props.floorElevationMm],
  );

  const diningTable = props.objects.find((object) => (
    object.properties["Pset_HomeTwinFurniture.Role"] === "table"
    || object.name.toLowerCase().includes("dining table")
  ));
  const island = props.objects.filter((object) => object.properties["Pset_HomeTwinKitchen.Role"] === "island");
  const sofa = props.objects.find((object) => object.name.toLowerCase().includes("sofa back"));
  // Only kitchen units carry authored bays to open, and only an extending table has a closed depth.
  const hasCarcasses = props.objects.some((object) => object.properties["Pset_HomeTwinKitchen.Bays"] !== undefined);
  const hasTableLeaf = diningTable?.properties["Pset_HomeTwinFurniture.ClosedDepthMm"] !== undefined;

  function focusOn(objects: ReadonlyArray<BuildingObject>) {
    const current = engine.current;
    if (current === null || objects.length === 0) return;
    const boxOf = (items: ReadonlyArray<Pick<BuildingObject, "bounds">>): Box => ({
      minX: Math.min(...items.map((item) => item.bounds.minimum.x)) * MM,
      maxX: Math.max(...items.map((item) => item.bounds.maximum.x)) * MM,
      minY: Math.min(...items.map((item) => item.bounds.minimum.y)) * MM,
      maxY: Math.max(...items.map((item) => item.bounds.maximum.y)) * MM,
      minZ: Math.min(...items.map((item) => item.bounds.minimum.z)) * MM,
      maxZ: Math.max(...items.map((item) => item.bounds.maximum.z)) * MM,
    });
    const focused = new Set(objects.map((object) => object.id));
    const obstacles = [
      ...props.objects
        .filter((object) => !focused.has(object.id) && !isCeilingReveal(object))
        .filter((object) => object.bounds.maximum.z - object.bounds.minimum.z > 150)
        .filter((object) => !hiddenInCeilingVoid(object, props.ceilingElevationMm, props.showGypsum))
        .map((object) => boxOf([object])),
      ...props.fixtures.flatMap((fixture) => {
        if (fixture.kind !== "pendant_bulb") return [];
        const centre = pendantShadeCentre(fixture);
        const radius = (fixture.spec.bulb_diameter_mm * MM) / 2;
        return [{
          minX: centre.x - radius,
          maxX: centre.x + radius,
          minY: centre.y - radius,
          maxY: centre.y + radius,
          minZ: centre.z - radius,
          maxZ: centre.z + radius,
        }];
      }),
    ];
    userMoved.current = true;
    applyCameraFrame(
      current,
      focusFrame(
        boxOf(objects),
        props.polygon.outer.map((point) => ({ x: point.x * MM, y: point.y * MM })),
        props.floorElevationMm * MM,
        props.ceilingElevationMm * MM,
        current.camera.fov,
        current.camera.aspect,
        obstacles,
      ),
    );
  }

  const namedViews: NamedView[] = [
    ...(island.length > 0 ? [{ label: "Kitchen", onSelect: () => focusOn(island) }] : []),
    ...(diningTable ? [{ label: "Dining", onSelect: () => focusOn([diningTable]) }] : []),
    ...(sofa ? [{ label: "Lounge", onSelect: () => focusOn([sofa]) }] : []),
  ];

  if (unsupported !== null) {
    return (
      <div className="model-view model-view--unsupported" role="img" aria-label="3D view unavailable">
        <p>
          <strong>This browser cannot open a WebGL view.</strong>
          {unsupported}
        </p>
        <p>The 2D ceiling plan carries the same geometry and every layout check.</p>
      </div>
    );
  }

  // A dark room against a pale page reads as a hole, so the backdrop dims with it.
  const dark = props.showLightRendering
    && outputShare < 0.15
    && !(props.sunDirection !== null && (props.sunAltitudeDeg ?? -1) > 0);

  const gestures =
    "Double-click anything to look at it. Drag to orbit, middle or right drag to pan, and the wheel zooms where the " +
    "pointer is. Walls in the way fade out on their own. Click a cabinet, wall, window or stair to read its IFC " +
    "details. Drag a light to move it, shift-click to take several at once. Click a door to open or close it, and a " +
    "wall switch to preview its group or drag it onto a wall.";

  const toggleClass = (on: boolean) => on ? "tool-button tool-button--tight tool-button--active" : "tool-button tool-button--tight";

  return (
    <div className={dark ? "model-view model-view--dark" : "model-view"} ref={tools.frameRef}>
      <div className="model-canvas" ref={host} role="img" aria-label="Interactive 3D room view" />
      <ViewerRail tools={tools} onReset={resetView} onPlan={planView} onEye={eyeView} />
      <div className="viewer-cards">
        <SectionPanel tools={tools} bounds={viewBounds} />
        <MeasureReadout tools={tools} />
        <ShortcutHelp tools={tools} gestures={gestures} />
        {inspection !== null ? <ObjectInspector details={inspection} onClose={() => setInspected(null)} /> : null}
      </div>
      <ViewerStatus tools={tools} />
      <div className="model-overlay" role="toolbar" aria-label="3D view options">
        <ViewsMenu views={namedViews} />
        <button
          className={toggleClass(seeThroughWalls)}
          type="button"
          aria-pressed={seeThroughWalls}
          aria-label="See through walls"
          onClick={() => setSeeThroughWalls((value) => !value)}
          title="Fade the walls standing between the camera and what it is aimed at (X)"
        >
          <Eye size={15} aria-hidden="true" /> <span className="viewer-label">See through walls</span>
        </button>
        {hasCarcasses ? (
          <button
            className={toggleClass(openCarcass)}
            type="button"
            aria-pressed={openCarcass}
            onClick={() => setOpenCarcass((value) => !value)}
            title="Take the kitchen fronts off to show the carcasses and their bays"
          >
            Carcasses
          </button>
        ) : null}
        {hasTableLeaf ? (
          <button
            className={toggleClass(!tableClosed)}
            type="button"
            aria-pressed={!tableClosed}
            onClick={() => setTableClosed((value) => !value)}
            title="Show the dining table with its extension leaf in, or closed with the seats it then takes"
          >
            Table leaf
          </button>
        ) : null}
      </div>
      <ViewerHint tools={tools}>
        Drag to orbit, right drag to pan, scroll to zoom. Double-click to look at something. Press ? for more.
      </ViewerHint>
      <div className="viewer-footer">
        <p className="model-disclaimer">{disclaimerText()}</p>
        <span
          className="model-north"
          title={`True north is ${props.trueNorthDeg.toFixed(0)}° from plan +Y`}
        >
          <Compass size={14} aria-hidden="true" /> True north {props.trueNorthDeg.toFixed(0)}&deg;
        </span>
      </div>
    </div>
  );
}
