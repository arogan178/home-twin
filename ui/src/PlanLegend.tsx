import { ChevronDown, Info } from "lucide-react";

import type { BakedLighting, IlluminanceGrid } from "./types";

export function PlanLegend({
  showSun,
  showCoverage,
  coverageSurface,
  hasStairs,
  legendOpen,
  onToggleLegend,
}: {
  readonly showSun: boolean;
  readonly showCoverage: boolean;
  readonly coverageSurface: BakedLighting | IlluminanceGrid | null;
  readonly hasStairs: boolean;
  readonly legendOpen: boolean;
  readonly onToggleLegend: () => void;
}) {
  return (
    <div className="plan-legend">
      <button
        type="button"
        className="plan-legend-toggle"
        aria-expanded={legendOpen}
        aria-controls="plan-legend-keys"
        onClick={onToggleLegend}
      >
        <Info size={14} /> Legend <ChevronDown size={13} className="plan-legend-chevron" />
      </button>
      {showSun ? <span><i className="legend-swatch legend-swatch--sun" /> Direct-sun patch, geometry only</span> : null}
      {showCoverage && coverageSurface !== null ? (
        <span>
          <i className="legend-swatch legend-swatch--coverage" /> Rendered light, peak{" "}
          <span className="legend-number">{Math.round(coverageSurface.maximum_lux)} lx</span> by {coverageSurface.method}
        </span>
      ) : null}
      {legendOpen ? (
        <div id="plan-legend-keys" className="plan-legend-keys">
          <span><i className="legend-swatch legend-swatch--fixture" /> Spotlight</span>
          <span><i className="legend-swatch legend-swatch--beam" /> Geometric beam at task plane</span>
          <span><i className="legend-swatch legend-swatch--cabinet" /> Cabinetry</span>
          <span><i className="legend-swatch legend-swatch--service" /> Services and exclusions</span>
          <span><i className="legend-swatch legend-swatch--sensor" /> Sensor, drag to move</span>
          <span><i className="legend-swatch legend-swatch--door" /> Doorway</span>
          <span><i className="legend-swatch legend-swatch--daylight" /> Daylight context, excluded from lux</span>
          {hasStairs ? (
            <span><i className="legend-swatch legend-swatch--stair" /> Stair flight</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
