import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { beamFootprintRadiusMm, CeilingPlan } from "./CeilingPlan";
import { IlluminanceGridSchema, RecessedSpotlightSchema } from "./types";

const illuminance = IlluminanceGridSchema.parse({
  samples: [
    { point: { x: 500, y: 500, z: 800 }, lux: 40, method: "lumen_beam_cone_v1" },
    { point: { x: 1000, y: 500, z: 800 }, lux: 200, method: "lumen_beam_cone_v1" },
  ],
  plane_elevation_mm: 800,
  step_mm: 500,
  threshold_lux: 180,
  maximum_lux: 200,
  mean_lux: 120,
  covered_fraction: 0.5,
  method: "lumen_beam_cone_v1",
});

const fixture = RecessedSpotlightSchema.parse({
  kind: "recessed_spotlight",
  tag: "SP01",
  room_id: "ROOM01",
  point: { x: 1750, y: 1750, z: 2700 },
  spec: {
    model: null,
    lumens: 650,
    beam_angle_deg: 36,
    cct_kelvin: 3000,
    cri: 90,
    dimmable: true,
    diameter_mm: 82,
    cutout_diameter_mm: 68,
    mounting_depth_mm: 95,
    ies_path: null,
    peak_candela: null,
  },
  switching_group: "MAIN",
  direction: { x: 0, y: 0, z: -1 },
  notes: [],
});

describe("CeilingPlan", () => {
  it("renders a labelled geometric beam footprint at the task plane", () => {
    const expectedRadius = 1900 * Math.tan((36 * Math.PI) / 360);
    expect(beamFootprintRadiusMm(fixture, 800)).toBeCloseTo(expectedRadius);

    const { container } = render(
      <CeilingPlan
        polygon={{
          outer: [
            { x: 0, y: 0 },
            { x: 3500, y: 0 },
            { x: 3500, y: 3500 },
            { x: 0, y: 3500 },
          ],
          holes: [],
        }}
        walls={[
          {
            wall_id: "W1",
            start: { x: 0, y: 0 },
            end: { x: 3500, y: 0 },
            inward_normal: { x: 0, y: 1, z: 0 }, thickness_mm: 150,
          },
        ]}
        objects={[]}
        openings={[
          {
            id: "WINDOW01",
            name: "Garden window",
            kind: "window",
            room_ids: [fixture.room_id],
            host_wall_id: "W1",
            start: { x: 900, y: 0 },
            end: { x: 2600, y: 0 },
            sill_height_mm: 900,
            head_height_mm: 2100,
            exposure: "exterior",
            evidence: "pdf_trace",
          },
        ]}
        daylightSources={[
          {
            id: "SHAFT01",
            name: "Side ventilation",
            kind: "ventilation_shaft",
            footprint: {
              outer: [
                { x: 3500, y: 0 },
                { x: 3900, y: 0 },
                { x: 3900, y: 3500 },
                { x: 3500, y: 3500 },
              ],
              holes: [],
            },
            bounds: {
              minimum: { x: 3500, y: 0, z: 0 },
              maximum: { x: 3900, y: 3500, z: 2700 },
            },
            daylight_role: "possible",
            evidence: "pdf_trace",
          },
        ]}
        fixtures={[fixture]}
        darkZones={[]}
        taskPlaneElevationMm={800}
        selectedTags={new Set([fixture.tag])}
        showDarkZones={false}
        onSelect={() => undefined}
        onMove={() => undefined}
      />,
    );

    const beam = container.querySelector(".fixture-beam");
    expect(beam).not.toBeNull();
    expect(Number(beam?.getAttribute("r"))).toBeCloseTo(expectedRadius);
    expect(screen.getByText("3,500")).toBeInTheDocument();
    expect(screen.getByText("SP01 geometric beam footprint at Z 800 mm")).toBeInTheDocument();
    expect(screen.getByText(/^WINDOW 1,700$/)).toBeInTheDocument();
    expect(screen.getByText("Side ventilation · possible")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Garden window: 1,700 mm wide, 1,200 mm high; potential daylight, excluded from electric-light estimate",
      ),
    ).toBeInTheDocument();
  });

  it("renders the light coverage grid, glow, and direct-sun patches when asked", () => {
    const { container } = render(
      <CeilingPlan
        polygon={{
          outer: [
            { x: 0, y: 0 },
            { x: 3500, y: 0 },
            { x: 3500, y: 3500 },
            { x: 0, y: 3500 },
          ],
          holes: [],
        }}
        walls={[]}
        objects={[]}
        openings={[]}
        daylightSources={[]}
        fixtures={[fixture]}
        darkZones={[]}
        taskPlaneElevationMm={800}
        selectedTags={new Set()}
        showDarkZones={false}
        onSelect={() => undefined}
        onMove={() => undefined}
        showCoverage
        showLightRendering
        trueNorthDeg={30}
        sunAltitudeDeg={42}
        sunDirection={{ x: 0.5, y: -0.6, z: 0.62 }}
        illuminance={illuminance}
        sunPatches={[
          {
            opening_id: "WINDOW01",
            opening_name: "Garden window",
            opening_kind: "window",
            pieces: [
              {
                outer: [
                  { x: 900, y: 0 },
                  { x: 2600, y: 0 },
                  { x: 2600, y: 1400 },
                  { x: 900, y: 1400 },
                ],
                holes: [],
              },
            ],
            projected: {
              outer: [
                { x: 900, y: 0 },
                { x: 2600, y: 0 },
                { x: 2600, y: 1400 },
                { x: 900, y: 1400 },
              ],
              holes: [],
            },
            plane_elevation_mm: 0,
            area_m2: 2.38,
            projected_area_m2: 2.38,
            incidence_deg: 42,
            method: "direct_sun_patch_geometry_v1",
            clip_method: "ear_clip_triangulation_and_convex_clip_v1",
          },
        ]}
      />,
    );

    expect(container.querySelectorAll(".coverage-layer rect")).toHaveLength(2);
    expect(container.querySelector(".fixture-glow")).not.toBeNull();
    expect(container.querySelectorAll(".sun-patch")).toHaveLength(1);
    expect(container.querySelector(".sun-disc")).not.toBeNull();
    expect(
      screen.getByText(
        "Garden window direct-sun patch, 2.38 m² at Z 0 mm; geometry only",
      ),
    ).toBeInTheDocument();
  });

  it("hides the rendered layers by default", () => {
    const { container } = render(
      <CeilingPlan
        polygon={{
          outer: [
            { x: 0, y: 0 },
            { x: 3500, y: 0 },
            { x: 3500, y: 3500 },
            { x: 0, y: 3500 },
          ],
          holes: [],
        }}
        walls={[]}
        objects={[]}
        openings={[]}
        daylightSources={[]}
        fixtures={[fixture]}
        darkZones={[]}
        taskPlaneElevationMm={800}
        selectedTags={new Set()}
        showDarkZones={false}
        onSelect={() => undefined}
        onMove={() => undefined}
      />,
    );

    expect(container.querySelector(".coverage-layer")).toBeNull();
    expect(container.querySelector(".sun-patch")).toBeNull();
    expect(container.querySelector(".sun-disc")).toBeNull();
  });
});


describe("doorways", () => {
  const room = {
    outer: [
      { x: 0, y: 0 },
      { x: 3500, y: 0 },
      { x: 3500, y: 3500 },
      { x: 0, y: 3500 },
    ],
    holes: [],
  };

  function doorway(kind: "door" | "window") {
    return {
      id: `OPEN-${kind}`,
      name: kind === "door" ? "Bedroom door" : "Bedroom window",
      kind,
      host_wall_id: "W1",
      start: { x: 1000, y: 0 },
      end: { x: 1900, y: 0 },
      sill_height_mm: kind === "door" ? 0 : 900,
      head_height_mm: kind === "door" ? 2100 : 2100,
      exposure: kind === "door" ? "interior" : "exterior",
      evidence: "pdf_trace",
      room_ids: ["ROOM01"],
    };
  }

  function plan(kind: "door" | "window") {
    return render(
      <CeilingPlan
        polygon={room}
        walls={[]}
        objects={[]}
        openings={[doorway(kind)]}
        daylightSources={[]}
        fixtures={[]}
        darkZones={[]}
        taskPlaneElevationMm={800}
        selectedTags={new Set()}
        showDarkZones={false}
        onSelect={() => undefined}
        onMove={() => undefined}
      />,
    );
  }

  it("labels a doorway as a doorway, not as a window", () => {
    const { container } = plan("door");

    expect(screen.getByText(/^DOOR 900$/)).toBeInTheDocument();
    expect(screen.queryByText(/WINDOW/)).not.toBeInTheDocument();
    expect(container.querySelector(".plan-opening--door")).not.toBeNull();
    // A door leaf, so it reads as circulation rather than glazing.
    expect(container.querySelector(".plan-door-swing")).not.toBeNull();
  });

  it("does not call a doorway daylight", () => {
    plan("door");
    const title = screen.getByText(/Bedroom door/);
    expect(title.textContent).toContain("interior doorway");
    expect(title.textContent).not.toContain("daylight");
  });

  it("keeps glazing as daylight context and draws no leaf", () => {
    const { container } = plan("window");

    expect(screen.getByText(/^WINDOW 900$/)).toBeInTheDocument();
    expect(container.querySelector(".plan-door-swing")).toBeNull();
    expect(screen.getByText(/Bedroom window/).textContent).toContain("daylight");
  });
});

describe("spotlight snapping", () => {
  it("draws the grid a spotlight lands on", () => {
    const { container } = render(
      <CeilingPlan
        polygon={{
          outer: [
            { x: 0, y: 0 },
            { x: 3500, y: 0 },
            { x: 3500, y: 3500 },
            { x: 0, y: 3500 },
          ],
          holes: [],
        }}
        walls={[]}
        objects={[]}
        openings={[]}
        daylightSources={[]}
        fixtures={[fixture]}
        darkZones={[]}
        taskPlaneElevationMm={800}
        selectedTags={new Set()}
        showDarkZones={false}
        snapMm={250}
        onSelect={() => undefined}
        onMove={() => undefined}
      />,
    );
    const minor = container.querySelector("#minor-grid") as SVGPatternElement;
    expect(minor.getAttribute("width")).toBe("250");
    const major = container.querySelector("#major-grid") as SVGPatternElement;
    expect(major.getAttribute("width")).toBe("1250");
  });
});

/** jsdom has no SVG geometry, so the plan reads client pixels as millimetres. */
function stubSvgGeometry() {
  const proto = SVGSVGElement.prototype as unknown as Record<string, unknown>;
  proto.getScreenCTM = () => ({ inverse: () => ({}) });
  proto.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } });
  proto.setPointerCapture = () => undefined;
  proto.releasePointerCapture = () => undefined;
  (SVGElement.prototype as unknown as Record<string, unknown>).setPointerCapture = () => undefined;
  (SVGElement.prototype as unknown as Record<string, unknown>).releasePointerCapture = () => undefined;
}

function planWith(
  fixtures: ReadonlyArray<typeof fixture>,
  selectedTags: ReadonlySet<string>,
  handlers: {
    onSelect?: (tags: ReadonlySet<string>) => void;
    onMove?: (moves: ReadonlyArray<{ tag: string; point: { x: number; y: number; z: number } }>) => void;
  },
) {
  return render(
    <CeilingPlan
      polygon={{
        outer: [
          { x: 0, y: 0 },
          { x: 4000, y: 0 },
          { x: 4000, y: 4000 },
          { x: 0, y: 4000 },
        ],
        holes: [],
      }}
      walls={[]}
      objects={[]}
      openings={[]}
      daylightSources={[]}
      fixtures={fixtures as never}
      darkZones={[]}
      taskPlaneElevationMm={800}
      selectedTags={selectedTags as never}
      showDarkZones={false}
      snapMm={100}
      onSelect={(handlers.onSelect ?? (() => undefined)) as never}
      onMove={(handlers.onMove ?? (() => undefined)) as never}
    />,
  );
}

const second = { ...fixture, tag: "SP02" as typeof fixture.tag, point: { x: 2750, y: 1750, z: 2700 } };

describe("selecting several spotlights", () => {
  beforeEach(stubSvgGeometry);

  it("replaces the selection on a plain click", () => {
    const selections: Array<ReadonlyArray<string>> = [];
    const { container } = planWith([fixture, second], new Set(["SP01"]), {
      onSelect: (tags) => selections.push([...tags]),
    });
    const hits = [...container.querySelectorAll(".fixture-hit")] as Element[];
    fireEvent.pointerDown(hits[1] as Element, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    expect(selections).toEqual([["SP02"]]);
  });

  it("adds to the selection when shift is held, and drops one that was already in it", () => {
    const selections: Array<ReadonlyArray<string>> = [];
    const { container } = planWith([fixture, second], new Set(["SP01"]), {
      onSelect: (tags) => selections.push([...tags]),
    });
    const hits = [...container.querySelectorAll(".fixture-hit")] as Element[];
    fireEvent.pointerDown(hits[1] as Element, { button: 0, shiftKey: true, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerDown(hits[0] as Element, { button: 0, shiftKey: true, clientX: 0, clientY: 0, pointerId: 2 });
    expect(selections).toEqual([["SP01", "SP02"], []]);
  });

  it("moves the whole selection when one of its members is dragged", () => {
    const moves: Array<ReadonlyArray<{ tag: string; point: { x: number; y: number } }>> = [];
    const { container } = planWith([fixture, second], new Set(["SP01", "SP02"]), {
      onMove: (batch) => moves.push(batch.map((move) => ({ tag: move.tag, point: move.point }))),
    });
    const [hit] = [...container.querySelectorAll(".fixture-hit")] as Element[];
    fireEvent.pointerDown(hit as Element, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(hit as Element, { clientX: 300, clientY: 0, pointerId: 1 });
    expect(moves).toHaveLength(1);
    // The grid snaps where the grabbed light lands, not how far it travelled,
    // so an off-grid pair comes onto the grid keeping its 1,000 mm spacing.
    expect(moves[0]).toEqual([
      { tag: "SP01", point: { x: 2100, y: 1800, z: 2700 } },
      { tag: "SP02", point: { x: 3100, y: 1800, z: 2700 } },
    ]);
  });

  it("narrows a set to the one light that was clicked without dragging", () => {
    const selections: Array<ReadonlyArray<string>> = [];
    const { container } = planWith([fixture, second], new Set(["SP01", "SP02"]), {
      onSelect: (tags) => selections.push([...tags]),
    });
    const [hit] = [...container.querySelectorAll(".fixture-hit")] as Element[];
    fireEvent.pointerDown(hit as Element, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(hit as Element, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    expect(selections.at(-1)).toEqual(["SP01"]);
  });

  it("keeps the whole set when the press became a drag", () => {
    const selections: Array<ReadonlyArray<string>> = [];
    const { container } = planWith([fixture, second], new Set(["SP01", "SP02"]), {
      onSelect: (tags) => selections.push([...tags]),
    });
    const [hit] = [...container.querySelectorAll(".fixture-hit")] as Element[];
    fireEvent.pointerDown(hit as Element, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(hit as Element, { clientX: 300, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(hit as Element, { button: 0, clientX: 300, clientY: 0, pointerId: 1 });
    expect(selections.every((tags) => tags.length === 2)).toBe(true);
  });

  it("draws a dotted guide when a dragged spotlight takes a neighbour's row", () => {
    const off = { ...second, point: { x: 2750, y: 1600, z: 2700 } };
    const { container } = planWith([fixture, off], new Set(["SP02"]), {});
    const hit = [...container.querySelectorAll(".fixture-hit")][1] as Element;
    fireEvent.pointerDown(hit as Element, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(hit as Element, { clientX: 0, clientY: -100, pointerId: 1 });
    const guide = container.querySelector(".alignment-guide") as SVGLineElement;
    expect(guide).not.toBeNull();
    expect(guide.getAttribute("y1")).toBe(guide.getAttribute("y2"));
  });
});

const sensor = {
  tag: "PIR01",
  room_id: "ROOM-01",
  point: { x: 2000, y: 2000, z: 2700 },
  controls_tag: "EF01",
  run_on_minutes: 20,
  spec: { kind: "movement", diameter_mm: 70, cutout_diameter_mm: 60, mounting_depth_mm: 25 },
  notes: [],
  kind: "movement_sensor",
};

function planWithSensor(
  selectedTags: ReadonlySet<string>,
  handlers: {
    onMove?: (moves: ReadonlyArray<{ tag: string; point: { x: number; y: number; z: number } }>) => void;
    onMoveSensor?: (moves: ReadonlyArray<{ tag: string; point: { x: number; y: number; z: number } }>) => void;
  },
  fixtures: ReadonlyArray<typeof fixture> = [],
) {
  return render(
    <CeilingPlan
      polygon={{ outer: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }], holes: [] }}
      walls={[]}
      objects={[]}
      openings={[]}
      daylightSources={[]}
      fixtures={fixtures as never}
      sensors={[sensor] as never}
      darkZones={[]}
      taskPlaneElevationMm={800}
      selectedTags={selectedTags as never}
      showDarkZones={false}
      snapMm={100}
      onSelect={() => undefined}
      onMove={(handlers.onMove ?? (() => undefined)) as never}
      onMoveSensor={(handlers.onMoveSensor ?? (() => undefined)) as never}
    />,
  );
}

describe("a movement sensor on the ceiling plan", () => {
  beforeEach(stubSvgGeometry);

  it("draws as a sensor rather than a room object", () => {
    const { container } = planWithSensor(new Set(), {});
    expect(container.querySelector(".sensor-body")).not.toBeNull();
    expect(container.querySelectorAll(".sensor-wave")).toHaveLength(3);
    expect(container.querySelector(".plan-object")).toBeNull();
  });

  it("drags on the same snap grid as a spotlight, reporting every move", () => {
    const moves: Array<ReadonlyArray<{ tag: string; point: { x: number; y: number; z: number } }>> = [];
    const { container } = planWithSensor(new Set(["PIR01"]), { onMoveSensor: (batch) => moves.push(batch) });
    const hit = container.querySelector(".sensor-mark .fixture-hit") as Element;

    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(hit, { clientX: 340, clientY: -280, pointerId: 1 });
    fireEvent.pointerUp(hit, { button: 0, clientX: 340, clientY: -280, pointerId: 1 });

    expect(moves.at(-1)).toEqual([{ tag: "PIR01", point: { x: 2300, y: 2300, z: 2700 } }]);
    expect(moves.length).toBeGreaterThan(0);
  });

  it("draws an alignment guide when a dragged spotlight takes the sensor's row", () => {
    const offRow = { ...fixture, tag: "SP01" as typeof fixture.tag, point: { x: 3000, y: 1950, z: 2700 } };
    const { container } = planWithSensor(new Set(["SP01"]), {}, [offRow]);
    const hit = container.querySelector(".fixture .fixture-hit") as Element;

    fireEvent.pointerDown(hit, { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
    fireEvent.pointerMove(hit, { clientX: 0, clientY: -20, pointerId: 2 });

    const guide = container.querySelector(".alignment-guide") as SVGLineElement;
    expect(guide).not.toBeNull();
    expect(guide.getAttribute("y1")).toBe(guide.getAttribute("y2"));
  });
});

function box(minX: number, minY: number, maxX: number, maxY: number, minZ: number, maxZ: number) {
  return { minimum: { x: minX, y: minY, z: minZ }, maximum: { x: maxX, y: maxY, z: maxZ } };
}

const kitchen = [
  { id: "B1", ifc_class: "IfcFurniture", kind: "cabinet", name: "Sink base cabinet, running through", room_ids: [], bounds: box(0, 0, 1200, 600, 1050, 1920), properties: { Tag: "KIT-B1" } },
  { id: "U1", ifc_class: "IfcFurniture", kind: "cabinet", name: "Upper cabinet, long-term store", room_ids: [], bounds: box(0, 0, 1200, 600, 2960, 3450), properties: { Tag: "KIT-U1" } },
  { id: "HOB", ifc_class: "IfcFurniture", kind: "furniture", name: "Hob, Elica NikolaTesla Fit XL", room_ids: [], bounds: box(2000, 0, 2600, 500, 1700, 1950), properties: {} },
  { id: "DUCT", ifc_class: "IfcDuctSegment", kind: "duct", name: "Duct DUCT01", room_ids: [], bounds: box(2000, 3000, 3000, 3200, 3510, 3690), properties: { Tag: "DUCT01" } },
];

function roomPlan(props: Partial<Parameters<typeof CeilingPlan>[0]> = {}) {
  return render(
    <CeilingPlan
      polygon={{ outer: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }], holes: [] }}
      walls={[]}
      objects={[]}
      openings={[]}
      daylightSources={[]}
      fixtures={[]}
      darkZones={[]}
      taskPlaneElevationMm={800}
      selectedTags={new Set()}
      showDarkZones={false}
      onSelect={() => undefined}
      onMove={() => undefined}
      {...props}
    />,
  );
}

const labelTexts = (container: HTMLElement) =>
  [...container.querySelectorAll(".plan-labels text")].map((text) => text.textContent);

describe("plan labels", () => {
  it("labels by Tag, shortens a long name, and skips a cabinet stacked over another", () => {
    const { container } = roomPlan({ objects: kitchen as never });
    expect(labelTexts(container)).toEqual(["DUCT01", "Hob", "KIT-B1"]);
  });

  it("ghosts a service above the finished ceiling and leaves it unlabelled", () => {
    const { container } = roomPlan({ objects: kitchen as never, ceilingElevationMm: 3450 });
    expect(labelTexts(container)).toEqual(["Hob", "KIT-B1"]);
    const ghosts = [...container.querySelectorAll(".plan-object--above-ceiling")];
    expect(ghosts).toHaveLength(1);
    expect(screen.getByText("Duct DUCT01: above the finished ceiling, 3,510 to 3,690 mm")).toBeInTheDocument();
  });

  it("puts the labels of two close spotlights on opposite sides", () => {
    const near = { ...fixture, tag: "SP02" as typeof fixture.tag, point: { x: 1850, y: 1750, z: 2700 } };
    const { container } = roomPlan({ fixtures: [fixture, near] });
    const xs = Object.fromEntries(
      [...container.querySelectorAll(".plan-labels text")].map((text) => [text.textContent, Number(text.getAttribute("x"))]),
    );
    expect(xs.SP01).toBeLessThan(1750);
    expect(xs.SP02).toBeGreaterThan(1850);
  });

  it("draws a wall band on the room side it bounds", () => {
    const { container } = roomPlan({
      walls: [{ wall_id: "W1", start: { x: 0, y: 0 }, end: { x: 3500, y: 0 }, inward_normal: { x: 0, y: 1, z: 0 }, thickness_mm: 150 }],
    });
    expect(container.querySelector(".wall-body")?.getAttribute("points")).toBe("0,0 3500,0 3500,150 0,150");
  });
});

describe("plan marks from the keyboard", () => {
  it("selects a focused mark with Enter, and adds to the selection with shift and Space", () => {
    const selections: Array<ReadonlyArray<string>> = [];
    planWith([fixture, second], new Set(["SP01"]), { onSelect: (tags) => selections.push([...tags]) });
    const mark = screen.getByRole("button", { name: "SP02, spotlight" });
    expect(mark).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(mark, { key: "Enter" });
    fireEvent.keyDown(mark, { key: " ", shiftKey: true });
    expect(selections).toEqual([["SP02"], ["SP01", "SP02"]]);
  });

  it("narrows a selection to the mark a plain Enter activates, as a click does", () => {
    const selections: Array<ReadonlyArray<string>> = [];
    planWith([fixture, second], new Set(["SP01", "SP02"]), { onSelect: (tags) => selections.push([...tags]) });
    fireEvent.keyDown(screen.getByRole("button", { name: "SP01, spotlight" }), { key: "Enter" });
    expect(selections).toEqual([["SP01"]]);
  });
});

describe("plan tips", () => {
  beforeEach(() => window.localStorage.clear());

  it("stays hidden once dismissed, and comes back from the help button", () => {
    const first = roomPlan();
    fireEvent.click(screen.getByRole("button", { name: "Hide the plan tips" }));
    expect(window.localStorage.getItem("home-twin.hint.plan")).toBe("dismissed");
    first.unmount();

    roomPlan();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the plan tips" }));
    expect(screen.getByRole("note")).toHaveTextContent("Hold space to pan");
    expect(window.localStorage.getItem("home-twin.hint.plan")).toBeNull();
  });
});

describe("line sets", () => {
  it("draws each leg at its own enclosure's width", () => {
    const { container } = render(
      <CeilingPlan
        polygon={{ outer: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }], holes: [] }}
        walls={[]}
        objects={[
          {
            id: "ls",
            name: "Line set LS03C",
            ifc_class: "IfcPipeSegment",
            kind: "pipe",
            room_ids: ["yard"],
            bounds: { minimum: { x: 0, y: 0, z: 3400 }, maximum: { x: 3000, y: 150, z: 3550 } },
            properties: {
              "Pset_HomeTwinHvac.Role": "line_set",
              "Pset_HomeTwinHvac.RouteMm": "0,75,3475;1500,75,3475;3000,75,3475",
              "Pset_HomeTwinHvac.Legs": "gypsum_box;clipped",
            },
          } as never,
        ]}
        openings={[]}
        daylightSources={[]}
        fixtures={[]}
        darkZones={[]}
        taskPlaneElevationMm={800}
        selectedTags={new Set() as never}
        showDarkZones={false}
        snapMm={100}
        onSelect={() => undefined}
        onMove={() => undefined}
      />,
    );

    const widths = [...container.querySelectorAll("line.plan-object--route")].map((line) =>
      (line as SVGLineElement).style.strokeWidth,
    );
    expect(widths).toEqual(["150", "30"]);
  });
});
