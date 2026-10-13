/// <reference types="vite/client" />

import presets from "./demoPresets.json";

// `vite build --mode demo` produces the static, read-only demo for GitHub Pages.
export const DEMO = import.meta.env.MODE === "demo";
export const DEMO_MESSAGE = "This is a read-only demo. Install Home Twin to run this.";
export const DEMO_INSTALL_URL = "https://github.com/arogan178/home-twin#install-and-verify";
export const DEMO_SUN = presets;

export class DemoReadOnlyError extends Error {
  constructor() {
    super(DEMO_MESSAGE);
    this.name = "DemoReadOnlyError";
  }
}

/** The recorded file for a UI request URL; scripts/record_demo.py writes the same path. */
export function demoFile(url: string, suffix = ".json"): string {
  const [path = "", query = ""] = url.split("?", 2);
  const key = decodeURIComponent(path.replace(/^\/api\//, "")) + (query === "" ? "" : `/${decodeURIComponent(query)}`);
  const escaped = key.replace(/[^A-Za-z0-9/._-]/g, (char) => `~${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `api/${escaped}${suffix}`;
}

/** Resolve a request to its recording; anything but a read is refused before it leaves the page. */
export function demoRequestUrl(url: string, init: RequestInit | undefined, base: string): string {
  if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new DemoReadOnlyError();
  return `${base}${demoFile(url)}`;
}
