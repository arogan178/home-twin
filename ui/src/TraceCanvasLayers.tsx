/** The plan drawn on the tracing canvas: underlay, outlines, openings, checks, and points. */

import type { PointerEvent } from "react";

import { extentOf, formatMillimetres, polygonPoints, screenY, underlayTransform, type Vec2 } from "./plan";
import { roomRing } from "./traceDocument";
import type { Selection } from "./TraceInspector";
import type { PlanAperture, PlanControl, PlanDocument, PlanUnderlay } from "./types";

export function TraceUnderlayImage({ underlay, href }: { readonly underlay: PlanUnderlay; readonly href: string }) {
  const radians = (underlay.rotation_deg * Math.PI) / 180;
  const a = underlay.mm_per_px * Math.cos(radians);
  const b = underlay.mm_per_px * Math.sin(radians);
  const e = -(a * underlay.origin_px.x + b * underlay.origin_px.y);
  const f = b * underlay.origin_px.x - a * underlay.origin_px.y;
  const matrix = `matrix(${a} ${-b} ${b} ${a} ${e} ${f})`;
  return (
    <g transform={matrix} pointerEvents="none">
      <image
        href={href}
        x={0}
        y={0}
        width={underlay.width_px}
        height={underlay.height_px}
        opacity={underlay.opacity}
        preserveAspectRatio="none"
      />
    </g>
  );
}

export function TraceShafts({
  document,
  selection,
  labelMm,
  onPick,
}: {
  readonly document: PlanDocument;
  readonly selection: Selection;
  readonly labelMm: number;
  readonly onPick: (event: PointerEvent<SVGElement>, id: string) => void;
}) {
  return (
    <>
      {document.daylight_sources.map((source) => {
        const ring = source.point_ids
          .map((id) => document.points[id])
          .filter((point): point is NonNullable<typeof point> => point !== undefined)
          .map((point) => ({ x: point.x_mm, y: point.y_mm }));
        if (ring.length < 3) return null;
        const centre = extentOf(ring);
        const active = selection.kind === "shaft" && selection.id === source.id;
        return (
          <g key={source.id} className={active ? "trace-shaft trace-shaft--active" : "trace-shaft"}>
            <polygon
              points={polygonPoints(ring)}
              onPointerDown={(event) => onPick(event, source.id)}
            />
            <text
              x={centre.minX + centre.width / 2}
              y={screenY(centre.minY + centre.height / 2)}
              fontSize={labelMm}
              pointerEvents="none"
            >
              SHAFT
            </text>
            <title>{`${source.name} · ${source.kind} · daylight ${source.daylight_role}`}</title>
          </g>
        );
      })}
    </>
  );
}

export function TraceRooms({
  document,
  selection,
  editingRoomId,
  labelMm,
  onPick,
}: {
  readonly document: PlanDocument;
  readonly selection: Selection;
  readonly editingRoomId: string | null;
  readonly labelMm: number;
  readonly onPick: (event: PointerEvent<SVGElement>, id: string) => void;
}) {
  return (
    <>
      {document.rooms.map((room) => {
        const ring = roomRing(document, room);
        if (ring.length < 3) return null;
        const centre = extentOf(ring);
        const active = editingRoomId === room.id || (selection.kind === "room" && selection.id === room.id);
        return (
          <g key={room.id} className={active ? "trace-room trace-room--active" : "trace-room"}>
            <polygon
              points={polygonPoints(ring)}
              onPointerDown={(event) => onPick(event, room.id)}
            />
            <text
              x={centre.minX + centre.width / 2}
              y={screenY(centre.minY + centre.height / 2)}
              fontSize={labelMm * 1.15}
              pointerEvents="none"
            >
              {room.name}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function TraceSoffits({
  document,
  selection,
  labelMm,
  onPick,
}: {
  readonly document: PlanDocument;
  readonly selection: Selection;
  readonly labelMm: number;
  readonly onPick: (event: PointerEvent<SVGElement>, id: string) => void;
}) {
  return (
    <>
      {document.soffits.map((soffit) => {
        const ring = soffit.point_ids
          .map((id) => document.points[id])
          .filter((point): point is NonNullable<typeof point> => point !== undefined)
          .map((point) => ({ x: point.x_mm, y: point.y_mm }));
        if (ring.length < 3) return null;
        const centre = extentOf(ring);
        const active = selection.kind === "soffit" && selection.id === soffit.id;
        return (
          <g key={soffit.id} className={active ? "trace-soffit trace-soffit--active" : "trace-soffit"}>
            <polygon
              points={polygonPoints(ring)}
              onPointerDown={(event) => onPick(event, soffit.id)}
            />
            <text
              x={centre.minX + centre.width / 2}
              y={screenY(centre.minY + centre.height / 2)}
              fontSize={labelMm}
              pointerEvents="none"
            >
              {formatMillimetres(soffit.height_mm)}
            </text>
            <title>{`${soffit.name}: ${soffit.kind} at ${formatMillimetres(soffit.height_mm)} mm`}</title>
          </g>
        );
      })}
    </>
  );
}

export function TraceApertures({
  document,
  selection,
  onPick,
}: {
  readonly document: PlanDocument;
  readonly selection: Selection;
  readonly onPick: (event: PointerEvent<SVGElement>, aperture: PlanAperture) => void;
}) {
  return (
    <>
      {document.apertures.map((aperture) => {
        const from = document.points[aperture.host_edge[0]];
        const to = document.points[aperture.host_edge[1]];
        if (from === undefined || to === undefined) return null;
        const length = Math.hypot(to.x_mm - from.x_mm, to.y_mm - from.y_mm) || 1;
        const unitX = (to.x_mm - from.x_mm) / length;
        const unitY = (to.y_mm - from.y_mm) / length;
        const offset = aperture.offset_mm ?? (length - aperture.width_mm) / 2;
        const startX = from.x_mm + unitX * offset;
        const startY = from.y_mm + unitY * offset;
        const active = selection.kind === "aperture" && selection.id === aperture.id;
        return (
          <line
            key={aperture.id}
            className={active ? "trace-aperture trace-aperture--active" : "trace-aperture"}
            x1={startX}
            y1={screenY(startY)}
            x2={startX + unitX * aperture.width_mm}
            y2={screenY(startY + unitY * aperture.width_mm)}
            onPointerDown={(event) => onPick(event, aperture)}
          />
        );
      })}
    </>
  );
}

export function TraceControls({
  document,
  controls,
  controlChecks,
  labelMm,
  onPick,
}: {
  readonly document: PlanDocument;
  readonly controls: ReadonlyArray<PlanControl>;
  readonly controlChecks: ReadonlyMap<string, { readonly passed: boolean; readonly discrepancy_mm: number }>;
  readonly labelMm: number;
  readonly onPick: (event: PointerEvent<SVGElement>, id: string) => void;
}) {
  return (
    <>
      {controls.map((control) => {
        const from = document.points[control.from_point];
        const to = document.points[control.to_point];
        if (from === undefined || to === undefined) return null;
        const check = controlChecks.get(control.id);
        const failed = check !== undefined && !check.passed;
        return (
          <g
            key={control.id}
            className={failed ? "trace-control trace-control--failed" : "trace-control"}
            onPointerDown={(event) => onPick(event, control.id)}
          >
            <line x1={from.x_mm} y1={screenY(from.y_mm)} x2={to.x_mm} y2={screenY(to.y_mm)} />
            <text
              x={(from.x_mm + to.x_mm) / 2}
              y={screenY((from.y_mm + to.y_mm) / 2) - labelMm * 0.5}
              fontSize={labelMm}
              pointerEvents="none"
            >
              {formatMillimetres(control.expected_mm)}
              {check === undefined ? "" : ` (${check.discrepancy_mm.toFixed(0)})`}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function TracePoints({
  document,
  visiblePointIds,
  selection,
  pending,
  hitRadiusMm,
  pointRadiusMm,
  labelMm,
}: {
  readonly document: PlanDocument;
  readonly visiblePointIds: ReadonlySet<string>;
  readonly selection: Selection;
  readonly pending: ReadonlyArray<string>;
  readonly hitRadiusMm: number;
  readonly pointRadiusMm: number;
  readonly labelMm: number;
}) {
  return (
    <>
      {Object.entries(document.points).filter(([id]) => visiblePointIds.has(id)).map(([id, point]) => {
        const active = selection.kind === "point" && selection.id === id;
        const queued = pending.includes(id);
        return (
          <g
            key={id}
            className={
              active ? "trace-point trace-point--active" : queued ? "trace-point trace-point--queued" : "trace-point"
            }
          >
            {/* A transparent disc keeps the grab target a steady size on
                screen while the drawn dot stays small. */}
            <circle
              className="trace-point-hit"
              cx={point.x_mm}
              cy={screenY(point.y_mm)}
              r={hitRadiusMm}
            />
            <circle
              cx={point.x_mm}
              cy={screenY(point.y_mm)}
              r={pointRadiusMm}
              pointerEvents="none"
            />
            {active ? (
              <text
                x={point.x_mm + labelMm}
                y={screenY(point.y_mm) - labelMm * 0.6}
                fontSize={labelMm}
                pointerEvents="none"
              >
                {id}
              </text>
            ) : null}
          </g>
        );
      })}
    </>
  );
}

export function TraceCalibrationMarks({
  calibration,
  underlay,
  pointRadiusMm,
  labelMm,
}: {
  readonly calibration: ReadonlyArray<Vec2>;
  readonly underlay: PlanUnderlay;
  readonly pointRadiusMm: number;
  readonly labelMm: number;
}) {
  return (
    <>
      {calibration.map((pixel, index) => {
        const plan = underlayTransform(underlay).toPlan(pixel);
        return (
          <g key={`calibration-${index}`} className="trace-calibration">
            <circle cx={plan.x} cy={screenY(plan.y)} r={pointRadiusMm * 1.6} />
            <text x={plan.x + labelMm} y={screenY(plan.y)} fontSize={labelMm}>
              {index + 1}
            </text>
          </g>
        );
      })}
    </>
  );
}
