/**
 * Every tracing shortcut and gesture, in one table.
 *
 * The shortcuts dialog renders this table and `docs/tracing.md` mirrors it row
 * for row; a test keeps the two identical.
 */

export type TaskId = "select" | "room" | "shaft" | "soffit" | "aperture" | "control" | "calibrate";

export const TASK_SHORTCUTS: ReadonlyArray<{ readonly task: TaskId; readonly key: string; readonly label: string }> = [
  { task: "select", key: "V", label: "Edit rooms" },
  { task: "room", key: "R", label: "Draw a room" },
  { task: "shaft", key: "H", label: "Draw a shaft" },
  { task: "soffit", key: "F", label: "Draw a soffit" },
  { task: "aperture", key: "O", label: "Add an opening" },
  { task: "control", key: "D", label: "Check a dimension" },
  { task: "calibrate", key: "G", label: "Drawing setup" },
];

export const UNDERLAY_KEY = "U";
export const NUDGE_MM = 10;
export const NUDGE_LARGE_MM = 100;

export const TRACE_SHORTCUTS: ReadonlyArray<{ readonly keys: string; readonly action: string }> = [
  ...TASK_SHORTCUTS.map((item) => ({ keys: item.key, action: item.label })),
  { keys: UNDERLAY_KEY, action: "Hide or show the reference underlay; view only, never saved" },
  { keys: "?", action: "Show this list of shortcuts" },
  { keys: "Ctrl+Z or Cmd+Z", action: "Undo, up to 50 steps" },
  { keys: "Ctrl+Shift+Z, Cmd+Shift+Z or Ctrl+Y", action: "Redo" },
  { keys: "Ctrl+S or Cmd+S", action: "Save the plan source" },
  { keys: "Arrow keys", action: `Move the selected point ${NUDGE_MM} mm along plan X or Y, or slide the selected opening ${NUDGE_MM} mm along its wall` },
  { keys: "Shift+arrow keys", action: `Move or slide the selection ${NUDGE_LARGE_MM} mm` },
  { keys: "Shift held", action: "Lock the next corner to plan X or Y through the last corner" },
  { keys: "Digits, then Enter", action: "Place the next corner at that length in millimetres, toward the cursor" },
  { keys: "Digits, then an arrow key", action: "Place the next corner at that length along plan X or Y" },
  { keys: "Backspace while typing a length", action: "Remove the last digit" },
  { keys: "Press, drag and release", action: "Draw a rectangular room, shaft or soffit before placing any corner" },
  { keys: "Drag a wall", action: "Move a whole wall of the room being edited, keeping it parallel" },
  { keys: "Enter", action: "Finish the room, shaft or soffit being drawn" },
  { keys: "Escape", action: "Clear a typed length; otherwise cancel the current task and selection, or close this list" },
  { keys: "Delete or Backspace", action: "Delete the selection" },
  { keys: "Space+drag", action: "Pan; middle-drag, and dragging empty space in Edit rooms, also pan" },
  { keys: "Scroll", action: "Zoom" },
];
