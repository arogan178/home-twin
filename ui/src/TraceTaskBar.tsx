/** The row of tracing tasks, with undo, redo, and the shortcuts sheet. */

import {
  Crosshair,
  Image as ImageIcon,
  Keyboard,
  Layers,
  MousePointer2,
  Redo2,
  Ruler,
  Square,
  Undo2,
  Wind,
} from "lucide-react";
import type { ReactNode } from "react";

import { TASK_SHORTCUTS, type TaskId } from "./traceShortcuts";

const taskIcons: Readonly<Record<TaskId, ReactNode>> = {
  select: <MousePointer2 size={16} />,
  room: <Square size={16} />,
  shaft: <Wind size={16} />,
  soffit: <Layers size={16} />,
  aperture: <Crosshair size={16} />,
  control: <Ruler size={16} />,
  calibrate: <ImageIcon size={16} />,
};

export function TraceTaskBar({
  activeTask,
  historyDepth,
  historySteps,
  onChooseTask,
  onStepHistory,
  onShowShortcuts,
}: {
  readonly activeTask: string;
  readonly historyDepth: { readonly undo: number; readonly redo: number };
  readonly historySteps: number;
  readonly onChooseTask: (task: TaskId) => void;
  readonly onStepHistory: (direction: "undo" | "redo") => void;
  readonly onShowShortcuts: () => void;
}) {
  return (
    <nav className="trace-taskbar" aria-label="Tracing tasks">
      <span>What do you want to do?</span>
      <div className="trace-taskbar-actions">
        {TASK_SHORTCUTS.map((item) => (
          <button
            key={item.task}
            type="button"
            className={activeTask === item.task ? "trace-task trace-task--active" : "trace-task"}
            aria-pressed={activeTask === item.task}
            aria-keyshortcuts={item.key}
            title={`${item.label} (${item.key})`}
            onClick={() => onChooseTask(item.task)}
          >
            {taskIcons[item.task]} {item.label} <kbd className="trace-key" aria-hidden="true">{item.key}</kbd>
          </button>
        ))}
        <button
          className="trace-task trace-task--utility"
          type="button"
          disabled={historyDepth.undo === 0}
          aria-keyshortcuts="Control+Z Meta+Z"
          title={historyDepth.undo === 0 ? "Nothing to undo" : `Undo (Ctrl+Z), ${historyDepth.undo} of ${historySteps} steps kept`}
          onClick={() => onStepHistory("undo")}
        >
          <Undo2 size={16} /> Undo
        </button>
        <button
          className="trace-task"
          type="button"
          disabled={historyDepth.redo === 0}
          aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
          title={historyDepth.redo === 0 ? "Nothing to redo" : "Redo (Ctrl+Shift+Z or Ctrl+Y)"}
          onClick={() => onStepHistory("redo")}
        >
          <Redo2 size={16} /> Redo
        </button>
        <button
          className="trace-task"
          type="button"
          aria-haspopup="dialog"
          aria-keyshortcuts="?"
          title="Keyboard shortcuts and gestures (?)"
          onClick={onShowShortcuts}
        >
          <Keyboard size={16} /> Shortcuts
        </button>
      </div>
    </nav>
  );
}
