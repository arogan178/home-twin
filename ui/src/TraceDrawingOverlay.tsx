import { polygonPoints, screenY, type Vec2 } from "./plan";
import type { SnapKind } from "./traceDrawing";

/** The rubber band, snap marker, close cue and dragged rectangle drawn under the cursor while tracing. */
export function TraceDrawingOverlay({
  fromMm,
  toMm,
  snap,
  closeAtMm,
  rectangle,
  lengthLabel,
  labelMm,
  markerMm,
}: {
  readonly fromMm: Vec2 | null;
  readonly toMm: Vec2;
  readonly snap: SnapKind | null;
  readonly closeAtMm: Vec2 | null;
  readonly rectangle: ReadonlyArray<Vec2> | null;
  readonly lengthLabel: string | null;
  readonly labelMm: number;
  readonly markerMm: number;
}) {
  const x = toMm.x;
  const y = screenY(toMm.y);
  return (
    <g className="trace-preview" pointerEvents="none">
      {rectangle !== null ? (
        <polygon className="trace-preview-band" points={polygonPoints(rectangle)} />
      ) : null}
      {fromMm !== null && rectangle === null ? (
        <line className="trace-preview-band" x1={fromMm.x} y1={screenY(fromMm.y)} x2={x} y2={y} />
      ) : null}
      {lengthLabel !== null ? (
        <text x={x + labelMm} y={y + labelMm * 1.4} fontSize={labelMm}>
          {lengthLabel}
        </text>
      ) : null}
      {snap === "point" ? <circle className="trace-preview-snap" cx={x} cy={y} r={markerMm * 1.6} /> : null}
      {snap === "line" ? (
        <polygon
          className="trace-preview-snap"
          points={`${x},${y - markerMm * 1.6} ${x + markerMm * 1.6},${y} ${x},${y + markerMm * 1.6} ${x - markerMm * 1.6},${y}`}
        />
      ) : null}
      {snap === "grid" ? (
        <path
          className="trace-preview-snap"
          d={`M ${x - markerMm} ${y} L ${x + markerMm} ${y} M ${x} ${y - markerMm} L ${x} ${y + markerMm}`}
        />
      ) : null}
      {closeAtMm !== null ? (
        <g className="trace-preview-close">
          <circle cx={closeAtMm.x} cy={screenY(closeAtMm.y)} r={markerMm * 2.6} />
          <text x={closeAtMm.x + markerMm * 3} y={screenY(closeAtMm.y) - markerMm * 3} fontSize={labelMm}>
            click to close
          </text>
        </g>
      ) : null}
    </g>
  );
}
