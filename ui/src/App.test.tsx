import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { render } from "./test/render";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const roomA = {
  id: "room-a",
  name: "Room A",
  storey_id: "storey",
  elevation_mm: 0,
  bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 3500, y: 3500, z: 2700 } },
};

const roomB = {
  ...roomA,
  id: "room-b",
  name: "Room B",
  bounds: { minimum: { x: 4000, y: 0, z: 0 }, maximum: { x: 7500, y: 3500, z: 2700 } },
};

const analysis = {
  validation: { findings: [] },
  dark_zones: [],
  illuminance: {
    samples: [{ point: { x: 1000, y: 1000, z: 800 }, lux: 210, method: "lumen_beam_cone_v1" }],
    plane_elevation_mm: 800,
    step_mm: 500,
    threshold_lux: 180,
    maximum_lux: 210,
    mean_lux: 210,
    covered_fraction: 1,
    method: "lumen_beam_cone_v1",
  },
  method: "lumen_beam_cone_v1",
  exclusions: ["daylight"],
};

const unlocatedSite = {
  site: {
    id: "site",
    name: "Unstated site",
    latitude_deg: null,
    longitude_deg: null,
    elevation_mm: 0,
    true_north_deg: 0,
    timezone: null,
    evidence: "unstated",
  },
};

function design(room: typeof roomA) {
  const { minimum, maximum } = room.bounds;
  return {
    revision: "sha256:test",
    room,
    ceiling: {
      room_id: room.id,
      polygon: {
        outer: [
          { x: minimum.x, y: minimum.y },
          { x: maximum.x, y: minimum.y },
          { x: maximum.x, y: maximum.y },
          { x: minimum.x, y: maximum.y },
        ],
        holes: [],
      },
      elevation_mm: maximum.z,
      source: "test",
    },
    walls: [],
    openings: [],
    daylight_sources: [],
    furniture: [],
    obstructions: [],
    fixtures: [],
    analysis,
    constraints: {
      wall_clearance_mm: 500,
      minimum_spacing_mm: 900,
      obstruction_clearance_mm: 250,
      shadow_gap_clearance_mm: 200,
      alignment_tolerance_mm: 50,
      collision_tolerance_mm: 10,
      target_lux: 150,
      task_plane_height_mm: 800,
      utilization_factor: 0.6,
      grid_step_mm: 500,
      avoid_object_kinds: [],
    },
  };
}

const project = {
  building: {
    id: "building",
    name: "Test house",
    schema: "IFC4",
    units: "mm",
    origin: { x: 0, y: 0, z: 0 },
    axes: "+X east, +Y north, +Z up",
    revision: "sha256:test",
  },
  storeys: [{ id: "storey", name: "Ground", elevation_mm: 0 }],
  rooms: [roomA, roomB],
  model_path: "model/test.ifc",
};

afterEach(() => {
  vi.unstubAllGlobals();
  // The app writes its view into the address bar, which jsdom keeps between tests.
  window.history.replaceState(null, "", "/");
});

describe("App room loading", () => {
  it("ignores an older design response after the room changes", async () => {
    const oldDesign = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/project") return Promise.resolve(jsonResponse(project));
      if (url === "/api/site") return Promise.resolve(jsonResponse(unlocatedSite));
      if (url.endsWith("/room-a/design")) return oldDesign.promise;
      if (url.endsWith("/room-b/design")) return Promise.resolve(jsonResponse(design(roomB)));
      if (url.endsWith("/analysis")) return Promise.resolve(jsonResponse({ analysis }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Room B/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Room B" })).toBeInTheDocument();

    await act(async () => {
      oldDesign.resolve(jsonResponse(design(roomA)));
      await oldDesign.promise;
    });

    expect(screen.getByRole("heading", { level: 1, name: "Room B" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Room A" })).not.toBeInTheDocument();
  });

  it("loads level geometry when the selected room contains a lower landing", async () => {
    const parent = {
      ...roomA,
      elevation_mm: 1050,
      bounds: { minimum: { x: 0, y: 0, z: 1050 }, maximum: { x: 3500, y: 3500, z: 3650 } },
    };
    const landing = {
      ...roomB,
      id: "landing",
      name: "Entrance landing",
      elevation_mm: 0,
      part_of: parent.id,
      bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 1200, y: 1400, z: 3650 } },
    };
    const parentDesign = design(parent);
    const roomGeometry = (room: typeof parent | typeof landing) => {
      const value = design(room);
      return {
        room: value.room,
        ceiling: value.ceiling,
        walls: value.walls,
        openings: value.openings,
        daylight_sources: value.daylight_sources,
        stairs: [],
        soffits: [],
        furniture: value.furniture,
        obstructions: value.obstructions,
        fixtures: value.fixtures,
      };
    };
    const splitProject = { ...project, rooms: [parent, landing] };
    const splitPlan = {
      revision: "sha256:test",
      site: unlocatedSite.site,
      constraints: parentDesign.constraints,
      rooms: [roomGeometry(parent), roomGeometry(landing)],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/project") return Promise.resolve(jsonResponse(splitProject));
      if (url === "/api/site") return Promise.resolve(jsonResponse(unlocatedSite));
      if (url === "/api/plan") return Promise.resolve(jsonResponse(splitPlan));
      if (url.includes("/design")) return Promise.resolve(jsonResponse(parentDesign));
      if (url.includes("/analysis")) return Promise.resolve(jsonResponse({ analysis }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Room A" })).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/plan")).toBe(true);
    });
  });
});

describe("App view switching", () => {
  function stubApi() {
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/project") return Promise.resolve(jsonResponse(project));
      if (url === "/api/site") return Promise.resolve(jsonResponse(unlocatedSite));
      if (url === "/api/plan") {
        const roomGeometry = (room: typeof roomA) => {
          const value = design(room);
          return {
            room: value.room,
            ceiling: value.ceiling,
            walls: value.walls,
            openings: value.openings,
            daylight_sources: value.daylight_sources,
            stairs: [],
            soffits: [],
            furniture: value.furniture,
            obstructions: value.obstructions,
            fixtures: value.fixtures,
            switches: [],
          };
        };
        return Promise.resolve(jsonResponse({
          revision: "sha256:test",
          site: unlocatedSite.site,
          constraints: design(roomA).constraints,
          rooms: [roomGeometry(roomA), roomGeometry(roomB)],
        }));
      }
      if (url.includes("/design")) return Promise.resolve(jsonResponse(design(roomA)));
      if (url.includes("/analysis")) return Promise.resolve(jsonResponse({ analysis }));
      if (url === "/api/trace") return Promise.reject(new Error("trace unavailable in this test"));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("starts on the 2D plan and swaps to the 3D view on request", async () => {
    stubApi();
    render(<App />);

    expect(await screen.findByRole("img", { name: "Interactive top-down ceiling plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Room A" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3D" }));

    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Interactive top-down ceiling plan" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "3D" })).toHaveAttribute("aria-pressed", "true");
    // The legend describes the 2D plan only.
    expect(screen.queryByRole("button", { name: "Legend" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "2D" }));
    expect(await screen.findByRole("img", { name: "Interactive top-down ceiling plan" })).toBeInTheDocument();
  });

  it("renders the light-coverage layer only when the layer is enabled", async () => {
    stubApi();
    const { container } = render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });

    expect(container.querySelector(".coverage-layer")).toBeNull();
    // "Light" is now a stage; the layer toggle inside it is "Coverage".
    fireEvent.click(screen.getByRole("button", { name: "Coverage" }));
    await waitFor(() => expect(container.querySelector(".coverage-layer")).not.toBeNull());
    expect(screen.getByText(/lumen_beam_cone_v1/)).toBeInTheDocument();
  });

  it("shows only the controls that answer the stage's question", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });

    // The light stage owns the explicit luminaire and control placement tools.
    expect(screen.getByRole("button", { name: "Spot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pendant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rope" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sun patches" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save to IFC" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Daylight" }));
    expect(await screen.findByRole("button", { name: "Sun patches" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Spot" })).toBeNull();

    // Publishing is the only stage that offers to write the model.
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("button", { name: "Save to IFC" })).toBeInTheDocument();
  });

  it("starts an empty room with a room-scoped control group", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });

    fireEvent.click(screen.getByRole("button", { name: "Spot" }));

    expect(screen.getByRole("textbox", { name: "Switching group" })).toHaveValue("ROOM_A_MAIN");
  });

  it("offers the tracing workspace from the top bar", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });

    fireEvent.click(screen.getByRole("button", { name: "Trace plan" }));

    expect(await screen.findByText(/trace unavailable in this test/)).toBeInTheDocument();
  });

  it("deletes the selection with the Delete key, and undoes and redoes it", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Spot" }));
    expect(screen.getByRole("textbox", { name: "Switching group" })).toBeInTheDocument();

    // Typing in a field must not delete the light being edited.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Switching group" }), { key: "Delete" });
    expect(screen.getByRole("textbox", { name: "Switching group" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(screen.queryByRole("textbox", { name: "Switching group" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Switching group" })).toBeInTheDocument();
    expect(redo).toBeEnabled();

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("textbox", { name: "Switching group" })).toBeNull();
    expect(redo).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("textbox", { name: "Switching group" })).toBeInTheDocument();
    // A new edit forks the history, so there is nothing left to redo.
    fireEvent.click(screen.getByRole("button", { name: "Spot" }));
    expect(redo).toBeDisabled();
  });

  it("keeps the view, scope and room in the address bar", async () => {
    stubApi();
    window.history.replaceState(null, "", "/?room=room-b&cam=1,2,3,4,5,6");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Room A" })).toBeInTheDocument();
    // The shared design stub always answers Room A; the room chosen is Room B.
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("room")).toBe("room-b"));
    // Loading the linked room keeps the linked camera.
    expect(new URLSearchParams(window.location.search).get("cam")).toBe("1,2,3,4,5,6");

    fireEvent.click(screen.getByRole("button", { name: "3D" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("view")).toBe("3d"));

    fireEvent.click(screen.getByRole("button", { name: /Whole floor/ }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("scope")).toBe("whole"));
    // A camera belongs to one room, so leaving it drops the camera.
    expect(new URLSearchParams(window.location.search).get("cam")).toBeNull();
  });

  it("turns each stage's own layer on when it opens and off when it closes", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });

    fireEvent.click(screen.getByRole("button", { name: "Daylight" }));
    expect(await screen.findByRole("button", { name: "Sun patches" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Site needed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Daylight" })).toHaveAttribute("aria-current", "step");

    fireEvent.click(screen.getByRole("button", { name: "Dark spots" }));
    expect(screen.getByRole("button", { name: "Dark zones" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Site needed")).toBeNull();
  });

  it("deselects with Escape, but not while a field has focus", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });
    fireEvent.click(screen.getByRole("button", { name: "Spot" }));
    const group = screen.getByRole("textbox", { name: "Switching group" });

    fireEvent.keyDown(group, { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "Switching group" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Switching group" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Select a mark on the plan" })).toBeInTheDocument();
  });

  it("shows the legend on request and keeps it out of the plan", async () => {
    stubApi();
    const { container } = render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });

    const toggle = screen.getByRole("button", { name: "Legend" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Cabinetry")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Cabinetry")).toBeInTheDocument();
    expect(container.querySelector(".plan-canvas .plan-legend")).toBeNull();
  });

  it("hides the room editing tools in the whole-floor view", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });
    await screen.findByRole("heading", { name: "Layout checks" });

    fireEvent.click(screen.getByRole("button", { name: /Whole floor/ }));
    expect(await screen.findByRole("img", { name: "Whole floor plan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add spotlight" })).toBeNull();
    expect(screen.queryByText("Select a mark on the plan")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Layout checks" })).toBeNull();
  });

  it("explains a room that fails to load, blocks adding to it, and retries", async () => {
    let failures = 1;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/project") return Promise.resolve(jsonResponse(project));
      if (url === "/api/site") return Promise.resolve(jsonResponse(unlocatedSite));
      if (url.includes("/design")) {
        if (failures > 0) {
          failures -= 1;
          return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
        }
        return Promise.resolve(jsonResponse(design(roomA)));
      }
      if (url.includes("/analysis")) return Promise.resolve(jsonResponse({ analysis }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText("This room could not be read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add spotlight" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Room A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add spotlight" })).toBeEnabled();
  });

  it("moves focus into the import dialog, closes it on cancel, and returns focus", async () => {
    stubApi();
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });
    const trigger = screen.getByRole("button", { name: "Replace IFC" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("button", { name: /Choose an IFC model/ })).toHaveFocus();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("reports warnings without blockers as a warning count, not as passed", async () => {
    const warned = {
      ...analysis,
      validation: { findings: [{ code: "switch_group_empty", severity: "warning", message: "SW09 switches nothing.", fixture_tags: ["SW09"], measured_mm: null, required_mm: null }] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/project") return Promise.resolve(jsonResponse(project));
      if (url === "/api/site") return Promise.resolve(jsonResponse(unlocatedSite));
      if (url.includes("/design")) return Promise.resolve(jsonResponse({ ...design(roomA), analysis: warned }));
      if (url.includes("/analysis")) return Promise.resolve(jsonResponse({ analysis: warned }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("No blockers · 1 warning")).toBeInTheDocument();
      expect(screen.getByText("Switch group empty")).toBeInTheDocument();
    });
    expect(screen.queryByText("Checks passed")).toBeNull();
  });

  it("re-reads the project after Save to IFC and saves next against the new revision", async () => {
    const before = "sha256:aaaaaaaa11111111";
    const after = "sha256:bbbbbbbb22222222";
    let revision = before;
    const commits: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/api/project") {
        return Promise.resolve(jsonResponse({ ...project, building: { ...project.building, revision } }));
      }
      if (url === "/api/site") return Promise.resolve(jsonResponse(unlocatedSite));
      if (url.endsWith("/room-a/design")) return Promise.resolve(jsonResponse({ ...design(roomA), revision }));
      if (url.endsWith("/analysis")) return Promise.resolve(jsonResponse({ analysis }));
      if (url.endsWith("/room-a/commit")) {
        commits.push(JSON.parse(String(init?.body)).expected_revision);
        revision = after;
        return Promise.resolve(jsonResponse({
          result: { revision: after, changed_ids: ["fixture-1"] },
          design: { ...design(roomA), revision: after },
        }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const requests = (path: string) => fetchMock.mock.calls.filter(([input]) => String(input).endsWith(path)).length;

    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });
    expect(screen.getByText("Rev aaaaaaaa")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const save = await screen.findByRole("button", { name: "Save to IFC" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    expect(await screen.findByText("Rev bbbbbbbb")).toBeInTheDocument();
    expect(screen.getByText("Saved 1 fixture changes to IFC.")).toBeInTheDocument();
    expect(requests("/api/project")).toBe(2);
    // The commit response already carries the design under the new revision.
    expect(requests("/room-a/design")).toBe(1);

    await waitFor(() => expect(screen.getByRole("button", { name: "Save to IFC" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save to IFC" }));
    await waitFor(() => expect(commits).toEqual([before, after]));
  });

  it("retries the whole floor without reloading the open room", async () => {
    let planFailures = 1;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/project") return Promise.resolve(jsonResponse(project));
      if (url === "/api/site") return Promise.resolve(jsonResponse(unlocatedSite));
      if (url === "/api/plan") {
        if (planFailures > 0) {
          planFailures -= 1;
          return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
        }
        return Promise.resolve(jsonResponse({
          revision: "sha256:test",
          site: unlocatedSite.site,
          constraints: design(roomA).constraints,
          rooms: [],
        }));
      }
      if (url.includes("/design")) return Promise.resolve(jsonResponse(design(roomA)));
      if (url.includes("/analysis")) return Promise.resolve(jsonResponse({ analysis }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });
    const designRequests = () => fetchMock.mock.calls.filter(([input]) => String(input).includes("/design")).length;
    const before = designRequests();

    fireEvent.click(screen.getByRole("button", { name: /Whole floor/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("The whole floor could not be read")).toBeNull());

    expect(designRequests()).toBe(before);
  });

  it("highlights a clicked room without leaving the whole-floor plan", async () => {
    stubApi();
    const { container } = render(<App />);
    await screen.findByRole("img", { name: "Interactive top-down ceiling plan" });

    fireEvent.click(screen.getByRole("button", { name: /Whole floor/ }));
    expect(await screen.findByRole("img", { name: "Whole floor plan" })).toBeInTheDocument();
    const rooms = container.querySelectorAll(".whole-room");
    expect(rooms).toHaveLength(2);
    fireEvent.click(rooms[1]!);

    expect(screen.getByRole("img", { name: "Whole floor plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "2 rooms" })).toBeInTheDocument();
    expect(rooms[1]).toHaveClass("whole-room--selected");
  });
});
