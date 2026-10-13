import { GitCommitHorizontal, Ruler, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { toolbarPosition, type ScreenRect } from "./selectionToolbar";
import type { PlanAperture } from "./types";

export type ApertureSize = Pick<PlanAperture, "width_mm" | "sill_height_mm" | "height_mm">;

export type ToolbarSelection =
  | { readonly kind: "room"; readonly id: string; readonly onAddCorner: () => void; readonly onDone: () => void }
  | { readonly kind: "point"; readonly id: string; readonly deleteRefusal: string | null; readonly onDelete: () => void }
  | {
      readonly kind: "aperture";
      readonly aperture: PlanAperture;
      readonly onChange: (patch: Partial<ApertureSize>) => void;
      readonly onDelete: () => void;
    }
  | { readonly kind: "control"; readonly id: string; readonly onReanchor: () => void; readonly onDelete: () => void };

const APERTURE_FIELDS: ReadonlyArray<{ readonly key: keyof ApertureSize; readonly label: string }> = [
  { key: "width_mm", label: "Width" },
  { key: "sill_height_mm", label: "Sill" },
  { key: "height_mm", label: "Height" },
];

/** The selection's main actions, floating beside it on the canvas. The inspector stays the full panel. */
export function TraceSelectionToolbar({
  anchor,
  canvas,
  selection,
}: {
  readonly anchor: ScreenRect;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly selection: ToolbarSelection;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = element.current;
    if (node === null || (node.offsetWidth === size.width && node.offsetHeight === size.height)) return;
    setSize({ width: node.offsetWidth, height: node.offsetHeight });
  });
  const { left, top, placement } = toolbarPosition(anchor, size, canvas);

  let label: string;
  let content: ReactNode;
  if (selection.kind === "room") {
    label = `Room ${selection.id}`;
    content = (
      <>
        <button type="button" title="Click the room edge where the new corner belongs" onClick={selection.onAddCorner}>
          <GitCommitHorizontal size={14} /> Add a corner
        </button>
        <button type="button" title="Stop editing this room" onClick={selection.onDone}>Done</button>
      </>
    );
  } else if (selection.kind === "point") {
    label = `Point ${selection.id}`;
    content = (
      <DeleteButton
        disabled={selection.deleteRefusal !== null}
        title={selection.deleteRefusal ?? "Delete this point"}
        onClick={selection.onDelete}
      />
    );
  } else if (selection.kind === "aperture") {
    const { aperture } = selection;
    label = `Opening ${aperture.id}`;
    content = (
      <>
        {APERTURE_FIELDS.map((field) => (
          <label key={field.key} className="trace-selection-field">
            <span>{field.label}</span>
            <input
              type="number"
              step={10}
              aria-label={`${field.label} in millimetres`}
              value={aperture[field.key]}
              onChange={(event) => {
                const next = event.currentTarget.valueAsNumber;
                if (Number.isFinite(next)) selection.onChange({ [field.key]: next });
              }}
            />
          </label>
        ))}
        <DeleteButton title="Delete this opening" onClick={selection.onDelete} />
      </>
    );
  } else {
    label = `Dimension check ${selection.id}`;
    content = (
      <>
        <button type="button" title="Click the two corners the printed dimension runs between" onClick={selection.onReanchor}>
          <Ruler size={14} /> Move onto other corners
        </button>
        <DeleteButton title="Delete this dimension check" onClick={selection.onDelete} />
      </>
    );
  }

  return (
    <div
      ref={element}
      className="trace-selection-toolbar"
      data-placement={placement}
      role="toolbar"
      aria-label={label}
      style={{ left, top }}
    >
      {content}
    </div>
  );
}

function DeleteButton({ disabled = false, title, onClick }: { readonly disabled?: boolean; readonly title: string; readonly onClick: () => void }) {
  return (
    <button type="button" className="trace-selection-delete" aria-label="Delete" title={title} disabled={disabled} onClick={onClick}>
      <Trash2 size={14} />
    </button>
  );
}
