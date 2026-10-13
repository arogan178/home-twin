import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostEdges } from "./traceDocument";
import { TraceWorkspace } from "./TraceWorkspace";
import { render } from "./test/render";
import { PlanDocumentSchema } from "./types";

const document = {
  schema: "home-twin.m1-plan/v2",
  project_id: "test-plan",
  building_name: "Test home",
  source: {
    file_name: "plan.pdf",
    sha256: "sha256:0",
    page: 1,
    locator: "Ground floor",
    method: "vector trace",
  },
  coordinate_frame: {
    units: "millimetres",
    x_axis: "plan_right",
    y_axis: "plan_up",
    z_axis: "up",
    origin: "paper origin",
    trace_transform: "identity",
  },
  evidence: {
    pdf_trace: { source: "drawing", status: "traced", uncertainty_mm: 50 },
  },
  points: {
    a: { x_mm: 0, y_mm: 0, evidence: "pdf_trace" },
    b: { x_mm: 3500, y_mm: 0, evidence: "pdf_trace" },
    c: { x_mm: 3500, y_mm: 3000, evidence: "pdf_trace" },
    d: { x_mm: 0, y_mm: 3000, evidence: "pdf_trace" },
  },
  controls: [
    { id: "width", from_point: "a", to_point: "b", expected_mm: 3500, tolerance_mm: 20 },
    { id: "depth", from_point: "b", to_point: "c", expected_mm: 3000, tolerance_mm: 20 },
  ],
  rooms: [
    {
      id: "living",
      name: "Living room",
      point_ids: ["a", "b", "c", "d"],
      ceiling_height_mm: 2600,
      ceiling_evidence: "pdf_trace",
      geometry_evidence: "pdf_trace",
    },
  ],
  default_wall: { thickness_mm: 150, evidence: "pdf_trace" },
  wall_overrides: [],
  apertures: [],
  daylight_sources: [],
  review_notes: [],
};

const review = {
  source_digest: "sha256:digest",
  controls: [
    { id: "width", expected_mm: 3500, traced_mm: 3500, discrepancy_mm: 0, tolerance_mm: 20, passed: true },
    { id: "depth", expected_mm: 3000, traced_mm: 3000, discrepancy_mm: 0, tolerance_mm: 20, passed: true },
  ],
  blockers: [],
  warnings: [
    { code: "site_unstated", message: "No site latitude, longitude, and true north are stated" },
  ],
  room_count: 1,
  wall_count: 4,
  traced_net_area_m2: 10.5,
  declared_internal_area_m2: null,
  review_notes: [],
  aperture_count: 0,
  site_located: false,
  has_underlay: false,
};

const trace = {
  document,
  review,
  revision: "sha256:planrev",
  source_path: "/repo/model/references/m1-plan.yaml",
  underlay_url: null,
  draft: {
    path: "/repo/model/m1-draft.ifc",
    exists: true,
    revision: "sha256:draftrev",
    is_open_model: true,
  },
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type Recorded = { url: string; body: unknown };

function stubApi(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url === "/api/trace") return Promise.resolve(jsonResponse(overrides.trace ?? trace));
    if (url === "/api/trace/review") {
      return Promise.resolve(jsonResponse({ review: { ...review, site_located: true } }));
    }
    if (url === "/api/trace/save") {
      return Promise.resolve(
        jsonResponse({
          revision: "sha256:planrev2",
          review: { ...review, site_located: true },
          trace: { ...trace, revision: "sha256:planrev2", document: body?.document ?? document },
        }),
      );
    }
    if (url === "/api/trace/build") {
      return Promise.resolve(
        jsonResponse({
          report: {
            path: "/repo/model/m1-draft.ifc",
            revision: "sha256:draftrev2",
            source_digest: "sha256:digest",
            published: true,
            rooms_verified: ["room-guid"],
            controls: review.controls,
            schema_issue_count: 0,
            warnings: [],
          },
          model_reloaded: true,
          revision: "sha256:draftrev2",
          trace: { ...trace, revision: "sha256:planrev2" },
          ...(overrides.build ?? {}),
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("hostEdges", () => {
  it("closes every room outline into ordered edges", () => {
    const parsed = PlanDocumentSchema.parse(document);
    expect(hostEdges(parsed).map((item) => item.edge)).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "a"],
    ]);
  });
});

describe("TraceWorkspace", () => {
  it("draws an opening at its saved wall offset", async () => {
    stubApi({
      trace: {
        ...trace,
        document: {
          ...document,
          apertures: [
            {
              id: "window_1",
              name: "Window 1",
              kind: "window",
              host_edge: ["a", "b"],
              offset_mm: 200,
              width_mm: 1000,
              sill_height_mm: 900,
              height_mm: 1200,
              room_ids: ["living"],
              exposure: "exterior",
              geometry_evidence: "pdf_trace",
              height_evidence: "pdf_trace",
              glazing_fraction: 0.8,
            },
          ],
        },
      },
    });
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    const opening = container.querySelector(".trace-aperture");
    expect(opening).not.toBeNull();
    expect(opening).toHaveAttribute("x1", "200");
    expect(opening).toHaveAttribute("x2", "1200");
  });

  it("opens as a calm, task-based editor instead of exposing tracing internals", async () => {
    stubApi();
    const { container } = render(
      <TraceWorkspace onModelRebuilt={async () => undefined} />,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Test home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit rooms/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Draw a room/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add an opening/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check a dimension/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Drawing setup/ })).toBeInTheDocument();

    // Points and printed controls are editing aids. Showing every one on load
    // made the floor plan unreadable before the user had chosen a task.
    expect(container.querySelectorAll(".trace-point")).toHaveLength(0);
    expect(container.querySelectorAll(".trace-control")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Point$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Control$/ })).not.toBeInTheDocument();
  });

  it("reveals only the selected room's corners while its outline is being corrected", async () => {
    stubApi();
    const { container } = render(
      <TraceWorkspace onModelRebuilt={async () => undefined} />,
    );
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    fireEvent.click(screen.getByRole("button", { name: /Edit rooms/ }));
    expect(screen.getByText(/Select the room you want to correct/)).toBeInTheDocument();
    expect(container.querySelectorAll(".trace-point")).toHaveLength(0);

    const outline = container.querySelector(".trace-room polygon");
    expect(outline).not.toBeNull();
    fireEvent.pointerDown(outline as Element, { button: 0 });

    expect(await screen.findByText(/Drag a corner to move it/)).toBeInTheDocument();
    expect(container.querySelectorAll(".trace-point")).toHaveLength(4);
    const toolbar = screen.getByRole("toolbar", { name: "Room living" });
    expect(within(toolbar).getByRole("button", { name: /Add a corner/ })).toBeInTheDocument();
  });

  it("adds an opening through a room-then-wall workflow and can undo it", async () => {
    stubApi();
    const { container } = render(
      <TraceWorkspace onModelRebuilt={async () => undefined} />,
    );
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    fireEvent.click(screen.getByRole("button", { name: /Add an opening/ }));
    expect(screen.getByText(/Select the room containing/)).toBeInTheDocument();
    expect(container.querySelectorAll(".trace-host-edge")).toHaveLength(0);

    fireEvent.pointerDown(container.querySelector(".trace-room polygon") as Element, { button: 0 });
    expect(screen.getByText(/Click the wall that contains/)).toBeInTheDocument();
    expect(container.querySelectorAll(".trace-host-edge")).toHaveLength(4);

    fireEvent.pointerDown(container.querySelector(".trace-host-edge") as Element, { button: 0 });
    expect(await screen.findByRole("heading", { level: 2, name: "Opening 1" })).toBeInTheDocument();
    expect(screen.getByText("Opening added")).toBeInTheDocument();
    expect(container.querySelectorAll(".trace-point")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Save plan source/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Build draft IFC/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled());
    expect(screen.queryByRole("heading", { level: 2, name: "Opening 1" })).not.toBeInTheDocument();
  });

  it("shows the reviewed source, its controls, and the missing-site warning", async () => {
    stubApi();
    render(<TraceWorkspace onModelRebuilt={async () => undefined} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Test home" })).toBeInTheDocument();
    expect(screen.getByTitle("/repo/model/references/m1-plan.yaml")).toHaveTextContent("Reviewed plan source");
    expect(screen.getByText(/2\/2 controls/)).toBeInTheDocument();
    expect(screen.getByText("site unstated")).toBeInTheDocument();
  });

  it("saves an edited site block under the current plan revision, then builds", async () => {
    const calls = stubApi();
    const rebuilt = vi.fn(async () => undefined);
    render(<TraceWorkspace onModelRebuilt={rebuilt} />);

    fireEvent.click(await screen.findByRole("button", { name: /Site and true north/ }));
    const add = await screen.findByRole("button", { name: /Add a site block/ });
    expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled();

    fireEvent.click(add);
    const latitude = screen.getByLabelText(/Latitude/);
    fireEvent.change(latitude, { target: { value: "51.5" } });
    fireEvent.change(screen.getByLabelText(/Longitude/), { target: { value: "7.25" } });
    fireEvent.change(screen.getByLabelText(/Plan \+Y bearing/), { target: { value: "12" } });

    const save = screen.getByRole("button", { name: /Save plan source/ });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(calls.some((call) => call.url === "/api/trace/save")).toBe(true));
    const saved = calls.find((call) => call.url === "/api/trace/save");
    expect(saved?.body).toMatchObject({
      expected_revision: "sha256:planrev",
      document: {
        schema: "home-twin.plan/v3",
        site: { latitude_deg: 51.5, longitude_deg: 7.25, true_north_deg: 12 },
      },
    });

    const build = await screen.findByRole("button", { name: /Build draft IFC/ });
    await waitFor(() => expect(build).toBeEnabled());
    fireEvent.click(build);

    await waitFor(() => expect(calls.some((call) => call.url === "/api/trace/build")).toBe(true));
    expect(calls.find((call) => call.url === "/api/trace/build")?.body).toEqual({
      expected_draft_revision: "sha256:draftrev",
      discard_fixtures: false,
    });
    await waitFor(() => expect(rebuilt).toHaveBeenCalled());
    expect(await screen.findByText(/Draft IFC published with 1 verified rooms/)).toBeInTheDocument();
  });

  it("keeps the inspector on the traced item after an edit, even without a site", async () => {
    stubApi();
    const { container: document_ } = render(
      <TraceWorkspace onModelRebuilt={async () => undefined} />,
    );

    // Site setup is available without stealing focus from the tracing task.
    fireEvent.click(await screen.findByRole("button", { name: /Site and true north/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Location and true north" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add a site block/ }));
    fireEvent.change(screen.getByLabelText(/Latitude/), { target: { value: "51.5" } });

    // Selecting a room must survive the next document edit.
    const outline = document_.querySelector(".trace-room polygon");
    expect(outline).not.toBeNull();
    fireEvent.pointerDown(outline as Element, { button: 0 });
    expect(await screen.findByRole("heading", { level: 2, name: "Living room" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Ceiling/), { target: { value: "2700" } });

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Living room" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { level: 2, name: "Location and true north" })).not.toBeInTheDocument();
  });

  it("rounds a new opening to a whole 5 mm on an odd wall", async () => {
    const odd = {
      ...trace,
      document: { ...document, points: { ...document.points, b: { x_mm: 1408.0236, y_mm: 0, evidence: "pdf_trace" } } },
    };
    stubApi({ trace: odd });
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    fireEvent.click(screen.getByRole("button", { name: /Add an opening/ }));
    fireEvent.pointerDown(container.querySelector(".trace-room polygon") as Element, { button: 0 });
    fireEvent.pointerDown(container.querySelector(".trace-host-edge") as Element, { button: 0 });

    await screen.findByRole("heading", { level: 2, name: "Opening 1" });
    expect((within(screen.getByRole("complementary")).getByLabelText(/Width/) as HTMLInputElement).value).toBe("1110");
  });

  it("keeps an opening the other room shares when one room is deleted", async () => {
    const shared = {
      ...trace,
      document: {
        ...document,
        rooms: [
          ...document.rooms,
          {
            id: "hall",
            name: "Hall",
            point_ids: ["a", "b", "c"],
            ceiling_height_mm: 2600,
            ceiling_evidence: "pdf_trace",
            geometry_evidence: "pdf_trace",
          },
        ],
        apertures: [
          {
            id: "threshold",
            name: "Threshold",
            kind: "unfilled",
            host_edge: ["a", "b"],
            width_mm: 900,
            sill_height_mm: 0,
            height_mm: 2100,
            room_ids: ["living", "hall"],
            exposure: "interior",
            geometry_evidence: "pdf_trace",
            height_evidence: "pdf_trace",
            glazing_fraction: 0,
          },
        ],
      },
    };
    const calls = stubApi({ trace: shared });
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    fireEvent.pointerDown(container.querySelectorAll(".trace-room polygon")[1] as Element, { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Delete Hall" }));

    fireEvent.click(await screen.findByRole("button", { name: /Save plan source/ }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/trace/save")).toBe(true));
    const body = calls.find((call) => call.url === "/api/trace/save")?.body as {
      document: { apertures: { room_ids: string[] }[] };
    };
    expect(body.document.apertures.map((item) => item.room_ids)).toEqual([["living"]]);
  });

  it("offers to move a check onto other corners instead of only editing its printed number", async () => {
    stubApi();
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    fireEvent.click(screen.getByRole("button", { name: /Check a dimension/ }));
    fireEvent.pointerDown(container.querySelector(".trace-control") as Element, { button: 0 });
    await screen.findByRole("heading", { level: 2, name: "Dimension check" });

    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /Move onto other corners/ }));
    expect(screen.getByText(/Click the two corners the printed dimension runs between/)).toBeInTheDocument();
    // Every traced corner has to be pickable to re-anchor onto one.
    expect(container.querySelectorAll(".trace-point")).toHaveLength(4);
  });

  it("draws the traced shafts, which the plan is not complete without", async () => {
    const withShaft = {
      ...trace,
      document: {
        ...document,
        points: {
          ...document.points,
          s1: { x_mm: 500, y_mm: 500, evidence: "pdf_trace" },
          s2: { x_mm: 1000, y_mm: 500, evidence: "pdf_trace" },
          s3: { x_mm: 1000, y_mm: 1100, evidence: "pdf_trace" },
          s4: { x_mm: 500, y_mm: 1100, evidence: "pdf_trace" },
        },
        daylight_sources: [
          {
            id: "wet_room_shaft",
            name: "Ventilation shaft between the wet rooms",
            kind: "ventilation_shaft",
            point_ids: ["s1", "s2", "s3", "s4"],
            daylight_role: "possible",
            geometry_evidence: "pdf_trace",
          },
        ],
      },
    };
    stubApi({ trace: withShaft });
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    expect(container.querySelectorAll(".trace-shaft")).toHaveLength(1);
    fireEvent.pointerDown(container.querySelector(".trace-shaft polygon") as Element, { button: 0 });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Ventilation shaft between the wet rooms" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Daylight/)).toHaveValue("possible");
  });

  it("refuses to build while the source has unsaved edits", async () => {
    stubApi();
    render(<TraceWorkspace onModelRebuilt={async () => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: /Site and true north/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Add a site block/ }));

    expect(screen.getByRole("button", { name: /Build draft IFC/ })).toBeDisabled();
  });

  it("treats an undo back to the saved source as clean", async () => {
    stubApi();
    render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Site and true north/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Add a site block/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save plan source/ })).toBeEnabled());
    expect(screen.getByRole("button", { name: /Build draft IFC/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled());
    expect(screen.getByRole("button", { name: /Build draft IFC/ })).toBeEnabled();
  });
});

/** jsdom has no SVG geometry, so client pixels read as plan millimetres with Y flipped. */
function stubSvgGeometry() {
  const proto = SVGSVGElement.prototype as unknown as Record<string, unknown>;
  proto.getScreenCTM = () => ({ inverse: () => ({}) });
  proto.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } });
  proto.setPointerCapture = () => undefined;
  proto.releasePointerCapture = () => undefined;
}

/** Pointer coordinates for a plan point in millimetres. */
const at = (xMm: number, yMm: number, extra: Record<string, unknown> = {}) => ({
  button: 0,
  pointerId: 1,
  clientX: xMm,
  clientY: -yMm,
  ...extra,
});

async function savedPlan(calls: Recorded[]) {
  const save = screen.getByRole("button", { name: /Save plan source/ });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(calls.some((call) => call.url === "/api/trace/save")).toBe(true));
  return (calls.find((call) => call.url === "/api/trace/save")?.body as { document: typeof document }).document;
}

describe("drawing gestures", () => {
  it("draws a room as one rectangle drag, snapped to the grid, undone in one step", async () => {
    stubSvgGeometry();
    const calls = stubApi();
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });
    fireEvent.click(screen.getByRole("button", { name: /Draw a room/ }));
    const canvas = container.querySelector("svg.trace-canvas") as Element;

    fireEvent.pointerDown(canvas, at(5003, 5004));
    fireEvent.pointerMove(canvas, at(8002, 7497));
    expect(screen.getByRole("status", { name: "Drawing readout" })).toHaveTextContent("Rectangle 3000 × 2500 mm");
    fireEvent.pointerUp(canvas, at(8002, 7497));

    expect(await screen.findByRole("heading", { level: 2, name: "Room 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: /Draw a room/ }));
    fireEvent.pointerDown(canvas, at(5003, 5004));
    fireEvent.pointerMove(canvas, at(8002, 7497));
    fireEvent.pointerUp(canvas, at(8002, 7497));
    const saved = await savedPlan(calls);
    expect(saved.rooms[1]?.point_ids).toEqual(["p1", "p2", "p3", "p4"]);
    expect(saved.points).toMatchObject({
      p1: { x_mm: 5000, y_mm: 5000 },
      p2: { x_mm: 8000, y_mm: 5000 },
      p3: { x_mm: 8000, y_mm: 7500 },
      p4: { x_mm: 5000, y_mm: 7500 },
    });
  });

  it("places typed lengths along the Shift-locked cursor or an arrow key, then closes on the first corner", async () => {
    stubSvgGeometry();
    const calls = stubApi();
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });
    fireEvent.click(screen.getByRole("button", { name: /Draw a room/ }));
    const canvas = container.querySelector("svg.trace-canvas") as Element;
    const readout = () => screen.getByRole("status", { name: "Drawing readout" });

    fireEvent.pointerMove(canvas, at(3490, 10));
    expect(readout()).toHaveTextContent("snaps to point b at x 3500, y 0 mm");

    fireEvent.pointerDown(canvas, at(5003, 5004));
    fireEvent.pointerUp(canvas, at(5003, 5004));
    fireEvent.pointerMove(canvas, at(6004, 5100, { shiftKey: true }));
    expect(readout()).toHaveTextContent("Length 1000 mm · locked to plan X · snaps to grid at x 6000, y 5000 mm");

    for (const key of ["3", "0", "0", "0", "0", "Backspace"]) fireEvent.keyDown(window, { key });
    expect(screen.getByRole("status", { name: "Typed length" })).toHaveTextContent("3000");
    expect(readout()).toHaveTextContent("Length 3000 mm");
    fireEvent.keyDown(window, { key: "Enter" });

    for (const key of ["2", "5", "0", "0", "ArrowUp"]) fireEvent.keyDown(window, { key });
    for (const key of ["9", "Escape"]) fireEvent.keyDown(window, { key });
    expect(screen.queryByRole("status", { name: "Typed length" })).not.toBeInTheDocument();
    expect(screen.getByText("3 corners placed")).toBeInTheDocument();

    fireEvent.pointerMove(canvas, at(5010, 5010));
    expect(readout()).toHaveTextContent("snaps to point p1 at x 5000, y 5000 mm · click to close");
    fireEvent.pointerDown(canvas, at(5010, 5010));
    fireEvent.pointerUp(canvas, at(5010, 5010));

    const saved = await savedPlan(calls);
    expect(saved.rooms[1]?.point_ids).toEqual(["p1", "p2", "p3"]);
    expect(saved.points).toMatchObject({
      p1: { x_mm: 5000, y_mm: 5000 },
      p2: { x_mm: 8000, y_mm: 5000 },
      p3: { x_mm: 8000, y_mm: 7500 },
    });
  });

  it("slides a whole wall perpendicular to itself in one undo step", async () => {
    stubSvgGeometry();
    const calls = stubApi();
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });
    fireEvent.click(screen.getByRole("button", { name: /Edit rooms/ }));
    fireEvent.pointerDown(container.querySelector(".trace-room polygon") as Element, { button: 0 });
    const canvas = container.querySelector("svg.trace-canvas") as Element;
    const drag = () => {
      fireEvent.pointerDown(container.querySelectorAll(".trace-wall-grab")[0] as Element, at(1750, 0, { pointerId: 2 }));
      fireEvent.pointerMove(canvas, at(1760, -20, { pointerId: 2 }));
      expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled();
      fireEvent.pointerMove(canvas, at(2150, -503, { pointerId: 2 }));
      fireEvent.pointerUp(canvas, at(2150, -503, { pointerId: 2 }));
    };

    drag();
    await waitFor(() => expect(screen.getByRole("button", { name: /Save plan source/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled());

    fireEvent.pointerDown(container.querySelector(".trace-room polygon") as Element, { button: 0 });
    drag();
    const saved = await savedPlan(calls);
    expect(saved.points).toMatchObject({
      a: { x_mm: 0, y_mm: -500 },
      b: { x_mm: 3500, y_mm: -500 },
      c: { x_mm: 3500, y_mm: 3000 },
      d: { x_mm: 0, y_mm: 3000 },
    });
  });
});

describe("keyboard editing", () => {
  const window1 = {
    id: "window_1",
    name: "Window 1",
    kind: "window",
    host_edge: ["a", "b"],
    offset_mm: 200,
    width_mm: 1000,
    sill_height_mm: 900,
    height_mm: 1200,
    room_ids: ["living"],
    exposure: "exterior",
    geometry_evidence: "pdf_trace",
    height_evidence: "pdf_trace",
    glazing_fraction: 0.8,
  };
  const underlay = {
    file_name: "plan.png",
    sha256: "sha256:png",
    width_px: 400,
    height_px: 300,
    mm_per_px: 10,
    origin_px: { x: 0, y: 300 },
    rotation_deg: 0,
    opacity: 0.55,
    evidence: "pdf_trace",
  };
  const key = (key: string, extra: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key, ...extra });

  async function selectCornerB(overrides: Partial<Record<string, unknown>> = {}) {
    stubSvgGeometry();
    const calls = stubApi(overrides);
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });
    await pickCornerB(container);
    return { calls, container };
  }

  async function pickCornerB(container: HTMLElement) {
    fireEvent.pointerDown(container.querySelector(".trace-room polygon") as Element, { button: 0 });
    const canvas = container.querySelector("svg.trace-canvas") as Element;
    fireEvent.pointerDown(canvas, at(3500, 0));
    fireEvent.pointerUp(canvas, at(3500, 0));
    await screen.findByRole("toolbar", { name: "Point b" });
  }

  it("moves a selected point 10 mm per arrow and 100 mm with Shift", async () => {
    const { calls, container } = await selectCornerB();
    const remove = within(screen.getByRole("toolbar", { name: "Point b" })).getByRole("button", { name: "Delete" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", "This point is used by a room, control, or opening");

    key("ArrowUp");
    key("z", { ctrlKey: true });
    expect(screen.getByRole("button", { name: /Redo/ })).toBeEnabled();
    await pickCornerB(container);
    key("ArrowUp");
    expect(screen.getByRole("button", { name: /Redo/ })).toBeDisabled();
    key("ArrowLeft", { shiftKey: true });
    const saved = await savedPlan(calls);
    expect(saved.points.b).toMatchObject({ x_mm: 3400, y_mm: 10 });
  });

  it("redoes an undone nudge to the exact coordinates, and a new edit clears redo", async () => {
    const { calls } = await selectCornerB();
    const save = () => screen.getByRole("button", { name: /Save plan source/ });
    const redo = () => screen.getByRole("button", { name: /Redo/ });
    expect(redo()).toBeDisabled();
    key("ArrowRight");
    key("z", { ctrlKey: true });
    await waitFor(() => expect(save()).toBeDisabled());
    expect(redo()).toBeEnabled();
    key("Z", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(save()).toBeEnabled());
    key("z", { metaKey: true });
    key("y", { ctrlKey: true });
    expect(redo()).toBeDisabled();

    const saved = await savedPlan(calls);
    expect(saved.points.b).toEqual({ x_mm: 3510, y_mm: 0, evidence: "pdf_trace" });
  });

  it("leaves Ctrl+Z to a focused text field", async () => {
    await selectCornerB();
    key("ArrowRight");
    const field = within(screen.getByRole("complementary")).getAllByRole("spinbutton")[0] as HTMLElement;
    fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    expect(screen.getByRole("button", { name: /Save plan source/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Redo/ })).toBeDisabled();
  });

  it("slides a selected opening 10 mm along its wall", async () => {
    stubSvgGeometry();
    const calls = stubApi({ trace: { ...trace, document: { ...document, apertures: [window1] } } });
    const { container } = render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });
    fireEvent.pointerDown(container.querySelector(".trace-aperture") as Element, at(700, 0));
    fireEvent.pointerUp(container.querySelector("svg.trace-canvas") as Element, at(700, 0));
    const toolbar = await screen.findByRole("toolbar", { name: "Opening window_1" });
    expect(within(toolbar).getByRole("spinbutton", { name: "Width in millimetres" })).toHaveValue(1000);

    key("ArrowUp");
    key("ArrowRight");
    const saved = await savedPlan(calls);
    expect((saved.apertures as Array<{ offset_mm?: number }>)[0]?.offset_mm).toBe(210);
  });

  it("hides the underlay with U without changing the plan source", async () => {
    const withUnderlay = { ...trace, underlay_url: "/api/trace/underlay/file", document: { ...document, underlay } };
    const { calls, container } = await selectCornerB({ trace: withUnderlay });
    const toggle = screen.getByRole("button", { name: "Show underlay" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".trace-canvas image")).not.toBeNull();

    key("u");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".trace-canvas image")).toBeNull();
    expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled();

    key("ArrowRight");
    const saved = await savedPlan(calls);
    expect((saved as { underlay?: unknown }).underlay).toEqual(underlay);
  });

  it("saves once with Ctrl+S and keeps the browser's save dialog away", async () => {
    const { calls } = await selectCornerB();
    key("ArrowRight");
    expect(key("s", { ctrlKey: true })).toBe(false);
    await waitFor(() => expect(screen.getByRole("button", { name: /Save plan source/ })).toBeDisabled());
    key("s", { ctrlKey: true });
    expect(calls.filter((call) => call.url === "/api/trace/save")).toHaveLength(1);
  });

  it("switches tasks by letter and lists every shortcut behind ?", async () => {
    stubApi();
    render(<TraceWorkspace onModelRebuilt={async () => undefined} />);
    await screen.findByRole("heading", { level: 1, name: "Test home" });

    key("r");
    expect(screen.getByRole("button", { name: /Draw a room/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Draw a room/ })).toHaveAttribute("title", "Draw a room (R)");

    key("?");
    const dialog = screen.getByRole("dialog", { name: "Shortcuts and gestures" });
    expect(within(dialog).getByRole("row", { name: "Ctrl+S or Cmd+S Save the plan source" })).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: "U Hide or show the reference underlay; view only, never saved" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("row")).toHaveLength(26);
    key("Escape");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Draw a room/ })).toHaveAttribute("aria-pressed", "true");
  });
});
