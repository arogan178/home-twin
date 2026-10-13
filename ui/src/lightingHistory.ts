import { useRef, useState } from "react";

import type { Fixture, FixtureTag, Sensor, WallSwitch } from "./types";

export type LightingDraftSnapshot = {
  readonly fixtures: Fixture[];
  readonly switches: WallSwitch[];
  readonly sensors: Sensor[];
  readonly selectedTags: ReadonlySet<FixtureTag>;
};

/** Undo and redo stacks for the lighting draft, each capped at 50 snapshots. */
export function useLightingHistory() {
  const undoStack = useRef<LightingDraftSnapshot[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const redoStack = useRef<LightingDraftSnapshot[]>([]);
  const [redoDepth, setRedoDepth] = useState(0);

  function record(current: LightingDraftSnapshot) {
    undoStack.current = [...undoStack.current.slice(-49), current];
    setUndoDepth(undoStack.current.length);
    // A new edit forks the history, so what was undone cannot be redone.
    redoStack.current = [];
    setRedoDepth(0);
  }

  /** The snapshot to restore, with `current` kept for redo; undefined when there is nothing to undo. */
  function undo(current: LightingDraftSnapshot): LightingDraftSnapshot | undefined {
    const previous = undoStack.current.at(-1);
    if (previous === undefined) return undefined;
    undoStack.current = undoStack.current.slice(0, -1);
    setUndoDepth(undoStack.current.length);
    redoStack.current = [...redoStack.current.slice(-49), current];
    setRedoDepth(redoStack.current.length);
    return previous;
  }

  function redo(current: LightingDraftSnapshot): LightingDraftSnapshot | undefined {
    const next = redoStack.current.at(-1);
    if (next === undefined) return undefined;
    redoStack.current = redoStack.current.slice(0, -1);
    setRedoDepth(redoStack.current.length);
    undoStack.current = [...undoStack.current.slice(-49), current];
    setUndoDepth(undoStack.current.length);
    return next;
  }

  function clear() {
    undoStack.current = [];
    setUndoDepth(0);
    redoStack.current = [];
    setRedoDepth(0);
  }

  return {
    undoDepth,
    redoDepth,
    canUndo: () => undoStack.current.length > 0,
    canRedo: () => redoStack.current.length > 0,
    record,
    undo,
    redo,
    clear,
  };
}
