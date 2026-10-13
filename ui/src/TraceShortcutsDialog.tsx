import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { TRACE_SHORTCUTS } from "./traceShortcuts";

/** Every tracing shortcut and gesture, as readable text. Escape is handled by the workspace key handler. */
export function TraceShortcutsDialog({ onClose }: { readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (dialog.current?.open === false) dialog.current.showModal();
    return () => opener?.focus();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="import-dialog trace-shortcuts"
      aria-labelledby="trace-shortcuts-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <header>
        <div>
          <p className="eyebrow">Plan tracing</p>
          <h2 id="trace-shortcuts-title">Shortcuts and gestures</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close shortcuts">
          <X size={20} />
        </button>
      </header>
      <table>
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {TRACE_SHORTCUTS.map((item) => (
            <tr key={item.keys}>
              <th scope="row"><kbd>{item.keys}</kbd></th>
              <td>{item.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </dialog>
  );
}
