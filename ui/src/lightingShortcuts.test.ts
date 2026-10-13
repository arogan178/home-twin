import { describe, expect, it } from "vitest";

import { lightingShortcut, type LightingShortcutContext } from "./lightingShortcuts";

const ready: LightingShortcutContext = {
  roomScope: true,
  canDuplicate: true,
  canUndo: true,
  canRedo: true,
  hasSelection: true,
  dialogOpen: false,
};

function press(key: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; prevented?: boolean; target?: EventTarget | null } = {}) {
  return {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: modifiers.meta ?? false,
    shiftKey: modifiers.shift ?? false,
    defaultPrevented: modifiers.prevented ?? false,
    target: modifiers.target ?? document.body,
  };
}

describe("lightingShortcut", () => {
  it("maps the edit keys", () => {
    expect(lightingShortcut(press("d", { ctrl: true }), ready)).toBe("duplicate");
    expect(lightingShortcut(press("z", { meta: true }), ready)).toBe("undo");
    expect(lightingShortcut(press("Z", { ctrl: true, shift: true }), ready)).toBe("redo");
    expect(lightingShortcut(press("y", { ctrl: true }), ready)).toBe("redo");
    expect(lightingShortcut(press("Delete"), ready)).toBe("delete");
    expect(lightingShortcut(press("Escape"), ready)).toBe("deselect");
    expect(lightingShortcut(press("d"), ready)).toBeNull();
  });

  it("leaves Ctrl+D to the browser when there is nothing to copy or the floor is open", () => {
    expect(lightingShortcut(press("d", { ctrl: true }), { ...ready, canDuplicate: false })).toBeNull();
    expect(lightingShortcut(press("d", { ctrl: true }), { ...ready, roomScope: false })).toBeNull();
  });

  it("claims undo and redo only with history to walk", () => {
    expect(lightingShortcut(press("z", { ctrl: true }), { ...ready, canUndo: false })).toBeNull();
    expect(lightingShortcut(press("y", { ctrl: true }), { ...ready, canRedo: false })).toBeNull();
  });

  it("does not edit the draft while a field has focus, except to undo", () => {
    const field = document.createElement("input");
    expect(lightingShortcut(press("Delete", { target: field }), ready)).toBeNull();
    expect(lightingShortcut(press("Escape", { target: field }), ready)).toBeNull();
    expect(lightingShortcut(press("d", { ctrl: true, target: field }), ready)).toBeNull();
    expect(lightingShortcut(press("y", { ctrl: true, target: field }), ready)).toBeNull();
    expect(lightingShortcut(press("z", { ctrl: true, target: field }), ready)).toBe("undo");
  });

  it("lets the 3D view and the import dialog keep Escape", () => {
    expect(lightingShortcut(press("Escape", { prevented: true }), ready)).toBeNull();
    expect(lightingShortcut(press("Escape"), { ...ready, dialogOpen: true })).toBeNull();
    expect(lightingShortcut(press("Escape"), { ...ready, hasSelection: false })).toBeNull();
    expect(lightingShortcut(press("Delete"), { ...ready, roomScope: false })).toBeNull();
  });
});
