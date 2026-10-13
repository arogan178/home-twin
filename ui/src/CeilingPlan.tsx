import { CircleHelp, MousePointerClick, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type DragEvent, type PointerEvent } from "react";

import {
  beamFootprint,
  beamFootprintRadiusMm,
  extentOf,
  formatMillimetres,
  illuminanceCells,
  luxColour,
  northBearingInPlan,
  placedFixtures,
  polygonPoints,
  resolveDrag,
  wallBand,
  screenY,
  type AlignmentGuide,
  type RenderableLightSurface,
  type Vec2,
} from "./plan";
import { ENCLOSURE_MM, LEGS as HVAC_LEGS, ROUTE as HVAC_ROUTE, parseLegs } from "./hvacProperties";
import { planOutlineAngle } from "./planOutline";
import { PlanCompass, PlanScale, PlanZoom } from "./PlanControls";
import {
  LABEL_PX,
  labelSizeMm,
  objectLabelRequests,
  placeLabels,
  routeLabelOptions,
  type Box,
  type LabelledObject,
  type LabelRequest,
} from "./planLabels";
import { doorSwingSign } from "./doorSwing";
import { snapToGridMm } from "./fixtureArrangement";
import { pressSelection, releaseSelection } from "./selection";
import { usePlanViewport, viewBoxOf } from "./useViewport";
import { switchPoint } from "./switchGeometry";
import { parseRoute } from "./serviceRoutes";
import type {
  BuildingObject,
  PointFixture,
  DaylightSource,
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

import "./planView.css";

export { beamFootprintRadiusMm };

/** Drag-and-drop data type the Spot and Pendant buttons carry onto the plan. */
export const PLAN_DROP_TYPE = "application/x-home-twin-fixture";

type CeilingPlanProps = {
  readonly polygon: Design["ceiling"]["polygon"];
  readonly walls: Design["walls"];
  readonly objects: ReadonlyArray<BuildingObject>;
  readonly openings: ReadonlyArray<Opening>;
  readonly daylightSources: ReadonlyArray<DaylightSource>;
  readonly fixtures: ReadonlyArray<Fixture>;
  readonly switches?: ReadonlyArray<WallSwitch>;
  readonly floorElevationMm?: number;
  /** The finished ceiling; a service wholly above it is drawn as a ghost. */
  readonly ceilingElevationMm?: number | null;
  readonly darkZones: ReadonlyArray<{ point: Point; estimated_lux: number }>;
  readonly taskPlaneElevationMm: number;
  readonly selectedTags: ReadonlySet<FixtureTag>;
  readonly showDarkZones: boolean;
  readonly onSelect: (tags: ReadonlySet<FixtureTag>) => void;
  readonly onMove: (moves: ReadonlyArray<{ readonly tag: FixtureTag; readonly point: Point }>) => void;
  /** A Spot or Pendant dropped from the toolbar, at a grid-snapped plan point. */
  readonly onDropFixture?: (kind: "recessed_spotlight" | "pendant_bulb", at: Vec2) => void;
  readonly illuminance?: RenderableLightSurface | null;
  readonly showCoverage?: boolean;
  readonly showLightRendering?: boolean;
  readonly sunPatches?: ReadonlyArray<SunPatch>;
  readonly sunDirection?: Point | null;
  readonly sunAltitudeDeg?: number | null;
  readonly trueNorthDeg?: number;
  readonly stairs?: ReadonlyArray<Stair>;
  readonly soffits?: ReadonlyArray<Soffit>;
  /** Spacing a dragged spotlight lands on, in millimetres. */
  readonly snapMm?: number;
  readonly sensors?: ReadonlyArray<Sensor>;
  readonly onMoveSensor?: (moves: ReadonlyArray<{ readonly tag: string; readonly point: Point }>) => void;
};

type DragState =
  | { kind: "idle" }
  | {
      kind: "moving";
      pointerId: number;
      /** The fixture under the cursor; the grid snaps to this one. */
      lead: FixtureTag;
      grabbedAt: Vec2;
      origins: ReadonlyMap<FixtureTag, Point>;
      guides: ReadonlyArray<AlignmentGuide>;
      additive: boolean;
      moved: boolean;
    }
  | { kind: "marquee"; pointerId: number; from: Vec2; to: Vec2; additive: boolean };

const objectClass: Record<string, string> = {
  cabinet: "plan-object plan-object--cabinet",
  furniture: "plan-object plan-object--furniture",
  shadow_gap: "plan-object plan-object--shadow-gap",
  ac: "plan-object plan-object--service",
  beam: "plan-object plan-object--service",
  duct: "plan-object plan-object--service",
  pipe: "plan-object plan-object--service",
  extractor: "plan-object plan-object--service",
};

const OPENING_LABEL: Record<string, string> = {
  door: "DOOR",
  window: "WINDOW",
  sliding_door: "SLIDING",
  unfilled: "OPENING",
};

/** A doorway is circulation; only glazing is daylight context. */
function openingTitle(opening: Opening, spanMm: number): string {
  const span = `${formatMillimetres(spanMm)} mm wide, ${formatMillimetres(opening.head_height_mm - opening.sill_height_mm)} mm high`;
  if (opening.kind === "door") {
    return `${opening.name}: ${opening.exposure} doorway, ${span}; blocks nothing above its head`;
  }
  return `${opening.name}: ${span}; potential daylight, excluded from electric-light estimate`;
}

/** The plan rectangle a rubber-band drag covers, however it was dragged. */
function marqueeBox(from: Vec2, to: Vec2) {
  return {
    minX: Math.min(from.x, to.x),
    maxX: Math.max(from.x, to.x),
    minY: Math.min(from.y, to.y),
    maxY: Math.max(from.y, to.y),
  };
}

const NUDGE: Record<string, Vec2> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
};

/** Whether a label still fits along a run. */
function fitsAlong(label: string, runMm: number, mmPerPx: number): boolean {
  return runMm > labelSizeMm(label, LABEL_PX, mmPerPx).width;
}

const SERVICE_KINDS = new Set(["ac", "beam", "duct", "extractor"]);

/** A service wholly above the finished ceiling is hidden by it, so it is only a ghost in plan. */
function aboveCeiling(object: BuildingObject, ceilingElevationMm: number | null): boolean {
  return ceilingElevationMm !== null && SERVICE_KINDS.has(object.kind) && object.bounds.minimum.z >= ceilingElevationMm;
}

/** The drawn box a label must fit inside: the bounds, or the inner square of a turned outline. */
function objectLabelBox(object: BuildingObject): Box {
  const width = Number(object.properties["Pset_HomeTwinFurniture.WidthMm"]);
  const depth = Number(object.properties["Pset_HomeTwinFurniture.DepthMm"]);
  const bearing = Number(object.properties["Pset_HomeTwinFurniture.BearingDeg"]);
  const box = {
    minX: object.bounds.minimum.x,
    maxX: object.bounds.maximum.x,
    minY: screenY(object.bounds.maximum.y),
    maxY: screenY(object.bounds.minimum.y),
  };
  if (!Number.isFinite(width) || !Number.isFinite(depth) || !Number.isFinite(bearing) || bearing % 90 === 0) return box;
  const half = Math.min(width, depth) / 2;
  const x = (box.minX + box.maxX) / 2;
  const y = (box.minY + box.maxY) / 2;
  return { minX: x - half, maxX: x + half, minY: y - half, maxY: y + half };
}

function markBox(x: number, y: number, radius: number): Box {
  return { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius };
}

/** Enter or Space on a focused mark does what a click on it does. */
function onActivate(select: (additive: boolean) => void) {
  return (event: ReactKeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    select(event.shiftKey || event.metaKey || event.ctrlKey);
  };
}

/** A key press is a whole click: a modifier toggles one mark, otherwise it selects only that mark. */
function keySelection(current: ReadonlySet<FixtureTag>, tag: FixtureTag, additive: boolean): ReadonlySet<FixtureTag> {
  return additive ? pressSelection(current, tag, true) : new Set([tag]);
}

const KIND_NAME: Record<Fixture["kind"], string> = {
  recessed_spotlight: "spotlight",
  pendant_bulb: "pendant",
  rope_light: "rope light",
};

function screenFrameOf(svg: SVGSVGElement | null, chrome: HTMLElement | null): { visible: Box; chrome: Box } | null {
  const matrix = svg?.getScreenCTM?.();
  if (svg == null || chrome == null || matrix == null || !matrix.a || !matrix.d) return null;
  const toPlan = (rect: DOMRect, padPx: number): Box => {
    const xs = [(rect.left - padPx - matrix.e) / matrix.a, (rect.right + padPx - matrix.e) / matrix.a];
    const ys = [(rect.top - padPx - matrix.f) / matrix.d, (rect.bottom + padPx - matrix.f) / matrix.d];
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };
  const svgRect = svg.getBoundingClientRect();
  const chromeRect = chrome.getBoundingClientRect();
  if (svgRect.width === 0 || chromeRect.width === 0) return null;
  return { visible: toPlan(svgRect, 0), chrome: toPlan(chromeRect, 6) };
}

function sameFrame(a: { visible: Box; chrome: Box } | null, b: { visible: Box; chrome: Box } | null): boolean {
  if (a === null || b === null) return a === b;
  const close = (p: Box, q: Box) =>
    Math.abs(p.minX - q.minX) < 1 && Math.abs(p.maxX - q.maxX) < 1 && Math.abs(p.minY - q.minY) < 1 && Math.abs(p.maxY - q.maxY) < 1;
  return close(a.visible, b.visible) && close(a.chrome, b.chrome);
}

const HINT_KEY = "home-twin.hint.plan";

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

export function CeilingPlan({
  polygon,
  walls,
  objects,
  openings,
  daylightSources,
  fixtures,
  switches = [],
  floorElevationMm = 0,
  ceilingElevationMm = null,
  darkZones,
  taskPlaneElevationMm,
  selectedTags,
  showDarkZones,
  onSelect,
  onMove,
  onDropFixture,
  illuminance = null,
  showCoverage = false,
  showLightRendering = true,
  sunPatches = [],
  sunDirection = null,
  sunAltitudeDeg = null,
  trueNorthDeg = 0,
  stairs = [],
  soffits = [],
  snapMm = 10,
  sensors = [],
  onMoveSensor,
}: CeilingPlanProps) {
  const [drag, setDrag] = useState<DragState>({ kind: "idle" });
  const [hint, setHint] = useState(() => readHintOpen());
  // Walls and shafts stand outside the ceiling they bound, so the fit takes them too.
  const framed = [
    ...polygon.outer,
    ...walls.flatMap((wall) => wallBand(wall)),
    ...daylightSources.flatMap((source) => source.footprint.outer),
  ];
  const extent = extentOf(framed);
  const margin = Math.max(extent.width * 0.08, 600);
  const ceilingPoints = polygonPoints(polygon.outer);
  const coverageCells = showCoverage ? illuminanceCells(illuminance) : [];
  // The left button drags fixtures, so panning uses middle, right, or shift.
  const view = usePlanViewport(framed, margin, [1, 2]);
  const svgElement = useRef<SVGSVGElement | null>(null);
  const chromeElement = useRef<HTMLDivElement | null>(null);
  const bindSvg = view.bind.ref;
  const svgRef = useCallback(
    (node: SVGSVGElement | null) => {
      svgElement.current = node;
      bindSvg(node);
    },
    [bindSvg],
  );
  // The drawn area and the control column, in plan units, so labels stay on
  // screen and out from under the controls.
  const [screenFrame, setScreenFrame] = useState<{ visible: Box; chrome: Box } | null>(null);
  useLayoutEffect(() => {
    const next = screenFrameOf(svgElement.current, chromeElement.current);
    setScreenFrame((current) => (sameFrame(current, next) ? current : next));
  });

  function planPoint(event: PointerEvent<SVGElement> | DragEvent<SVGElement>): Vec2 | null {
    const target = event.currentTarget;
    const svg = target instanceof SVGSVGElement ? target : target.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (svg == null || matrix == null) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: -local.y };
  }

  // A sensor is a ceiling penetration on a plan position, like a spotlight, so
  // it takes the same drag: one snap grid, one set of alignment guides, and a
  // spot lines up with a sensor as readily as with another spot.
  const movable: ReadonlyArray<{ readonly tag: string; readonly point: Point }> = [
    ...placedFixtures(fixtures),
    ...sensors,
  ];
  const sensorTags = new Set(sensors.map((sensor) => sensor.tag));

  function resolveMove(drag: Extract<DragState, { kind: "moving" }>, cursor: Vec2) {
    const still = movable
      .filter((item) => !drag.origins.has(item.tag as FixtureTag))
      .map((item) => ({ tag: item.tag, at: { x: item.point.x, y: item.point.y } }));
    const resolved = resolveDrag(
      drag.origins,
      drag.lead,
      { x: cursor.x - drag.grabbedAt.x, y: cursor.y - drag.grabbedAt.y },
      still,
      snapMm,
      8 * view.mmPerPixel,
    );
    return {
      guides: resolved.guides,
      moves: resolved.moves.filter((move) => !sensorTags.has(move.tag)).map(
        (move) => ({ tag: move.tag as FixtureTag, point: move.point }),
      ),
      sensorMoves: resolved.moves.filter((move) => sensorTags.has(move.tag)),
    };
  }

  function startDrag(event: PointerEvent<SVGCircleElement>, tag: FixtureTag) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const next = pressSelection(selectedTags, tag, additive);
    onSelect(next);
    setHint(false);
    const grabbedAt = planPoint(event);
    if (grabbedAt === null || !next.has(tag)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      kind: "moving",
      pointerId: event.pointerId,
      lead: tag,
      grabbedAt,
      origins: new Map(
        movable
          .filter((item) => next.has(item.tag as FixtureTag))
          .map((item) => [item.tag as FixtureTag, item.point]),
      ),
      guides: [],
      additive,
      moved: false,
    });
  }

  function moveDrag(event: PointerEvent<SVGCircleElement>) {
    if (drag.kind !== "moving" || drag.pointerId !== event.pointerId) return;
    const cursor = planPoint(event);
    if (cursor === null) return;
    const resolved = resolveMove(drag, cursor);
    setDrag({ ...drag, guides: resolved.guides, moved: true });
    if (resolved.moves.length > 0) onMove(resolved.moves);
    if (resolved.sensorMoves.length > 0) onMoveSensor?.(resolved.sensorMoves);
  }

  function endDrag(event: PointerEvent<SVGCircleElement>) {
    if (drag.kind !== "moving" || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const narrowed = releaseSelection(selectedTags, drag.lead, drag.additive, drag.moved);
    setDrag({ kind: "idle" });
    if (narrowed !== null) onSelect(narrowed);
  }

  function startMarquee(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const from = planPoint(event);
    if (from === null) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!additive) onSelect(new Set());
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ kind: "marquee", pointerId: event.pointerId, from, to: from, additive });
  }

  function moveMarquee(event: PointerEvent<SVGSVGElement>) {
    if (drag.kind !== "marquee" || drag.pointerId !== event.pointerId) return;
    const to = planPoint(event);
    if (to !== null) setDrag({ ...drag, to });
  }

  function endMarquee(event: PointerEvent<SVGSVGElement>) {
    if (drag.kind !== "marquee" || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const box = marqueeBox(drag.from, drag.to);
    const caught = placedFixtures(fixtures)
      .filter(
        (fixture) =>
          fixture.point.x >= box.minX &&
          fixture.point.x <= box.maxX &&
          fixture.point.y >= box.minY &&
          fixture.point.y <= box.maxY,
      )
      .map((fixture) => fixture.tag);
    setDrag({ kind: "idle" });
    if (caught.length > 0) onSelect(new Set(drag.additive ? [...selectedTags, ...caught] : caught));
  }

  // Escape puts a drag back where it started, and the arrows step a selection
  // by one grid square, so neither placing nor undoing needs the mouse.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]") != null) return;
      if (event.key === "Escape" && drag.kind === "moving") {
        onMove([...drag.origins].map(([tag, point]) => ({ tag, point })));
        setDrag({ kind: "idle" });
        return;
      }
      const step = NUDGE[event.key];
      if (step === undefined || drag.kind !== "idle" || selectedTags.size === 0) return;
      event.preventDefault();
      const snap = Math.max(snapMm, 1);
      onMove(
        placedFixtures(fixtures)
          .filter((fixture) => selectedTags.has(fixture.tag))
          .map((fixture) => ({
            tag: fixture.tag,
            point: {
              x: fixture.point.x + step.x * snap,
              y: fixture.point.y + step.y * snap,
              z: fixture.point.z,
            },
          })),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drag, fixtures, onMove, selectedTags, snapMm]);

  const objectIds = new Set<string>();
  const uniqueObjects = objects.filter((object) => {
    if (objectIds.has(object.id)) return false;
    objectIds.add(object.id);
    return true;
  });

  // Chrome sits at a fixed screen size in the viewport corner, like a map's.
  // Sized off the room it was enormous in the living room and covered the
  // geometry in the L-shaped wet rooms.
  const px = view.mmPerPixel;
  const gridMm = Math.max(snapMm, 10);
  // A grid finer than a few pixels reads as a grey wash, so it steps up to metres.
  const minorGridVisible = gridMm / px >= 8;
  const coarseGrid = (gridMm * 5) / px < 8;
  const labelFont = LABEL_PX * px;

  const markRadius = (fixture: PointFixture) =>
    Math.max(
      fixture.kind === "recessed_spotlight" ? fixture.spec.diameter_mm / 2 : fixture.spec.bulb_diameter_mm / 2,
      58,
      6 * px,
    );
  const sensorRadius = (sensor: Sensor) => Math.max(sensor.spec.diameter_mm / 2, 58, 6 * px);
  const switchHalf = Math.max(55, 6 * px);
  const switchPoints = switches.flatMap((device) => {
    const point = switchPoint(device, walls, floorElevationMm);
    return point === null ? [] : [{ device, point }];
  });
  const ghostIds = new Set(
    uniqueObjects.filter((object) => aboveCeiling(object, ceilingElevationMm)).map((object) => object.id),
  );

  const marks: Box[] = [
    ...placedFixtures(fixtures).map((fixture) =>
      markBox(fixture.point.x, screenY(fixture.point.y), markRadius(fixture)),
    ),
    ...sensors.map((sensor) => markBox(sensor.point.x, screenY(sensor.point.y), sensorRadius(sensor))),
    ...switchPoints.map(({ point }) => markBox(point.x, screenY(point.y), switchHalf)),
  ];
  const clear = 4 * px;
  const beside = (tag: string, x: number, y: number, radius: number): LabelRequest => ({
    key: `mark:${tag}`,
    options: [{ text: tag, fontPx: LABEL_PX, placement: { kind: "beside", at: { x, y }, clearMm: radius + clear } }],
  });

  const wallLabels: LabelRequest[] = walls.flatMap((wall) => {
    const x1 = wall.start.x;
    const y1 = screenY(wall.start.y);
    const x2 = wall.end.x;
    const y2 = screenY(wall.end.y);
    const lengthMm = Math.hypot(x2 - x1, y2 - y1);
    let angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    if (angle > 90 || angle < -90) angle += 180;
    const text = formatMillimetres(lengthMm);
    if (!fitsAlong(text, lengthMm, px)) return [];
    const at = {
      x: (x1 + x2) / 2 - wall.inward_normal.x * 12 * px,
      y: (y1 + y2) / 2 + wall.inward_normal.y * 12 * px,
    };
    return [{ key: `wall:${wall.wall_id}`, options: [{ text, fontPx: LABEL_PX, placement: { kind: "at", at, angleDeg: angle } }] }];
  });

  const openingLabels: LabelRequest[] = openings.flatMap((opening, index) => {
    const rank = openings.filter((other) => other.host_wall_id === opening.host_wall_id).indexOf(opening);
    const spanMm = Math.hypot(opening.end.x - opening.start.x, opening.end.y - opening.start.y);
    const dirX = spanMm === 0 ? 1 : (opening.end.x - opening.start.x) / spanMm;
    const dirY = spanMm === 0 ? 0 : (opening.end.y - opening.start.y) / spanMm;
    const inward = walls.find((wall) => wall.wall_id === opening.host_wall_id)?.inward_normal ?? { x: 0, y: 1 };
    let angle = (Math.atan2(-dirY, dirX) * 180) / Math.PI;
    if (angle > 90 || angle < -90) angle += 180;
    // A label wider than the opening lands on its neighbours, so it gives up
    // the kind first and then the number; the tooltip keeps both.
    const kindLabel = OPENING_LABEL[opening.kind] ?? opening.kind.toUpperCase();
    const span = formatMillimetres(spanMm);
    const inset = (rank % 2 === 0 ? 12 : 26) * px;
    const at = {
      x: (opening.start.x + opening.end.x) / 2 + inward.x * inset,
      y: screenY((opening.start.y + opening.end.y) / 2) - inward.y * inset,
    };
    const texts = [`${kindLabel} ${span}`, span].filter((text) => fitsAlong(text, spanMm, px));
    return [{
      key: `opening:${opening.id}:${index}`,
      options: texts.map((text) => ({ text, fontPx: LABEL_PX, placement: { kind: "at", at, angleDeg: angle } as const })),
    }];
  });

  const areaLabels: LabelRequest[] = [
    ...soffits.map((soffit) => {
      const extent = extentOf(soffit.footprint.outer);
      const within = { minX: extent.minX, maxX: extent.maxX, minY: screenY(extent.maxY), maxY: screenY(extent.minY) };
      const at = { x: extent.minX + extent.width / 2, y: screenY(extent.minY + extent.height / 2) };
      const text = formatMillimetres(soffit.height_above_floor_mm);
      return { key: `soffit:${soffit.id}`, options: [{ text, fontPx: LABEL_PX, placement: { kind: "inside", at, within } as const }] };
    }),
    // A shaft is small, so its full name would run across the plan; the name
    // and role stay in the tooltip.
    ...daylightSources.map((source) => {
      const extent = extentOf(source.footprint.outer);
      const within = { minX: extent.minX, maxX: extent.maxX, minY: screenY(extent.maxY), maxY: screenY(extent.minY) };
      const at = { x: extent.minX + extent.width / 2, y: screenY(extent.minY + extent.height / 2) };
      return { key: `shaft:${source.id}`, options: [{ text: "SHAFT", fontPx: LABEL_PX, placement: { kind: "inside", at, within } as const }] };
    }),
  ];

  // A line set is a thin route, so its label runs along a leg rather than
  // floating in the middle of the room its bounding box spans.
  const routeLabels: LabelRequest[] = uniqueObjects.flatMap((object) => {
    if (object.kind !== "pipe" || ghostIds.has(object.id)) return [];
    const route = parseRoute(object.properties[HVAC_ROUTE]);
    const text = typeof object.properties.Tag === "string" ? object.properties.Tag : null;
    if (route === null || text === null) return [];
    const drawn = route.map((point) => ({ x: point.x * 1000, y: screenY(point.y * 1000) }));
    return [{ key: object.id, options: routeLabelOptions(drawn, text, LABEL_PX, px, 75 + 9 * px) }];
  });

  const labelled: LabelledObject[] = uniqueObjects
    .filter((object) => !ghostIds.has(object.id) && object.kind !== "pipe")
    .map((object) => ({
      id: object.id,
      name: object.name,
      tag: typeof object.properties.Tag === "string" ? object.properties.Tag : null,
      box: objectLabelBox(object),
      minZ: object.bounds.minimum.z,
      maxZ: object.bounds.maximum.z,
    }));

  // Marks name the lights being placed, so they claim space first; a selected
  // one before the rest, then walls and openings, then the room's contents.
  const labels = placeLabels(
    [
      ...[...placedFixtures(fixtures)]
        .sort((a, b) => Number(selectedTags.has(b.tag)) - Number(selectedTags.has(a.tag)))
        .map((fixture) => beside(fixture.tag, fixture.point.x, screenY(fixture.point.y), markRadius(fixture))),
      ...fixtures.flatMap((fixture) => {
        if (fixture.kind !== "rope_light" || fixture.path[0] === undefined) return [];
        const start = fixture.path[0];
        return [beside(fixture.tag, start.x, screenY(start.y), Math.max(fixture.spec.diameter_mm, 34) / 2)];
      }),
      ...sensors.map((sensor) => beside(sensor.tag, sensor.point.x, screenY(sensor.point.y), sensorRadius(sensor))),
      ...switchPoints.map(({ device, point }) => beside(device.tag, point.x, screenY(point.y), switchHalf)),
      ...openingLabels,
      ...wallLabels,
      ...areaLabels,
      ...routeLabels,
      ...objectLabelRequests(labelled),
    ],
    px,
    screenFrame === null ? marks : [...marks, screenFrame.chrome],
    screenFrame?.visible ?? null,
  );
  const labelClass = (key: string): string => {
    const [kind = "", rest = ""] = key.split(/:(.*)/s);
    if (kind === "mark") {
      return selectedTags.has(rest as FixtureTag) ? "plan-label fixture-label fixture-label--selected" : "plan-label fixture-label";
    }
    if (kind === "wall") return "plan-label wall-dimension";
    if (kind === "opening") {
      const opening = openings.find((candidate) => rest.startsWith(`${candidate.id}:`));
      return `plan-label opening-label opening-label--${opening?.kind ?? "window"}`;
    }
    if (kind === "soffit") return "plan-label soffit-label";
    if (kind === "shaft") return "plan-label shaft-label";
    return "plan-label object-label";
  };

  const northBearing = northBearingInPlan(trueNorthDeg);

  return (
    <div className="plan-frame">
    {hint ? (
      <div className="plan-hint" role="note">
        <MousePointerClick size={14} aria-hidden />
        <p>
          Drag a light or sensor to move it. Shift-click takes several, and dragging the background box-selects.
          Hold space to pan. Tab to a mark and press Enter to select it.
        </p>
        <button
          type="button"
          className="plan-hint-close"
          aria-label="Hide the plan tips"
          title="Hide the plan tips"
          onClick={() => {
            storeHintOpen(false);
            setHint(false);
          }}
        >
          <X size={13} />
        </button>
      </div>
    ) : null}
    <div className="plan-body">
    <svg
      className="ceiling-plan"
      viewBox={viewBoxOf(view.viewport)}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Interactive top-down ceiling plan"
      onContextMenu={(event) => event.preventDefault()}
      onDragOver={(event) => {
        if (onDropFixture !== undefined && event.dataTransfer.types.includes(PLAN_DROP_TYPE)) event.preventDefault();
      }}
      onDrop={(event) => {
        const kind = event.dataTransfer.getData(PLAN_DROP_TYPE);
        if (onDropFixture === undefined || (kind !== "recessed_spotlight" && kind !== "pendant_bulb")) return;
        event.preventDefault();
        const at = planPoint(event);
        if (at !== null) onDropFixture(kind, snapToGridMm(at, snapMm));
      }}
      style={{ "--mm-per-px": px } as CSSProperties}
      {...view.bind}
      ref={svgRef}
      onPointerDown={(event) => {
        view.bind.onPointerDown(event);
        if (!view.panning()) startMarquee(event);
      }}
      onPointerMove={(event) => {
        view.bind.onPointerMove(event);
        moveMarquee(event);
      }}
      onPointerUp={(event) => {
        view.bind.onPointerUp(event);
        endMarquee(event);
      }}
      onPointerCancel={(event) => {
        view.bind.onPointerCancel(event);
        endMarquee(event);
      }}
    >
      <defs>
        {/* The drawn grid is the grid a spotlight lands on, so lining lights
            up is a matter of reading the plan. */}
        <pattern id="minor-grid" width={gridMm} height={gridMm} patternUnits="userSpaceOnUse">
          {minorGridVisible ? (
            <path d={`M ${gridMm} 0 L 0 0 0 ${gridMm}`} className="grid-line grid-line--minor" />
          ) : null}
        </pattern>
        <pattern id="major-grid" width={gridMm * 5} height={gridMm * 5} patternUnits="userSpaceOnUse">
          <rect width={gridMm * 5} height={gridMm * 5} fill="url(#minor-grid)" />
          {coarseGrid ? null : (
            <path d={`M ${gridMm * 5} 0 L 0 0 0 ${gridMm * 5}`} className="grid-line grid-line--major" />
          )}
        </pattern>
        <pattern id="metre-grid" width="1000" height="1000" patternUnits="userSpaceOnUse">
          <path d="M 1000 0 L 0 0 0 1000" className="grid-line grid-line--major" />
        </pattern>
        <pattern id="daylight-hatch" width="100" height="100" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="100" height="100" fill="#d9edf5" fillOpacity="0.4" />
          <path d="M 0 0 V 100" className="daylight-hatch-line" />
        </pattern>
        <filter id="fixture-shadow" x="-80%" y="-80%" width="260%" height="260%">
          <feDropShadow dx="0" dy="18" stdDeviation="16" floodOpacity="0.18" />
        </filter>
        <radialGradient id="beam-glow">
          <stop offset="0%" stopColor="#ffd45a" stopOpacity="0.34" />
          <stop offset="72%" stopColor="#ffd45a" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#e7a900" stopOpacity="0.03" />
        </radialGradient>
        <radialGradient id="lamp-glow">
          <stop offset="0%" stopColor="#fff6dc" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#ffdb8a" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#ffca55" stopOpacity="0" />
        </radialGradient>
        <marker id="stair-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#2f4a5c" />
        </marker>
        <clipPath id="ceiling-clip">
          <polygon points={ceilingPoints} />
        </clipPath>
      </defs>

      <rect
        x={view.viewport.x}
        y={view.viewport.y}
        width={view.viewport.width}
        height={view.viewport.height}
        fill={coarseGrid ? "url(#metre-grid)" : "url(#major-grid)"}
      />
      <polygon points={ceilingPoints} className="ceiling-fill" />

      {soffits.map((soffit) => (
        <g key={soffit.id} className={`plan-soffit plan-soffit--${soffit.kind}`}>
          <polygon points={polygonPoints(soffit.footprint.outer)} />
          <title>{`${soffit.name}: gypsum ${soffit.kind}, underside ${formatMillimetres(soffit.height_above_floor_mm)} mm above the floor`}</title>
        </g>
      ))}

      {daylightSources.map((source) => (
        <g key={source.id} className="daylight-source">
          <polygon points={polygonPoints(source.footprint.outer)} />
          <title>{`${source.name} · ${source.daylight_role}`}</title>
        </g>
      ))}

      {coverageCells.length > 0 ? (
        <g clipPath="url(#ceiling-clip)" className="coverage-layer" pointerEvents="none">
          {coverageCells.map((cell) => (
            <rect
              key={`lux-${cell.x}-${cell.y}`}
              x={cell.x - cell.sizeMm / 2}
              y={screenY(cell.y) - cell.sizeMm / 2}
              width={cell.sizeMm}
              height={cell.sizeMm}
              fill={luxColour(cell.intensity)}
              opacity={0.18 + 0.6 * cell.intensity}
            />
          ))}
        </g>
      ) : null}

      {sunPatches.length > 0 ? (
        <g clipPath="url(#ceiling-clip)" className="sun-patch-layer" pointerEvents="none">
          {sunPatches.flatMap((patch) =>
            patch.pieces.map((piece, index) => (
              <polygon key={`sun-${patch.opening_id}-${index}`} points={polygonPoints(piece.outer)} className="sun-patch">
                <title>
                  {`${patch.opening_name} direct-sun patch, ${patch.area_m2.toFixed(2)} m² at Z ${formatMillimetres(patch.plane_elevation_mm)} mm; geometry only`}
                </title>
              </polygon>
            )),
          )}
        </g>
      ) : null}

      <g clipPath="url(#ceiling-clip)" pointerEvents="none">
        {fixtures.filter((fixture) => fixture.kind === "recessed_spotlight").map((fixture) => {
          const footprint = beamFootprint(fixture, taskPlaneElevationMm);
          const className = selectedTags.has(fixture.tag) ? "fixture-beam fixture-beam--selected" : "fixture-beam";
          const title = `${fixture.tag} geometric beam footprint at Z ${formatMillimetres(taskPlaneElevationMm)} mm`;
          if (footprint.radiusMm <= 0) return null;
          if (footprint.tilted) {
            return (
              <polygon key={`beam-${fixture.tag}`} points={polygonPoints(footprint.outline)} className={className}>
                <title>{title}</title>
              </polygon>
            );
          }
          return (
            <circle
              key={`beam-${fixture.tag}`}
              cx={fixture.point.x}
              cy={screenY(fixture.point.y)}
              r={footprint.radiusMm}
              className={className}
            >
              <title>{title}</title>
            </circle>
          );
        })}
        {showLightRendering
          ? fixtures.filter((fixture) => fixture.kind === "recessed_spotlight").map((fixture) => {
              const footprint = beamFootprint(fixture, taskPlaneElevationMm);
              if (footprint.radiusMm <= 0) return null;
              return (
                <circle
                  key={`glow-${fixture.tag}`}
                  cx={footprint.centre.x}
                  cy={screenY(footprint.centre.y)}
                  r={footprint.radiusMm * 0.92}
                  className="fixture-glow"
                  fill="url(#lamp-glow)"
                />
              );
            })
          : null}
      </g>

      {showDarkZones
        ? darkZones.map((zone) => (
            <g key={`${zone.point.x}-${zone.point.y}`} className="dark-zone">
              <circle cx={zone.point.x} cy={screenY(zone.point.y)} r="42" />
              <path
                d={`M ${zone.point.x - 28} ${screenY(zone.point.y)} h 56 M ${zone.point.x} ${screenY(zone.point.y) - 28} v 56`}
              />
            </g>
          ))
        : null}

      {stairs.map((stair) => {
        const ring = stair.footprint.outer;
        const bearing = (stair.up_bearing_deg * Math.PI) / 180;
        const ux = Math.sin(bearing);
        const uy = Math.cos(bearing);
        const alongs = ring.map((point) => point.x * ux + point.y * uy);
        const acrosses = ring.map((point) => point.x * uy - point.y * ux);
        const minAlong = Math.min(...alongs);
        const minAcross = Math.min(...acrosses);
        const maxAcross = Math.max(...acrosses);
        const going = Math.max(...alongs) - minAlong;
        const step = going / Math.max(stair.tread_count, 1);
        const nosings = Array.from({ length: Math.max(stair.tread_count - 1, 0) }, (_, index) => {
          const at = minAlong + step * (index + 1);
          return {
            x1: at * ux + minAcross * uy,
            y1: at * uy - minAcross * ux,
            x2: at * ux + maxAcross * uy,
            y2: at * uy - maxAcross * ux,
          };
        });
        const arrowFrom = { x: (minAlong + step * 0.4) * ux + ((minAcross + maxAcross) / 2) * uy,
                            y: (minAlong + step * 0.4) * uy - ((minAcross + maxAcross) / 2) * ux };
        const arrowTo = { x: (minAlong + going - step * 0.3) * ux + ((minAcross + maxAcross) / 2) * uy,
                          y: (minAlong + going - step * 0.3) * uy - ((minAcross + maxAcross) / 2) * ux };
        return (
          <g key={stair.id} className="plan-stair">
            <polygon points={polygonPoints(ring)} />
            {nosings.map((line, index) => (
              <line
                key={`${stair.id}-tread-${index}`}
                x1={line.x1}
                y1={screenY(line.y1)}
                x2={line.x2}
                y2={screenY(line.y2)}
              />
            ))}
            <path
              className="plan-stair-arrow"
              d={`M ${arrowFrom.x} ${screenY(arrowFrom.y)} L ${arrowTo.x} ${screenY(arrowTo.y)}`}
            />
            <title>
              {`${stair.name}: ${stair.tread_count} treads at ${Math.round(stair.tread_depth_mm)} mm, rising ${Math.round(stair.rise_mm)} mm`}
            </title>
          </g>
        );
      })}

      {uniqueObjects.map((object) => {
        const objectWidth = object.bounds.maximum.x - object.bounds.minimum.x;
        const objectHeight = object.bounds.maximum.y - object.bounds.minimum.y;
        // A turned object's bounding box is not its shape. Where the plan
        // dimensions and bearing are authored, draw the outline itself: an SVG
        // rect whose corner radius is half its width is the stadium of an oval table.
        const authoredWidth = Number(object.properties["Pset_HomeTwinFurniture.WidthMm"]);
        const authoredDepth = Number(object.properties["Pset_HomeTwinFurniture.DepthMm"]);
        const bearing = Number(object.properties["Pset_HomeTwinFurniture.BearingDeg"]);
        const turned =
          Number.isFinite(authoredWidth) && Number.isFinite(authoredDepth) && Number.isFinite(bearing);
        const centreX = (object.bounds.minimum.x + object.bounds.maximum.x) / 2;
        const centreY = screenY((object.bounds.minimum.y + object.bounds.maximum.y) / 2);
        const outline = object.properties["Pset_HomeTwinFurniture.Shape"];
        const radius =
          outline === "oval" || outline === "round" ? authoredWidth / 2 : outline === "rounded_rectangle" ? 40 : 0;
        const ghost = ghostIds.has(object.id);
        const shapeClass = ghost
          ? "plan-object plan-object--above-ceiling"
          : (objectClass[object.kind] ?? "plan-object");
        // A line set wraps a room; its hull would cover the ceiling it runs round.
        const route = object.kind === "pipe" ? parseRoute(object.properties[HVAC_ROUTE]) : null;
        if (route !== null) {
          const legs = parseLegs(object.properties[HVAC_LEGS], route.length - 1);
          return (
            <g key={object.id}>
              {legs === null ? (
                <polyline
                  points={route.map((point) => `${point.x * 1000},${screenY(point.y * 1000)}`).join(" ")}
                  className={`${shapeClass} plan-object--route`}
                />
              ) : (
                // Each leg at its own enclosure's width: a gypsum box is 150, clipped copper 30.
                legs.map((leg, index) => (
                  <line
                    key={index}
                    x1={route[index]!.x * 1000}
                    y1={screenY(route[index]!.y * 1000)}
                    x2={route[index + 1]!.x * 1000}
                    y2={screenY(route[index + 1]!.y * 1000)}
                    className={`${shapeClass} plan-object--route`}
                    style={{ strokeWidth: ENCLOSURE_MM[leg]![0] }}
                  />
                ))
              )}
              <title>{object.name}</title>
            </g>
          );
        }
        return (
          <g key={object.id} pointerEvents={ghost ? "none" : undefined}>
            <title>
              {ghost
                ? `${object.name}: above the finished ceiling, ${formatMillimetres(object.bounds.minimum.z)} to ${formatMillimetres(object.bounds.maximum.z)} mm`
                : object.name}
            </title>
            {/* A diagonal duct's bounding box is twice its width. Where the true
                outline is authored, draw it, so an exclusion is not overstated. */}
            {object.plan_footprint && !turned ? (
              <polygon
                points={polygonPoints(object.plan_footprint.outer)}
                className={shapeClass}
              />
            ) : turned ? (
              <rect
                x={centreX - authoredWidth / 2}
                y={centreY - authoredDepth / 2}
                width={Math.max(authoredWidth, 1)}
                height={Math.max(authoredDepth, 1)}
                rx={radius}
                transform={`rotate(${planOutlineAngle(bearing)} ${centreX} ${centreY})`}
                className={shapeClass}
              />
            ) : (
            <rect
              x={object.bounds.minimum.x}
              y={screenY(object.bounds.maximum.y)}
              width={Math.max(objectWidth, 1)}
              height={Math.max(objectHeight, 1)}
              className={shapeClass}
            />
            )}
          </g>
        );
      })}

      {walls.map((wall) => {
        const x1 = wall.start.x;
        const y1 = screenY(wall.start.y);
        const x2 = wall.end.x;
        const y2 = screenY(wall.end.y);
        return (
          <g key={wall.wall_id}>
            <polygon
              className="wall-body"
              points={polygonPoints(wallBand(wall))}
            />
            <line x1={x1} y1={y1} x2={x2} y2={y2} className="wall-line" />
          </g>
        );
      })}

      {openings.map((opening, openingIndex) => {
        const spanMm = Math.hypot(opening.end.x - opening.start.x, opening.end.y - opening.start.y);
        const dirX = spanMm === 0 ? 1 : (opening.end.x - opening.start.x) / spanMm;
        const dirY = spanMm === 0 ? 0 : (opening.end.y - opening.start.y) / spanMm;
        const host = walls.find((wall) => wall.wall_id === opening.host_wall_id);
        const inward = host?.inward_normal ?? { x: 0, y: 1 };
        const leaf = Math.min(spanMm, 900);
        const swingSign = doorSwingSign(opening.swing, { x: dirX, y: dirY }, inward);
        const sideX = -dirY * swingSign;
        const sideY = dirX * swingSign;
        const openX = opening.start.x + sideX * leaf;
        const openY = opening.start.y + sideY * leaf;
        const closedX = opening.start.x + dirX * leaf;
        const closedY = opening.start.y + dirY * leaf;
        // Draw the leaf on its authored side and the arc from the closed leaf
        // to that open position. An unspecified swing keeps the legacy inward
        // drawing convention.
        const swing = `M ${opening.start.x} ${screenY(opening.start.y)} ` +
          `L ${openX} ${screenY(openY)} ` +
          `M ${closedX} ${screenY(closedY)} ` +
          `A ${leaf} ${leaf} 0 0 ${swingSign > 0 ? 0 : 1} ${openX} ${screenY(openY)}`;
        return (
          <g key={`${opening.id}-${openingIndex}`} className={`plan-opening plan-opening--${opening.kind}`}>
            <line
              x1={opening.start.x}
              y1={screenY(opening.start.y)}
              x2={opening.end.x}
              y2={screenY(opening.end.y)}
            />
            {opening.kind === "door" ? <path className="plan-door-swing" d={swing} /> : null}
            <title>{openingTitle(opening, spanMm)}</title>
          </g>
        );
      })}

      {fixtures.map((fixture) => {
        const selected = selectedTags.has(fixture.tag);
        const name = `${fixture.tag}, ${KIND_NAME[fixture.kind]}`;
        if (fixture.kind === "rope_light") {
          return (
            <g
              key={fixture.tag}
              className={selected ? "fixture fixture--selected plan-mark" : "fixture plan-mark"}
              role="button"
              tabIndex={0}
              aria-label={name}
              aria-pressed={selected}
              onPointerDown={() => onSelect(new Set([fixture.tag]))}
              onKeyDown={onActivate(() => onSelect(new Set([fixture.tag])))}
            >
              <polyline points={polygonPoints(fixture.path)} className="rope-light-mark" fill="none" strokeWidth={Math.max(fixture.spec.diameter_mm, 34)} />
            </g>
          );
        }
        const radius = markRadius(fixture);
        const x = fixture.point.x;
        const y = screenY(fixture.point.y);
        return (
          <g
            key={fixture.tag}
            className={`${selected ? "fixture fixture--selected" : "fixture"}${fixture.kind === "pendant_bulb" ? " fixture--pendant" : ""} plan-mark`}
            role="button"
            tabIndex={0}
            aria-label={name}
            aria-pressed={selected}
            onKeyDown={onActivate((additive) => onSelect(keySelection(selectedTags, fixture.tag, additive)))}
          >
            <circle cx={x} cy={y} r={radius + 5 * px} className="mark-focus-ring" pointerEvents="none" />
            <circle
              cx={x}
              cy={y}
              r={radius + (selected ? 24 : 10) + 3 * px}
              className="fixture-hit"
              onPointerDown={(event) => startDrag(event, fixture.tag)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
            <circle cx={x} cy={y} r={radius} className="fixture-mark" filter="url(#fixture-shadow)" pointerEvents="none" />
            <path
              d={`M ${x - radius * 0.55} ${y} h ${radius * 1.1} M ${x} ${y - radius * 0.55} v ${radius * 1.1}`}
              className="fixture-cross"
              pointerEvents="none"
            />
          </g>
        );
      })}
      {switchPoints.map(({ device, point }) => {
        const selected = selectedTags.has(device.tag as FixtureTag);
        const x = point.x;
        const y = screenY(point.y);
        const select = () => onSelect(new Set([device.tag as FixtureTag]));
        return (
          <g
            key={device.tag}
            className={selected ? "wall-switch wall-switch--selected plan-mark" : "wall-switch plan-mark"}
            role="button"
            tabIndex={0}
            aria-label={`${device.tag}, wall switch`}
            aria-pressed={selected}
            onPointerDown={select}
            onKeyDown={onActivate(select)}
          >
            <rect x={x - switchHalf} y={y - switchHalf} width={switchHalf * 2} height={switchHalf * 2} rx={switchHalf / 3} />
            <path d={`M ${x - switchHalf * 0.4} ${y + switchHalf * 0.4} L ${x + switchHalf * 0.4} ${y - switchHalf * 0.4}`} />
          </g>
        );
      })}
      {sensors.map((sensor) => {
        const selected = selectedTags.has(sensor.tag as FixtureTag);
        const radius = sensorRadius(sensor);
        const y = screenY(sensor.point.y);
        return (
          <g
            key={sensor.tag}
            className={selected ? "sensor-mark sensor-mark--selected plan-mark" : "sensor-mark plan-mark"}
            role="button"
            tabIndex={0}
            aria-label={`${sensor.tag}, movement sensor`}
            aria-pressed={selected}
            onKeyDown={onActivate((additive) =>
              onSelect(keySelection(selectedTags, sensor.tag as FixtureTag, additive)),
            )}
          >
            <circle cx={sensor.point.x} cy={y} r={radius + 5 * px} className="mark-focus-ring" pointerEvents="none" />
            <circle
              cx={sensor.point.x}
              cy={y}
              r={radius + (selected ? 24 : 10) + 3 * px}
              className="fixture-hit"
              onPointerDown={(event) => startDrag(event, sensor.tag as FixtureTag)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <title>
                {`${sensor.tag} switches ${sensor.switching_group ?? sensor.controls_tag}, `
                  + `${sensor.run_on_minutes} min run-on`}
              </title>
            </circle>
            <circle cx={sensor.point.x} cy={y} r={radius} className="sensor-body" pointerEvents="none" />
            {/* Three arcs, so a movement sensor does not read as a small downlight. */}
            {[0.45, 0.7, 0.95].map((scale) => (
              <path
                key={scale}
                d={`M ${sensor.point.x - radius * scale} ${y} A ${radius * scale} ${radius * scale} 0 0 1 ${sensor.point.x + radius * scale} ${y}`}
                className="sensor-wave"
                pointerEvents="none"
              />
            ))}
          </g>
        );
      })}

      <g className="plan-labels" pointerEvents="none">
        {labels.map((label) => (
          <text
            key={label.key}
            x={label.x}
            y={label.y}
            style={{ fontSize: labelFont }}
            textAnchor="middle"
            dominantBaseline="central"
            transform={label.angleDeg === 0 ? undefined : `rotate(${label.angleDeg} ${label.x} ${label.y})`}
            className={labelClass(label.key)}
          >
            {label.text}
          </text>
        ))}
      </g>

      {drag.kind === "moving"
        ? drag.guides.map((guide) => {
            const reach = 140 * px;
            const from = guide.fromMm - reach;
            const to = guide.toMm + reach;
            const line =
              guide.axis === "column"
                ? { x1: guide.atMm, x2: guide.atMm, y1: screenY(from), y2: screenY(to) }
                : { x1: from, x2: to, y1: screenY(guide.atMm), y2: screenY(guide.atMm) };
            return (
              <line
                key={`${guide.axis}-${guide.atMm}`}
                {...line}
                className="alignment-guide"
                strokeDasharray={`${5 * px} ${5 * px}`}
                pointerEvents="none"
              />
            );
          })
        : null}

      {drag.kind === "marquee"
        ? (() => {
            const box = marqueeBox(drag.from, drag.to);
            return (
              <rect
                x={box.minX}
                y={screenY(box.maxY)}
                width={box.maxX - box.minX}
                height={box.maxY - box.minY}
                className="plan-marquee"
                pointerEvents="none"
              />
            );
          })()
        : null}
    </svg>
    <div className="plan-chrome" ref={chromeElement}>
      <div className="plan-chrome-row">
        {hint ? null : (
          <button
            type="button"
            className="plan-hint-toggle"
            aria-label="Show the plan tips"
            title="Show the plan tips"
            onClick={() => {
              storeHintOpen(true);
              setHint(true);
            }}
          >
            <CircleHelp size={15} />
          </button>
        )}
        <PlanZoom view={view} fitLabel="Fit the room" />
      </div>
      <PlanCompass northBearingDeg={northBearing} sunDirection={sunDirection} sunAltitudeDeg={sunAltitudeDeg} />
      <PlanScale mmPerPx={px} />
    </div>
    </div>
    </div>
  );
}
