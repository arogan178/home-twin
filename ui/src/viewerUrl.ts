/**
 * The address bar as the view's bookmark.
 *
 * `view`, `scope` and `room` were already read on load; writing them back
 * makes the current view a link someone else can open. `cam` holds the 3D
 * camera, so a link, a reload or a trip to the 2D plan and back returns to the
 * same angle. The history entry is replaced rather than pushed: orbiting is
 * not navigation, and Back should still leave the app.
 */

import type { CameraFrame } from "./cameraPresets";

const CAMERA_PARAM = "cam";

export function formatCameraFrame(frame: CameraFrame): string {
  const { position: p, target: t } = frame;
  return [p.x, p.y, p.z, t.x, t.y, t.z].map((value) => value.toFixed(2)).join(",");
}

export function parseCameraFrame(value: string | null): CameraFrame | null {
  if (value === null) return null;
  const numbers = value.split(",").map(Number);
  if (numbers.length !== 6 || !numbers.every(Number.isFinite)) return null;
  const [px, py, pz, tx, ty, tz] = numbers as [number, number, number, number, number, number];
  if (Math.hypot(px - tx, py - ty, pz - tz) < 1e-3) return null;
  return { position: { x: px, y: py, z: pz }, target: { x: tx, y: ty, z: tz } };
}

function replaceSearch(update: (params: URLSearchParams) => void): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  update(url.searchParams);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, "", next);
  }
}

export function readCameraFrame(): CameraFrame | null {
  if (typeof window === "undefined") return null;
  return parseCameraFrame(new URLSearchParams(window.location.search).get(CAMERA_PARAM));
}

export function writeCameraFrame(frame: CameraFrame | null): void {
  replaceSearch((params) => {
    if (frame === null) params.delete(CAMERA_PARAM);
    else params.set(CAMERA_PARAM, formatCameraFrame(frame));
  });
}

/** Write the view, scope and room. An unknown room leaves its parameter alone. */
export function writeViewState(state: {
  readonly view: "plan" | "model";
  readonly scope: "room" | "whole";
  readonly roomId: string | null;
}): void {
  replaceSearch((params) => {
    if (state.view === "model") params.set("view", "3d");
    else params.delete("view");
    if (state.scope === "whole") params.set("scope", "whole");
    else params.delete("scope");
    if (state.roomId !== null) params.set("room", state.roomId);
  });
}
