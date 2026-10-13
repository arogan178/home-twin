import { ChevronRight, Copy, CopyPlus, Trash2, X } from "lucide-react";

import { humaniseId } from "./displayNames";
import type { Design, Fixture, Point, WallSwitch } from "./types";

type FixtureInspectorProps = {
  /** The one selected spotlight, or null when none or several are selected. */
  readonly fixture: Fixture | null;
  readonly device: WallSwitch | null;
  readonly walls: Design["walls"];
  readonly selectedTags: ReadonlyArray<string>;
  readonly onPointChange: (point: Point) => void;
  readonly onFixtureChange: (fixture: Fixture) => void;
  readonly onTagChange: (tag: string) => void;
  readonly onSwitchChange: (device: WallSwitch) => void;
  readonly groupIsOff: boolean;
  readonly onToggleGroup: (group: string) => void;
  /** False while the room is not loaded, so there is no ceiling to add to. */
  readonly canAdd: boolean;
  readonly onAdd: () => void;
  /** How many selected marks are spotlights or pendants, the kinds Duplicate copies. */
  readonly duplicateCount: number;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  /** Clears the selection, which closes the inspector. */
  readonly onClose: () => void;
};

function HeadingActions({ deleteLabel, onDelete, onClose }: { deleteLabel: string; onDelete: () => void; onClose: () => void }) {
  return (
    <div className="inspector-actions">
      <button className="icon-button icon-button--danger" type="button" onClick={onDelete} aria-label={deleteLabel} title={deleteLabel}>
        <Trash2 size={16} />
      </button>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close the inspector" title="Close (Esc)">
        <X size={16} />
      </button>
    </div>
  );
}

function DuplicateButton({ count, onDuplicate }: { count: number; onDuplicate: () => void }) {
  return (
    <button
      className="button button--secondary"
      type="button"
      onClick={onDuplicate}
      disabled={count === 0}
      title={
        count === 0
          ? "Only spotlights and pendants can be duplicated"
          : `Copy ${count === 1 ? "this light" : `these ${count} lights`} one grid step east and south (Ctrl+D)`
      }
    >
      <Copy size={16} /> Duplicate
    </button>
  );
}

function NumberField({
  label,
  value,
  suffix,
  step = 1,
  inline = false,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  step?: number;
  inline?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={inline ? "field field--number field--inline" : "field field--number"}>
      <span>{label}</span>
      <span className="field-number-shell">
        <input
          type="number"
          value={Number(value.toFixed(2))}
          step={step}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        <small>{suffix}</small>
      </span>
    </label>
  );
}

export function FixtureInspector({
  fixture,
  device,
  walls,
  selectedTags,
  onPointChange,
  onFixtureChange,
  onTagChange,
  onSwitchChange,
  groupIsOff,
  onToggleGroup,
  canAdd,
  onAdd,
  duplicateCount,
  onDuplicate,
  onDelete,
  onClose,
}: FixtureInspectorProps) {
  if (fixture === null && device === null && selectedTags.length > 1) {
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Selection</p>
            <h2>{selectedTags.length} spotlights</h2>
          </div>
          <HeadingActions deleteLabel={`Delete ${selectedTags.length} spotlights`} onDelete={onDelete} onClose={onClose} />
        </div>
        <section className="inspector-section">
          <p className="inspector-note">{selectedTags.join(", ")}</p>
          <p className="inspector-note">
            Drag any one of them to move the set, or step them with the arrow keys. Coordinates and
            light settings need a single selection.
          </p>
          <DuplicateButton count={duplicateCount} onDuplicate={onDuplicate} />
        </section>
      </aside>
    );
  }

  if (fixture === null && device === null) {
    return (
      <aside className="inspector inspector--empty">
        <div className="inspector-empty-mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <h2>Select a mark on the plan</h2>
        <p>Select a light or switch to edit its exact installation data.</p>
        <button className="button button--secondary" type="button" onClick={onAdd} disabled={!canAdd}>
          <CopyPlus size={16} /> Add spotlight
        </button>
      </aside>
    );
  }

  if (device !== null) {
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <div><p className="eyebrow">Wall switch</p><h2>{device.tag}</h2></div>
          <HeadingActions deleteLabel={`Delete ${device.tag}`} onDelete={onDelete} onClose={onClose} />
        </div>
        <section className="inspector-section">
          <div className="section-label"><span>Wall placement</span><small>Drag the plate in 3D</small></div>
          <label className="field">
            <span>Host wall</span>
            <select value={device.host_wall_id} onChange={(event) => onSwitchChange({ ...device, host_wall_id: event.currentTarget.value })}>
              {walls.map((wall, index) => <option key={wall.wall_id} value={wall.wall_id}>Wall {index + 1}</option>)}
            </select>
          </label>
          <NumberField label="Offset" value={device.offset_mm} suffix="mm" onChange={(offset_mm) => onSwitchChange({ ...device, offset_mm })} />
          <NumberField label="Height" value={device.mounting_height_mm} suffix="mm" onChange={(mounting_height_mm) => onSwitchChange({ ...device, mounting_height_mm })} />
        </section>
        <section className="inspector-section">
          <label className="field"><span>Controls group</span><input value={device.switching_group} onChange={(event) => onSwitchChange({ ...device, switching_group: event.currentTarget.value })} /></label>
          <label className="field"><span>Switch type</span><select value={device.spec.kind} onChange={(event) => onSwitchChange({ ...device, spec: { ...device.spec, kind: event.currentTarget.value as WallSwitch["spec"]["kind"] } })}><option value="toggle">Toggle</option><option value="dimmer">Dimmer</option><option value="momentary">Momentary</option></select></label>
        </section>
        <section className="inspector-section">
          <div className="section-label"><span>3D preview</span><small>{groupIsOff ? "Lights off" : "Lights on"}</small></div>
          <button className="button button--secondary" type="button" onClick={() => onToggleGroup(device.switching_group)}>
            {groupIsOff ? "Turn group on" : "Turn group off"}
          </button>
        </section>
      </aside>
    );
  }

  if (fixture === null) return null;

  const updateModel = (model: string | null) => {
    switch (fixture.kind) {
      case "recessed_spotlight": onFixtureChange({ ...fixture, spec: { ...fixture.spec, model } }); break;
      case "pendant_bulb": onFixtureChange({ ...fixture, spec: { ...fixture.spec, model } }); break;
      case "rope_light": onFixtureChange({ ...fixture, spec: { ...fixture.spec, model } }); break;
    }
  };
  const updateOutput = (value: number) => {
    switch (fixture.kind) {
      case "recessed_spotlight": onFixtureChange({ ...fixture, spec: { ...fixture.spec, lumens: value } }); break;
      case "pendant_bulb": onFixtureChange({ ...fixture, spec: { ...fixture.spec, lumens: value } }); break;
      case "rope_light": onFixtureChange({ ...fixture, spec: { ...fixture.spec, lumens_per_m: value } }); break;
    }
  };
  const updateCct = (cct_kelvin: number) => {
    switch (fixture.kind) {
      case "recessed_spotlight": onFixtureChange({ ...fixture, spec: { ...fixture.spec, cct_kelvin } }); break;
      case "pendant_bulb": onFixtureChange({ ...fixture, spec: { ...fixture.spec, cct_kelvin } }); break;
      case "rope_light": onFixtureChange({ ...fixture, spec: { ...fixture.spec, cct_kelvin } }); break;
    }
  };

  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">{humaniseId(fixture.kind)}</p>
          <h2>{fixture.tag}</h2>
        </div>
        <HeadingActions deleteLabel={`Delete ${fixture.tag}`} onDelete={onDelete} onClose={onClose} />
      </div>
      <section className="inspector-section">
        <DuplicateButton count={duplicateCount} onDuplicate={onDuplicate} />
      </section>

      {fixture.kind !== "rope_light" ? <section className="inspector-section">
        <div className="section-label">
          <span>Installation point</span>
          <small>Building coordinates</small>
        </div>
        <div className="coordinate-stack">
          <NumberField inline label="X" value={fixture.point.x} suffix="mm" onChange={(x) => onPointChange({ ...fixture.point, x })} />
          <NumberField inline label="Y" value={fixture.point.y} suffix="mm" onChange={(y) => onPointChange({ ...fixture.point, y })} />
          <NumberField inline label="Z" value={fixture.point.z} suffix="mm" onChange={(z) => onPointChange({ ...fixture.point, z })} />
        </div>
      </section> : (
        <section className="inspector-section">
          <div className="section-label"><span>Light path</span><small>Building coordinates</small></div>
          <NumberField label="Start X" value={fixture.path[0]?.x ?? 0} suffix="mm" onChange={(x) => onFixtureChange({ ...fixture, path: fixture.path.map((point, index) => index === 0 ? { ...point, x } : point) })} />
          <NumberField label="Start Y" value={fixture.path[0]?.y ?? 0} suffix="mm" onChange={(y) => onFixtureChange({ ...fixture, path: fixture.path.map((point, index) => index === 0 ? { ...point, y } : point) })} />
          <NumberField label="End X" value={fixture.path.at(-1)?.x ?? 0} suffix="mm" onChange={(x) => onFixtureChange({ ...fixture, path: fixture.path.map((point, index) => index === fixture.path.length - 1 ? { ...point, x } : point) })} />
          <NumberField label="End Y" value={fixture.path.at(-1)?.y ?? 0} suffix="mm" onChange={(y) => onFixtureChange({ ...fixture, path: fixture.path.map((point, index) => index === fixture.path.length - 1 ? { ...point, y } : point) })} />
        </section>
      )}

      <section className="inspector-section">
        <div className="section-label">
          <span>Identity and light</span>
          <small>Saved to IFC</small>
        </div>
        <label className="field">
          <span>Installation label</span>
          <input
            value={fixture.tag}
            aria-label="Installation label"
            onChange={(event) => onTagChange(event.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span>Fixture model</span>
          <input
            value={fixture.spec.model ?? ""}
            title={fixture.spec.model ?? undefined}
            placeholder="Manufacturer and model"
            onChange={(event) => updateModel(event.currentTarget.value || null)}
          />
        </label>
        <div className="two-fields">
          <NumberField
            label="Output"
            value={fixture.kind === "rope_light" ? fixture.spec.lumens_per_m ?? 900 : fixture.spec.lumens ?? 650}
            suffix={fixture.kind === "rope_light" ? "lm/m" : "lm"}
            onChange={updateOutput}
          />
          {fixture.kind === "recessed_spotlight" ? <NumberField
            label="Beam"
            value={fixture.spec.beam_angle_deg}
            suffix="deg"
            onChange={(beam_angle_deg) => onFixtureChange({ ...fixture, spec: { ...fixture.spec, beam_angle_deg } })}
          /> : null}
        </div>
        <div className="two-fields">
          <NumberField
            label="CCT"
            value={fixture.spec.cct_kelvin ?? 3000}
            suffix="K"
            step={100}
            onChange={updateCct}
          />
          {fixture.kind === "recessed_spotlight" ? <NumberField
            label="Cut-out"
            value={fixture.spec.cutout_diameter_mm}
            suffix="mm"
            onChange={(cutout_diameter_mm) =>
              onFixtureChange({ ...fixture, spec: { ...fixture.spec, cutout_diameter_mm } })
            }
          /> : fixture.kind === "pendant_bulb" ? <NumberField label="Drop" value={fixture.spec.drop_mm} suffix="mm" onChange={(drop_mm) => onFixtureChange({ ...fixture, spec: { ...fixture.spec, drop_mm } })} /> : <NumberField label="Diameter" value={fixture.spec.diameter_mm} suffix="mm" onChange={(diameter_mm) => onFixtureChange({ ...fixture, spec: { ...fixture.spec, diameter_mm } })} />}
        </div>
      </section>

      <section className="inspector-section">
        <label className="field">
          <span>Switching group</span>
          <span className="field-with-icon">
            <input
              value={fixture.switching_group}
              onChange={(event) => onFixtureChange({ ...fixture, switching_group: event.currentTarget.value })}
            />
            <ChevronRight size={16} />
          </span>
        </label>
      </section>
    </aside>
  );
}
