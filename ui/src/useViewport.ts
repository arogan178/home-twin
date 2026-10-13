/**
 * Pan and zoom for an SVG plan, in plan millimetres.
 *
 * The viewport is the visible plan rectangle. Zooming keeps the point under the
 * cursor fixed, which is what makes wheel zoom feel like a map rather than a
 * jump, and every value stays in the canonical frame so a caller never has to
 * think in pixels.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { extentOf, screenY, type Extent, type Vec2 } from "./plan";

export type Viewport = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const MIN_SPAN_MM = 400;
const MAX_SPAN_MM = 400_000;

export function viewBoxOf(viewport: Viewport): string {
  return `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`;
}

/** The viewport that frames an extent in screen space, with a margin. */
export function frameExtent(extent: Extent, marginMm: number): Viewport {
  return {
    x: extent.minX - marginMm,
    y: screenY(extent.maxY) - marginMm,
    width: Math.max(extent.width + marginMm * 2, MIN_SPAN_MM),
    height: Math.max(extent.height + marginMm * 2, MIN_SPAN_MM),
  };
}

export type PlanViewport = {
  readonly viewport: Viewport;
  /**
   * Plan millimetres per screen pixel.
   *
   * Annotation has to be sized in screen terms. Text and symbols authored in
   * plan millimetres shrink as the framed room grows, so the same label that
   * reads well in a 3 m bathroom is illegible across a 20 m floor.
   */
  readonly mmPerPixel: number;
  readonly zoom: (factor: number, anchor?: Vec2) => void;
  readonly panBy: (dx: number, dy: number) => void;
  readonly reset: () => void;
  readonly scalePercent: number;
  /** Whether the view is taking the current pointer, so a caller can stand back. */
  readonly panning: () => boolean;
  /** Attach to the SVG element to enable wheel zoom and drag-to-pan. */
  readonly bind: {
    readonly ref: (element: SVGSVGElement | null) => void;
    readonly onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
    readonly onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
    readonly onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
    readonly onPointerCancel: (event: React.PointerEvent<SVGSVGElement>) => void;
  };
};

/**
 * Whether the space bar is down, which is the left-button pan modifier.
 *
 * Shift used to pan, but selecting several fixtures at once needs it more, and
 * space-to-pan is what every drawing tool already trains.
 */
export function useSpaceHeld(): React.RefObject<boolean> {
  const held = useRef(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target as HTMLElement | null;
      // Space belongs to a text field or a focused button, not to the canvas.
      if (target?.closest("input, textarea, select, button, [contenteditable]") != null) return;
      event.preventDefault();
      held.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") held.current = false;
    };
    const blur = () => {
      held.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return held;
}

/**
 * `panButtons` lists the mouse buttons that drag the view. A plan that also
 * drags fixtures reserves the left button, so it passes middle and right only,
 * and the left button pans only while space is held.
 */
export function usePlanViewport(
  points: ReadonlyArray<Vec2>,
  marginMm: number,
  panButtons: ReadonlyArray<number> = [1, 2],
): PlanViewport {
  const home = frameExtent(extentOf(points), marginMm);
  const [viewport, setViewport] = useState<Viewport>(home);
  const [framed, setFramed] = useState(() => JSON.stringify(home));
  const element = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ pointerId: number; start: Vec2; origin: Viewport } | null>(null);
  const [pixelSpan, setPixelSpan] = useState<{ width: number; height: number } | null>(null);
  const spaceHeld = useSpaceHeld();

  // Re-frame when the geometry changes, but never while the user is looking
  // somewhere specific in the same room.
  const homeKey = JSON.stringify(home);
  useEffect(() => {
    if (homeKey !== framed) {
      setFramed(homeKey);
      setViewport(JSON.parse(homeKey) as Viewport);
    }
  }, [homeKey, framed]);

  const clientToPlan = useCallback((clientX: number, clientY: number): Vec2 | null => {
    const svg = element.current;
    if (svg === null) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // The SVG uses preserveAspectRatio="xMidYMid meet", so the shorter axis is
    // letterboxed; account for it or the anchor drifts.
    const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
    const offsetX = (rect.width - viewport.width * scale) / 2;
    const offsetY = (rect.height - viewport.height * scale) / 2;
    return {
      x: viewport.x + (clientX - rect.left - offsetX) / scale,
      y: viewport.y + (clientY - rect.top - offsetY) / scale,
    };
  }, [viewport]);

  const zoom = useCallback((factor: number, anchor?: Vec2) => {
    setViewport((current) => {
      const width = Math.min(MAX_SPAN_MM, Math.max(MIN_SPAN_MM, current.width * factor));
      const applied = width / current.width;
      const height = current.height * applied;
      const focusX = anchor?.x ?? current.x + current.width / 2;
      const focusY = anchor?.y ?? current.y + current.height / 2;
      return {
        x: focusX - (focusX - current.x) * applied,
        y: focusY - (focusY - current.y) * applied,
        width,
        height,
      };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }, []);

  const reset = useCallback(() => setViewport(JSON.parse(homeKey) as Viewport), [homeKey]);

  // Wheel is attached natively so it can be non-passive and preventDefault.
  const ref = useCallback((node: SVGSVGElement | null) => {
    element.current = node;
    if (node === null) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setPixelSpan(rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
  }, []);

  useEffect(() => {
    const svg = element.current;
    if (svg === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const anchor = clientToPlan(event.clientX, event.clientY);
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoom(Math.exp(step * 0.0015), anchor ?? undefined);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [clientToPlan, zoom]);

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (!panButtons.includes(event.button) && !(event.button === 0 && spaceHeld.current)) return;
    const start = clientToPlan(event.clientX, event.clientY);
    if (start === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start, origin: viewport };
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    const svg = element.current;
    if (svg === null) return;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / active.origin.width, rect.height / active.origin.height);
    const offsetX = (rect.width - active.origin.width * scale) / 2;
    const offsetY = (rect.height - active.origin.height * scale) / 2;
    const current = {
      x: active.origin.x + (event.clientX - rect.left - offsetX) / scale,
      y: active.origin.y + (event.clientY - rect.top - offsetY) / scale,
    };
    setViewport({
      ...active.origin,
      x: active.origin.x - (current.x - active.start.x),
      y: active.origin.y - (current.y - active.start.y),
    });
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (drag.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      drag.current = null;
    }
  }

  // "xMidYMid meet" fits the whole viewport, so the larger ratio is the one on
  // screen; without a measured element, assume the framed width fills 900 px.
  const mmPerPixel =
    pixelSpan === null
      ? viewport.width / 900
      : Math.max(viewport.width / pixelSpan.width, viewport.height / pixelSpan.height);

  return {
    viewport,
    mmPerPixel,
    zoom,
    panBy,
    reset,
    scalePercent: (home.width / viewport.width) * 100,
    panning: () => drag.current !== null,
    bind: { ref, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
