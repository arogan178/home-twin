/** The build readiness strip under the canvas and the full list of plan checks beside it. */

import { AlertTriangle, Check, Hammer, LoaderCircle, Save } from "lucide-react";

import type { LoadState, PlanReview } from "./types";

export function TraceReviewDock({
  review,
  dirty,
  busy,
  onSave,
  onBuild,
}: {
  readonly review: LoadState<PlanReview>;
  readonly dirty: boolean;
  readonly busy: "idle" | "saving" | "building";
  readonly onSave: () => void;
  readonly onBuild: () => void;
}) {
  const currentReview = review.kind === "ready" ? review.value : null;
  const blockers = currentReview?.blockers ?? [];
  return (
    <div className="review-dock">
      <div className="review-status">
        {review.kind === "loading" ? (
          <>
            <LoaderCircle className="spin" size={16} />
            <span>Reviewing the trace</span>
          </>
        ) : null}
        {currentReview !== null && blockers.length === 0 ? (
          <>
            <Check size={16} />
            <span>Ready to build IFC</span>
            <small>
              {currentReview.room_count} rooms, {currentReview.controls.filter((item) => item.passed).length}/
              {currentReview.controls.length} controls, {currentReview.traced_net_area_m2.toFixed(1)} m&sup2;
              {currentReview.warnings.length > 0 ? `, ${currentReview.warnings.length} review notes` : ""}
            </small>
          </>
        ) : null}
        {blockers.length > 0 ? (
          <>
            <AlertTriangle size={16} />
            <span>
              {blockers.length} blocker{blockers.length === 1 ? "" : "s"}
            </span>
            <small>{blockers[0]?.message}</small>
          </>
        ) : null}
      </div>
      <div className="review-actions">
        <button
          className="button button--secondary"
          type="button"
          disabled={!dirty || busy !== "idle"}
          onClick={onSave}
        >
          <Save size={17} /> {busy === "saving" ? "Saving source..." : "Save plan source"}
        </button>
        <button
          className="button button--primary"
          type="button"
          disabled={dirty || blockers.length > 0 || busy !== "idle"}
          onClick={onBuild}
        >
          <Hammer size={17} /> {busy === "building" ? "Building draft..." : "Build draft IFC"}
        </button>
      </div>
    </div>
  );
}

export function TracePlanChecks({ review }: { readonly review: PlanReview }) {
  return (
    <details className="checks-panel trace-review">
      <summary className="checks-heading">
        <span>
          <strong>Plan checks</strong>
          <small>{review.blockers.length > 0 ? `${review.blockers.length} need attention` : "No blockers"}</small>
        </span>
        <span className="checks-count">{review.blockers.length + review.warnings.length}</span>
      </summary>
      <div className="finding-list trace-review-list">
        {review.blockers.map((finding) => (
          <div className="finding finding--error" key={`b-${finding.code}-${finding.message}`}>
            <span className="finding-mark">!</span>
            <div>
              <strong>{finding.code.replaceAll("_", " ")}</strong>
              <p>{finding.message}</p>
            </div>
          </div>
        ))}
        {review.warnings.map((finding) => (
          <div className="finding finding--warning" key={`w-${finding.code}-${finding.message}`}>
            <span className="finding-mark">!</span>
            <div>
              <strong>{finding.code.replaceAll("_", " ")}</strong>
              <p>{finding.message}</p>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
