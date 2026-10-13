import { FileCheck2, FileWarning, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "./api";
import type { ImportSummary, Revision } from "./types";

type ImportDialogProps = {
  readonly revision: Revision;
  readonly onClose: () => void;
  readonly onAdopted: () => Promise<void>;
};

type ImportState =
  | { kind: "choosing" }
  | { kind: "inspecting"; fileName: string }
  | { kind: "review"; summary: ImportSummary }
  | { kind: "adopting"; summary: ImportSummary }
  | { kind: "error"; message: string };

export function ImportDialog({ revision, onClose, onAdopted }: ImportDialogProps) {
  const [state, setState] = useState<ImportState>({ kind: "choosing" });
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  // The native modal makes the page inert; focus goes back to whatever opened it.
  useEffect(() => {
    if (dialog.current?.open === false) dialog.current.showModal();
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => trigger?.focus();
  }, []);

  // Each step lands focus on its first control, ahead of the close button.
  useEffect(() => {
    const items = focusables(dialog.current);
    (items.find((element) => !element.matches(".icon-button")) ?? items[0] ?? dialog.current)?.focus();
  }, [state.kind]);

  async function inspect(file: File) {
    setState({ kind: "inspecting", fileName: file.name });
    try {
      setState({ kind: "review", summary: await api.inspectIfc(file) });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "The IFC could not be inspected" });
    }
  }

  async function adopt(summary: ImportSummary) {
    setState({ kind: "adopting", summary });
    try {
      await api.adoptIfc(summary.import_id, revision);
      await onAdopted();
      onClose();
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "The IFC could not be adopted" });
    }
  }

  async function close() {
    if (state.kind === "review") await api.discardIfc(state.summary.import_id);
    onClose();
  }

  const busy = state.kind === "inspecting" || state.kind === "adopting";

  return (
    <dialog
      ref={dialog}
      className="import-dialog"
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) void close();
      }}
      onMouseDown={(event) => event.target === event.currentTarget && !busy && void close()}
    >
      <header>
        <div>
          <p className="eyebrow">Replace the canonical model</p>
          <h2 id="import-title">Inspect an IFC first</h2>
        </div>
        <button className="icon-button" type="button" onClick={() => void close()} disabled={busy} aria-label="Close import dialog">
          <X size={20} />
        </button>
      </header>

      {state.kind === "choosing" ? (
        <>
          <button className="drop-target" type="button" onClick={() => input.current?.click()}>
            <Upload size={28} />
            <strong>Choose an IFC model</strong>
            <span>The file stays on this computer. Maximum size 250 MB.</span>
          </button>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept=".ifc"
            onChange={(event) => {
              const file = event.currentTarget.files?.item(0);
              if (file !== null && file !== undefined) void inspect(file);
            }}
          />
          <div className="import-note">
            <FileWarning size={18} />
            <p><strong>Have a PDF, DWG or image?</strong> Export it as an image and trace it in <strong>Trace plan</strong>, which builds a verified draft IFC without replacing this model.</p>
          </div>
        </>
      ) : null}

      {state.kind === "inspecting" ? (
        <div className="dialog-progress">
          <span className="spinner" />
          <strong>Checking {state.fileName}</strong>
          <p>Reading rooms, ceiling geometry, walls and IFC schema.</p>
        </div>
      ) : null}

      {state.kind === "review" || state.kind === "adopting" ? (
        <div className="import-review">
          <div className="import-file-row">
            <FileCheck2 size={24} />
            <div><strong>{state.summary.file_name}</strong><span>{(state.summary.size_bytes / 1_048_576).toFixed(1)} MB</span></div>
          </div>
          <dl className="import-facts">
            <div><dt>Building</dt><dd>{state.summary.building.name}</dd></div>
            <div><dt>Rooms</dt><dd>{state.summary.ready_room_count} / {state.summary.room_count} ready</dd></div>
            <div><dt>Schema</dt><dd>{state.summary.building.schema}</dd></div>
          </dl>
          {state.summary.blockers.length > 0 ? (
            <div className="message message--error"><strong>Cannot use this IFC</strong>{state.summary.blockers.map((item) => <p key={item}>{item}</p>)}</div>
          ) : null}
          {state.summary.warnings.length > 0 ? (
            <div className="message message--warning"><strong>Review before continuing</strong>{state.summary.warnings.map((item) => <p key={item}>{item}</p>)}</div>
          ) : null}
          <footer>
            <button className="button button--quiet" type="button" onClick={() => setState({ kind: "choosing" })} disabled={state.kind === "adopting"}>Choose another</button>
            <button className="button button--primary" type="button" disabled={!state.summary.can_adopt || state.kind === "adopting"} onClick={() => void adopt(state.summary)}>
              {state.kind === "adopting" ? "Replacing model..." : "Use this IFC"}
            </button>
          </footer>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="dialog-error">
          <FileWarning size={28} />
          <strong>Import stopped</strong>
          <p>{state.message}</p>
          <button className="button button--secondary" type="button" onClick={() => setState({ kind: "choosing" })}>Try another file</button>
        </div>
      ) : null}
    </dialog>
  );
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLElement>("button, [href], input:not(.visually-hidden), select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
    (element) => !element.hasAttribute("disabled"),
  );
}
