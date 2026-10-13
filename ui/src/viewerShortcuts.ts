/** Single-key shortcuts shared by both 3D views. */

export type ViewerAction =
  | "reset"
  | "plan"
  | "eye"
  | "measure"
  | "section"
  | "seeThrough"
  | "fullscreen"
  | "help"
  | "escape";

export const VIEWER_SHORTCUTS: ReadonlyArray<{ readonly key: string; readonly action: ViewerAction; readonly label: string }> = [
  { key: "R", action: "reset", label: "Reset the view" },
  { key: "T", action: "plan", label: "Look straight down (plan view)" },
  { key: "E", action: "eye", label: "Stand at eye level" },
  { key: "M", action: "measure", label: "Measure between two points" },
  { key: "C", action: "section", label: "Cut a section" },
  { key: "X", action: "seeThrough", label: "See through walls" },
  { key: "F", action: "fullscreen", label: "Full screen" },
  { key: "?", action: "help", label: "Show these shortcuts" },
  { key: "Esc", action: "escape", label: "Cancel a measurement or close the inspector" },
];

type KeyLike = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
};

function isEditable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

/** The action a key press asks for, or null when it belongs to something else. */
export function viewerAction(event: KeyLike): ViewerAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return null;
  if (event.key === "Escape") return "escape";
  if (event.key === "?") return "help";
  const match = VIEWER_SHORTCUTS.find((item) => item.key.length === 1 && item.key === event.key.toUpperCase());
  return match?.action ?? null;
}
