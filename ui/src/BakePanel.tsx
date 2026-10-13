import { AlertTriangle, Layers, LoaderCircle } from "lucide-react";

import type { BakedLighting, LoadState } from "./types";

type BakePanelProps = {
  readonly state: LoadState<BakedLighting> | null;
  readonly stale: boolean;
  readonly plane: "floor" | "task";
  readonly onPlaneChange: (plane: "floor" | "task") => void;
  readonly onBake: () => void;
};

export function BakePanel({ state, stale, plane, onPlaneChange, onBake }: BakePanelProps) {
  const baked = state !== null && state.kind === "ready" ? state.value : null;

  return (
    <section className="bake-panel">
      <div className="checks-heading">
        <h2 className="panel-title">Shadow pass</h2>
        <span className="checks-meta">{baked === null ? "Not run" : `${baked.samples.length} samples`}</span>
      </div>

      <div className="segmented segmented--tight" role="group" aria-label="Bake plane">
        <button
          type="button"
          className={plane === "floor" ? "segmented-option segmented-option--active" : "segmented-option"}
          aria-pressed={plane === "floor"}
          onClick={() => onPlaneChange("floor")}
        >
          Floor
        </button>
        <button
          type="button"
          className={plane === "task" ? "segmented-option segmented-option--active" : "segmented-option"}
          aria-pressed={plane === "task"}
          onClick={() => onPlaneChange("task")}
        >
          Task plane
        </button>
      </div>

      <button
        className="button button--secondary"
        type="button"
        disabled={state?.kind === "loading"}
        onClick={onBake}
      >
        {state?.kind === "loading" ? (
          <>
            <LoaderCircle className="spin" size={16} /> Tracing shadow rays
          </>
        ) : (
          <>
            <Layers size={16} /> {baked === null ? "Run shadow pass" : "Re-run shadow pass"}
          </>
        )}
      </button>

      {state?.kind === "error" ? (
        <p className="daylight-status daylight-status--error">
          <AlertTriangle size={15} /> {state.message}
        </p>
      ) : null}

      {baked !== null ? (
        <>
          {stale ? (
            <div className="message message--warning">
              <strong>The layout changed since this pass.</strong>
              <p>Run it again to shade the current spotlights.</p>
            </div>
          ) : null}
          <dl className="bake-facts">
            <div>
              <dt>Peak</dt>
              <dd>{Math.round(baked.maximum_lux)} lx</dd>
            </div>
            <div>
              <dt>Mean</dt>
              <dd>{Math.round(baked.mean_lux)} lx</dd>
            </div>
            <div>
              <dt>At target</dt>
              <dd>{Math.round(baked.covered_fraction * 100)}%</dd>
            </div>
            <div>
              <dt>Shadowed</dt>
              <dd>{Math.round(baked.shadowed_fraction * 100)}%</dd>
            </div>
          </dl>
          {baked.task_area != null ? (
            <>
              <div className="section-label">
                <span>Task area</span>
                <small>{Math.round(baked.task_area.border_mm)} mm border</small>
              </div>
              <dl className="bake-facts">
                <div>
                  <dt>Mean</dt>
                  <dd>{Math.round(baked.task_area.mean_lux)} lx</dd>
                </div>
                <div>
                  <dt>Minimum</dt>
                  <dd>{Math.round(baked.task_area.minimum_lux)} lx</dd>
                </div>
                <div>
                  <dt>Uniformity</dt>
                  <dd>{baked.task_area.uniformity.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>At target</dt>
                  <dd>{Math.round(baked.task_area.covered_fraction * 100)}%</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="method-note">
              No task-area figure: excluding the perimeter band leaves nothing in a room this narrow, so
              the numbers above cover the whole floor including the strip against the wall.
            </p>
          )}
          <ul className="bake-occluders">
            {baked.occluders.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {baked.interreflection != null && baked.interreflection.lux > 0 ? (
            <p className="method-note">
              Plus {Math.round(baked.interreflection.lux)} lx of room bounce, from{" "}
              {Math.round(baked.interreflection.luminous_flux_lm)} lm over{" "}
              {baked.interreflection.surface_area_m2.toFixed(1)} m² at{" "}
              {Math.round(baked.interreflection.average_reflectance * 100)}% average reflectance, itself
              stated rather than measured. Uniform by assumption: it says nothing about where the bounce
              lands.
            </p>
          ) : null}
          {baked.dark_regions.length > 0 ? (
            <div className="bake-dark">
              <div className="section-label">
                <span>Under target</span>
                <small>{baked.dark_regions.length} patch{baked.dark_regions.length === 1 ? "" : "es"}</small>
              </div>
              <ul className="bake-occluders">
                {baked.dark_regions.slice(0, 4).map((region) => (
                  <li key={`${region.centre.x}-${region.centre.y}`}>
                    {region.area_m2.toFixed(2)} m² down to {Math.round(region.minimum_lux)} lx
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="method-note">
            {baked.method} at {Math.round(baked.step_mm)} mm, {Math.round(baked.threshold_lux)} lx target,
            maintained at {baked.maintenance_factor.toFixed(2)}
            <br />
            excludes {baked.exclusions.join(", ")}
          </p>
        </>
      ) : (
        <p className="method-note">
          Adds shadow rays against cabinetry, services, stairs and walls to the same lumen and beam-cone
          approximation, and quotes maintained illuminance over the room minus its perimeter band. Slower
          than the live grid, so it runs when you ask.
        </p>
      )}
    </section>
  );
}
