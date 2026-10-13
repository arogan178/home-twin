/** The right-rail panel for whatever is selected on the tracing canvas. */

import { Crosshair, Image as ImageIcon, MapPin, Ruler, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "./api";
import { formatMillimetres } from "./plan";
import {
  POINT_IN_USE,
  SITE_EVIDENCE_ID,
  referencedPointIds,
  withEvidence,
  withSchema,
  withoutRoom,
} from "./traceDocument";
import type { PlanAperture, PlanControl, PlanDaylightSource, PlanDocument, PlanRoom, PlanSoffit } from "./types";

export type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "point"; readonly id: string }
  | { readonly kind: "room"; readonly id: string }
  | { readonly kind: "shaft"; readonly id: string }
  | { readonly kind: "soffit"; readonly id: string }
  | { readonly kind: "control"; readonly id: string }
  | { readonly kind: "aperture"; readonly id: string }
  | { readonly kind: "site" }
  | { readonly kind: "underlay" };

type NumberFieldProps = {
  readonly label: string;
  readonly value: number;
  readonly suffix?: string;
  readonly step?: number;
  readonly onChange: (value: number) => void;
};

function NumberField({ label, value, suffix, step = 1, onChange }: NumberFieldProps) {
  return (
    <label className="field field--number">
      <span>{label}</span>
      <span className="field-number-shell">
        <input
          type="number"
          value={Number(value.toFixed(4))}
          step={step}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        {suffix === undefined ? null : <small>{suffix}</small>}
      </span>
    </label>
  );
}

function EvidenceSelect({
  document,
  value,
  onChange,
}: {
  readonly document: PlanDocument;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>Evidence</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {Object.entries(document.evidence).map(([id, evidence]) => (
          <option key={id} value={id}>
            {id} · {evidence.status}
          </option>
        ))}
      </select>
    </label>
  );
}

type TraceInspectorProps = {
  readonly document: PlanDocument;
  readonly selection: Selection;
  readonly controlChecks: Map<string, { readonly traced_mm: number; readonly passed: boolean; readonly discrepancy_mm: number }>;
  readonly onSelect: (selection: Selection) => void;
  readonly onEdit: (change: (document: PlanDocument) => PlanDocument) => void;
  readonly onCalibrate: (knownMm: number, axis: "x" | "y" | null) => void;
  readonly onSetOrigin: () => void;
  readonly onUploadUnderlay: () => void;
  readonly onReanchorControl: (id: string) => void;
  readonly calibrationCount: number;
};

export function TraceInspector({
  document,
  selection,
  controlChecks,
  onSelect,
  onEdit,
  onCalibrate,
  onSetOrigin,
  onUploadUnderlay,
  onReanchorControl,
  calibrationCount,
}: TraceInspectorProps) {
  const [knownMm, setKnownMm] = useState(3500);
  const [axis, setAxis] = useState<"x" | "y" | null>("x");
  const referenced = referencedPointIds(document);

  if (selection.kind === "site") {
    const site = document.site ?? null;
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Site</p>
            <h2>Location and true north</h2>
          </div>
        </div>
        <p className="inspector-note">
          Sun geometry needs all three. They are written to native <code>IfcSite</code> fields and the model
          <code>TrueNorth</code>, so the draft carries them.
        </p>
        {site === null ? (
          <button
            className="button button--secondary"
            type="button"
            onClick={() =>
              onEdit((current) => ({
                ...withEvidence(
                  withSchema(current),
                  SITE_EVIDENCE_ID,
                  "Site coordinates and true north need owner or survey confirmation.",
                ),
                site: {
                  name: "Site",
                  latitude_deg: null,
                  longitude_deg: null,
                  elevation_mm: 0,
                  true_north_deg: 0,
                  timezone: null,
                  evidence: SITE_EVIDENCE_ID,
                },
              }))
            }
          >
            <MapPin size={16} /> Add a site block
          </button>
        ) : (
          <>
            <label className="field">
              <span>Name</span>
              <input
                value={site.name}
                onChange={(event) =>
                  onEdit((current) =>
                    current.site == null ? current : { ...current, site: { ...current.site, name: event.target.value } },
                  )
                }
              />
            </label>
            <NumberField
              label="Latitude"
              value={site.latitude_deg ?? 0}
              suffix="deg N"
              step={0.0001}
              onChange={(latitude_deg) =>
                onEdit((current) => (current.site == null ? current : { ...current, site: { ...current.site, latitude_deg } }))
              }
            />
            <NumberField
              label="Longitude"
              value={site.longitude_deg ?? 0}
              suffix="deg E"
              step={0.0001}
              onChange={(longitude_deg) =>
                onEdit((current) => (current.site == null ? current : { ...current, site: { ...current.site, longitude_deg } }))
              }
            />
            <NumberField
              label="Plan +Y bearing"
              value={site.true_north_deg}
              suffix="deg from true north"
              step={0.5}
              onChange={(true_north_deg) =>
                onEdit((current) =>
                  current.site == null ? current : { ...current, site: { ...current.site, true_north_deg } },
                )
              }
            />
            <NumberField
              label="Ground level"
              value={site.elevation_mm}
              suffix="mm"
              step={100}
              onChange={(elevation_mm) =>
                onEdit((current) => (current.site == null ? current : { ...current, site: { ...current.site, elevation_mm } }))
              }
            />
            <label className="field">
              <span>Timezone</span>
              <input
                value={site.timezone ?? ""}
                placeholder="Europe/London"
                onChange={(event) =>
                  onEdit((current) =>
                    current.site == null
                      ? current
                      : { ...current, site: { ...current.site, timezone: event.target.value || null } },
                  )
                }
              />
            </label>
            <EvidenceSelect
              document={document}
              value={site.evidence}
              onChange={(evidence) =>
                onEdit((current) => (current.site == null ? current : { ...current, site: { ...current.site, evidence } }))
              }
            />
          </>
        )}
      </aside>
    );
  }

  if (selection.kind === "underlay") {
    const underlay = document.underlay ?? null;
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Reference drawing</p>
            <h2>Underlay</h2>
          </div>
        </div>
        {underlay === null ? (
          <>
            <p className="inspector-note">Add a clear image of the plan, then align it using one printed dimension.</p>
            <button className="button button--secondary" type="button" onClick={onUploadUnderlay}>
              <ImageIcon size={16} /> Choose plan image
            </button>
          </>
        ) : (
          <>
            <p className="inspector-note">{underlay.calibration_note ?? "Calibrated."}</p>
            <NumberField
              label="Scale"
              value={underlay.mm_per_px}
              suffix="mm per pixel"
              step={0.01}
              onChange={(mm_per_px) =>
                onEdit((current) =>
                  current.underlay == null ? current : { ...current, underlay: { ...current.underlay, mm_per_px } },
                )
              }
            />
            <NumberField
              label="Rotation"
              value={underlay.rotation_deg}
              suffix="deg"
              step={0.1}
              onChange={(rotation_deg) =>
                onEdit((current) =>
                  current.underlay == null ? current : { ...current, underlay: { ...current.underlay, rotation_deg } },
                )
              }
            />
            <NumberField
              label="Opacity"
              value={underlay.opacity}
              step={0.05}
              onChange={(opacity) =>
                onEdit((current) =>
                  current.underlay == null
                    ? current
                    : { ...current, underlay: { ...current.underlay, opacity: Math.min(1, Math.max(0, opacity)) } },
                )
              }
            />
            <div className="inspector-section">
              <div className="section-label">
                <span>Calibrate</span>
                <small>{calibrationCount} of 2 points picked</small>
              </div>
              <NumberField label="Printed length" value={knownMm} suffix="mm" step={10} onChange={setKnownMm} />
              <div className="segmented segmented--tight" role="group" aria-label="Calibration axis">
                {(["x", "y", null] as const).map((option) => (
                  <button
                    key={String(option)}
                    type="button"
                    className={axis === option ? "segmented-option segmented-option--active" : "segmented-option"}
                    onClick={() => setAxis(option)}
                  >
                    {option === "x" ? "Along +X" : option === "y" ? "Along +Y" : "Keep angle"}
                  </button>
                ))}
              </div>
              <button className="button button--secondary" type="button" onClick={() => onCalibrate(knownMm, axis)}>
                <Ruler size={16} /> Apply scale
              </button>
              <button className="button button--quiet" type="button" onClick={onSetOrigin}>
                <Crosshair size={16} /> Point 1 becomes plan 0,0
              </button>
            </div>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => {
                void api.discardUnderlay();
                onEdit((current) => ({ ...current, underlay: null }));
                onSelect({ kind: "none" });
              }}
            >
              <Trash2 size={16} /> Remove underlay
            </button>
          </>
        )}
      </aside>
    );
  }

  if (selection.kind === "point") {
    const point = document.points[selection.id];
    if (point === undefined) return <EmptyInspector onSelect={onSelect} />;
    const used = referenced.has(selection.id);
    const roomUse = document.rooms.find((room) => room.point_ids.includes(selection.id));
    const cornerNumber = roomUse === undefined ? null : roomUse.point_ids.indexOf(selection.id) + 1;
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Room corner</p>
            <h2>{cornerNumber === null ? "Point position" : `Corner ${cornerNumber}`}</h2>
          </div>
          <button
            className="icon-button icon-button--danger"
            type="button"
            disabled={used}
            title={used ? POINT_IN_USE : "Delete this point"}
            onClick={() => {
              onEdit((current) => {
                const points = { ...current.points };
                delete points[selection.id];
                return { ...current, points };
              });
              onSelect({ kind: "none" });
            }}
          >
            <Trash2 size={18} />
          </button>
        </div>
        <p className="inspector-note">{roomUse === undefined ? selection.id : `${roomUse.name} · ${selection.id}`}</p>
        <NumberField
          label="X"
          value={point.x_mm}
          suffix="mm"
          onChange={(x_mm) =>
            onEdit((current) => ({
              ...current,
              points: { ...current.points, [selection.id]: { ...point, x_mm } },
            }))
          }
        />
        <NumberField
          label="Y"
          value={point.y_mm}
          suffix="mm"
          onChange={(y_mm) =>
            onEdit((current) => ({
              ...current,
              points: { ...current.points, [selection.id]: { ...point, y_mm } },
            }))
          }
        />
        <EvidenceSelect
          document={document}
          value={point.evidence}
          onChange={(evidence) =>
            onEdit((current) => ({
              ...current,
              points: { ...current.points, [selection.id]: { ...point, evidence } },
            }))
          }
        />
      </aside>
    );
  }

  if (selection.kind === "room") {
    const room = document.rooms.find((item) => item.id === selection.id);
    if (room === undefined) return <EmptyInspector onSelect={onSelect} />;
    const update = (change: (value: PlanRoom) => PlanRoom) =>
      onEdit((current) => ({
        ...current,
        rooms: current.rooms.map((item) => (item.id === room.id ? change(item) : item)),
      }));
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Room</p>
            <h2>{room.name}</h2>
          </div>
          <button
            className="icon-button icon-button--danger"
            type="button"
            aria-label={`Delete ${room.name}`}
            onClick={() => {
              onEdit((current) => withoutRoom(current, room.id));
              onSelect({ kind: "none" });
            }}
          >
            <Trash2 size={18} />
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input value={room.name} onChange={(event) => update((item) => ({ ...item, name: event.target.value }))} />
        </label>
        <NumberField
          label="Ceiling"
          value={room.ceiling_height_mm}
          suffix="mm"
          step={10}
          onChange={(ceiling_height_mm) => update((item) => ({ ...item, ceiling_height_mm }))}
        />
        <EvidenceSelect
          document={document}
          value={room.ceiling_evidence}
          onChange={(ceiling_evidence) => update((item) => ({ ...item, ceiling_evidence }))}
        />
        <label className="field">
          <span>Kind</span>
          <select
            value={room.exposure === "exterior" ? "exterior" : "interior"}
            onChange={(event) =>
              update((item) => ({
                ...item,
                exposure: event.currentTarget.value === "exterior" ? "exterior" : undefined,
              }))
            }
          >
            <option value="interior">Indoor room</option>
            <option value="exterior">Outdoor space</option>
          </select>
        </label>
        <div className="inspector-section">
          <div className="section-label">
            <span>Outline</span>
            <small>{room.point_ids.length} points, in order</small>
          </div>
          <ol className="point-order">
            {room.point_ids.map((id, index) => (
              <li key={`${id}-${index}`}>
                <button type="button" className="chip" onClick={() => onSelect({ kind: "point", id })}>
                  Corner {index + 1}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${id} from ${room.name}`}
                  disabled={room.point_ids.length <= 3}
                  onClick={() =>
                    update((item) => ({
                      ...item,
                      point_ids: item.point_ids.filter((_, position) => position !== index),
                    }))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    );
  }

  if (selection.kind === "shaft") {
    const source = document.daylight_sources.find((item) => item.id === selection.id);
    if (source === undefined) return <EmptyInspector onSelect={onSelect} />;
    const update = (change: (value: PlanDaylightSource) => PlanDaylightSource) =>
      onEdit((current) => ({
        ...current,
        daylight_sources: current.daylight_sources.map((item) => (item.id === source.id ? change(item) : item)),
      }));
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Shaft</p>
            <h2>{source.name}</h2>
          </div>
          <button
            className="icon-button icon-button--danger"
            type="button"
            aria-label={`Delete ${source.name}`}
            onClick={() => {
              onEdit((current) => ({
                ...current,
                daylight_sources: current.daylight_sources.filter((item) => item.id !== source.id),
              }));
              onSelect({ kind: "none" });
            }}
          >
            <Trash2 size={18} />
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input value={source.name} onChange={(event) => update((item) => ({ ...item, name: event.target.value }))} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={source.kind} onChange={(event) => update((item) => ({ ...item, kind: event.currentTarget.value }))}>
            <option value="ventilation_shaft">Ventilation shaft</option>
            <option value="light_court">Light court</option>
          </select>
        </label>
        <label className="field">
          <span>Daylight</span>
          <select
            value={source.daylight_role}
            onChange={(event) => update((item) => ({ ...item, daylight_role: event.currentTarget.value }))}
          >
            <option value="possible">Possible</option>
            <option value="none">None</option>
          </select>
        </label>
        <div className="inspector-section">
          <div className="section-label">
            <span>Outline</span>
            <small>{source.point_ids.length} corners, in order</small>
          </div>
          <ol className="point-order">
            {source.point_ids.map((id, index) => (
              <li key={`${id}-${index}`}>
                <button type="button" className="chip" onClick={() => onSelect({ kind: "point", id })}>
                  Corner {index + 1}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <p className="inspector-note">
          A shaft is daylight context, not a room. It is never counted as internal floor area and its contribution is
          not calculated.
        </p>
      </aside>
    );
  }

  if (selection.kind === "soffit") {
    const soffit = document.soffits.find((item) => item.id === selection.id);
    if (soffit === undefined) return <EmptyInspector onSelect={onSelect} />;
    const host = document.rooms.find((room) => room.id === soffit.room_id);
    const stated = host?.structural_ceiling_height_mm ?? host?.ceiling_height_mm;
    const ceiling = typeof stated === "number" ? stated : 2700;
    const update = (change: (value: PlanSoffit) => PlanSoffit) =>
      onEdit((current) => ({
        ...current,
        soffits: current.soffits.map((item) => (item.id === soffit.id ? change(item) : item)),
      }));
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Gypsum</p>
            <h2>{soffit.name}</h2>
          </div>
          <button
            className="icon-button icon-button--danger"
            type="button"
            aria-label={`Delete ${soffit.name}`}
            onClick={() => {
              onEdit((current) => ({
                ...current,
                soffits: current.soffits.filter((item) => item.id !== soffit.id),
              }));
              onSelect({ kind: "none" });
            }}
          >
            <Trash2 size={18} />
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input value={soffit.name} onChange={(event) => update((item) => ({ ...item, name: event.target.value }))} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={soffit.kind} onChange={(event) => update((item) => ({ ...item, kind: event.currentTarget.value }))}>
            <option value="soffit">Dropped soffit</option>
            <option value="bulkhead">Bulkhead</option>
            <option value="cove">Cove</option>
          </select>
        </label>
        <NumberField
          label="Underside"
          value={soffit.height_mm}
          suffix="mm"
          step={10}
          onChange={(height_mm) => update((item) => ({ ...item, height_mm }))}
        />
        <div className="inspector-section">
          <div className="section-label">
            <span>Outline</span>
            <small>{soffit.point_ids.length} corners, in order</small>
          </div>
          <ol className="point-order">
            {soffit.point_ids.map((id, index) => (
              <li key={`${id}-${index}`}>
                <button type="button" className="chip" onClick={() => onSelect({ kind: "point", id })}>
                  Corner {index + 1}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <p className="inspector-note">
          Hangs in {host?.name ?? soffit.room_id}, whose ceiling is {formatMillimetres(ceiling)} mm. The underside is
          measured from that room's floor and blocks light like any other ceiling.
        </p>
      </aside>
    );
  }

  if (selection.kind === "control") {
    const control = document.controls.find((item) => item.id === selection.id);
    if (control === undefined) return <EmptyInspector onSelect={onSelect} />;
    const check = controlChecks.get(control.id);
    const update = (change: (value: PlanControl) => PlanControl) =>
      onEdit((current) => ({
        ...current,
        controls: current.controls.map((item) => (item.id === control.id ? change(item) : item)),
      }));
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Printed control</p>
            <h2>Dimension check</h2>
          </div>
          <button
            className="icon-button icon-button--danger"
            type="button"
            onClick={() => {
              onEdit((current) => ({
                ...current,
                controls: current.controls.filter((item) => item.id !== control.id),
              }));
              onSelect({ kind: "none" });
            }}
          >
            <Trash2 size={18} />
          </button>
        </div>
        <p className="inspector-note">
          {control.id} · {control.from_point} to {control.to_point}
        </p>
        <NumberField
          label="Printed"
          value={control.expected_mm}
          suffix="mm"
          step={1}
          onChange={(expected_mm) => update((item) => ({ ...item, expected_mm }))}
        />
        <NumberField
          label="Tolerance"
          value={control.tolerance_mm}
          suffix="mm"
          step={1}
          onChange={(tolerance_mm) => update((item) => ({ ...item, tolerance_mm }))}
        />
        {check === undefined ? null : (
          <div className={check.passed ? "message message--ok" : "message message--error"}>
            <strong>{check.passed ? "Passes" : "Fails"}</strong>
            <p>
              Traced {formatMillimetres(check.traced_mm)} mm, off by {check.discrepancy_mm.toFixed(1)} mm.
            </p>
            {check.passed ? null : (
              <p>
                Either the trace is wrong here, or this check is on the wrong two corners. The printed number is the
                check, so do not edit it to fit.
              </p>
            )}
          </div>
        )}
        <button className="button button--secondary" type="button" onClick={() => onReanchorControl(control.id)}>
          <Ruler size={15} /> Move onto other corners
        </button>
      </aside>
    );
  }

  if (selection.kind === "aperture") {
    const aperture = document.apertures.find((item) => item.id === selection.id);
    if (aperture === undefined) return <EmptyInspector onSelect={onSelect} />;
    const update = (change: (value: PlanAperture) => PlanAperture) =>
      onEdit((current) => ({
        ...current,
        apertures: current.apertures.map((item) => (item.id === aperture.id ? change(item) : item)),
      }));
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Opening</p>
            <h2>{aperture.name}</h2>
          </div>
          <button
            className="icon-button icon-button--danger"
            type="button"
            onClick={() => {
              onEdit((current) => ({
                ...current,
                apertures: current.apertures.filter((item) => item.id !== aperture.id),
              }));
              onSelect({ kind: "none" });
            }}
          >
            <Trash2 size={18} />
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input value={aperture.name} onChange={(event) => update((item) => ({ ...item, name: event.target.value }))} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select
            value={aperture.kind}
            onChange={(event) => update((item) => ({ ...item, kind: event.currentTarget.value as PlanAperture["kind"] }))}
          >
            <option value="window">Window</option>
            <option value="door">Door</option>
            <option value="sliding_door">Sliding door</option>
            <option value="unfilled">Open doorway</option>
          </select>
        </label>
        <NumberField
          label="Width"
          value={aperture.width_mm}
          suffix="mm"
          step={10}
          onChange={(width_mm) => update((item) => ({ ...item, width_mm }))}
        />
        <NumberField
          label="Sill"
          value={aperture.sill_height_mm}
          suffix="mm above floor"
          step={10}
          onChange={(sill_height_mm) => update((item) => ({ ...item, sill_height_mm }))}
        />
        <NumberField
          label="Height"
          value={aperture.height_mm}
          suffix="mm"
          step={10}
          onChange={(height_mm) => update((item) => ({ ...item, height_mm }))}
        />
        <label className="field">
          <span>Exposure</span>
          <select
            value={aperture.exposure}
            onChange={(event) => update((item) => ({ ...item, exposure: event.currentTarget.value }))}
          >
            <option value="exterior">Exterior</option>
            <option value="interior">Interior</option>
          </select>
        </label>
        <p className="inspector-note">
          Only exterior glazed openings can cast a direct-sun patch. Sill and head heights stay assumptions until they
          are confirmed on site.
        </p>
      </aside>
    );
  }

  return <EmptyInspector onSelect={onSelect} />;
}

function EmptyInspector({ onSelect }: { readonly onSelect: (selection: Selection) => void }) {
  return (
    <aside className="inspector inspector--empty">
      <div className="inspector-empty-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <p className="eyebrow">Ready to trace</p>
      <h2>Choose a task above, then work directly on the plan</h2>
      <p>Select a room to correct its shape. Changes remain a reviewable draft until you save and build the IFC.</p>
      <button className="button button--secondary" type="button" onClick={() => onSelect({ kind: "site" })}>
        <MapPin size={16} /> Site and true north
      </button>
      <button className="button button--quiet" type="button" onClick={() => onSelect({ kind: "underlay" })}>
        <ImageIcon size={16} /> Reference drawing
      </button>
    </aside>
  );
}
