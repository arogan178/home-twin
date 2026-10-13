/** The tool rail and its panels, shared by both 3D views. */

import {
  Camera,
  ChevronDown,
  Expand,
  FlipVertical2,
  Keyboard,
  LayoutDashboard,
  Link,
  Maximize2,
  MousePointerClick,
  PersonStanding,
  Ruler,
  Scissors,
  Shrink,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { MEASURE_METHOD } from "./measureTool";
import { formatMillimetres } from "./plan";
import { SECTION_LABELS, sectionRange, type SectionMode, type ViewBounds } from "./sectionPlane";
import type { ViewerTools } from "./useViewerTools";
import { VIEWER_SHORTCUTS, type ViewerAction } from "./viewerShortcuts";

function RailButton(props: {
  readonly label: string;
  readonly shortcut?: string;
  readonly active?: boolean | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const title = props.shortcut ? `${props.label} (${props.shortcut})` : props.label;
  return (
    <button
      type="button"
      className={props.active ? "viewer-rail-button viewer-rail-button--active" : "viewer-rail-button"}
      aria-pressed={props.active}
      aria-label={props.label}
      title={title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function ViewerRail(props: {
  readonly tools: ViewerTools;
  readonly onReset: () => void;
  readonly onPlan: () => void;
  /** Eye level in a room; walking in the whole floor. Absent hides the button. */
  readonly onEye?: () => void;
  readonly eyeLabel?: string | undefined;
  readonly eyeActive?: boolean | undefined;
}) {
  const { tools } = props;
  return (
    <div className="viewer-rail" role="toolbar" aria-label="3D view tools" aria-orientation="vertical">
      <RailButton label="Reset view" shortcut="R" onClick={props.onReset}>
        <Maximize2 size={16} />
      </RailButton>
      <RailButton label="Plan view" shortcut="T" onClick={props.onPlan}>
        <LayoutDashboard size={16} />
      </RailButton>
      {props.onEye ? (
        <RailButton label={props.eyeLabel ?? "Eye level"} shortcut="E" active={props.eyeActive} onClick={props.onEye}>
          <PersonStanding size={16} />
        </RailButton>
      ) : null}
      <RailButton label="Measure" shortcut="M" active={tools.measuring} onClick={tools.toggleMeasuring}>
        <Ruler size={16} />
      </RailButton>
      <RailButton label="Section cut" shortcut="C" active={tools.sectionOpen} onClick={tools.toggleSection}>
        <Scissors size={16} />
      </RailButton>
      <span className="viewer-rail-gap" />
      <RailButton label="Save a captioned snapshot" onClick={tools.snapshot}>
        <Camera size={16} />
      </RailButton>
      <RailButton label="Copy a link to this view" onClick={tools.copyLink}>
        <Link size={16} />
      </RailButton>
      <RailButton
        label={tools.fullscreen ? "Leave full screen" : "Full screen"}
        shortcut="F"
        active={tools.fullscreen}
        onClick={tools.toggleFullscreen}
      >
        {tools.fullscreen ? <Shrink size={16} /> : <Expand size={16} />}
      </RailButton>
      <RailButton
        label="Keyboard shortcuts"
        shortcut="?"
        active={tools.helpOpen}
        onClick={() => tools.setHelpOpen(!tools.helpOpen)}
      >
        <Keyboard size={16} />
      </RailButton>
    </div>
  );
}

export function SectionPanel(props: { readonly tools: ViewerTools; readonly bounds: ViewBounds }) {
  const { tools } = props;
  if (!tools.sectionOpen || tools.section.mode === "off") return null;
  const { section } = tools;
  const mode = section.mode as Exclude<SectionMode, "off">;
  const range = sectionRange(mode, props.bounds);
  const axis = mode === "height" ? "Z" : mode.toUpperCase();
  return (
    <section className="viewer-card viewer-card--section" aria-label="Section cut">
      <div className="viewer-card-heading">
        <p className="eyebrow">Section</p>
        <button type="button" className="viewer-card-close" aria-label="Remove the section" onClick={tools.toggleSection}>
          <X size={14} />
        </button>
      </div>
      <div className="segmented segmented--tight" role="group" aria-label="Section direction">
        {(Object.keys(SECTION_LABELS) as Array<Exclude<SectionMode, "off">>).map((item) => (
          <button
            key={item}
            type="button"
            className={mode === item ? "segmented-option segmented-option--active" : "segmented-option"}
            aria-pressed={mode === item}
            onClick={() => tools.chooseSection(item)}
          >
            {SECTION_LABELS[item]}
          </button>
        ))}
      </div>
      <label className="viewer-slider">
        <span>
          {axis} {formatMillimetres(section.atM * 1000)} mm
        </span>
        <input
          type="range"
          aria-label="Section position"
          min={range.min}
          max={range.max}
          step={0.01}
          value={section.atM}
          onChange={(event) => tools.setSection({ ...section, atM: event.currentTarget.valueAsNumber })}
        />
      </label>
      <button
        type="button"
        className="tool-button tool-button--tight"
        aria-pressed={section.flip}
        onClick={() => tools.setSection({ ...section, flip: !section.flip })}
      >
        <FlipVertical2 size={14} /> Keep the other side
      </button>
      <p className="viewer-card-note">Display cut only. Lighting is unchanged: the hidden side still casts.</p>
    </section>
  );
}

export function MeasureReadout(props: { readonly tools: ViewerTools }) {
  const { tools } = props;
  if (!tools.measuring) return null;
  const result = tools.measurement;
  return (
    <section className="viewer-card viewer-card--measure" aria-label="Measurement" aria-live="polite">
      <div className="viewer-card-heading">
        <p className="eyebrow">Measure</p>
        <button type="button" className="viewer-card-close" aria-label="Stop measuring" onClick={tools.toggleMeasuring}>
          <X size={14} />
        </button>
      </div>
      {result === null ? (
        <p className="viewer-card-prompt">
          {tools.measureStarted ? "Click the second point. Hold Shift to lock to an axis." : "Click the first point."}
        </p>
      ) : (
        <>
          <p className="viewer-measure-value">{formatMillimetres(result.distanceMm)} mm</p>
          <dl className="viewer-measure-parts">
            <div><dt>ΔX</dt><dd>{formatMillimetres(result.dxMm)}</dd></div>
            <div><dt>ΔY</dt><dd>{formatMillimetres(result.dyMm)}</dd></div>
            <div><dt>ΔZ</dt><dd>{formatMillimetres(result.dzMm)}</dd></div>
          </dl>
          <p className="viewer-card-prompt">
            {result.axis === "free" ? "Straight line." : `Locked to ${result.axis.toUpperCase()}.`} Click again to start
            a new one.
          </p>
        </>
      )}
      <p className="viewer-card-note">{MEASURE_METHOD}</p>
    </section>
  );
}

export function ShortcutHelp(props: {
  readonly tools: ViewerTools;
  readonly gestures: string;
  /** Shortcuts the view does not offer. */
  readonly omit?: ReadonlyArray<ViewerAction>;
}) {
  const { tools } = props;
  if (!tools.helpOpen) return null;
  return (
    <section className="viewer-card viewer-card--help" aria-label="Keyboard shortcuts">
      <div className="viewer-card-heading">
        <p className="eyebrow">Shortcuts</p>
        <button type="button" className="viewer-card-close" aria-label="Close shortcuts" onClick={() => tools.setHelpOpen(false)}>
          <X size={14} />
        </button>
      </div>
      <dl className="viewer-shortcuts">
        {VIEWER_SHORTCUTS.filter((item) => !props.omit?.includes(item.action)).map((item) => (
          <div key={item.key}>
            <dt><kbd>{item.key}</kbd></dt>
            <dd>{item.label}</dd>
          </div>
        ))}
      </dl>
      <p className="viewer-card-note">{props.gestures}</p>
      {tools.hintOpen ? null : (
        <button type="button" className="tool-button tool-button--tight" onClick={() => tools.setHintOpen(true)}>
          <MousePointerClick size={14} /> Show the tip again
        </button>
      )}
    </section>
  );
}

export function ViewerStatus(props: { readonly tools: ViewerTools }) {
  return props.tools.status === null ? null : (
    <p className="viewer-status" role="status">{props.tools.status}</p>
  );
}

/** The one-line tip under the view's controls, dismissed for good once closed. */
export function ViewerHint(props: { readonly tools: ViewerTools; readonly children: ReactNode }) {
  if (!props.tools.hintOpen) return null;
  return (
    <p className="model-hint">
      <MousePointerClick size={14} aria-hidden="true" />
      <span>{props.children}</span>
      <button
        type="button"
        className="viewer-hint-close"
        aria-label="Dismiss the tip. Press ? to bring it back"
        onClick={() => props.tools.setHintOpen(false)}
      >
        <X size={13} />
      </button>
    </p>
  );
}

export type NamedView = { readonly label: string; readonly onSelect: () => void };

/** A menu of named camera positions, such as the kitchen or the sofa. */
export function ViewsMenu(props: { readonly views: ReadonlyArray<NamedView> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (props.views.length === 0) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      // The view treats Escape as "close the inspector", so the menu keeps it.
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <div className="viewer-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className={open ? "tool-button tool-button--tight tool-button--active" : "tool-button tool-button--tight"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Views <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="viewer-menu-list" role="menu" id={menuId} aria-label="Views">
          {props.views.map((view) => (
            <button
              key={view.label}
              type="button"
              role="menuitem"
              className="viewer-menu-item"
              onClick={() => {
                setOpen(false);
                view.onSelect();
              }}
            >
              {view.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
