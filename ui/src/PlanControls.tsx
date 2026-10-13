/** The screen-fixed controls over a plan: zoom, compass and scale bar. */

import { Maximize2, Minus, Plus } from "lucide-react";

import { formatMillimetres, type Vec2 } from "./plan";
import { scaleBarMm } from "./planLabels";
import type { PlanViewport } from "./useViewport";

export function PlanZoom({ view, fitLabel }: { readonly view: PlanViewport; readonly fitLabel: string }) {
  return (
    <div className="plan-zoom" role="group" aria-label="Plan zoom">
      <button type="button" onClick={() => view.zoom(1 / 1.3)} aria-label="Zoom in" title="Zoom in">
        <Plus size={15} />
      </button>
      <span>{Math.round(view.scalePercent)}%</span>
      <button type="button" onClick={() => view.zoom(1.3)} aria-label="Zoom out" title="Zoom out">
        <Minus size={15} />
      </button>
      <button type="button" onClick={view.reset} aria-label={fitLabel} title={fitLabel}>
        <Maximize2 size={14} />
      </button>
    </div>
  );
}

const DIAL = 22;

/** North, and the sun's bearing when it is up, drawn at a fixed screen size. */
export function PlanCompass({
  northBearingDeg,
  sunDirection,
  sunAltitudeDeg,
}: {
  readonly northBearingDeg: number;
  readonly sunDirection: Vec2 | null;
  readonly sunAltitudeDeg: number | null;
}) {
  const radians = (northBearingDeg * Math.PI) / 180;
  const north = { x: Math.sin(radians), y: -Math.cos(radians) };
  const sunUp = sunDirection !== null && (sunAltitudeDeg ?? -1) > 0;
  return (
    <svg
      className="plan-compass"
      viewBox="-36 -36 72 72"
      width="72"
      height="72"
      role="img"
      aria-label={`North is ${Math.round(northBearingDeg)}° clockwise from plan up`}
    >
      <circle r={DIAL} className="north-dial" />
      <line x1="0" y1="0" x2={north.x * (DIAL - 5)} y2={north.y * (DIAL - 5)} className="north-needle" />
      <text x={north.x * 30} y={north.y * 30} className="north-letter" textAnchor="middle" dominantBaseline="central">
        N
      </text>
      {sunUp ? (
        <g className="sun-marker">
          <line x1="0" y1="0" x2={sunDirection.x * (DIAL - 3)} y2={-sunDirection.y * (DIAL - 3)} className="sun-ray" />
          <circle cx={sunDirection.x * (DIAL + 3)} cy={-sunDirection.y * (DIAL + 3)} r={5} className="sun-disc">
            <title>{`Sun at altitude ${(sunAltitudeDeg ?? 0).toFixed(1)}°`}</title>
          </circle>
        </g>
      ) : null}
    </svg>
  );
}

/** A round length at the current zoom, and the plan's +X and +Y. */
export function PlanScale({ mmPerPx }: { readonly mmPerPx: number }) {
  const lengthMm = scaleBarMm(mmPerPx);
  const lengthPx = lengthMm / mmPerPx;
  const label = `${formatMillimetres(lengthMm)} mm`;
  // 11 px mono advances about 6.7 px a character; the label may be wider than a short bar.
  const spanPx = Math.max(lengthPx, label.length * 6.7);
  const width = Math.ceil(spanPx) + 50;
  return (
    <svg className="plan-scale" width={width} height="40" role="img" aria-label={`Scale bar, ${formatMillimetres(lengthMm)} mm`}>
      <g className="plan-axes" transform="translate(6 34)">
        <path d="M 0 0 h 18 M 0 0 v -18" />
        <text x="22" y="0" dominantBaseline="central">+X</text>
        <text x="0" y="-25" textAnchor="middle" dominantBaseline="central">+Y</text>
      </g>
      <g transform={`translate(${width - 4 - (spanPx + lengthPx) / 2} 34)`}>
        <path d={`M 0 -4 v 4 h ${lengthPx} v -4`} />
        <text x={lengthPx / 2} y="-11" textAnchor="middle" dominantBaseline="central">
          {label}
        </text>
      </g>
    </svg>
  );
}
