import { Power, SunDim } from "lucide-react";

import { humaniseId } from "./displayNames";
import { DIMMING_METHOD, outputFraction, type DimLevels, type LightGroupSummary } from "./dimming";

type LightGroupsPanelProps = {
  readonly groups: ReadonlyArray<LightGroupSummary>;
  readonly offGroups: ReadonlySet<string>;
  readonly dimLevels: DimLevels;
  readonly onToggleGroup: (group: string) => void;
  readonly onSetGroupsOff: (groups: ReadonlyArray<string>, off: boolean) => void;
  readonly onDim: (group: string, level: number) => void;
};

/** Switch and dim each group in the 3D view, as a preview of the scene it sets. */
export function LightGroupsPanel({ groups, offGroups, dimLevels, onToggleGroup, onSetGroupsOff, onDim }: LightGroupsPanelProps) {
  if (groups.length === 0) return null;
  const anyOn = groups.some((group) => !offGroups.has(group.group));
  return (
    <section className="daylight-panel groups-panel">
      <div className="checks-heading">
        <h2 className="panel-title">Switch groups <span className="checks-meta">3D preview</span></h2>
        <button
          type="button"
          className="button button--quiet button--compact"
          onClick={() => onSetGroupsOff(groups.map((group) => group.group), anyOn)}
        >
          {anyOn ? "All off" : "All on"}
        </button>
      </div>
      <ul className="groups-list">
        {groups.map((group) => {
          const off = offGroups.has(group.group);
          const fixed = group.fixtures - group.dimmableFixtures;
          const level = outputFraction(dimLevels, group.group, true);
          const name = humaniseId(group.group);
          return (
            <li key={group.group} className={off ? "groups-row groups-row--off" : "groups-row"}>
              <button
                type="button"
                className={off ? "groups-power" : "groups-power groups-power--on"}
                aria-pressed={!off}
                aria-label={`${off ? "Switch on" : "Switch off"} ${name}`}
                onClick={() => onToggleGroup(group.group)}
              >
                <Power size={13} />
              </button>
              <div className="groups-detail">
                <strong title={group.group}>{name}</strong>
                <small>
                  {group.fixtures} light{group.fixtures === 1 ? "" : "s"}
                  {group.switchTags.length > 0 ? ` · ${group.switchTags.join(", ")}` : " · no switch"}
                  {group.hasDimmer ? " · dimmer" : ""}
                  {fixed > 0 ? ` · ${fixed} fixed output` : ""}
                </small>
                {group.dimmableFixtures > 0 ? (
                  <label className="groups-dim">
                    <SunDim size={13} />
                    <span className="visually-hidden">Preview output for {name}</span>
                    <input
                      type="range"
                      min={5}
                      max={100}
                      step={5}
                      disabled={off}
                      value={Math.round(level * 100)}
                      onChange={(event) => onDim(group.group, event.currentTarget.valueAsNumber / 100)}
                    />
                    <output>{Math.round(level * 100)}%</output>
                  </label>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="method-note">{DIMMING_METHOD} A fitting stated as not dimmable stays at full output.</p>
    </section>
  );
}
