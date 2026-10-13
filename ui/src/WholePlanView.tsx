/**
 * The whole floor at once, in 2D or 3D.
 *
 * Design work happens one room at a time, because the constraints and the
 * shadow pass are per room. This view exists for the other half of the job:
 * seeing whether the trace adds up as a home, and showing the proposal to
 * someone. It is read-only by design; clicking a room only highlights it.
 */

import { ArrowLeft, Boxes, Clock3, Eye, Layers, LoaderCircle, Map as MapIcon, PanelTop, Pause, Play } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { deepestInteriorPoint, extentOf, formatMillimetres, polygonPoints, screenY, wallBand } from "./plan";
import { PlanZoom } from "./PlanControls";
import { LABEL_PX, nearestOnBox, placeLabels, type Box, type LabelRequest, type Segment } from "./planLabels";
import "./planView.css";
import { roomDisplayName } from "./roomOrder";
import { switchPoint } from "./switchGeometry";
import type { DimLevels } from "./dimming";
import type { PlanScope, RoomId, ViewMode, WholePlan } from "./types";
import { usePlanViewport, viewBoxOf } from "./useViewport";

const WholePlanModel = lazy(async () => ({ default: (await import("./WholePlanModel")).WholePlanModel }));

type WholePlanViewProps = {
  readonly plan: WholePlan;
  readonly view: ViewMode;
  readonly selectedRoomId: RoomId | null;
  readonly onSelectRoom: (roomId: RoomId) => void;
  readonly onScopeChange: (scope: PlanScope) => void;
  readonly onViewChange: (view: ViewMode) => void;
  readonly offGroups: ReadonlySet<string>;
  readonly onToggleGroup: (group: string) => void;
  readonly dimLevels?: DimLevels;
};

export function WholePlanView({
  plan,
  view,
  selectedRoomId,
  onSelectRoom,
  onScopeChange,
  onViewChange,
  offGroups,
  onToggleGroup,
  dimLevels,
}: WholePlanViewProps) {
  // Walls and stairs run past the ceilings they bound, so the fit takes them too.
  const allPoints = plan.rooms.flatMap((entry) => [
    ...entry.ceiling.polygon.outer,
    ...entry.walls.flatMap((wall) => wallBand(wall)),
    ...entry.stairs.flatMap((stair) => stair.footprint.outer),
  ]);
  const extent = extentOf(allPoints);
  const margin = Math.max(extent.width * 0.08, 1200);
  const viewport = usePlanViewport(allPoints, margin, [1, 2]);
  const [showCeiling, setShowCeiling] = useState(false);
  const [showGypsum, setShowGypsum] = useState(false);
  const [seeThroughWalls, setSeeThroughWalls] = useState(true);
  const [hour, setHour] = useState(12);
  const [cyclePlaying, setCyclePlaying] = useState(false);
  const levels = [...new Set(plan.rooms.map((entry) => entry.room.elevation_mm))].sort((a, b) => a - b);
  const dropped = plan.rooms.filter(
    (entry) => (entry.ceiling.structural_elevation_mm ?? 0) > entry.ceiling.elevation_mm + 1,
  );
  const fixtureCount = plan.rooms.reduce((total, entry) => total + entry.fixtures.length, 0);

  const px = viewport.mmPerPixel;
  const roomNotes = new Map<string, string>(
    plan.rooms.map((entry) => [
      entry.room.id,
      [
        entry.room.is_external
          ? "outdoor"
          : `${formatMillimetres(entry.ceiling.elevation_mm - entry.room.elevation_mm)} mm ceiling`,
        entry.fixtures.length > 0 ? `${entry.fixtures.length} lights` : null,
      ].filter(Boolean).join(" · "),
    ]),
  );
  // A name sits inside its room, smaller if it must; a room too small for even
  // that gets its name beside it on a leader line.
  const anchors = new Map<string, { x: number; y: number }>(plan.rooms.map((entry) => [entry.room.id, deepestInteriorPoint(entry.ceiling.polygon.outer)]));
  const roomBox = (ring: ReadonlyArray<{ x: number; y: number }>) => {
    const extent = extentOf(ring);
    return { minX: extent.minX, maxX: extent.maxX, minY: screenY(extent.maxY), maxY: screenY(extent.minY) };
  };
  // Names sit clear of the walls, so a wall line never cuts through one.
  const wallLines: Segment[] = [
    ...new Map(plan.rooms.flatMap((entry) => entry.walls.map((wall) => [wall.wall_id, wall] as const))).values(),
  ].map((wall) => [
    { x: wall.start.x, y: screenY(wall.start.y) },
    { x: wall.end.x, y: screenY(wall.end.y) },
  ] as const);
  const inside = placeLabels(
    plan.rooms.map((entry) => {
      const anchor = anchors.get(entry.room.id)!;
      const at = { x: anchor.x, y: screenY(anchor.y) };
      const within = roomBox(entry.ceiling.polygon.outer);
      return {
        key: entry.room.id,
        options: [13, LABEL_PX].map((fontPx) => ({
          text: roomDisplayName(entry.room),
          fontPx,
          placement: { kind: "inside", at, within } as const,
        })),
      };
    }),
    px,
    [],
    null,
    wallLines,
  );
  const placedIds = new Set(inside.map((name) => name.key));
  // A callout sits just outside its own room, keeps a clear gap from every
  // other name, and its leader leaves through one wall only, so it cannot be
  // read as belonging to a neighbour.
  const unnamed = plan.rooms.filter((entry) => !placedIds.has(entry.room.id));
  const gap = (box: Box, by: number): Box => ({ minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by });
  // A leader that ran through a light would seem to end on the wrong dot.
  const fixtureMarks: Box[] = plan.rooms.flatMap((entry) =>
    entry.fixtures.flatMap((fixture) => {
      if (fixture.kind === "rope_light") return [];
      const radius = (fixture.kind === "pendant_bulb" ? 130 : 90) + 2 * px;
      const y = screenY(fixture.point.y);
      return [{ minX: fixture.point.x - radius, minY: y - radius, maxX: fixture.point.x + radius, maxY: y + radius }];
    }),
  );
  const holds = (box: Box, point: { x: number; y: number }) =>
    point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
  const names = [...inside];
  const leaderLines: Segment[] = [];
  for (const entry of unnamed) {
    const anchor = anchors.get(entry.room.id)!;
    const at = { x: anchor.x, y: screenY(anchor.y) };
    const lights = fixtureMarks.filter((mark) => !holds(mark, at));
    const otherSmallRooms = unnamed
      .filter((other) => other.room.id !== entry.room.id)
      .map((other) => roomBox(other.ceiling.polygon.outer));
    // Clear of the other small rooms and the lights, and through its own wall
    // only, if it can be; but never left unnamed.
    const callout = placeLabels(
      [{
        key: entry.room.id,
        options: [
          { avoid: [...otherSmallRooms, ...lights], leaderCrossings: 1, spacingMm: 24 * px },
          { avoid: lights, leaderCrossings: 1, spacingMm: 24 * px },
          { avoid: lights, leaderCrossings: 2, spacingMm: 24 * px },
          { avoid: [], leaderCrossings: 1, spacingMm: 24 * px },
          { avoid: [], leaderCrossings: 2, spacingMm: 12 * px },
        ].map((rule) => ({
          text: roomDisplayName(entry.room),
          fontPx: LABEL_PX,
          placement: { kind: "around", box: roomBox(entry.ceiling.polygon.outer), gapMm: 6 * px } as const,
          leader: at,
          ...rule,
        })),
      }],
      px,
      names.map((name) => name.box),
      null,
      [...wallLines, ...leaderLines],
    );
    for (const name of callout) {
      if (name.leader !== undefined) leaderLines.push([name.leader, nearestOnBox(name.box, name.leader)]);
    }
    names.push(...callout);
  }
  const notes = placeLabels(
    names
      .filter((name) => name.leader === undefined)
      .map((name) => {
        const entry = plan.rooms.find((candidate) => candidate.room.id === name.key)!;
        return {
          key: name.key,
          // Below the name, then above it; a long note gives up its light count first.
          options: [...new Set([roomNotes.get(name.key) ?? "", (roomNotes.get(name.key) ?? "").split(" · ")[0] ?? ""])]
            .filter((text) => text.length > 0)
            .flatMap((text) =>
              [1, -1].map((side) => ({
                text,
                fontPx: LABEL_PX,
                placement: {
                  kind: "inside" as const,
                  at: { x: name.x, y: name.y + side * (name.fontPx / 2 + LABEL_PX * 0.8) * px },
                  within: roomBox(entry.ceiling.polygon.outer),
                },
              })),
            ),
        } satisfies LabelRequest;
      }),
    px,
    names.map((name) => (name.leader === undefined ? name.box : gap(name.box, 12 * px))),
    null,
    wallLines,
  );

  useEffect(() => {
    if (!cyclePlaying) return undefined;
    const timer = window.setInterval(() => setHour((current) => (current + 0.1) % 24), 80);
    return () => window.clearInterval(timer);
  }, [cyclePlaying]);

  return (
    <>
      <div className="workspace-toolbar whole-toolbar">
        <div className="room-context">
          <p className="eyebrow">Whole floor</p>
          <h1>{plan.rooms.length} rooms</h1>
          <span className="whole-toolbar-count">
            {fixtureCount} light{fixtureCount === 1 ? "" : "s"}
            {levels.length > 1 ? <span className="whole-toolbar-levels">{` · ${levels.length} levels`}</span> : null}
          </span>
        </div>
        <div className="segmented" role="group" aria-label="View">
          <button
            type="button"
            className={view === "plan" ? "segmented-option segmented-option--active" : "segmented-option"}
            aria-pressed={view === "plan"}
            onClick={() => onViewChange("plan")}
          >
            <MapIcon size={15} /> <span className="tool-label">2D</span>
          </button>
          <button
            type="button"
            className={view === "model" ? "segmented-option segmented-option--active" : "segmented-option"}
            aria-pressed={view === "model"}
            onClick={() => onViewChange("model")}
          >
            <Boxes size={15} /> <span className="tool-label">3D</span>
          </button>
        </div>
        <div className="tool-cluster">
          <button className="tool-button" type="button" onClick={() => onScopeChange("room")}>
            <ArrowLeft size={15} /> <span className="tool-label">Back to one room</span>
          </button>
          {view === "model" ? (
            <>
              <button
                className={showGypsum ? "tool-button tool-button--active" : "tool-button"}
                type="button"
                aria-pressed={showGypsum}
                disabled={dropped.length === 0}
                title={
                  dropped.length === 0
                    ? "No room states a gypsum soffit below the slab"
                    : `${dropped.length} rooms have a soffit below the slab`
                }
                onClick={() => setShowGypsum((current) => !current)}
              >
                <Layers size={15} /> <span className="tool-label">Gypsum</span>
              </button>
              <button
                className={showCeiling ? "tool-button tool-button--active whole-fold" : "tool-button whole-fold"}
                type="button"
                aria-pressed={showCeiling}
                title="Show the ceiling"
                onClick={() => setShowCeiling((current) => !current)}
              >
                <PanelTop size={15} /> <span className="tool-label">Ceiling</span>
              </button>
              <button
                className={seeThroughWalls ? "tool-button tool-button--active whole-fold" : "tool-button whole-fold"}
                type="button"
                aria-pressed={seeThroughWalls}
                aria-label="See through walls"
                title="Fade the walls standing between the camera and what it is aimed at"
                onClick={() => setSeeThroughWalls((current) => !current)}
              >
                <Eye size={15} /> <span className="tool-label">See through</span>
              </button>
              <label className="time-control">
                <Clock3 size={15} />
                <span>{`${String(Math.floor(hour)).padStart(2, "0")}:${hour % 1 >= 0.5 ? "30" : "00"}`}</span>
                <input
                  aria-label="Visual time of day"
                  type="range"
                  min={0}
                  max={23.5}
                  step={0.5}
                  value={hour}
                  onChange={(event) => setHour(event.currentTarget.valueAsNumber)}
                />
              </label>
              <button
                className={cyclePlaying ? "tool-button tool-button--active" : "tool-button"}
                type="button"
                aria-pressed={cyclePlaying}
                aria-label={cyclePlaying ? "Pause the day cycle" : "Cycle through the day"}
                title={cyclePlaying ? "Pause the day cycle" : "Cycle through the day"}
                onClick={() => setCyclePlaying((playing) => !playing)}
              >
                {cyclePlaying ? <Pause size={15} /> : <Play size={15} />}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="plan-stage">
        {view === "plan" ? (
          <>
            <svg
              className="ceiling-plan"
              viewBox={viewBoxOf(viewport.viewport)}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Whole floor plan"
              onContextMenu={(event) => event.preventDefault()}
              style={{ "--mm-per-px": viewport.mmPerPixel } as React.CSSProperties}
              {...viewport.bind}
            >
              <defs>
                <pattern id="whole-minor" width="500" height="500" patternUnits="userSpaceOnUse">
                  <path d="M 500 0 L 0 0 0 500" className="grid-line grid-line--minor" />
                </pattern>
              </defs>
              <rect
                x={viewport.viewport.x}
                y={viewport.viewport.y}
                width={viewport.viewport.width}
                height={viewport.viewport.height}
                fill="url(#whole-minor)"
              />

              {plan.rooms.map((entry) => {
                const ring = entry.ceiling.polygon.outer;
                const selected = entry.room.id === selectedRoomId;
                // A room above the datum reads lighter, so a split level is visible.
                const raised = entry.room.elevation_mm > (levels[0] ?? 0);
                const kinds = roomNotes.get(entry.room.id) ?? "";
                return (
                  <g
                    key={entry.room.id}
                    className={`whole-room${selected ? " whole-room--selected" : ""}${raised ? " whole-room--raised" : ""}${entry.room.is_external ? " whole-room--outdoor" : ""}`}
                    onClick={() => onSelectRoom(entry.room.id)}
                  >
                    <polygon points={polygonPoints(ring)} />
                    <title>{`${roomDisplayName(entry.room)} · ${kinds} · floor ${formatMillimetres(entry.room.elevation_mm)} mm`}</title>
                  </g>
                );
              })}

              {[...new Map(
                plan.rooms.flatMap((entry) => entry.walls.map((wall) => [wall.wall_id, wall] as const)),
              ).values()].map((wall) => (
                <polygon
                  key={wall.wall_id}
                  className="whole-wall"
                  points={polygonPoints(wallBand(wall))}
                />
              ))}

              {plan.rooms.flatMap((entry) =>
                entry.stairs.map((stair) => (
                  <polygon key={`${entry.room.id}-${stair.id}`} className="whole-stair" points={polygonPoints(stair.footprint.outer)} />
                )),
              )}

              {plan.rooms.flatMap((entry) =>
                entry.openings.map((opening) => (
                  <line
                    key={`${entry.room.id}-${opening.id}`}
                    className={`whole-opening whole-opening--${opening.kind}`}
                    x1={opening.start.x}
                    y1={screenY(opening.start.y)}
                    x2={opening.end.x}
                    y2={screenY(opening.end.y)}
                  />
                )),
              )}

              {plan.rooms.flatMap((entry) =>
                entry.fixtures.map((fixture) => {
                  if (fixture.kind === "rope_light") {
                    return <polyline key={`${entry.room.id}-${fixture.tag}`} className={`whole-rope-light${offGroups.has(fixture.switching_group) ? " whole-fixture--off" : ""}`} points={polygonPoints(fixture.path)} />;
                  }
                  const radius = fixture.kind === "pendant_bulb" ? 130 : 90;
                  return <circle key={`${entry.room.id}-${fixture.tag}`} className={`whole-fixture whole-fixture--${fixture.kind}${offGroups.has(fixture.switching_group) ? " whole-fixture--off" : ""}`} cx={fixture.point.x} cy={screenY(fixture.point.y)} r={radius} />;
                }),
              )}
              {plan.rooms.flatMap((entry) =>
                entry.switches.map((device) => {
                  const point = switchPoint(device, entry.walls, entry.room.elevation_mm);
                  return point === null ? null : <rect key={`${entry.room.id}-${device.tag}`} className={offGroups.has(device.switching_group) ? "whole-switch whole-switch--off" : "whole-switch"} x={point.x - 60} y={screenY(point.y) - 60} width={120} height={120} rx={16} onClick={(event) => { event.stopPropagation(); onToggleGroup(device.switching_group); }} />;
                }),
              )}

              <g className="whole-labels">
                {names.map((name) => (
                  <g key={name.key}>
                    {name.leader === undefined ? null : (
                      <>
                        <line
                          className="whole-leader"
                          x1={name.leader.x}
                          y1={name.leader.y}
                          x2={nearestOnBox(name.box, name.leader).x}
                          y2={nearestOnBox(name.box, name.leader).y}
                        />
                        <circle className="whole-leader-dot" cx={name.leader.x} cy={name.leader.y} r={3 * px} />
                      </>
                    )}
                    <text
                      className="whole-room-label"
                      x={name.x}
                      y={name.y}
                      style={{ fontSize: name.fontPx * px }}
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {name.text}
                    </text>
                  </g>
                ))}
                {notes.map((note) => (
                  <text
                    key={note.key}
                    className="whole-room-note"
                    x={note.x}
                    y={note.y}
                    style={{ fontSize: note.fontPx * px }}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {note.text}
                  </text>
                ))}
              </g>
            </svg>
            <div className="plan-chrome">
              <PlanZoom view={viewport} fitLabel="Fit the plan" />
            </div>
          </>
        ) : (
          <Suspense
            fallback={
              <div className="workspace-loading">
                <LoaderCircle className="spin" /> Loading the whole-floor model
              </div>
            }
          >
            <WholePlanModel
              plan={plan}
              selectedRoomId={selectedRoomId}
              onSelectRoom={onSelectRoom}
              showCeiling={showCeiling}
              showGypsum={showGypsum}
              seeThroughWalls={seeThroughWalls}
              offGroups={offGroups}
              onToggleGroup={onToggleGroup}
              hour={hour}
              {...(dimLevels === undefined ? {} : { dimLevels })}
              onToggleSeeThrough={() => setSeeThroughWalls((current) => !current)}
            />
          </Suspense>
        )}
        {view === "plan" ? (
          <div className="plan-caption">
            <span>Click a room to highlight it · use the room list to open it</span>
            {levels.length > 1 ? <span>Lighter fill sits {formatMillimetres(levels[levels.length - 1]! - levels[0]!)} mm higher</span> : null}
            <span>Scroll to zoom · right-drag or space-drag to pan</span>
          </div>
        ) : null}
      </div>
    </>
  );
}
