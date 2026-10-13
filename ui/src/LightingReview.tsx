import { AlertTriangle, ArrowRight, Check, Download, LoaderCircle, RefreshCw, Save, ScanSearch } from "lucide-react";

import { humaniseId } from "./displayNames";
import type { DraftState, ExportResponse, Finding, Validation } from "./types";

/** The status line and the stage's actions under the plan. */
export function ReviewDock({
  draft,
  analysisPending,
  report,
  errorCount,
  lightCount,
  switchCount,
  publishing,
  nextStageLabel,
  canCommit,
  onExport,
  onValidate,
  onCommit,
  onNextStage,
}: {
  readonly draft: DraftState;
  readonly analysisPending: boolean;
  readonly report: Validation | null;
  readonly errorCount: number;
  readonly lightCount: number;
  readonly switchCount: number;
  readonly publishing: boolean;
  readonly nextStageLabel: string;
  readonly canCommit: boolean;
  readonly onExport: () => void;
  readonly onValidate: () => void;
  readonly onCommit: () => void;
  readonly onNextStage: () => void;
}) {
  const warningCount = report?.findings.filter((finding) => finding.severity === "warning").length ?? 0;
  const noteCount = report?.findings.filter((finding) => finding.severity === "info").length ?? 0;
  const reviewSummary = [
    warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : null,
    noteCount > 0 ? `${noteCount} note${noteCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="review-dock">
      <div className="review-status" role="status">
        {draft.kind === "dirty" && !analysisPending ? <><RefreshCw size={16} /><span>Layout changed</span><small>Waiting for checks</small></> : null}
        {draft.kind === "validating" || analysisPending ? <><LoaderCircle className="spin" size={16} /><span>Updating light analysis</span></> : null}
        {draft.kind === "saving" ? <><LoaderCircle className="spin" size={16} /><span>Saving to IFC</span></> : null}
        {report !== null && report.findings.length === 0 ? <><Check size={16} className="review-status-ok" /><span>Checks passed</span><small>{lightCount} lights · {switchCount} switches</small></> : null}
        {report !== null && errorCount === 0 && reviewSummary !== "" ? <><Check size={16} className="review-status-ok" /><span>{`No blockers · ${reviewSummary}`}</span><small>Review them in Layout checks</small></> : null}
        {report !== null && errorCount > 0 ? <><AlertTriangle size={16} className="review-status-error" /><span>{errorCount} blocking issue{errorCount === 1 ? "" : "s"}</span><small>Fix before saving</small></> : null}
      </div>
      <div className="review-actions">
        {publishing ? (
          <>
            <button className="button button--quiet" type="button" onClick={onExport}><Download size={16} /> Export</button>
            <button className="button button--secondary" type="button" disabled={draft.kind === "validating" || draft.kind === "saving"} onClick={onValidate}><ScanSearch size={16} /> Check layout</button>
            <button className="button button--primary" type="button" disabled={!canCommit} onClick={onCommit}><Save size={16} /> Save to IFC</button>
          </>
        ) : (
          <>
            <button className="button button--secondary" type="button" disabled={draft.kind === "validating" || draft.kind === "saving"} onClick={onValidate}><ScanSearch size={16} /> Check layout</button>
            <button className="button button--primary" type="button" onClick={onNextStage}>
              Next: {nextStageLabel} <ArrowRight size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function LayoutChecks({ report }: { report: Validation }) {
  return (
    <section className="checks-panel">
      <div className="checks-heading"><h2 className="panel-title">Layout checks</h2><span className="checks-count">{report.findings.length}</span></div>
      <Findings report={report} />
    </section>
  );
}

export function InstallationFiles({ exports }: { exports: ExportResponse }) {
  return (
    <section className="download-panel">
      <h2 className="panel-title">Installation files</h2>
      {exports.files.map((file) => <a key={file.name} href={file.url} download><Download size={15} /><span>{file.name}</span></a>)}
    </section>
  );
}

function Findings({ report }: { report: Validation }) {
  if (report.findings.length === 0) {
    return (
      <div className="all-clear">
        <span><Check size={15} /></span>
        <p><strong>No geometric conflicts</strong>Ready to review, then save to IFC.</p>
      </div>
    );
  }

  return (
    <div className="finding-list">
      {report.findings.map((finding, index) => (
        <FindingRow key={`${finding.code}-${finding.fixture_tags.join("-")}-${index}`} finding={finding} />
      ))}
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className={`finding finding--${finding.severity}`}>
      <span className="finding-mark">!</span>
      <div><strong>{humaniseId(finding.code)}</strong><p>{finding.message}</p></div>
    </div>
  );
}
