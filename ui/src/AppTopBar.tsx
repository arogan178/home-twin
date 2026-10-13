import { AlertTriangle, FileUp, LampCeiling, PencilRuler } from "lucide-react";

import type { Project, WorkspaceMode } from "./types";

export function AppTopBar({
  project,
  workspace,
  onWorkspaceChange,
  onReplaceIfc,
}: {
  readonly project: Project;
  readonly workspace: WorkspaceMode;
  readonly onWorkspaceChange: (workspace: WorkspaceMode) => void;
  readonly onReplaceIfc: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand-mark"><LampCeiling size={18} /><span>Home Twin</span></div>
      <div className="project-title">
        <span>{project.building.name}</span>
        <small>{project.building.schema} · local model</small>
      </div>
      <div className="segmented" role="group" aria-label="Workspace">
        <button
          type="button"
          className={workspace === "design" ? "segmented-option segmented-option--active" : "segmented-option"}
          aria-pressed={workspace === "design"}
          onClick={() => onWorkspaceChange("design")}
        >
          <LampCeiling size={15} /> Lighting
        </button>
        <button
          type="button"
          className={workspace === "trace" ? "segmented-option segmented-option--active" : "segmented-option"}
          aria-pressed={workspace === "trace"}
          onClick={() => onWorkspaceChange("trace")}
        >
          <PencilRuler size={15} /> Trace plan
        </button>
      </div>
      <div className="topbar-actions">
        <span className="revision-chip" title={project.building.revision}>Rev {project.building.revision.slice(7, 15)}</span>
        {project.server_stale ? (
          <span
            className="revision-chip revision-chip--stale"
            title="Python is loaded once, so a fix edited since then is not running. Stop the server and start it again."
          >
            <AlertTriangle size={13} /> Server needs restarting
          </span>
        ) : null}
        <button className="button button--quiet button--compact" type="button" onClick={onReplaceIfc}><FileUp size={15} /> <span>Replace IFC</span></button>
      </div>
    </header>
  );
}
