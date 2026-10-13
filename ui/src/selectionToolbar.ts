import { screenY, type Vec2 } from "./plan";

export type ScreenRect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
type Size = { readonly width: number; readonly height: number };
type View = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** Plan points in millimetres to a canvas pixel rectangle, matching the SVG's default xMidYMid meet letterbox. */
export function planBoxToScreen(points: ReadonlyArray<Vec2>, view: View, canvas: Size): ScreenRect {
  const scale = Math.min(canvas.width / view.width, canvas.height / view.height);
  const offsetX = (canvas.width - view.width * scale) / 2;
  const offsetY = (canvas.height - view.height * scale) / 2;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => screenY(point.y));
  const left = offsetX + (Math.min(...xs) - view.x) * scale;
  const top = offsetY + (Math.min(...ys) - view.y) * scale;
  return {
    left,
    top,
    width: (Math.max(...xs) - Math.min(...xs)) * scale,
    height: (Math.max(...ys) - Math.min(...ys)) * scale,
  };
}

/**
 * Where a toolbar sits beside a selection: centred above it, flipped below when
 * there is no room above, and clamped inside the canvas.
 */
export function toolbarPosition(
  anchor: ScreenRect,
  toolbar: Size,
  canvas: Size,
  gapPx = 8,
): { readonly left: number; readonly top: number; readonly placement: "above" | "below" } {
  const clamp = (value: number, max: number) => Math.max(gapPx, Math.min(value, max));
  const left = clamp(anchor.left + anchor.width / 2 - toolbar.width / 2, canvas.width - toolbar.width - gapPx);
  const above = anchor.top - gapPx - toolbar.height;
  const placement = above >= gapPx ? "above" : "below";
  const top = placement === "above" ? above : clamp(anchor.top + anchor.height + gapPx, canvas.height - toolbar.height - gapPx);
  return { left, top, placement };
}
