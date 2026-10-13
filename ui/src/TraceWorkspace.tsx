/**
 * Trace a plan into the reviewed source that the plan compiler turns into IFC.
 *
 * The document edited here is exactly the server's plan source file. There is
 * no second building model and no browser-side session: every save writes the
 * reviewed source under a revision guard, and every build runs the same
 * deterministic compiler with the same verification the CLI uses.
 */

import {
  AlertTriangle,
  Eye,
  GitCommitHorizontal,
  LoaderCircle,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type WheelEvent,
} from "react";

import { api } from "./api";
import { useLoadState } from "./queryClient";
import {
  calibrateUnderlay,
  extentOf,
  screenY,
  millimetresPerPixel,
  offsetAlongEdge,
  snapRadii,
  snapToGeometry,
  underlayTransform,
  type Vec2,
} from "./plan";
import {
  TraceApertures,
  TraceCalibrationMarks,
  TraceControls,
  TracePoints,
  TraceRooms,
  TraceShafts,
  TraceSoffits,
  TraceUnderlayImage,
} from "./TraceCanvasLayers";
import { TraceDrawingOverlay } from "./TraceDrawingOverlay";
import { TraceInspector, type Selection } from "./TraceInspector";
import { TracePlanChecks, TraceReviewDock } from "./TraceReview";
import { TraceTaskBar } from "./TraceTaskBar";
import { TraceSelectionToolbar, type ToolbarSelection } from "./TraceSelectionToolbar";
import { TraceShortcutsDialog } from "./TraceShortcutsDialog";
import { planBoxToScreen } from "./selectionToolbar";
import { NUDGE_LARGE_MM, NUDGE_MM, TASK_SHORTCUTS, UNDERLAY_KEY } from "./traceShortcuts";
import {
  describePreview,
  orthoLock,
  pointAtLength,
  rectangleCorners,
  roundTenthMm,
  snapOnAxis,
  wallOffset,
  type DrawPreview,
} from "./traceDrawing";
import {
  HAND_EVIDENCE_ID,
  POINT_IN_USE,
  allPoints,
  cornerPointIds,
  hostEdges,
  nearestRoomOutline,
  nextId,
  pointIdAt,
  referencedPointIds,
  roomRing,
  soffitHost,
  tracedSegments,
  withAperture,
  withControl,
  withHandPoints,
  withInsertedRoomPoint,
  withMovedWall,
  withNudgedAperture,
  withNudgedPoint,
  withPointAt,
  withReanchoredControl,
  withRoom,
  withShaft,
  withSoffit,
  withUnderlay,
  withUnderlayCalibration,
  withUnderlayOrigin,
  withUpdatedAperture,
  withoutAperture,
  withoutControl,
  withoutPoint,
  withoutRoom,
  withoutShaft,
  withoutSoffit,
} from "./traceDocument";
import { useSpaceHeld } from "./useViewport";
import {
  PlanDocumentSchema,
  type LoadState,
  type PlanAperture,
  type PlanDocument,
  type PlanReview,
} from "./types";

type Tool = "select" | "insert" | "room" | "shaft" | "soffit" | "control" | "reanchor" | "aperture" | "calibrate";

type Draft = {
  readonly document: PlanDocument;
  readonly revision: string;
  readonly dirty: boolean;
};

const SNAP_MM = 10;
const HISTORY_STEPS = 50;
/**
 * Hit and draw sizes are screen pixels, converted to millimetres for the
 * current zoom. Sizing them in millimetres made a point a fraction of a pixel
 * once the whole flat was in view, so there was nothing to aim at.
 */
const POINT_RADIUS_PX = 6;
const LABEL_PX = 12;
/** Closing a loop back onto its first point needs a forgiving snap. */
/** And a wide zoom must not snap every click onto whichever point is nearest. */
/**
 * Dragging snaps tighter than picking. Reusing the pick radius made a dragged
 * point stick to a neighbour half a metre away, which at building scale reads
 * as the drag being ignored.
 */

/** Whether a pointer has moved far enough in plan terms to count as a drag. */
function pastThreshold(from: Vec2, to: Vec2, thresholdMm = 40): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= thresholdMm;
}

const ARROW_AXES: Readonly<Record<string, Vec2>> = {
  ArrowRight: { x: 1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
};

/** Tools whose clicks place corners into the pending queue. */
function isPlacingTool(tool: Tool): boolean {
  return tool === "room" || tool === "shaft" || tool === "soffit" || tool === "control" || tool === "reanchor";
}

function fittedView(document: PlanDocument) {
  const extent = extentOf(allPoints(document));
  const margin = Math.max(extent.width, extent.height) * 0.12 + 500;
  return {
    x: extent.minX - margin,
    y: screenY(extent.maxY) - margin,
    width: extent.width + margin * 2,
    height: extent.height + margin * 2,
  };
}

export function TraceWorkspace({
  onModelRebuilt,
}: {
  readonly onModelRebuilt: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  // Every mount reads the source fresh: the draft is seeded once from it, and a
  // cached copy could carry a revision that a save would then be rejected for.
  const traceQuery = useQuery({ queryKey: ["trace"], queryFn: ({ signal }) => api.trace(signal), gcTime: 0 });
  const loaded = useLoadState(traceQuery, "The plan trace could not load");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<LoadState<PlanReview>>({ kind: "loading" });
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [hover, setHover] = useState<{ rawMm: Vec2; shift: boolean } | null>(null);
  const [reanchoring, setReanchoring] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<Vec2[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "saving" | "building">("idle");
  const [view, setView] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [underlayUrl, setUnderlayUrl] = useState<string | null>(null);
  const undoStack = useRef<PlanDocument[]>([]);
  const redoStack = useRef<PlanDocument[]>([]);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const [dragActive, setDragActive] = useState(false);
  const [underlayHidden, setUnderlayHidden] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [canvas, setCanvas] = useState({ width: 1, height: 1 });
  const svg = useRef<SVGSVGElement | null>(null);
  const canvasObserver = useRef<ResizeObserver | null>(null);
  // A callback ref, because the canvas is only mounted once the plan source has
  // loaded; a mount-time effect measured a null element and never ran again,
  // which left one pixel standing for the whole plan.
  const attachCanvas = useCallback((node: SVGSVGElement | null) => {
    canvasObserver.current?.disconnect();
    canvasObserver.current = null;
    svg.current = node;
    if (node === null) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setCanvas({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) });
    };
    measure();
    // Degrade to the single measurement where ResizeObserver is unavailable,
    // rather than taking the whole canvas down with a ReferenceError.
    if (typeof ResizeObserver === "undefined") return;
    canvasObserver.current = new ResizeObserver(measure);
    canvasObserver.current.observe(node);
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const savedDocument = useRef<string>("");
  const spaceHeld = useSpaceHeld();
  const panning = useRef<{
    pointerId: number;
    startClient: Vec2;
    view: { x: number; y: number };
    mmPerPx: number;
  } | null>(null);
  // A drag carries where it was grabbed and where it started, so a click
  // selects without moving and a slide keeps the grab point under the cursor.
  const dragging = useRef<{ pointerId: number; id: string; from: Vec2 } | null>(null);
  const apertureDrag = useRef<{
    pointerId: number;
    id: string;
    from: Vec2;
    grabOffsetMm: number;
  } | null>(null);
  // A rectangle is only drawn once a press with no corners placed travels
  // past the drag threshold; a release before that is an ordinary click.
  const rectDrag = useRef<{ pointerId: number; from: Vec2; start: DrawPreview } | null>(null);
  const wallDrag = useRef<{
    pointerId: number;
    ids: readonly [string, string];
    from: Vec2;
    startMm: Vec2;
    endMm: Vec2;
    lines: Array<readonly [Vec2, Vec2]>;
  } | null>(null);
  const movedRef = useRef(false);
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  useEffect(() => {
    if (pending.length === 0) setTyped("");
  }, [pending.length]);

  const dirty = draft?.dirty ?? false;
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Fit the view once the document is known.
  useEffect(() => {
    if (draft === null || view !== null) return;
    setView(fittedView(draft.document));
  }, [draft, view]);

  // Review the working document without writing anything.
  useEffect(() => {
    if (draft === null || !draft.dirty) return undefined;
    const controller = new AbortController();
    setReview({ kind: "loading" });
    const timer = window.setTimeout(() => {
      void api.reviewTrace(draft.document, controller.signal).then(
        (response) => setReview({ kind: "ready", value: response.review }),
        (error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setReview({ kind: "error", message: error instanceof Error ? error.message : "Review failed" });
        },
      );
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft]);

  // Dirty means "differs from the saved source", not "was edited at some point",
  // so undoing back to the saved state re-enables Build instead of demanding a
  // redundant save.
  // A pointer drag fires faster than React re-renders, so edits read the latest
  // document from a ref rather than the render closure. Pushing history from
  // inside a state updater also duplicated entries under StrictMode.
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  // Save and build set the draft from their own response.
  useEffect(() => {
    const value = traceQuery.data;
    if (value === undefined || draftRef.current !== null) return;
    savedDocument.current = JSON.stringify(value.document);
    setDraft({ document: value.document, revision: value.revision, dirty: false });
    setReview({ kind: "ready", value: value.review });
    setUnderlayUrl(value.underlay_url === null ? null : `${value.underlay_url}?v=${value.revision.slice(7, 19)}`);
  }, [traceQuery.data]);

  const edit = useCallback(
    (change: (document: PlanDocument) => PlanDocument, record = true) => {
      const current = draftRef.current;
      if (current === null) return;
      const next = change(current.document);
      if (next === current.document) return;
      if (record) {
        undoStack.current = [...undoStack.current.slice(1 - HISTORY_STEPS), current.document];
        redoStack.current = [];
        setHistoryDepth({ undo: undoStack.current.length, redo: 0 });
      }
      const updated = {
        ...current,
        document: next,
        dirty: JSON.stringify(next) !== savedDocument.current,
      };
      draftRef.current = updated;
      setDraft(updated);
    },
    [],
  );

  function clearHistory() {
    undoStack.current = [];
    redoStack.current = [];
    setHistoryDepth({ undo: 0, redo: 0 });
  }

  /** Undo or redo one step; the document left behind goes onto the other stack. */
  function stepHistory(direction: "undo" | "redo") {
    const current = draftRef.current;
    const [from, to] = direction === "undo" ? [undoStack, redoStack] : [redoStack, undoStack];
    const restored = from.current.at(-1);
    if (current === null || restored === undefined) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current.slice(1 - HISTORY_STEPS), current.document];
    setHistoryDepth({ undo: undoStack.current.length, redo: redoStack.current.length });
    const updated = { ...current, document: restored, dirty: JSON.stringify(restored) !== savedDocument.current };
    draftRef.current = updated;
    setDraft(updated);
    setSelection({ kind: "none" });
    setEditingRoomId(null);
    setPending([]);
    setCalibration([]);
    setTool("select");
  }

  function planPointOf(event: { clientX: number; clientY: number }): Vec2 | null {
    const element = svg.current;
    const matrix = element?.getScreenCTM();
    if (element === null || element === undefined || matrix === null || matrix === undefined) return null;
    const local = element.createSVGPoint();
    local.x = event.clientX;
    local.y = event.clientY;
    const transformed = local.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: -transformed.y };
  }

  function snapped(
    document: PlanDocument,
    point: Vec2,
    radiusMm: number,
    ignore?: string,
    forbidden?: ReadonlySet<string>,
  ) {
    const candidates = Object.entries(document.points)
      .filter(([id]) => id !== ignore && !(forbidden?.has(id) ?? false))
      .map(([id, value]) => ({ id, at: { x: value.x_mm, y: value.y_mm } }));
    return snapToGeometry(point, candidates, tracedSegments(document), radiusMm, lineSnapMm, SNAP_MM);
  }

  /** Where a click at `raw` lands; the preview calls this too, so what it shows is what a click does. */
  function resolveDraw(document: PlanDocument, raw: Vec2, shift: boolean): DrawPreview {
    const last = document.points[pending[pending.length - 1] ?? ""];
    if (shift && last !== undefined) {
      const candidates = Object.entries(document.points).map(([id, value]) => ({
        id,
        at: { x: value.x_mm, y: value.y_mm },
      }));
      return snapOnAxis({ x: last.x_mm, y: last.y_mm }, raw, candidates, hitRadiusMm, SNAP_MM);
    }
    const hit = snapped(document, raw, hitRadiusMm);
    return { point: hit.point, pointId: hit.pointId, snap: hit.pointId !== null ? "point" : hit.onLine ? "line" : "grid" };
  }

  function placeCorner(point: Vec2, existingId: string | null) {
    const source = draftRef.current?.document;
    if (source === undefined) return;
    let pointId = existingId;
    if (pointId === null) {
      pointId = nextId("p", Object.keys(source.points));
      const created = pointId;
      edit((current) =>
        withHandPoints(current, { [created]: { x_mm: point.x, y_mm: point.y, evidence: HAND_EVIDENCE_ID } }),
      );
    }
    const chosen = pointId;
    if (chosen === pending[0] && pending.length >= 3 && (tool === "room" || tool === "shaft" || tool === "soffit")) {
      finishShape();
      return;
    }
    if (pending.includes(chosen)) return;
    const next = [...pending, chosen];
    if (tool === "control" && next.length === 2) {
      // Creating the control inside a setPending updater ran it twice under
      // StrictMode, so it happens here and the queue is cleared afterwards.
      finishControl(next as [string, string]);
      setPending([]);
      return;
    }
    if (tool === "reanchor" && next.length === 2) {
      reanchorControl(next as [string, string]);
      setPending([]);
      return;
    }
    setPending(next);
  }

  /** Where the typed length lands: toward the cursor (ortho-locked under Shift), or along an arrow key's axis. */
  function typedTarget(axis: Vec2 | null): Vec2 | null {
    const source = draftRef.current?.document;
    const last = source?.points[pending[pending.length - 1] ?? ""];
    const lengthMm = Number(typed);
    if (last === undefined || !(lengthMm > 0)) return null;
    const fromMm = { x: last.x_mm, y: last.y_mm };
    const aim =
      axis !== null
        ? { x: fromMm.x + axis.x, y: fromMm.y + axis.y }
        : hover === null
          ? null
          : hover.shift
            ? orthoLock(fromMm, hover.rawMm)
            : hover.rawMm;
    return aim === null ? null : pointAtLength(fromMm, aim, lengthMm);
  }

  function placeTyped(axis: Vec2 | null) {
    const source = draftRef.current?.document;
    const at = typedTarget(axis);
    if (source === undefined || at === null) {
      setNotice("Type a length above zero, then point the cursor the way it runs or press an arrow key.");
      return;
    }
    setTyped("");
    placeCorner(at, pointIdAt(source, at));
  }

  /** Four snapped corners from a press-drag-release, finished as one undo step. */
  function finishRectangle(start: DrawPreview, end: DrawPreview) {
    const source = draftRef.current?.document;
    if (source === undefined) return;
    const corners = rectangleCorners(start.point, end.point);
    if (corners === null) {
      setNotice("Drag across both a width and a depth to draw a rectangle.");
      return;
    }
    const { ids, created } = cornerPointIds(source, corners);
    edit((current) => withHandPoints(current, created));
    setPending(ids);
    // Record the finish only if adding the corners did not already.
    finishShape(ids, draftRef.current?.document === source);
  }

  function handleCanvasPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (draft === null || view === null) return;
    if (event.button === 1 || event.button === 2 || spaceHeld.current) {
      panning.current = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        view: { x: view.x, y: view.y },
        mmPerPx,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const raw = planPointOf(event);
    if (raw === null) return;
    const document = draft.document;
    const hit = snapped(document, raw, hitRadiusMm);

    if (tool === "insert") {
      // Add a vertex to whichever room outline the click is nearest, on the
      // edge it is nearest, so the outline is not folded over itself.
      const { roomId: bestRoom, distanceMm: bestDistance } = nearestRoomOutline(document, raw, editingRoomId);
      if (bestRoom === null || bestDistance > hitRadiusMm * 3) {
        setNotice("Click on a room outline to add a point to it.");
        return;
      }
      const id = nextId("p", Object.keys(document.points));
      const target = bestRoom;
      edit((current) => withInsertedRoomPoint(current, target, id, hit.point));
      setSelection({ kind: "point", id });
      setEditingRoomId(target);
      setTool("select");
      setNotice(`Added ${id} to the outline. Drag it with Select.`);
      return;
    }

    if (isPlacingTool(tool)) {
      const target = resolveDraw(document, raw, event.shiftKey);
      if (pending.length === 0 && (tool === "room" || tool === "shaft" || tool === "soffit")) {
        rectDrag.current = { pointerId: event.pointerId, from: raw, start: target };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      placeCorner(target.point, target.pointId);
      return;
    }

    if (tool === "calibrate") {
      const underlay = document.underlay;
      if (underlay === null || underlay === undefined) {
        setNotice("Add a reference image before calibrating.");
        return;
      }
      const pixel = underlayTransform(underlay).toPixel(raw);
      setCalibration((current) => (current.length >= 2 ? [pixel] : [...current, pixel]));
      return;
    }

    if (tool === "select" && hit.pointId !== null) {
      setSelection({ kind: "point", id: hit.pointId });
      dragging.current = { pointerId: event.pointerId, id: hit.pointId, from: raw };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === "select") {
      // Empty-space drag is the ordinary pan gesture. Requiring Shift or a
      // middle mouse button made the editor needlessly hostile on a trackpad.
      panning.current = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        view: { x: view.x, y: view.y },
        mmPerPx,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function handleCanvasPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (isPlacingTool(tool) || tool === "calibrate") {
      const raw = planPointOf(event);
      if (raw !== null) setHover({ rawMm: raw, shift: event.shiftKey });
    }
    const rectangle = rectDrag.current;
    if (rectangle !== null && rectangle.pointerId === event.pointerId) {
      const raw = planPointOf(event);
      if (raw !== null && pastThreshold(rectangle.from, raw)) movedRef.current = true;
      return;
    }
    const wall = wallDrag.current;
    if (wall !== null && wall.pointerId === event.pointerId) {
      const raw = planPointOf(event);
      if (raw === null) return;
      if (!movedRef.current && !pastThreshold(wall.from, raw)) return;
      const result = wallOffset(wall.startMm, wall.endMm, wall.from, raw, wall.lines, SNAP_MM, lineSnapMm);
      if (result === null) return;
      const [startId, endId] = wall.ids;
      const moved = (at: Vec2) => ({
        x_mm: roundTenthMm(at.x + result.offsetMm.x),
        y_mm: roundTenthMm(at.y + result.offsetMm.y),
      });
      let changed = false;
      // The whole drag is one undo step: history is recorded by the first move that changes anything.
      edit((current) => {
        const next = withMovedWall(current, startId, endId, moved(wall.startMm), moved(wall.endMm));
        if (next !== current) changed = true;
        return next;
      }, !movedRef.current);
      if (changed) {
        movedRef.current = true;
        setDragActive(true);
      }
      return;
    }
    const slid = apertureDrag.current;
    if (slid !== null && slid.pointerId === event.pointerId) {
      const raw = planPointOf(event);
      const source = draftRef.current?.document;
      if (raw === null || source === undefined) return;
      if (!movedRef.current && !pastThreshold(slid.from, raw)) return;
      const aperture = source.apertures.find((item) => item.id === slid.id);
      const start = aperture && source.points[aperture.host_edge[0]];
      const end = aperture && source.points[aperture.host_edge[1]];
      if (aperture === undefined || start === undefined || end === undefined) return;
      // Offset from the grab point, not from the cursor, so the opening does
      // not jump to sit centred under wherever the pointer happens to be.
      const offset = offsetAlongEdge(
        { x: start.x_mm, y: start.y_mm },
        { x: end.x_mm, y: end.y_mm },
        raw,
        aperture.width_mm,
        5,
        slid.grabOffsetMm,
      );
      edit((document) => withUpdatedAperture(document, slid.id, { offset_mm: offset }), !movedRef.current);
      movedRef.current = true;
      setDragActive(true);
      return;
    }
    const held = dragging.current;
    if (held !== null && held.pointerId === event.pointerId) {
      const raw = planPointOf(event);
      if (raw === null) return;
      if (!movedRef.current && !pastThreshold(held.from, raw)) return;
      // Snap to another traced point when close, so shared corners stay shared.
      const source = draftRef.current?.document;
      if (source === undefined) return;
      // Snapping onto a point that neighbours this one in a room outline would
      // collapse that edge to nothing, which is never what a drag meant.
      const forbidden = new Set<string>();
      for (const room of source.rooms) {
        const ids = room.point_ids;
        const at = ids.indexOf(held.id);
        if (at === -1) continue;
        const before = ids[(at - 1 + ids.length) % ids.length];
        const after = ids[(at + 1) % ids.length];
        if (before !== undefined) forbidden.add(before);
        if (after !== undefined) forbidden.add(after);
      }
      const target = snapped(source, raw, dragSnapMm, held.id, forbidden);
      const x = target.pointId === null ? Math.round(raw.x / SNAP_MM) * SNAP_MM : target.point.x;
      const y = target.pointId === null ? Math.round(raw.y / SNAP_MM) * SNAP_MM : target.point.y;
      // The whole drag is one undo step, so only the first move records history.
      edit((current) => withPointAt(current, held.id, x, y), !movedRef.current);
      movedRef.current = true;
      setDragActive(true);
      return;
    }
    const drag = panning.current;
    if (drag === null || drag.pointerId !== event.pointerId || view === null) return;
    setView({
      ...view,
      x: drag.view.x - (event.clientX - drag.startClient.x) * drag.mmPerPx,
      y: drag.view.y - (event.clientY - drag.startClient.y) * drag.mmPerPx,
    });
  }

  function handleCanvasPointerUp(event: PointerEvent<SVGSVGElement>) {
    setDragActive(false);
    const rectangle = rectDrag.current;
    if (rectangle !== null && rectangle.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      rectDrag.current = null;
      const raw = planPointOf(event);
      const source = draftRef.current?.document;
      if (event.type === "pointerup" && movedRef.current && raw !== null && source !== undefined) {
        finishRectangle(rectangle.start, resolveDraw(source, raw, false));
      } else if (event.type === "pointerup") {
        placeCorner(rectangle.start.point, rectangle.start.pointId);
      }
      movedRef.current = false;
    }
    if (wallDrag.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      wallDrag.current = null;
      movedRef.current = false;
    }
    if (apertureDrag.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      apertureDrag.current = null;
      movedRef.current = false;
    }
    if (dragging.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      dragging.current = null;
      movedRef.current = false;
    }
    if (panning.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      panning.current = null;
    }
  }

  function handleWheel(event: WheelEvent<SVGSVGElement>) {
    if (view === null) return;
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.0012);
    const width = Math.min(400_000, Math.max(600, view.width * factor));
    const height = width * (view.height / view.width);
    setView({
      x: view.x + (view.width - width) / 2,
      y: view.y + (view.height - height) / 2,
      width,
      height,
    });
  }

  function finishControl(points: [string, string]) {
    const id = nextId("control_", (draft?.document.controls ?? []).map((control) => control.id));
    edit((current) => withControl(current, id, points));
    setSelection({ kind: "control", id });
    setTool("select");
    setNotice("Control added. Enter the printed dimension so the trace is checked against the drawing.");
  }

  // A printed dimension is the check, so a failing one is re-anchored onto the
  // corners that carry it rather than having its expectation edited to fit.
  function reanchorControl(points: [string, string]) {
    const id = reanchoring;
    if (id === null) return;
    edit((current) => withReanchoredControl(current, id, points));
    setReanchoring(null);
    setSelection({ kind: "control", id });
    setTool("select");
    setNotice("Moved the check onto those two corners. Its printed dimension is unchanged.");
  }

  function finishShape(chosen: string[] = pending, record = true) {
    if (tool === "shaft") finishShaft(chosen, record);
    else if (tool === "soffit") finishSoffit(chosen, record);
    else finishRoom(chosen, record);
  }

  keyHandlerRef.current = (event: KeyboardEvent) => {
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    // Save works from a text field too, and the browser's own save dialog is never wanted here.
    if (event.type === "keydown" && command && key === "s") {
      event.preventDefault();
      if (draft?.dirty === true && busy === "idle") void save();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === "Shift") {
      setHover((current) => (current === null ? null : { ...current, shift: event.type === "keydown" }));
      return;
    }
    if (event.type !== "keydown") return;
    if (shortcutsOpen) {
      if (event.key === "Escape") setShortcutsOpen(false);
      return;
    }
    if (command && (key === "y" || (key === "z" && event.shiftKey))) {
      event.preventDefault();
      stepHistory("redo");
      return;
    }
    if (command && key === "z") {
      event.preventDefault();
      stepHistory("undo");
      return;
    }
    const typing = pending.length > 0 && isPlacingTool(tool);
    if (typing && /^[0-9.]$/.test(event.key)) {
      setTyped((current) => current + event.key);
      return;
    }
    if (typed !== "") {
      const axis = ARROW_AXES[event.key];
      if (event.key === "Enter" || axis !== undefined) {
        event.preventDefault();
        placeTyped(axis ?? null);
        return;
      }
      if (event.key === "Escape") {
        setTyped("");
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        setTyped((current) => current.slice(0, -1));
        return;
      }
    }
    if (!command && !event.altKey) {
      if (event.key === "?") {
        setShortcutsOpen(true);
        return;
      }
      const task = TASK_SHORTCUTS.find((item) => item.key.toLowerCase() === key);
      if (task !== undefined) {
        chooseTask(task.task);
        return;
      }
      if (key === UNDERLAY_KEY.toLowerCase()) {
        setUnderlayHidden((hidden) => !hidden);
        return;
      }
    }
    const nudge = ARROW_AXES[event.key];
    if (nudge !== undefined && pending.length === 0 && (selection.kind === "point" || selection.kind === "aperture")) {
      event.preventDefault();
      nudgeSelection(nudge, event.shiftKey ? NUDGE_LARGE_MM : NUDGE_MM, !event.repeat);
      return;
    }
    if (event.key === "Escape") {
      setPending([]);
      setCalibration([]);
      setEditingRoomId(null);
      setSelection({ kind: "none" });
      setTool("select");
    }
    if (event.key === "Enter" && (tool === "room" || tool === "shaft" || tool === "soffit")) {
      finishShape();
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
    }
  };

  /** Move the selected point along the arrow, or slide the selected opening along its wall, clamped as a drag is. */
  function nudgeSelection(direction: Vec2, stepMm: number, record: boolean) {
    if (selection.kind === "point") {
      const id = selection.id;
      edit((current) => withNudgedPoint(current, id, direction, stepMm), record);
      return;
    }
    if (selection.kind !== "aperture") return;
    const id = selection.id;
    edit((current) => withNudgedAperture(current, id, direction, stepMm), record);
  }

  /** Delete whatever is selected, refusing a point another record still needs. */
  function deleteSelection() {
    if (draft === null) return;
    const current = draft.document;
    if (selection.kind === "point") {
      if (referencedPointIds(current).has(selection.id)) {
        setNotice(`${selection.id} is used by a room, control, or opening. Remove it there first.`);
        return;
      }
      edit((document) => withoutPoint(document, selection.id));
      setNotice(`Deleted point ${selection.id}.`);
    } else if (selection.kind === "room") {
      edit((document) => withoutRoom(document, selection.id));
      setNotice("Deleted the room and the openings that were only its own.");
    } else if (selection.kind === "shaft") {
      edit((document) => withoutShaft(document, selection.id));
      setNotice("Deleted the shaft.");
    } else if (selection.kind === "soffit") {
      edit((document) => withoutSoffit(document, selection.id));
      setNotice("Deleted the soffit.");
    } else if (selection.kind === "control") {
      edit((document) => withoutControl(document, selection.id));
      setNotice("Deleted the control.");
    } else if (selection.kind === "aperture") {
      edit((document) => withoutAperture(document, selection.id));
      setNotice("Deleted the opening.");
    } else {
      return;
    }
    setSelection({ kind: "none" });
  }

  function finishShaft(chosen: string[] = pending, record = true) {
    if (chosen.length < 3) {
      setNotice("A shaft needs at least three corners.");
      return;
    }
    const id = nextId("shaft_", (draft?.document.daylight_sources ?? []).map((item) => item.id));
    edit((current) => withShaft(current, id, chosen), record);
    setPending([]);
    setSelection({ kind: "shaft", id });
    setTool("select");
  }

  // A soffit belongs to the room it hangs in, so the room is picked from where
  // it was drawn rather than asked for.
  function finishSoffit(chosen: string[] = pending, record = true) {
    if (chosen.length < 3) {
      setNotice("A soffit needs at least three corners.");
      return;
    }
    const id = nextId("soffit_", (draft?.document.soffits ?? []).map((item) => item.id));
    const source = draft?.document;
    if (source === undefined) return;
    const host = soffitHost(source, chosen);
    if (host === undefined) {
      setNotice("Draw the soffit inside a room: it has to hang from that room's ceiling.");
      return;
    }
    edit((current) => withSoffit(current, id, host, chosen), record);
    setPending([]);
    setSelection({ kind: "soffit", id });
    setTool("select");
  }

  function finishRoom(chosen: string[] = pending, record = true) {
    if (chosen.length < 3) {
      setNotice("A room needs at least three points.");
      return;
    }
    const id = nextId("room_", (draft?.document.rooms ?? []).map((room) => room.id));
    edit((current) => withRoom(current, id, chosen), record);
    setPending([]);
    setSelection({ kind: "room", id });
    setEditingRoomId(id);
    setTool("select");
  }

  function addAperture(roomId: string, edge: [string, string]) {
    const id = nextId("aperture_", (draft?.document.apertures ?? []).map((item) => item.id));
    edit((current) => withAperture(current, id, roomId, edge));
    setSelection({ kind: "aperture", id });
    setEditingRoomId(null);
    setTool("select");
  }

  async function uploadUnderlay(file: File) {
    const url = URL.createObjectURL(file);
    try {
      const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("That reference image could not be decoded"));
        image.src = url;
      });
      const stored = await api.uploadUnderlay(file, size.width, size.height);
      edit((current) => withUnderlay(current, stored));
      setUnderlayUrl(`/api/trace/underlay/file?v=${stored.sha256.slice(7, 19)}`);
      setSelection({ kind: "underlay" });
      setTool("calibrate");
      setNotice("Reference image stored. Click two ends of a printed dimension, then enter its length.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The reference image could not be stored");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function applyCalibration(knownMm: number, axis: "x" | "y" | null) {
    const first = calibration[0];
    const second = calibration[1];
    if (first === undefined || second === undefined) {
      setNotice("Click both ends of the printed dimension first.");
      return;
    }
    const result = calibrateUnderlay(first, second, knownMm, axis);
    if (result === null) {
      setNotice("Those two clicks are too close together to calibrate.");
      return;
    }
    edit((current) => withUnderlayCalibration(current, result, knownMm));
    setCalibration([]);
    setNotice(`Underlay scale set to ${result.mm_per_px.toFixed(4)} mm per pixel.`);
  }

  function setPlanOrigin() {
    const first = calibration[0];
    if (first === undefined) {
      setNotice("Click the drawing point that should become plan 0,0 first.");
      return;
    }
    edit((current) => withUnderlayOrigin(current, first));
    setCalibration([]);
    setNotice("Plan origin moved to that drawing point.");
  }

  async function save() {
    if (draft === null) return;
    setBusy("saving");
    try {
      const parsed = PlanDocumentSchema.parse(draft.document);
      const response = await api.saveTrace(parsed, draft.revision);
      savedDocument.current = JSON.stringify(response.trace.document);
      setDraft({ document: response.trace.document, revision: response.revision, dirty: false });
      setReview({ kind: "ready", value: response.review });
      queryClient.setQueryData(["trace"], response.trace);
      clearHistory();
      setNotice("Plan source saved. Build the draft to see it as IFC.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The plan source could not be saved");
    } finally {
      setBusy("idle");
    }
  }

  async function build() {
    if (loaded.kind !== "ready") return;
    setBusy("building");
    try {
      const response = await api.buildTrace(loaded.value.draft.revision);
      queryClient.setQueryData(["trace"], response.trace);
      savedDocument.current = JSON.stringify(response.trace.document);
      setDraft({ document: response.trace.document, revision: response.trace.revision, dirty: false });
      setReview({ kind: "ready", value: response.trace.review });
      setNotice(
        `Draft IFC ${response.report.published ? "published" : "already current"} with ${response.report.rooms_verified.length} verified rooms and ${response.report.schema_issue_count} schema issues.`,
      );
      if (response.model_reloaded) await onModelRebuilt();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The draft could not be built");
    } finally {
      setBusy("idle");
    }
  }

  // The canvas letterboxes with the default xMidYMid meet, so the scale is the
  // tighter of the two axes and one pixel is this many millimetres.
  const mmPerPx =
    view === null ? 1 : millimetresPerPixel(view.width, view.height, canvas.width, canvas.height);
  const { pick: hitRadiusMm, drag: dragSnapMm } = snapRadii(mmPerPx);
  // Sliding onto a wall should be easier than landing on a corner, but not so
  // easy that a point in open space gets pulled to the nearest edge.
  const lineSnapMm = Math.min(Math.max(10 * mmPerPx, 60), 300);
  const pointRadiusMm = POINT_RADIUS_PX * mmPerPx;
  const labelMm = LABEL_PX * mmPerPx;

  const document = draft?.document ?? null;
  const currentReview = review.kind === "ready" ? review.value : null;
  const controlById = useMemo(
    () => new Map((currentReview?.controls ?? []).map((control) => [control.id, control])),
    [currentReview],
  );

  if (loaded.kind === "error") {
    return (
      <main className="workspace workspace--trace">
        <div className="workspace-loading workspace-loading--error">
          <AlertTriangle /> {loaded.message}
        </div>
      </main>
    );
  }
  if (loaded.kind === "loading" || document === null || draft === null) {
    return (
      <main className="workspace workspace--trace">
        <div className="workspace-loading">
          <LoaderCircle className="spin" /> Reading the reviewed plan source
        </div>
      </main>
    );
  }

  const underlay = document.underlay ?? null;
  const visiblePointIds = new Set<string>(pending);
  if (tool === "room" || tool === "shaft" || tool === "soffit" || tool === "control" || tool === "reanchor") {
    Object.keys(document.points).forEach((id) => visiblePointIds.add(id));
  } else if (editingRoomId !== null && (tool === "select" || tool === "insert")) {
    document.rooms
      .find((room) => room.id === editingRoomId)
      ?.point_ids.forEach((id) => visiblePointIds.add(id));
  } else if (selection.kind === "point") {
    visiblePointIds.add(selection.id);
  }

  // The cursor preview resolves exactly as a click would, then is read out
  // twice: drawn on the canvas and written as text for the accessibility tree.
  let cursor: {
    readonly fromMm: Vec2 | null;
    readonly preview: { readonly point: Vec2; readonly snap: DrawPreview["snap"] | null; readonly pointId: string | null };
    readonly closeAtMm: Vec2 | null;
    readonly locked: boolean;
    readonly rectangle: Vec2[] | null;
  } | null = null;
  if (hover !== null && isPlacingTool(tool)) {
    const last = document.points[pending[pending.length - 1] ?? ""];
    const fromMm = last === undefined ? null : { x: last.x_mm, y: last.y_mm };
    const typedAt = typed === "" ? null : typedTarget(null);
    const target = resolveDraw(document, hover.rawMm, hover.shift);
    const first = document.points[pending[0] ?? ""];
    const closes =
      typedAt === null && pending.length >= 3 && target.pointId === pending[0] && first !== undefined &&
      (tool === "room" || tool === "shaft" || tool === "soffit");
    const dragged = rectDrag.current;
    cursor = {
      fromMm,
      preview: typedAt === null ? target : { point: typedAt, snap: null, pointId: null },
      closeAtMm: closes ? { x: first.x_mm, y: first.y_mm } : null,
      locked: hover.shift && fromMm !== null,
      rectangle:
        dragged !== null && movedRef.current
          ? rectangleCorners(dragged.start.point, resolveDraw(document, hover.rawMm, false).point)
          : null,
    };
  } else if (hover !== null && tool === "calibrate" && underlay !== null) {
    const first = calibration.length === 1 && calibration[0] !== undefined ? underlayTransform(underlay).toPlan(calibration[0]) : null;
    cursor = { fromMm: first, preview: { point: hover.rawMm, snap: null, pointId: null }, closeAtMm: null, locked: false, rectangle: null };
  }
  const readout = cursor === null ? null : describePreview({ ...cursor, closing: cursor.closeAtMm !== null });
  const lengthLabel =
    cursor === null
      ? null
      : cursor.rectangle !== null
        ? readout
        : cursor.fromMm === null
          ? null
          : `${roundTenthMm(Math.hypot(cursor.preview.point.x - cursor.fromMm.x, cursor.preview.point.y - cursor.fromMm.y))} mm`;

  function pickShaft(event: PointerEvent<SVGElement>, id: string) {
    if (tool !== "select") return;
    event.stopPropagation();
    setEditingRoomId(null);
    setSelection({ kind: "shaft", id });
  }

  function pickRoom(event: PointerEvent<SVGElement>, id: string) {
    if (tool !== "select" && tool !== "aperture") return;
    event.stopPropagation();
    setEditingRoomId(id);
    setSelection({ kind: "room", id });
  }

  function pickSoffit(event: PointerEvent<SVGElement>, id: string) {
    if (tool !== "select") return;
    event.stopPropagation();
    setEditingRoomId(null);
    setSelection({ kind: "soffit", id });
  }

  const pickAperture = (event: PointerEvent<SVGElement>, aperture: PlanAperture) => {
    if (tool !== "select") return;
    event.stopPropagation();
    setEditingRoomId(null);
    setSelection({ kind: "aperture", id: aperture.id });
    const grabbed = planPointOf(event);
    if (grabbed !== null) {
      const from = document.points[aperture.host_edge[0]];
      const to = document.points[aperture.host_edge[1]];
      const current =
        aperture.offset_mm ??
        (from && to
          ? (Math.hypot(to.x_mm - from.x_mm, to.y_mm - from.y_mm) - aperture.width_mm) / 2
          : 0);
      const pointerOffset =
        from && to
          ? offsetAlongEdge(
              { x: from.x_mm, y: from.y_mm },
              { x: to.x_mm, y: to.y_mm },
              grabbed,
              aperture.width_mm,
              1,
            )
          : current;
      apertureDrag.current = {
        pointerId: event.pointerId,
        id: aperture.id,
        from: grabbed,
        grabOffsetMm: current - pointerOffset,
      };
      svg.current?.setPointerCapture(event.pointerId);
    }
  };

  function pickControl(event: PointerEvent<SVGElement>, id: string) {
    if (tool !== "select" && tool !== "control") return;
    event.stopPropagation();
    setSelection({ kind: "control", id });
    setPending([]);
    setTool("select");
  }

  function chooseTask(next: Tool) {
    setTool(next);
    setPending([]);
    setCalibration([]);
    setEditingRoomId(null);
    if (next === "calibrate") setSelection({ kind: "underlay" });
    else setSelection({ kind: "none" });
  }

  function zoomBy(factor: number) {
    if (view === null) return;
    const width = Math.min(400_000, Math.max(600, view.width * factor));
    const height = width * (view.height / view.width);
    setView({
      x: view.x + (view.width - width) / 2,
      y: view.y + (view.height - height) / 2,
      width,
      height,
    });
  }

  function startAddCorner() {
    setTool("insert");
  }

  function finishEditingRoom() {
    setEditingRoomId(null);
    setSelection({ kind: "none" });
  }

  function startReanchor(id: string) {
    setReanchoring(id);
    setPending([]);
    setTool("reanchor");
  }

  function updateAperture(id: string, patch: Partial<PlanAperture>) {
    edit((current) => withUpdatedAperture(current, id, patch));
  }

  let toolbarSelection: ToolbarSelection | null = null;
  let toolbarAnchor: Vec2[] | null = null;
  const pointOf = (id: string) => {
    const point = document.points[id];
    return point === undefined ? [] : [{ x: point.x_mm, y: point.y_mm }];
  };
  if (tool === "select" && selection.kind === "room" && editingRoomId === selection.id) {
    const room = document.rooms.find((item) => item.id === selection.id);
    if (room !== undefined) {
      toolbarSelection = { kind: "room", id: room.id, onAddCorner: startAddCorner, onDone: finishEditingRoom };
      toolbarAnchor = roomRing(document, room);
    }
  } else if (tool === "select" && selection.kind === "point") {
    toolbarSelection = {
      kind: "point",
      id: selection.id,
      deleteRefusal: referencedPointIds(document).has(selection.id) ? POINT_IN_USE : null,
      onDelete: deleteSelection,
    };
    toolbarAnchor = pointOf(selection.id);
  } else if (tool === "select" && selection.kind === "aperture") {
    const aperture = document.apertures.find((item) => item.id === selection.id);
    if (aperture !== undefined) {
      toolbarSelection = {
        kind: "aperture",
        aperture,
        onChange: (patch) => updateAperture(aperture.id, patch),
        onDelete: deleteSelection,
      };
      const [from] = pointOf(aperture.host_edge[0]);
      const [to] = pointOf(aperture.host_edge[1]);
      const length = from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
      if (from !== undefined && to !== undefined && length > 0) {
        const start = (aperture.offset_mm ?? (length - aperture.width_mm) / 2) / length;
        const end = start + aperture.width_mm / length;
        const along = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
        toolbarAnchor = [along(start), along(end)];
      }
    }
  } else if (tool === "select" && selection.kind === "control") {
    const control = document.controls.find((item) => item.id === selection.id);
    if (control !== undefined) {
      toolbarSelection = { kind: "control", id: control.id, onReanchor: () => startReanchor(control.id), onDelete: deleteSelection };
      toolbarAnchor = [...pointOf(control.from_point), ...pointOf(control.to_point)];
    }
  }
  if (toolbarAnchor !== null && toolbarAnchor.length === 0) toolbarAnchor = null;

  const activeTask =
    selection.kind === "aperture" ? "aperture" : selection.kind === "control" ? "control" : tool;

  return (
    <>
      <main className="workspace workspace--trace">
        <div className="workspace-toolbar">
          <div className="room-context">
            <p className="eyebrow">Plan tracing</p>
            <h1>{document.building_name}</h1>
            <span title={loaded.value.source_path}>Reviewed plan source</span>
          </div>
          <div className="trace-save-state">
            <span className={draft.dirty ? "trace-dirty-dot trace-dirty-dot--active" : "trace-dirty-dot"} />
            {draft.dirty ? "Unsaved changes" : "All changes saved"}
          </div>
        </div>

        <TraceTaskBar
          activeTask={activeTask}
          historyDepth={historyDepth}
          historySteps={HISTORY_STEPS}
          onChooseTask={chooseTask}
          onStepHistory={stepHistory}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />

        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.svg"
          onChange={(event) => {
            const file = event.currentTarget.files?.item(0);
            if (file !== null && file !== undefined) void uploadUnderlay(file);
            event.currentTarget.value = "";
          }}
        />

        <div className="plan-stage">
          <div className="trace-guidance" role="status">
            {tool === "select" && editingRoomId === null && selection.kind === "aperture" ? (
              <><strong>Opening added</strong><span>Edit its details on the right, or drag it along the wall.</span><button type="button" onClick={() => setSelection({ kind: "none" })}>Done</button></>
            ) : null}
            {tool === "select" && editingRoomId === null && selection.kind === "control" ? (
              <><strong>Dimension added</strong><span>Enter the number printed on the plan in the panel.</span><button type="button" onClick={() => setSelection({ kind: "none" })}>Done</button></>
            ) : null}
            {tool === "select" && editingRoomId === null && selection.kind !== "aperture" && selection.kind !== "control" ? (
              <><strong>Select the room you want to correct</strong><span>Then its editable corners will appear.</span></>
            ) : null}
            {tool === "select" && editingRoomId !== null ? (
              <>
                <strong>Drag a corner to move it, or a wall to slide it</strong>
                <span>Drag empty space to pan. Scroll to zoom.</span>
                <button type="button" onClick={startAddCorner}><GitCommitHorizontal size={14} /> Add a corner</button>
                <button type="button" onClick={finishEditingRoom}>Done</button>
              </>
            ) : null}
            {tool === "shaft" ? (
              <>
                <strong>Click each corner of the shaft, in order</strong>
                <span>{pending.length} corner{pending.length === 1 ? "" : "s"} placed</span>
                <button type="button" onClick={() => finishShaft()}>Finish shaft</button>
                <button type="button" onClick={() => { setPending([]); setTool("select"); }}>Cancel</button>
              </>
            ) : null}
            {tool === "soffit" ? (
              <>
                <strong>Click each corner of the gypsum soffit, in order</strong>
                <span>{pending.length} corner{pending.length === 1 ? "" : "s"} placed · it hangs in the room you draw it in</span>
                <button type="button" onClick={() => finishSoffit()}>Finish soffit</button>
                <button type="button" onClick={() => { setPending([]); setTool("select"); }}>Cancel</button>
              </>
            ) : null}
            {tool === "reanchor" ? (
              <><strong>Click the two corners the printed dimension runs between</strong><span>{pending.length} of 2 selected</span><button type="button" onClick={() => { setPending([]); setReanchoring(null); setTool("select"); }}>Cancel</button></>
            ) : null}
            {tool === "insert" ? (
              <><strong>Click the room edge where the new corner belongs</strong><button type="button" onClick={() => setTool("select")}>Cancel</button></>
            ) : null}
            {tool === "room" ? (
              <>
                <strong>Click each corner of the room, in order</strong>
                <span>{pending.length} corner{pending.length === 1 ? "" : "s"} placed</span>
                <button type="button" disabled={pending.length < 3} onClick={() => finishRoom()}>Finish room</button>
                <button type="button" onClick={() => { setPending([]); setTool("select"); }}>Cancel</button>
              </>
            ) : null}
            {tool === "control" ? (
              <><strong>Click both ends of a printed dimension</strong><span>{pending.length} of 2 points selected · or click an existing check to edit it</span><button type="button" onClick={() => { setPending([]); setTool("select"); }}>Cancel</button></>
            ) : null}
            {tool === "aperture" && editingRoomId === null ? (
              <><strong>Select the room containing the window or door</strong><span>Its walls will highlight next.</span></>
            ) : null}
            {tool === "aperture" && editingRoomId !== null ? (
              <><strong>Click the wall that contains the opening</strong><button type="button" onClick={() => { setEditingRoomId(null); setSelection({ kind: "none" }); }}>Choose another room</button></>
            ) : null}
            {tool === "calibrate" ? (
              <><strong>Align the reference drawing</strong><span>Use two ends of a known printed dimension.</span></>
            ) : null}
            {readout !== null && readout !== "" ? (
              <span className="trace-readout" role="status" aria-label="Drawing readout">{readout}</span>
            ) : null}
            {typed !== "" ? (
              <span className="trace-typed">
                Typed length <output role="status" aria-label="Typed length">{typed}</output> mm · Enter places it toward the cursor, an arrow key along that axis
              </span>
            ) : null}
          </div>
          <div className="trace-zoom" aria-label="Canvas view controls">
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(0.8)}><ZoomIn size={16} /></button>
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1.25)}><ZoomOut size={16} /></button>
            <button type="button" aria-label="Fit plan" onClick={() => setView(fittedView(document))}><Maximize2 size={16} /></button>
            <button
              type="button"
              aria-label="Show underlay"
              aria-pressed={underlay !== null && !underlayHidden}
              aria-keyshortcuts={UNDERLAY_KEY}
              disabled={underlay === null}
              title={underlay === null ? "No reference underlay is loaded" : `Show or hide the reference underlay (${UNDERLAY_KEY}); view only, never saved`}
              onClick={() => setUnderlayHidden((hidden) => !hidden)}
            >
              <Eye size={16} />
            </button>
          </div>
          <svg
            ref={attachCanvas}
            className="trace-canvas"
            viewBox={view === null ? "0 0 1000 1000" : `${view.x} ${view.y} ${view.width} ${view.height}`}
            style={{ "--mm-per-px": mmPerPx } as CSSProperties}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            onPointerCancel={handleCanvasPointerUp}
            onPointerLeave={() => setHover(null)}
            onWheel={handleWheel}
            onDoubleClick={() => {
              if (tool === "room" && pending.length >= 3) finishRoom();
              if (tool === "shaft" && pending.length >= 3) finishShaft();
              if (tool === "soffit" && pending.length >= 3) finishSoffit();
            }}
            onContextMenu={(event) => event.preventDefault()}
            role="application"
            aria-label="Plan tracing canvas"
          >
            <defs>
              <pattern id="trace-grid" width="1000" height="1000" patternUnits="userSpaceOnUse">
                <path d="M 1000 0 L 0 0 0 1000" className="grid-line grid-line--major" />
              </pattern>
            </defs>
            <rect
              x={view?.x ?? 0}
              y={view?.y ?? 0}
              width={view?.width ?? 1000}
              height={view?.height ?? 1000}
              fill="url(#trace-grid)"
            />

            {underlay !== null && underlayUrl !== null && !underlayHidden ? (
              <TraceUnderlayImage underlay={underlay} href={underlayUrl} />
            ) : null}

            <TraceShafts document={document} selection={selection} labelMm={labelMm} onPick={pickShaft} />

            <TraceRooms document={document} selection={selection} editingRoomId={editingRoomId} labelMm={labelMm} onPick={pickRoom} />

            <TraceSoffits document={document} selection={selection} labelMm={labelMm} onPick={pickSoffit} />

            {tool === "select" && editingRoomId !== null
              ? hostEdges(document).filter(({ roomId }) => roomId === editingRoomId).map(({ edge }) => {
                  const from = document.points[edge[0]];
                  const to = document.points[edge[1]];
                  if (from === undefined || to === undefined) return null;
                  return (
                    <line
                      key={`wall-${edge[0]}-${edge[1]}`}
                      className="trace-wall-grab"
                      x1={from.x_mm}
                      y1={screenY(from.y_mm)}
                      x2={to.x_mm}
                      y2={screenY(to.y_mm)}
                      onPointerDown={(event) => {
                        if (event.button !== 0 || spaceHeld.current) return;
                        event.stopPropagation();
                        const grabbed = planPointOf(event);
                        if (grabbed === null) return;
                        wallDrag.current = {
                          pointerId: event.pointerId,
                          ids: edge,
                          from: grabbed,
                          startMm: { x: from.x_mm, y: from.y_mm },
                          endMm: { x: to.x_mm, y: to.y_mm },
                          lines: tracedSegments(document),
                        };
                        svg.current?.setPointerCapture(event.pointerId);
                      }}
                    />
                  );
                })
              : null}

            {tool === "aperture"
              ? hostEdges(document).filter(({ roomId }) => roomId === editingRoomId).map(({ roomId, edge }) => {
                  const from = document.points[edge[0]];
                  const to = document.points[edge[1]];
                  if (from === undefined || to === undefined) return null;
                  return (
                    <line
                      key={`host-${roomId}-${edge[0]}-${edge[1]}`}
                      className="trace-host-edge"
                      x1={from.x_mm}
                      y1={screenY(from.y_mm)}
                      x2={to.x_mm}
                      y2={screenY(to.y_mm)}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        addAperture(roomId, edge);
                      }}
                    />
                  );
                })
              : null}

            <TraceApertures document={document} selection={selection} onPick={pickAperture} />

            <TraceControls
              document={document}
              controls={document.controls.filter((control) => tool === "control" || tool === "reanchor" || (selection.kind === "control" && selection.id === control.id))}
              controlChecks={controlById}
              labelMm={labelMm}
              onPick={pickControl}
            />

            {pending.length > 1 ? (
              <polygon
                className="trace-pending"
                points={pending
                  .map((id) => document.points[id])
                  .filter((point): point is NonNullable<typeof point> => point !== undefined)
                  .map((point) => `${point.x_mm},${screenY(point.y_mm)}`)
                  .join(" ")}
              />
            ) : null}

            <TracePoints
              document={document}
              visiblePointIds={visiblePointIds}
              selection={selection}
              pending={pending}
              hitRadiusMm={hitRadiusMm}
              pointRadiusMm={pointRadiusMm}
              labelMm={labelMm}
            />

            {underlay !== null ? (
              <TraceCalibrationMarks calibration={calibration} underlay={underlay} pointRadiusMm={pointRadiusMm} labelMm={labelMm} />
            ) : null}

            {cursor !== null ? (
              <TraceDrawingOverlay
                fromMm={cursor.fromMm}
                toMm={cursor.preview.point}
                snap={cursor.preview.snap}
                closeAtMm={cursor.closeAtMm}
                rectangle={cursor.rectangle}
                lengthLabel={lengthLabel}
                labelMm={labelMm}
                markerMm={pointRadiusMm}
              />
            ) : null}
          </svg>
          {toolbarSelection !== null && toolbarAnchor !== null && view !== null && !dragActive ? (
            <TraceSelectionToolbar anchor={planBoxToScreen(toolbarAnchor, view, canvas)} canvas={canvas} selection={toolbarSelection} />
          ) : null}
        </div>

        <TraceReviewDock
          review={review}
          dirty={draft.dirty}
          busy={busy}
          onSave={() => void save()}
          onBuild={() => void build()}
        />
      </main>

      <div className="right-rail">
        <TraceInspector
          document={document}
          selection={selection}
          controlChecks={controlById}
          onSelect={setSelection}
          onEdit={edit}
          onCalibrate={applyCalibration}
          onSetOrigin={setPlanOrigin}
          onUploadUnderlay={() => fileInput.current?.click()}
          onReanchorControl={startReanchor}
          calibrationCount={calibration.length}
        />
        {currentReview !== null ? <TracePlanChecks review={currentReview} /> : null}
      </div>

      {shortcutsOpen ? <TraceShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}

      {notice !== null ? (
        <button className="toast" type="button" onClick={() => setNotice(null)}>
          <span>{notice}</span>
          <small>Dismiss</small>
        </button>
      ) : null}
    </>
  );
}
