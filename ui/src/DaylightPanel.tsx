import { AlertTriangle, CalendarDays, Clock, LoaderCircle, MapPin, Sun, SunDim } from "lucide-react";

import { idWords, plainText } from "./displayNames";
import type { DaylightResponse, LoadState, Site } from "./types";

type DaylightPanelProps = {
  readonly site: Site | null;
  readonly state: LoadState<DaylightResponse>;
  readonly date: string;
  readonly minutes: number;
  readonly plane: "floor" | "task";
  readonly onDateChange: (date: string) => void;
  readonly onMinutesChange: (minutes: number) => void;
  readonly onPlaneChange: (plane: "floor" | "task") => void;
  readonly onEditSite: () => void;
};

const KEY_DATES: ReadonlyArray<{ readonly label: string; readonly month: number; readonly day: number }> = [
  { label: "Summer solstice", month: 6, day: 21 },
  { label: "Equinox", month: 3, day: 20 },
  { label: "Winter solstice", month: 12, day: 21 },
];

export function clockLabel(minutes: number): string {
  const whole = Math.max(0, Math.min(1439, Math.round(minutes)));
  const hours = Math.floor(whole / 60);
  return `${String(hours).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export function localInstant(date: string, minutes: number): string {
  return `${date}T${clockLabel(minutes)}:00`;
}

function timeOfDay(when: string): number {
  const time = when.slice(11, 16).split(":");
  return Number(time[0] ?? 0) * 60 + Number(time[1] ?? 0);
}

function SunPathChart({ response }: { response: DaylightResponse }) {
  const path = response.sun_path;
  if (path === null || path.samples.length === 0) return null;
  const width = 260;
  const height = 74;
  const ceiling = Math.max(path.max_altitude_deg, 10);
  const toX = (minutes: number) => (minutes / 1440) * width;
  const toY = (altitude: number) => height - (Math.max(altitude, 0) / ceiling) * (height - 8);
  const line = path.samples
    .map((sample) => `${toX(timeOfDay(sample.when)).toFixed(1)},${toY(sample.altitude_deg).toFixed(1)}`)
    .join(" ");
  const current = response.daylight.position;
  return (
    <figure className="sun-path">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Solar altitude across the day">
        <line x1="0" y1={height} x2={width} y2={height} className="sun-path-horizon" />
        <polyline points={line} className="sun-path-line" />
        {current !== null ? (
          <g className="sun-path-now">
            <line
              x1={toX(timeOfDay(current.when))}
              y1="0"
              x2={toX(timeOfDay(current.when))}
              y2={height}
            />
            <circle cx={toX(timeOfDay(current.when))} cy={toY(current.altitude_deg)} r="4" />
          </g>
        ) : null}
      </svg>
      <figcaption>
        <span>{path.sunrise === null ? "No sunrise" : `Rise ${path.sunrise.slice(11, 16)}`}</span>
        <span>{path.solar_noon === null ? "No noon" : `Noon ${path.solar_noon.slice(11, 16)}`}</span>
        <span>{path.sunset === null ? "No sunset" : `Set ${path.sunset.slice(11, 16)}`}</span>
      </figcaption>
    </figure>
  );
}

export function DaylightPanel({
  site,
  state,
  date,
  minutes,
  plane,
  onDateChange,
  onMinutesChange,
  onPlaneChange,
  onEditSite,
}: DaylightPanelProps) {
  const located = site !== null && site.latitude_deg !== null && site.longitude_deg !== null;

  return (
    <section className="daylight-panel">
      <div className="checks-heading">
        <h2 className="panel-title">Sunlight</h2>
        <span className="checks-meta">{located ? "Geometry only" : "Site needed"}</span>
      </div>

      {!located ? (
        <div className="message message--warning">
          <strong>This model states no site location.</strong>
          <p>
            Sun angles need a latitude, longitude, and the bearing of plan +Y from true north. Enter them once in the
            tracing workspace and rebuild the draft.
          </p>
          <button className="button button--secondary" type="button" onClick={onEditSite}>
            <MapPin size={16} /> Set the site
          </button>
        </div>
      ) : (
        <>
          <p className="daylight-site">
            <MapPin size={14} /> {site.latitude_deg?.toFixed(4)}&deg;, {site.longitude_deg?.toFixed(4)}&deg; · {site.timezone ?? "UTC"}
            <br />
            plan +Y at {site.true_north_deg.toFixed(1)}&deg; from true north
          </p>

          <label className="field">
            <span>
              <CalendarDays size={14} /> Date
            </span>
            <input type="date" value={date} onChange={(event) => onDateChange(event.currentTarget.value)} />
          </label>
          <div className="quick-dates">
            {KEY_DATES.map((item) => {
              const year = date.slice(0, 4);
              const value = `${year}-${String(item.month).padStart(2, "0")}-${String(item.day).padStart(2, "0")}`;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={value === date ? "chip chip--active" : "chip"}
                  aria-pressed={value === date}
                  onClick={() => onDateChange(value)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <label className="field">
            <span>
              <Clock size={14} /> Local time <strong>{clockLabel(minutes)}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={1425}
              step={15}
              value={minutes}
              onChange={(event) => onMinutesChange(event.currentTarget.valueAsNumber)}
            />
          </label>

          <div className="segmented segmented--tight" role="group" aria-label="Sun patch plane">
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

          {state.kind === "loading" ? (
            <p className="daylight-status">
              <LoaderCircle className="spin" size={15} /> Computing sun geometry
            </p>
          ) : null}
          {state.kind === "error" ? (
            <p className="daylight-status daylight-status--error">
              <AlertTriangle size={15} /> {state.message}
            </p>
          ) : null}

          {state.kind === "ready" ? (
            <>
              <dl className="daylight-facts">
                <div>
                  <dt>Altitude</dt>
                  <dd>
                    {state.value.daylight.position === null
                      ? "-"
                      : `${state.value.daylight.position.altitude_deg.toFixed(1)}°`}
                  </dd>
                </div>
                <div>
                  <dt>Azimuth</dt>
                  <dd>
                    {state.value.daylight.position === null
                      ? "-"
                      : `${state.value.daylight.position.azimuth_deg.toFixed(1)}°`}
                  </dd>
                </div>
                <div>
                  <dt>Direct patches</dt>
                  <dd>{state.value.daylight.patches.length}</dd>
                </div>
                <div>
                  <dt>Lit area</dt>
                  <dd>
                    {state.value.daylight.patches
                      .reduce((total, patch) => total + patch.area_m2, 0)
                      .toFixed(2)}{" "}
                    m&sup2;
                  </dd>
                </div>
              </dl>

              <SunPathChart response={state.value} />

              {state.value.daylight.patches.length > 0 ? (
                <ul className="patch-list">
                  {state.value.daylight.patches.map((patch) => (
                    <li key={patch.opening_id}>
                      <Sun size={14} />
                      <span>
                        <strong>{patch.opening_name}</strong>
                        {patch.area_m2.toFixed(2)} m&sup2; at {patch.incidence_deg.toFixed(0)}&deg; incidence
                        {patch.area_m2 < patch.projected_area_m2 - 1e-6 ? ", clipped by the room outline" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="daylight-status">
                  <SunDim size={15} /> No direct beam reaches this room at this instant.
                </p>
              )}

              <ul className="daylight-notes">
                {state.value.daylight.notes.map((note) => (
                  <li key={note}>{plainText(note)}</li>
                ))}
              </ul>
              <p className="method-note" title={state.value.daylight.method}>
                Method: {idWords(state.value.daylight.method)}. Excludes{" "}
                {state.value.daylight.exclusions.map(idWords).join(", ")}.
              </p>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
