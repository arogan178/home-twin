import {
  AlertTriangle,
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  Boxes,
  Cable,
  Grid2X2,
  LampCeiling,
  Lightbulb,
  Layers,
  LoaderCircle,
  Map as MapIcon,
  PanelTop,
  Plus,
  RefreshCw,
  Sparkles,
  Sun,
  Radar,
  Redo2,
  ToggleLeft,
  Undo2,
} from "lucide-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "./api";
import { AppTopBar } from "./AppTopBar";
import { BakePanel } from "./BakePanel";
import { CeilingPlan, PLAN_DROP_TYPE } from "./CeilingPlan";
import { DaylightPanel } from "./DaylightPanel";
import { DEMO, DEMO_SUN, DemoReadOnlyError } from "./demo";
import { lightGroups, withDimLevel, type DimLevels } from "./dimming";
import { distributeEvenly } from "./fixtureArrangement";
import { FixtureInspector } from "./FixtureInspector";
import { ImportDialog } from "./ImportDialog";
import { LightGroupsPanel } from "./LightGroupsPanel";
import {
  controlGroupFor,
  defaultSpec,
  duplicableTags,
  duplicates,
  insideCeiling,
  movedSpotlights,
  newPendant,
  newRopeLight,
  newSensor,
  newSpotlight,
  newWallSwitch,
  renameFixture,
  selectedSpotlights,
  spotlightsOf,
  withFixturePoints,
  withoutTags,
  withSensorPoints,
  withSpotlights,
  type PointMove,
} from "./lightingDraft";
import { RoomRail } from "./RoomRail";
import { DESIGN_STAGES, StageBar, type DesignStage } from "./StageBar";
import { InstallationFiles, LayoutChecks, ReviewDock } from "./LightingReview";
import { PlanLegend } from "./PlanLegend";
import { mergeRoomDrafts, tagsOutsideRoom, withRoomDraft, withoutRoomDraft, type RoomDrafts } from "./roomDrafts";
import { useLightingHistory, type LightingDraftSnapshot } from "./lightingHistory";
import { lightingShortcut } from "./lightingShortcuts";
import { useLoadState } from "./queryClient";
import { useDaylight } from "./useDaylight";
import { writeCameraFrame, writeViewState } from "./viewerUrl";
import {
  type BakedLighting,
  type DarkZone,
  type Design,
  type DraftState,
  type ElectricLightingAnalysis,
  type ExportResponse,
  type Fixture,
  type FixtureTag,
  type LoadState,
  type RoomId,
  type Sensor,
  type SunPatch,
  type WallSwitch,
  type PlanScope,
  type ViewMode,
  type WorkspaceMode,
} from "./types";

function ToolLabel({ children }: { children: ReactNode }) {
  return <span className="tool-label">{children}</span>;
}

// The WebGL view carries three.js, so the 2D plan never pays for it.
const RoomView3D = lazy(async () => ({ default: (await import("./RoomView3D")).RoomView3D }));
const TraceWorkspace = lazy(async () => ({ default: (await import("./TraceWorkspace")).TraceWorkspace }));
const WholePlanView = lazy(async () => ({ default: (await import("./WholePlanView")).WholePlanView }));

type AnalysisState =
  | { readonly kind: "pending"; readonly draftVersion: number }
  | { readonly kind: "ready"; readonly draftVersion: number; readonly value: ElectricLightingAnalysis }
  | { readonly kind: "error"; readonly draftVersion: number; readonly message: string };

// Stable empties, so an absent result does not hand the 3D view a new array
// on every render and rebuild the room for nothing.
const NO_SUN_PATCHES: SunPatch[] = [];
const NO_DARK_ZONES: DarkZone[] = [];
const NO_WALL_IDS: string[] = [];

const LOADING: LoadState<never> = { kind: "loading" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}

function today(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function App() {
  const initialParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initialView: ViewMode = initialParams?.get("view") === "3d" || initialParams?.get("view") === "model" ? "model" : "plan";
  const initialScope: PlanScope = initialParams?.get("scope") === "whole" ? "whole" : "room";

  const [workspace, setWorkspace] = useState<WorkspaceMode>("design");
  const [view, setView] = useState<ViewMode>(initialView);
  const [scope, setScope] = useState<PlanScope>(initialScope);
  const [roomId, setRoomId] = useState<RoomId | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [switches, setSwitches] = useState<WallSwitch[]>([]);
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [roomDrafts, setRoomDrafts] = useState<RoomDrafts>({});
  const [offGroups, setOffGroups] = useState<ReadonlySet<string>>(new Set());
  const [draftVersion, setDraftVersion] = useState(0);
  const fixturesRef = useRef<Fixture[]>([]);
  const switchesRef = useRef<WallSwitch[]>([]);
  const sensorsRef = useRef<Sensor[]>([]);
  const roomDraftsRef = useRef<RoomDrafts>({});
  const latestDraftVersion = useRef(0);
  const [analysis, setAnalysis] = useState<AnalysisState>({ kind: "pending", draftVersion: 0 });
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<FixtureTag>>(new Set());
  const [draft, setDraft] = useState<DraftState>({ kind: "dirty" });
  const [showDarkZones, setShowDarkZones] = useState(false);
  const [showCeiling, setShowCeiling] = useState(true);
  const [showGypsum, setShowGypsum] = useState(false);
  const [snapMm, setSnapMm] = useState(100);
  const [stage, setStage] = useState<DesignStage>("light");
  const [showCoverage, setShowCoverage] = useState(false);
  const [showSun, setShowSun] = useState(false);
  const [sunDate, setSunDate] = useState(DEMO ? (DEMO_SUN.dates[1] ?? today()) : today());
  const [sunMinutes, setSunMinutes] = useState(12 * 60);
  const [sunPlane, setSunPlane] = useState<"floor" | "task">("floor");
  const [baked, setBaked] = useState<LoadState<BakedLighting> | null>(null);
  const [bakedVersion, setBakedVersion] = useState<number | null>(null);
  const [bakePlane, setBakePlane] = useState<"floor" | "task">("task");
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exports, setExports] = useState<ExportResponse | null>(null);
  const draftHistory = useLightingHistory();
  const [dimLevels, setDimLevels] = useState<DimLevels>(new Map());
  const previousRoute = useRef<{ readonly roomId: RoomId | null; readonly scope: PlanScope } | null>(null);

  fixturesRef.current = fixtures;
  switchesRef.current = switches;
  sensorsRef.current = sensors;
  roomDraftsRef.current = roomDrafts;

  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["project"], queryFn: ({ signal }) => api.project(signal) });
  const project = useLoadState(projectQuery);
  const revision = projectQuery.data?.building.revision ?? null;
  const refreshProject = useCallback(() => queryClient.invalidateQueries({ queryKey: ["project"] }), [queryClient]);
  const siteQuery = useQuery({
    queryKey: ["site", revision],
    queryFn: ({ signal }) => api.site(signal),
    enabled: revision !== null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const site = siteQuery.data?.site ?? null;

  useEffect(() => {
    const value = projectQuery.data;
    if (value === undefined) return;
    setRoomId((current) => {
      if (current !== null && value.rooms.some((room) => room.id === current)) return current;
      const requested = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("room") : null;
      if (requested) {
        const match = value.rooms.find((r) => r.name.toLowerCase() === requested.toLowerCase() || r.id === requested);
        if (match) return match.id;
      }
      return value.rooms[0]?.id ?? null;
    });
  }, [projectQuery.data]);

  const designQuery = useQuery({
    queryKey: ["design", roomId, revision],
    queryFn: ({ signal }) => api.design(roomId!, signal),
    enabled: roomId !== null && revision !== null,
    staleTime: Infinity,
  });
  const [appliedDesign, setAppliedDesign] = useState<Design | null>(null);

  useEffect(() => {
    setSelectedTags(new Set());
    draftHistory.clear();
    setExports(null);
  }, [roomId, revision]);

  useEffect(() => {
    const value = designQuery.data;
    if (value === undefined) return;
    const local = roomDraftsRef.current[value.room.id];
    setFixtures([...(local?.fixtures ?? value.fixtures)]);
    setSwitches([...(local?.switches ?? value.switches)]);
    setSensors([...value.sensors]);
    latestDraftVersion.current = 0;
    setDraftVersion(0);
    setAnalysis({ kind: "ready", draftVersion: 0, value: value.analysis });
    setDraft({ kind: "clean", report: value.analysis.validation });
    setBaked(null);
    setBakedVersion(null);
    setAppliedDesign(value);
  }, [designQuery.data]);

  const fetchedDesign = useLoadState(designQuery);
  // Room geometry is shown only once its own fixtures are in state, never beside the previous room's.
  const design = fetchedDesign.kind === "ready" && fetchedDesign.value !== appliedDesign ? LOADING : fetchedDesign;

  useEffect(() => {
    if (roomId === null || design.kind !== "ready") return undefined;
    const version = draftVersion;
    const controller = new AbortController();
    setAnalysis({ kind: "pending", draftVersion: version });
    const timer = window.setTimeout(() => {
      void api.analyse(roomId, fixtures, controller.signal, switches).then(
        (response) => {
          if (latestDraftVersion.current !== version) return;
          setAnalysis({ kind: "ready", draftVersion: version, value: response.analysis });
          setDraft({ kind: "validated", report: response.analysis.validation });
        },
        (error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (latestDraftVersion.current !== version) return;
          setAnalysis({ kind: "error", draftVersion: version, message: errorMessage(error) });
        },
      );
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [design, draftVersion, fixtures, switches, roomId]);

  const daylight = useDaylight(
    roomId,
    revision,
    sunDate,
    sunMinutes,
    sunPlane,
    showSun && site !== null && site.latitude_deg !== null,
  );

  // A room with a nested lower level needs the same geometry payload even in
  // single-room mode, otherwise the upper slab has a hole with no floor below.
  const hasLowerLevel = roomId !== null && (projectQuery.data?.rooms.some((room) => room.part_of === roomId) ?? false);
  const wholePlanQuery = useQuery({
    queryKey: ["wholePlan", revision],
    queryFn: ({ signal }) => api.wholePlan(signal),
    enabled: revision !== null && (scope === "whole" || hasLowerLevel),
    staleTime: Infinity,
  });
  const wholePlan = useLoadState(wholePlanQuery);

  // The view, scope and room ride in the address bar, so the current view is
  // a link. A camera belongs to one room or to the whole floor, so moving
  // between them drops it.
  useEffect(() => {
    const previous = previousRoute.current;
    previousRoute.current = { roomId, scope };
    if (previous !== null && ((previous.roomId !== null && previous.roomId !== roomId) || previous.scope !== scope)) {
      writeCameraFrame(null);
    }
    writeViewState({ view, scope, roomId });
  }, [view, scope, roomId]);

  // The inspector edits one spotlight. A wider selection still drags and
  // deletes as a set, but there is no single point or spec to show.
  const selectedFixture = useMemo(
    () => (selectedTags.size === 1 ? fixtures.find((fixture) => selectedTags.has(fixture.tag)) ?? null : null),
    [fixtures, selectedTags],
  );
  const selectedSpotlightCount = fixtures.filter(
    (fixture) => fixture.kind === "recessed_spotlight" && selectedTags.has(fixture.tag),
  ).length;
  const selectedSwitch = useMemo(
    () => (selectedTags.size === 1 ? switches.find((device) => selectedTags.has(device.tag as FixtureTag)) ?? null : null),
    [switches, selectedTags],
  );

  function bumpDraft() {
    setDraftVersion((current) => {
      const next = current + 1;
      latestDraftVersion.current = next;
      return next;
    });
    setDraft({ kind: "dirty" });
    setExports(null);
  }

  function rememberRoomDraft(nextFixtures: ReadonlyArray<Fixture>, nextSwitches: ReadonlyArray<WallSwitch>) {
    if (roomId === null) return;
    setRoomDrafts((current) => {
      const next = withRoomDraft(current, roomId, {
        fixtures: [...nextFixtures],
        switches: [...nextSwitches],
      });
      roomDraftsRef.current = next;
      return next;
    });
  }

  function draftSnapshot(): LightingDraftSnapshot {
    return {
      fixtures: [...fixturesRef.current],
      switches: [...switchesRef.current],
      sensors: [...sensorsRef.current],
      selectedTags: new Set(selectedTags),
    };
  }

  function rememberUndoPoint() {
    draftHistory.record(draftSnapshot());
  }

  function restoreDraft(snapshot: LightingDraftSnapshot) {
    setFixtures(snapshot.fixtures);
    setSwitches(snapshot.switches);
    setSensors(snapshot.sensors);
    fixturesRef.current = snapshot.fixtures;
    switchesRef.current = snapshot.switches;
    sensorsRef.current = snapshot.sensors;
    setSelectedTags(snapshot.selectedTags);
    rememberRoomDraft(snapshot.fixtures, snapshot.switches);
    bumpDraft();
  }

  function undoDraft() {
    const previous = draftHistory.undo(draftSnapshot());
    if (previous === undefined) return;
    restoreDraft(previous);
    setNotice("Undid the last lighting edit.");
  }

  function redoDraft() {
    const next = draftHistory.redo(draftSnapshot());
    if (next === undefined) return;
    restoreDraft(next);
    setNotice("Redid the lighting edit.");
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (workspace !== "design") return;
      const shortcut = lightingShortcut(event, {
        roomScope: scope === "room",
        canDuplicate: duplicableTags(fixturesRef.current, selectedTags).length > 0,
        canUndo: draftHistory.canUndo(),
        canRedo: draftHistory.canRedo(),
        hasSelection: selectedTags.size > 0,
        dialogOpen: importOpen,
      });
      if (shortcut === null) return;
      if (shortcut !== "deselect") event.preventDefault();
      if (shortcut === "duplicate") duplicateSelection();
      else if (shortcut === "redo") redoDraft();
      else if (shortcut === "undo") undoDraft();
      else if (shortcut === "delete") deleteSelection();
      else setSelectedTags(new Set());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function updateFixture(tag: FixtureTag, update: (fixture: Fixture) => Fixture) {
    rememberUndoPoint();
    setFixtures((current) => {
      const next = current.map((fixture) => (fixture.tag === tag ? update(fixture) : fixture));
      fixturesRef.current = next;
      rememberRoomDraft(next, switchesRef.current);
      return next;
    });
    bumpDraft();
  }

  function updateSwitch(tag: FixtureTag, update: (device: WallSwitch) => WallSwitch) {
    rememberUndoPoint();
    setSwitches((current) => {
      const next = current.map((device) => (device.tag === tag ? update(device) : device));
      switchesRef.current = next;
      rememberRoomDraft(fixturesRef.current, next);
      return next;
    });
    bumpDraft();
  }

  function moveFixtures(moves: ReadonlyArray<PointMove<FixtureTag>>) {
    if (moves.length === 0) return;
    rememberUndoPoint();
    setFixtures((current) => {
      const next = withFixturePoints(current, moves);
      fixturesRef.current = next;
      rememberRoomDraft(next, switchesRef.current);
      return next;
    });
    bumpDraft();
  }

  /** Replaces the room's fixtures as one draft edit; the caller records the undo point. */
  function replaceFixtures(next: Fixture[]) {
    setFixtures(next);
    fixturesRef.current = next;
    rememberRoomDraft(next, switchesRef.current);
    bumpDraft();
  }

  function toggleGroup(group: string) {
    setOffGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function setGroupsOff(groups: ReadonlyArray<string>, off: boolean) {
    setOffGroups((current) => {
      const next = new Set(current);
      for (const group of groups) {
        if (off) next.add(group);
        else next.delete(group);
      }
      return next;
    });
  }

  function chooseStage(next: DesignStage) {
    const entry = DESIGN_STAGES.find((item) => item.id === next)!;
    setStage(next);
    if (entry.view !== undefined) setView(entry.view);
    setShowSun(entry.layer === "sun");
    setShowDarkZones(entry.layer === "darkZones");
  }

  function activeControlGroup(): string {
    return controlGroupFor(
      selectedFixture ?? selectedSwitch,
      fixturesRef.current,
      switchesRef.current,
      design.kind === "ready" ? design.value.room.name : null,
    );
  }

  function dropInsideCeiling(at: { x: number; y: number }): boolean {
    if (design.kind !== "ready") return false;
    const inside = insideCeiling(design.value, at);
    if (!inside) setNotice("The drop point, snapped to the grid, is outside the ceiling, so nothing was added.");
    return inside;
  }

  // The installation export lists the whole home, so a new tag must be free in
  // every room. Until the plan loads only this room is known; a save still checks.
  function otherRoomTags(roomId: RoomId) {
    return wholePlan.kind === "ready" ? tagsOutsideRoom(wholePlan.value, roomDraftsRef.current, roomId) : [];
  }

  function addSpotlight(at?: { x: number; y: number }) {
    if (design.kind !== "ready") return;
    if (at !== undefined && !dropInsideCeiling(at)) return;
    rememberUndoPoint();
    const spec = selectedFixture?.kind === "recessed_spotlight" ? selectedFixture.spec : defaultSpec;
    const fixture = newSpotlight(
      design.value,
      fixturesRef.current,
      at,
      spec,
      activeControlGroup(),
      otherRoomTags(design.value.room.id),
    );
    replaceFixtures([...fixturesRef.current, fixture]);
    setSelectedTags(new Set([fixture.tag]));
  }

  function addPendant(at?: { x: number; y: number }) {
    if (design.kind !== "ready") return;
    if (at !== undefined && !dropInsideCeiling(at)) return;
    rememberUndoPoint();
    const fixture = newPendant(
      design.value,
      fixturesRef.current,
      at,
      activeControlGroup(),
      otherRoomTags(design.value.room.id),
    );
    replaceFixtures([...fixturesRef.current, fixture]);
    setSelectedTags(new Set([fixture.tag]));
  }

  function addRopeLight() {
    if (design.kind !== "ready") return;
    rememberUndoPoint();
    const fixture = newRopeLight(
      design.value,
      fixturesRef.current,
      activeControlGroup(),
      otherRoomTags(design.value.room.id),
    );
    replaceFixtures([...fixturesRef.current, fixture]);
    setSelectedTags(new Set([fixture.tag]));
  }

  function addWallSwitch() {
    if (design.kind !== "ready" || design.value.walls.length === 0) return;
    const device = newWallSwitch(
      design.value,
      fixturesRef.current,
      switchesRef.current,
      activeControlGroup(),
      otherRoomTags(design.value.room.id),
    );
    if (device === null) {
      setNotice("No wall segment is wide enough for a switch plate outside the room openings.");
      return;
    }
    rememberUndoPoint();
    const next = [...switchesRef.current, device];
    setSwitches(next);
    switchesRef.current = next;
    rememberRoomDraft(fixturesRef.current, next);
    bumpDraft();
    setSelectedTags(new Set([device.tag as FixtureTag]));
  }

  function deleteSelection() {
    if (selectedTags.size === 0) return;
    rememberUndoPoint();
    const nextFixtures = withoutTags(fixturesRef.current, selectedTags);
    const nextSwitches = withoutTags(switchesRef.current, selectedTags);
    setFixtures(nextFixtures);
    setSwitches(nextSwitches);
    fixturesRef.current = nextFixtures;
    switchesRef.current = nextSwitches;
    rememberRoomDraft(nextFixtures, nextSwitches);
    bumpDraft();
    setSelectedTags(new Set());
  }

  async function validate() {
    if (roomId === null) return;
    setDraft({ kind: "validating" });
    try {
      const response = await api.analyse(roomId, fixtures, undefined, switches);
      if (latestDraftVersion.current !== draftVersion) return;
      setAnalysis({ kind: "ready", draftVersion, value: response.analysis });
      setDraft({ kind: "validated", report: response.analysis.validation });
      setNotice(response.analysis.validation.findings.length === 0 ? "Layout passes geometric checks." : "Validation found items to review.");
    } catch (error) {
      setDraft({ kind: "dirty" });
      setNotice(errorMessage(error));
    }
  }

  async function optimise() {
    if (roomId === null || design.kind !== "ready") return;
    setNotice("Generating a constrained layout...");
    try {
      const selectedSpotlight = selectedFixture?.kind === "recessed_spotlight" ? selectedFixture : null;
      const proposal = await api.optimise(roomId, selectedSpotlight?.spec ?? defaultSpec);
      rememberUndoPoint();
      replaceFixtures(withSpotlights(fixtures, proposal.layout.fixtures));
      setSelectedTags(new Set(proposal.layout.fixtures.slice(0, 1).map((fixture) => fixture.tag)));
      setNotice(`Proposed ${proposal.layout.fixtures.length} spotlights. Nothing has been saved yet.`);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  function moveSensors(moves: ReadonlyArray<PointMove<string>>) {
    if (moves.length === 0) return;
    rememberUndoPoint();
    setSensors((current) => {
      const next = withSensorPoints(current, moves);
      sensorsRef.current = next;
      return next;
    });
    bumpDraft();
  }

  function addSensor() {
    if (design.kind !== "ready") return;
    rememberUndoPoint();
    const sensor = newSensor(
      design.value,
      fixturesRef.current,
      sensorsRef.current,
      otherRoomTags(design.value.room.id),
      activeControlGroup(),
    );
    const next = [...sensorsRef.current, sensor];
    setSensors(next);
    sensorsRef.current = next;
    bumpDraft();
    setSelectedTags(new Set([sensor.tag as FixtureTag]));
    setNotice(`Added ${sensor.tag}, switching ${sensor.switching_group} with a ${sensor.run_on_minutes} minute run-on.`);
  }
  async function commit() {
    if (roomId === null || design.kind !== "ready") return;
    const unsaved = draft;
    setDraft({ kind: "saving" });
    try {
      const response = await api.commit(roomId, fixtures, design.value.revision, switches, sensors);
      queryClient.setQueryData(["design", roomId, response.result.revision], response.design);
      setRoomDrafts((current) => {
        const next = withoutRoomDraft(current, roomId);
        roomDraftsRef.current = next;
        return next;
      });
      // The design under the new revision is already cached, so this re-reads only the project.
      await refreshProject();
      setFixtures(response.design.fixtures);
      setSwitches(response.design.switches);
      setSensors(response.design.sensors);
      fixturesRef.current = response.design.fixtures;
      switchesRef.current = response.design.switches;
      latestDraftVersion.current = 0;
      setDraftVersion(0);
      setAnalysis({ kind: "ready", draftVersion: 0, value: response.design.analysis });
      setDraft({ kind: "clean", report: response.design.analysis.validation });
      draftHistory.clear();
      setNotice(`Saved ${response.result.changed_ids.length} fixture changes to IFC.`);
    } catch (error) {
      // The demo refuses before anything is sent, so the layout is exactly as it was.
      setDraft(error instanceof DemoReadOnlyError ? unsaved : { kind: "dirty" });
      setNotice(errorMessage(error));
    }
  }

  async function runBake() {
    if (roomId === null || design.kind !== "ready") return;
    const version = draftVersion;
    setBaked({ kind: "loading" });
    try {
      // 150 mm resolves a cabinet edge; a large room stays under a second.
      const response = await api.bake(roomId, fixtures, 150, bakePlane);
      setBaked({ kind: "ready", value: response.baked });
      setBakedVersion(version);
    } catch (error) {
      setBaked({ kind: "error", message: errorMessage(error) });
      setBakedVersion(null);
    }
  }

  function duplicateSelection() {
    if (design.kind !== "ready") return;
    const copies = duplicates(
      fixturesRef.current,
      switchesRef.current,
      selectedTags,
      snapMm,
      otherRoomTags(design.value.room.id),
    );
    if (copies.length === 0) return;
    rememberUndoPoint();
    replaceFixtures([...fixturesRef.current, ...copies]);
    setSelectedTags(new Set(copies.map((copy) => copy.tag)));
    setNotice(`Duplicated ${copies.map((copy) => copy.tag).join(", ")}.`);
  }

  function distributeSelection() {
    const spotlights = selectedSpotlights(fixturesRef.current, selectedTags);
    if (spotlights.length < 3) return;
    moveFixtures(distributeEvenly(spotlights));
    setNotice(`Spaced ${spotlights.length} spotlights evenly between the two furthest apart.`);
  }

  async function alignFixtures() {
    if (roomId === null) return;
    try {
      const spotlights = spotlightsOf(fixtures);
      const result = await api.align(roomId, spotlights);
      const aligned = spotlightsOf(result.fixtures);
      const moved = movedSpotlights(spotlights, aligned);
      const next = withSpotlights(fixtures, aligned);
      rememberUndoPoint();
      replaceFixtures(next);
      setNotice(
        moved.length === 0
          ? "Every spotlight already sits on the axes the others share."
          : `Moved ${moved.length} spotlight${moved.length === 1 ? "" : "s"} onto a shared axis.`,
      );
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  function renameSelectedFixture(nextValue: string) {
    if (selectedFixture === null) return;
    const result = renameFixture(fixturesRef.current, switchesRef.current, selectedFixture.tag, nextValue);
    if (result.kind === "rejected") {
      setNotice(result.message);
      return;
    }
    if (result.kind === "unchanged") return;
    rememberUndoPoint();
    replaceFixtures(result.fixtures);
    setSelectedTags(new Set([result.tag]));
  }

  async function createExports() {
    if (roomId === null) return;
    try {
      const result = await api.exports(roomId);
      setExports(result);
      setNotice("Installation files are ready.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  const currentAnalysis = analysis.kind === "ready" && analysis.draftVersion === draftVersion ? analysis.value : null;
  // A room's own lower levels open through its floor; the whole-floor view
  // reads them from the plan, a single room has to be told.
  const lowerLevels = useMemo(
    () =>
      wholePlan.kind === "ready" && design.kind === "ready"
        ? wholePlan.value.rooms
            .filter((entry) => entry.room.part_of === design.value.room.id)
            .map((entry) => ({
              outline: entry.ceiling.polygon.outer,
              elevationMm: entry.room.elevation_mm,
              walls: entry.walls,
              openings: entry.openings,
            }))
        : [],
    [wholePlan, design],
  );
  const effectiveWholePlan = useMemo(
    () => (wholePlan.kind === "ready" ? mergeRoomDrafts(wholePlan.value, roomDrafts) : null),
    [wholePlan, roomDrafts],
  );
  // One array per loaded design, so the views see the same objects between edits.
  const roomObjects = useMemo(
    () => (design.kind === "ready" ? [...design.value.furniture, ...design.value.obstructions] : []),
    [design],
  );
  const lightGroupSummaries = useMemo(() => {
    if (scope === "whole") {
      const rooms = effectiveWholePlan?.rooms ?? [];
      return lightGroups(rooms.flatMap((entry) => entry.fixtures), rooms.flatMap((entry) => entry.switches));
    }
    return lightGroups(fixtures, switches);
  }, [scope, effectiveWholePlan, fixtures, switches]);
  const activeReport = currentAnalysis?.validation ?? null;
  const errorCount = activeReport?.findings.filter((finding) => finding.severity === "error").length ?? 0;
  const canCommit = currentAnalysis !== null && errorCount === 0 && draft.kind !== "saving";
  const sunResult = showSun && daylight.kind === "ready" ? daylight.value.daylight : null;
  const bakedSurface =
    showCoverage && baked !== null && baked.kind === "ready" && bakedVersion === draftVersion
      ? baked.value
      : null;

  const stageIndex = DESIGN_STAGES.findIndex((item) => item.id === stage);
  const upcomingStage = DESIGN_STAGES[Math.min(stageIndex + 1, DESIGN_STAGES.length - 1)]!;
  const coverageSurface = bakedSurface ?? currentAnalysis?.illuminance ?? null;
  const retryRoom = () => {
    void designQuery.refetch();
    if (wholePlanQuery.isError) void wholePlanQuery.refetch();
  };
  const retryWholePlan = () => void wholePlanQuery.refetch();

  if (project.kind === "loading") {
    return <main className="startup"><LoaderCircle className="spin" /><p>Opening the IFC model</p></main>;
  }
  if (project.kind === "error") {
    return (
      <main className="startup startup--error">
        <AlertTriangle />
        <h1>Home Twin could not open</h1>
        <p>{project.message}</p>
        <button className="button button--secondary" type="button" onClick={() => void projectQuery.refetch()}>
          <RefreshCw size={16} /> Try again
        </button>
      </main>
    );
  }

  return (
    <div className={workspace === "trace" ? "app-shell app-shell--trace" : "app-shell"}>
      <AppTopBar
        project={project.value}
        workspace={workspace}
        onWorkspaceChange={setWorkspace}
        onReplaceIfc={() => setImportOpen(true)}
      />
      <RoomRail
        rooms={project.value.rooms}
        roomId={roomId}
        scope={scope}
        onSelectWholeFloor={() => { setScope("whole"); setWorkspace("design"); }}
        onSelectRoom={(id) => { setRoomId(id); setScope("room"); setWorkspace("design"); }}
      />

      {workspace === "trace" ? (
        <Suspense fallback={<main className="workspace"><div className="workspace-loading" role="status"><LoaderCircle className="spin" /> Loading plan tracing</div></main>}>
          <TraceWorkspace onModelRebuilt={refreshProject} />
        </Suspense>
      ) : (
        <>
          <main className={scope === "room" ? "workspace workspace--staged" : "workspace"}>
            {scope === "whole" ? (
              <>
                {wholePlan.kind === "loading" ? (
                  <div className="workspace-loading"><LoaderCircle className="spin" /> Reading the whole floor</div>
                ) : null}
                {wholePlan.kind === "error" ? (
                  <div className="workspace-loading workspace-loading--error" role="alert">
                    <AlertTriangle size={22} />
                    <strong>The whole floor could not be read</strong>
                    <p>{wholePlan.message}</p>
                    <button className="button button--secondary" type="button" onClick={retryWholePlan}><RefreshCw size={16} /> Retry</button>
                  </div>
                ) : null}
                {wholePlan.kind === "ready" ? (
                  <Suspense fallback={<div className="workspace-loading" role="status"><LoaderCircle className="spin" /> Loading the whole-floor view</div>}>
                    <WholePlanView
                      plan={effectiveWholePlan ?? wholePlan.value}
                      view={view}
                      selectedRoomId={roomId}
                      onSelectRoom={setRoomId}
                      onScopeChange={setScope}
                      onViewChange={setView}
                      offGroups={offGroups}
                      onToggleGroup={toggleGroup}
                      dimLevels={dimLevels}
                    />
                  </Suspense>
                ) : null}
              </>
            ) : null}
            {scope === "room" && design.kind === "loading" ? <div className="workspace-loading"><LoaderCircle className="spin" /> Reading room geometry</div> : null}
            {scope === "room" && design.kind === "error" ? (
              <div className="workspace-loading workspace-loading--error" role="alert">
                <AlertTriangle size={22} />
                <strong>This room could not be read</strong>
                <p>{design.message}</p>
                <button className="button button--secondary" type="button" onClick={retryRoom}><RefreshCw size={16} /> Retry</button>
              </div>
            ) : null}
            {scope === "room" && design.kind === "ready" ? (
              <>
                <StageBar
                  room={design.value.room}
                  ceilingElevationMm={design.value.ceiling.elevation_mm}
                  stage={stage}
                  onChooseStage={chooseStage}
                />
                <div className="workspace-toolbar">
                  <div className="segmented" role="group" aria-label="View">
                    <button
                      type="button"
                      className={view === "plan" ? "segmented-option segmented-option--active" : "segmented-option"}
                      aria-pressed={view === "plan"}
                      onClick={() => setView("plan")}
                    >
                      <MapIcon size={15} /> 2D
                    </button>
                    <button
                      type="button"
                      className={view === "model" ? "segmented-option segmented-option--active" : "segmented-option"}
                      aria-pressed={view === "model"}
                      onClick={() => setView("model")}
                    >
                      <Boxes size={15} /> 3D
                    </button>
                  </div>
                  <div className="tool-cluster" role="toolbar" aria-label={`${DESIGN_STAGES[stageIndex]!.label} tools`}>
                    {stage === "ceiling" ? (
                      <div className="tool-group" role="group" aria-label="Display">
                        <button className={showCeiling ? "tool-button tool-button--active" : "tool-button"} type="button" aria-pressed={showCeiling} title="Show the ceiling in 3D" onClick={() => setShowCeiling((value) => !value)}><PanelTop size={16} /><ToolLabel>Ceiling</ToolLabel></button>
                        <button
                          className={showGypsum ? "tool-button tool-button--active" : "tool-button"}
                          type="button"
                          aria-pressed={showGypsum}
                          title="Show gypsum soffits and the dropped ceiling in 3D"
                          disabled={design.value.soffits.length === 0 && (design.value.ceiling.structural_elevation_mm ?? 0) <= design.value.ceiling.elevation_mm + 1}
                          onClick={() => setShowGypsum((value) => !value)}
                        >
                          <Layers size={16} /><ToolLabel>Gypsum</ToolLabel>
                        </button>
                      </div>
                    ) : null}
                    {stage === "light" ? (
                      <>
                        <div className="tool-group tool-group--add" role="group" aria-label="Add">
                          <button className="tool-button" type="button" title="Add a recessed spotlight, or drag onto the plan to place it" draggable onDragStart={(event) => event.dataTransfer.setData(PLAN_DROP_TYPE, "recessed_spotlight")} onClick={() => addSpotlight()}><Plus size={16} /><ToolLabel>Spot</ToolLabel></button>
                          <button className="tool-button" type="button" title="Add a pendant, or drag onto the plan to place it" draggable onDragStart={(event) => event.dataTransfer.setData(PLAN_DROP_TYPE, "pendant_bulb")} onClick={() => addPendant()}><Lightbulb size={16} /><ToolLabel>Pendant</ToolLabel></button>
                          <button className="tool-button" type="button" title="Add a rope light" onClick={addRopeLight}><Cable size={16} /><ToolLabel>Rope</ToolLabel></button>
                          <button className="tool-button" type="button" title="Add a wall switch" onClick={addWallSwitch}><ToggleLeft size={16} /><ToolLabel>Switch</ToolLabel></button>
                          <button className="tool-button" type="button" title="Add a movement sensor" onClick={addSensor}><Radar size={16} /><ToolLabel>Sensor</ToolLabel></button>
                        </div>
                        <div className="tool-group tool-group--layout" role="group" aria-label="Layout">
                          <button className="tool-button" type="button" title="Propose a spotlight layout" onClick={() => void optimise()}><Sparkles size={16} /><ToolLabel>Propose</ToolLabel></button>
                          <button className="tool-button" type="button" title="Move spotlights onto shared axes" onClick={() => void alignFixtures()}><AlignHorizontalJustifyCenter size={16} /><ToolLabel>Align</ToolLabel></button>
                          <button
                            className="tool-button"
                            type="button"
                            disabled={selectedSpotlightCount < 3}
                            title={
                              selectedSpotlightCount < 3
                                ? `Select at least 3 spotlights to distribute (${selectedSpotlightCount} selected)`
                                : "Space the selected spotlights evenly between the two furthest apart"
                            }
                            onClick={distributeSelection}
                          >
                            <AlignHorizontalDistributeCenter size={16} /><ToolLabel>Distribute</ToolLabel>
                          </button>
                        </div>
                        <div className="tool-group" role="group" aria-label="History">
                          <button className="tool-button tool-button--icon" type="button" disabled={draftHistory.undoDepth === 0} onClick={undoDraft} aria-label="Undo" title="Undo the last lighting edit (Ctrl+Z)"><Undo2 size={16} /></button>
                          <button className="tool-button tool-button--icon" type="button" disabled={draftHistory.redoDepth === 0} onClick={redoDraft} aria-label="Redo" title="Redo the lighting edit (Ctrl+Shift+Z)"><Redo2 size={16} /></button>
                        </div>
                        <div className="tool-group" role="group" aria-label="Display">
                          <button className={showCoverage ? "tool-button tool-button--active" : "tool-button"} type="button" aria-pressed={showCoverage} title="Show the light coverage layer" onClick={() => setShowCoverage((value) => !value)}><LampCeiling size={16} /><ToolLabel>Coverage</ToolLabel></button>
                          <label className="tool-select" title="Snap spotlights to a grid">
                            <Grid2X2 size={15} />
                            <span className="visually-hidden">Snap spotlights to</span>
                            <select value={snapMm} onChange={(event) => setSnapMm(Number(event.currentTarget.value))}>
                              <option value={10}>10 mm</option>
                              <option value={50}>50 mm</option>
                              <option value={100}>100 mm</option>
                              <option value={250}>250 mm</option>
                              <option value={500}>500 mm</option>
                            </select>
                          </label>
                        </div>
                      </>
                    ) : null}
                    {stage === "daylight" ? (
                      <div className="tool-group" role="group" aria-label="Display">
                        <button className={showSun ? "tool-button tool-button--active" : "tool-button"} type="button" aria-pressed={showSun} title="Show where direct sun lands" onClick={() => setShowSun((value) => !value)}><Sun size={16} /><ToolLabel>Sun patches</ToolLabel></button>
                      </div>
                    ) : null}
                    {stage === "check" ? (
                      <div className="tool-group" role="group" aria-label="Display">
                        <button className={showDarkZones ? "tool-button tool-button--active" : "tool-button"} type="button" aria-pressed={showDarkZones} title="Show areas under the target level" onClick={() => setShowDarkZones((value) => !value)}><Grid2X2 size={16} /><ToolLabel>Dark zones</ToolLabel></button>
                        <button className={showCoverage ? "tool-button tool-button--active" : "tool-button"} type="button" aria-pressed={showCoverage} title="Show the light coverage layer" onClick={() => setShowCoverage((value) => !value)}><LampCeiling size={16} /><ToolLabel>Coverage</ToolLabel></button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="plan-stage plan-stage--with-legend">
                  <div className="plan-canvas">
                    {view === "plan" ? (
                      <CeilingPlan
                        polygon={design.value.ceiling.polygon}
                        ceilingElevationMm={design.value.ceiling.elevation_mm}
                        walls={design.value.walls}
                        objects={roomObjects}
                        openings={design.value.openings}
                        daylightSources={design.value.daylight_sources}
                        fixtures={fixtures}
                        switches={switches}
                        floorElevationMm={design.value.room.elevation_mm}
                        darkZones={currentAnalysis?.dark_zones ?? NO_DARK_ZONES}
                        illuminance={coverageSurface}
                        stairs={design.value.stairs}
                        soffits={design.value.soffits}
                        showCoverage={showCoverage}
                        showLightRendering={showCoverage}
                        sunPatches={sunResult?.patches ?? NO_SUN_PATCHES}
                        sunDirection={sunResult?.sun_direction ?? null}
                        sunAltitudeDeg={sunResult?.position?.altitude_deg ?? null}
                        trueNorthDeg={site?.true_north_deg ?? 0}
                        taskPlaneElevationMm={
                          design.value.room.elevation_mm + design.value.constraints.task_plane_height_mm
                        }
                        selectedTags={selectedTags}
                        showDarkZones={showDarkZones}
                        snapMm={snapMm}
                        onSelect={setSelectedTags}
                        onMove={moveFixtures}
                        onDropFixture={(kind, at) => (kind === "pendant_bulb" ? addPendant(at) : addSpotlight(at))}
                        sensors={sensors}
                        onMoveSensor={moveSensors}
                      />
                    ) : (
                      <Suspense
                        fallback={
                          <div className="workspace-loading">
                            <LoaderCircle className="spin" /> Loading the 3D view
                          </div>
                        }
                      >
                        <RoomView3D
                          polygon={design.value.ceiling.polygon}
                          walls={design.value.walls}
                          openings={design.value.openings}
                          objects={roomObjects}
                          fixtures={fixtures}
                          switches={switches}
                          offGroups={offGroups}
                          illuminance={currentAnalysis?.illuminance ?? null}
                          baked={bakedSurface}
                          stairs={design.value.stairs}
                          darkZones={currentAnalysis?.dark_zones ?? NO_DARK_ZONES}
                          sunPatches={sunResult?.patches ?? NO_SUN_PATCHES}
                          sunDirection={sunResult?.sun_direction ?? null}
                          sunAltitudeDeg={sunResult?.position?.altitude_deg ?? null}
                          trueNorthDeg={site?.true_north_deg ?? 0}
                          floorElevationMm={design.value.room.elevation_mm}
                          ceilingElevationMm={design.value.ceiling.elevation_mm}
                          taskPlaneElevationMm={
                            design.value.room.elevation_mm + design.value.constraints.task_plane_height_mm
                          }
                          targetLux={design.value.constraints.target_lux}
                          utilizationFactor={design.value.constraints.utilization_factor}
                          selectedTags={selectedTags}
                          snapMm={snapMm}
                          showLightRendering
                          showCoverage={showCoverage}
                          showDarkZones={showDarkZones}
                          structuralCeilingElevationMm={design.value.ceiling.structural_elevation_mm ?? null}
                          floorFinish={design.value.room.floor_finish ?? null}
                          wallFinish={design.value.room.wall_finish ?? null}
                          featureWallId={design.value.room.feature_wall_id ?? null}
                          featureWallColour={design.value.room.feature_wall_colour ?? null}
                          skirting={design.value.room.skirting ?? null}
                          skirtingHeightMm={design.value.room.skirting_height_mm ?? null}
                          skirtingThicknessMm={design.value.room.skirting_thickness_mm ?? null}
                          cladWallIds={design.value.room.clad_wall_ids ?? NO_WALL_IDS}
                          showCeiling={showCeiling}
                          isExternal={design.value.room.is_external}
                          showGypsum={showGypsum}
                          soffits={design.value.soffits}
                          lowerLevels={lowerLevels}
                          onSelect={setSelectedTags}
                          onMove={moveFixtures}
                          sensors={sensors}
                          onMoveSwitch={(tag, position) => updateSwitch(tag, (device) => ({ ...device, ...position }))}
                          onToggleGroup={toggleGroup}
                          dimLevels={dimLevels}
                          viewLabel={design.value.room.name}
                        />
                      </Suspense>
                    )}
                  </div>
                  {view === "plan" ? (
                    <PlanLegend
                      showSun={showSun}
                      showCoverage={showCoverage}
                      coverageSurface={coverageSurface}
                      hasStairs={design.value.stairs.length > 0}
                      legendOpen={legendOpen}
                      onToggleLegend={() => setLegendOpen((open) => !open)}
                    />
                  ) : null}
                </div>

                <ReviewDock
                  draft={draft}
                  analysisPending={analysis.kind === "pending"}
                  unavailableMessage={
                    DEMO && analysis.kind === "error" && analysis.draftVersion === draftVersion ? analysis.message : null
                  }
                  report={activeReport}
                  errorCount={errorCount}
                  lightCount={fixtures.length}
                  switchCount={switches.length}
                  publishing={stage === "publish"}
                  nextStageLabel={upcomingStage.label}
                  canCommit={canCommit}
                  onExport={() => void createExports()}
                  onValidate={() => void validate()}
                  onCommit={() => void commit()}
                  onNextStage={() => chooseStage(upcomingStage.id)}
                />
              </>
            ) : null}
          </main>

          <div className="right-rail">
            {scope === "room" ? (
              <FixtureInspector
                fixture={selectedFixture}
                device={selectedSwitch}
                walls={design.kind === "ready" ? design.value.walls : []}
                selectedTags={[...selectedTags]}
                onPointChange={(point) => selectedFixture !== null && moveFixtures([{ tag: selectedFixture.tag, point }])}
                onFixtureChange={(fixture) => selectedFixture !== null && updateFixture(selectedFixture.tag, () => fixture)}
                onTagChange={renameSelectedFixture}
                onSwitchChange={(device) => selectedSwitch !== null && updateSwitch(selectedSwitch.tag as FixtureTag, () => device)}
                groupIsOff={selectedSwitch !== null && offGroups.has(selectedSwitch.switching_group)}
                onToggleGroup={toggleGroup}
                canAdd={design.kind === "ready"}
                onAdd={() => addSpotlight()}
                duplicateCount={duplicableTags(fixturesRef.current, selectedTags).length}
                onDuplicate={duplicateSelection}
                onDelete={deleteSelection}
                onClose={() => setSelectedTags(new Set())}
              />
            ) : null}
            {view === "model" ? (
              <LightGroupsPanel
                groups={lightGroupSummaries}
                offGroups={offGroups}
                dimLevels={dimLevels}
                onToggleGroup={toggleGroup}
                onSetGroupsOff={setGroupsOff}
                onDim={(group, level) => setDimLevels((current) => withDimLevel(current, group, level))}
              />
            ) : null}
            {scope === "room" && showCoverage ? (
              <BakePanel
                state={baked}
                stale={baked?.kind === "ready" && bakedVersion !== draftVersion}
                plane={bakePlane}
                onPlaneChange={(next) => {
                  setBakePlane(next);
                  setBaked(null);
                  setBakedVersion(null);
                }}
                onBake={() => void runBake()}
              />
            ) : null}
            {scope === "room" && showSun ? (
              <DaylightPanel
                site={site}
                state={daylight}
                date={sunDate}
                minutes={sunMinutes}
                plane={sunPlane}
                onDateChange={setSunDate}
                onMinutesChange={setSunMinutes}
                onPlaneChange={setSunPlane}
                onEditSite={() => setWorkspace("trace")}
              />
            ) : null}
            {scope === "room" && activeReport !== null ? <LayoutChecks report={activeReport} /> : null}
            {scope === "room" && exports !== null ? <InstallationFiles exports={exports} /> : null}
          </div>
        </>
      )}

      {notice !== null ? <button className="toast" type="button" onClick={() => setNotice(null)}><span>{notice}</span><small>Dismiss</small></button> : null}
      {importOpen ? <ImportDialog revision={project.value.building.revision} onClose={() => setImportOpen(false)} onAdopted={refreshProject} /> : null}
    </div>
  );
}
