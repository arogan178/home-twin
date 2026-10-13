import type { ZodType } from "zod";

import { DEMO, DemoReadOnlyError, demoRequestUrl } from "./demo";

import {
  AdoptResponseSchema,
  AnalysisResponseSchema,
  BakeResponseSchema,
  CommitResponseSchema,
  DaylightResponseSchema,
  DesignSchema,
  ExportResponseSchema,
  ImportSummarySchema,
  AlignResponseSchema,
  LayoutProposalSchema,
  ProjectSchema,
  SiteResponseSchema,
  TraceBuildResponseSchema,
  TraceReviewResponseSchema,
  TraceSaveResponseSchema,
  TraceSchema,
  WholePlanSchema,
  UnderlayUploadSchema,
  type Fixture,
  type PlanDocument,
  type Revision,
  type RoomId,
  type Sensor,
  type SpotlightSpec,
  type WallSwitch,
} from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(DEMO ? demoRequestUrl(url, init, import.meta.env.BASE_URL) : url, init);
  const raw: unknown = await response.json();
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    if (typeof raw === "object" && raw !== null && "detail" in raw) {
      const detail = raw.detail;
      if (typeof detail === "string") message = detail;
      if (typeof detail === "object" && detail !== null && "message" in detail && typeof detail.message === "string") {
        message = detail.message;
      }
    }
    throw new ApiError(message, response.status);
  }
  return schema.parse(raw);
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

function fixturePayload(fixture: Fixture) {
  if (fixture.kind === "rope_light") {
    return {
      kind: fixture.kind,
      tag: fixture.tag,
      path: fixture.path,
      spec: fixture.spec,
      switching_group: fixture.switching_group,
      notes: fixture.notes,
    };
  }
  if (fixture.kind === "pendant_bulb") {
    return {
      kind: fixture.kind,
      tag: fixture.tag,
      point: fixture.point,
      spec: fixture.spec,
      switching_group: fixture.switching_group,
      notes: fixture.notes,
    };
  }
  return {
    kind: fixture.kind,
    tag: fixture.tag,
    point: fixture.point,
    spec: fixture.spec,
    switching_group: fixture.switching_group,
    direction: fixture.direction,
    notes: fixture.notes,
  };
}

function sensorPayload(sensor: Sensor) {
  return {
    tag: sensor.tag,
    point: sensor.point,
    run_on_minutes: sensor.run_on_minutes,
    switching_group: sensor.switching_group,
    controls_tag: sensor.controls_tag,
    spec: sensor.spec,
    notes: sensor.notes,
  };
}

function switchPayload(device: WallSwitch) {
  return {
    tag: device.tag,
    host_wall_id: device.host_wall_id,
    offset_mm: device.offset_mm,
    mounting_height_mm: device.mounting_height_mm,
    switching_group: device.switching_group,
    spec: device.spec,
    mounting_face: device.mounting_face,
    notes: device.notes,
  };
}

export const api = {
  project: (signal?: AbortSignal) =>
    request("/api/project", ProjectSchema, signal === undefined ? undefined : { signal }),
  design: (roomId: RoomId, signal?: AbortSignal) =>
    request(
      `/api/rooms/${encodeURIComponent(roomId)}/design`,
      DesignSchema,
      signal === undefined ? undefined : { signal },
    ),
  analyse: (roomId: RoomId, fixtures: Fixture[], signal?: AbortSignal, switches: WallSwitch[] = []) => {
    const layout = { fixtures: fixtures.map(fixturePayload), switches: switches.map(switchPayload) };
    if (DEMO) return demoAnalysis(roomId, layout, signal);
    return request(`/api/rooms/${encodeURIComponent(roomId)}/analysis`, AnalysisResponseSchema, {
      ...jsonBody(layout),
      ...(signal === undefined ? {} : { signal }),
    });
  },
  bake: (roomId: RoomId, fixtures: Fixture[], stepMm: number, plane: "floor" | "task", signal?: AbortSignal) =>
    request(`/api/rooms/${encodeURIComponent(roomId)}/bake`, BakeResponseSchema, {
      ...jsonBody({ fixtures: fixtures.map(fixturePayload), step_mm: stepMm, plane }),
      ...(signal === undefined ? {} : { signal }),
    }),
  align: (roomId: RoomId, fixtures: Fixture[]) =>
    request(
      `/api/rooms/${encodeURIComponent(roomId)}/align`,
      AlignResponseSchema,
      jsonBody({ fixtures }),
    ),
  optimise: (roomId: RoomId, fixture: SpotlightSpec) =>
    request(
      `/api/rooms/${encodeURIComponent(roomId)}/optimise`,
      LayoutProposalSchema,
      jsonBody({ fixture }),
    ),
  commit: (
    roomId: RoomId,
    fixtures: Fixture[],
    expectedRevision: Revision,
    switches: WallSwitch[] = [],
    sensors: Sensor[] = [],
  ) =>
    request(
      `/api/rooms/${encodeURIComponent(roomId)}/commit`,
      CommitResponseSchema,
      jsonBody({
        fixtures: fixtures.map(fixturePayload),
        switches: switches.map(switchPayload),
        sensors: sensors.map(sensorPayload),
        expected_revision: expectedRevision,
      }),
    ),
  inspectIfc: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request("/api/imports", ImportSummarySchema, { method: "POST", body: form });
  },
  adoptIfc: (importId: string, expectedRevision: Revision) =>
    request(`/api/imports/${encodeURIComponent(importId)}/adopt`, AdoptResponseSchema, jsonBody({ expected_revision: expectedRevision })),
  discardIfc: async (importId: string) => {
    if (DEMO) return;
    await fetch(`/api/imports/${encodeURIComponent(importId)}`, { method: "DELETE" });
  },
  exports: (roomId: RoomId) =>
    request(`/api/exports?room_id=${encodeURIComponent(roomId)}`, ExportResponseSchema, { method: "POST" }),
  site: (signal?: AbortSignal) =>
    request("/api/site", SiteResponseSchema, signal === undefined ? undefined : { signal }),
  wholePlan: (signal?: AbortSignal) =>
    request("/api/plan", WholePlanSchema, signal === undefined ? undefined : { signal }),
  daylight: (roomId: RoomId, at: string, plane: "floor" | "task", signal?: AbortSignal) =>
    request(
      `/api/rooms/${encodeURIComponent(roomId)}/daylight?at=${encodeURIComponent(at)}&plane=${plane}`,
      DaylightResponseSchema,
      signal === undefined ? undefined : { signal },
    ),
  trace: (signal?: AbortSignal) =>
    request("/api/trace", TraceSchema, signal === undefined ? undefined : { signal }),
  reviewTrace: (document: PlanDocument, signal?: AbortSignal) =>
    request("/api/trace/review", TraceReviewResponseSchema, {
      ...jsonBody({ document }),
      ...(signal === undefined ? {} : { signal }),
    }),
  saveTrace: (document: PlanDocument, expectedRevision: string) =>
    request(
      "/api/trace/save",
      TraceSaveResponseSchema,
      jsonBody({ document, expected_revision: expectedRevision }),
    ),
  buildTrace: (expectedDraftRevision: string | null, discardFixtures = false) =>
    request(
      "/api/trace/build",
      TraceBuildResponseSchema,
      jsonBody({
        expected_draft_revision: expectedDraftRevision,
        discard_fixtures: discardFixtures,
      }),
    ),
  discardUnderlay: async () => {
    if (DEMO) return;
    await fetch("/api/trace/underlay", { method: "DELETE" });
  },
  uploadUnderlay: (file: File, widthPx: number, heightPx: number) => {
    const form = new FormData();
    form.append("file", file);
    form.append("width_px", String(widthPx));
    form.append("height_px", String(heightPx));
    return request("/api/trace/underlay", UnderlayUploadSchema, { method: "POST", body: form });
  },
};

// The demo recorded only the saved layout's analysis, so an edited layout has no honest answer.
async function demoAnalysis(roomId: RoomId, layout: object, signal?: AbortSignal) {
  const saved = await api.design(roomId, signal);
  const savedLayout = { fixtures: saved.fixtures.map(fixturePayload), switches: saved.switches.map(switchPayload) };
  if (JSON.stringify(savedLayout) !== JSON.stringify(layout)) throw new DemoReadOnlyError();
  return request(
    `/api/rooms/${encodeURIComponent(roomId)}/analysis`,
    AnalysisResponseSchema,
    signal === undefined ? undefined : { signal },
  );
}
