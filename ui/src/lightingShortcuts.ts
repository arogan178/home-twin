/** The lighting edits the keyboard reaches while the design workspace is open. */
export type LightingShortcut = "duplicate" | "undo" | "redo" | "delete" | "deselect";

export type LightingShortcutContext = {
  readonly roomScope: boolean;
  readonly canDuplicate: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  readonly dialogOpen: boolean;
};

type ShortcutKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target" | "defaultPrevented">;

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

/** The edit a key press asks for, or null when it asks for none or nothing would change. */
export function lightingShortcut(event: ShortcutKey, context: LightingShortcutContext): LightingShortcut | null {
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "d") {
      // The browser bookmarks the page on Ctrl+D; claim it only when there is something to copy.
      return context.roomScope && context.canDuplicate && !isEditableTarget(event.target) ? "duplicate" : null;
    }
    if ((key === "z" && event.shiftKey) || key === "y") {
      return context.canRedo && !isEditableTarget(event.target) ? "redo" : null;
    }
    return key === "z" && !event.shiftKey && context.canUndo ? "undo" : null;
  }
  if (event.key === "Delete" && context.roomScope && context.hasSelection && !isEditableTarget(event.target)) {
    return "delete";
  }
  // The 3D view claims Escape first for its own tools and cards.
  if (event.key === "Escape" && !event.defaultPrevented && !context.dialogOpen && context.hasSelection && !isEditableTarget(event.target)) {
    return "deselect";
  }
  return null;
}
