import { describe, expect, it } from "vitest";

import {
  alignmentSnap,
  availableInteriorPoint,
  beamFootprint,
  beamFootprintRadiusMm,
  calibrateUnderlay,
  deepestInteriorPoint,
  edgeDistance,
  illuminanceCells,
  insertionIndex,
  luxColour,
  millimetresPerPixel,
  northBearingInPlan,
  offsetAlongEdge,
  planViewBox,
  resolveDrag,
  screenY,
  snapRadii,
  snapToGeometry,
  underlayTransform,
  wallBand,
} from "./plan";
import { PlanUnderlaySchema, RecessedSpotlightSchema, type IlluminanceGrid } from "./types";

const fixture = RecessedSpotlightSchema.parse({
  kind: "recessed_spotlight",
  tag: "SP01",
  room_id: "ROOM",
  point: { x: 2000, y: 2000, z: 2700 },
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

describe("plan frame", () => {
  it("puts plan up on screen up", () => {
    expect(screenY(1500)).toBe(-1500);
    expect(planViewBox({ minX: 0, minY: 0, maxX: 4000, maxY: 3000, width: 4000, height: 3000 }, 500)).toBe(
      "-500 -3500 5000 4000",
    );
  });
});

describe("beam footprints", () => {
  it("keeps a downlight circular", () => {
    const footprint = beamFootprint(fixture, 800);
    expect(footprint.tilted).toBe(false);
    expect(footprint.radiusMm).toBeCloseTo(1900 * Math.tan((36 * Math.PI) / 360));
    expect(footprint.radiusMm).toBeCloseTo(beamFootprintRadiusMm(fixture, 800));
    expect(footprint.centre).toEqual({ x: 2000, y: 2000 });
  });

  it("offsets the footprint of an aimed fixture towards its aim", () => {
    const aimed = beamFootprint({ ...fixture, direction: { x: -1, y: 0, z: -1 } }, 800);
    expect(aimed.tilted).toBe(true);
    expect(aimed.outline.length).toBeGreaterThan(8);
    expect(aimed.centre.x).toBeLessThan(fixture.point.x - 500);
    expect(aimed.centre.y).toBeCloseTo(fixture.point.y, 6);
  });

  it("reports nothing for a fixture aimed away from the plane", () => {
    expect(beamFootprint({ ...fixture, direction: { x: 0, y: 0, z: 1 } }, 800).radiusMm).toBe(0);
    expect(beamFootprint(fixture, 2700).radiusMm).toBe(0);
  });
});

describe("new fixture placement", () => {
  it("stays inside a concave outline where the bounding-box centre would not", () => {
    const lShape = [
      { x: 0, y: 0 },
      { x: 6000, y: 0 },
      { x: 6000, y: 1500 },
      { x: 1500, y: 1500 },
      { x: 1500, y: 6000 },
      { x: 0, y: 6000 },
    ];
    const seat = deepestInteriorPoint(lShape);
    // The bounding-box centre (3000, 3000) is outside this outline.
    expect(seat.x < 1500 || seat.y < 1500).toBe(true);
    expect(seat.x % 10).toBe(0);
    expect(seat.y % 10).toBe(0);
  });

  it("finds a distinct default seat for a second fixture", () => {
    const ring = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }];
    const first = deepestInteriorPoint(ring);
    const second = availableInteriorPoint(ring, [first], 900, 500);

    expect(edgeDistance(second, ring)).toBeGreaterThanOrEqual(500);
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThanOrEqual(900);
  });
});

describe("illuminance rendering", () => {
  const grid: IlluminanceGrid = {
    samples: [
      { point: { x: 0, y: 0, z: 800 }, lux: 0, method: "lumen_beam_cone_v1" },
      { point: { x: 500, y: 0, z: 800 }, lux: 120, method: "lumen_beam_cone_v1" },
      { point: { x: 1000, y: 0, z: 800 }, lux: 240, method: "lumen_beam_cone_v1" },
    ],
    plane_elevation_mm: 800,
    step_mm: 500,
    threshold_lux: 180,
    maximum_lux: 240,
    mean_lux: 120,
    covered_fraction: 1 / 3,
    maintenance_factor: 1,
    method: "lumen_beam_cone_v1",
  };

  it("maps every sample to a square cell with a normalised intensity", () => {
    const cells = illuminanceCells(grid);
    expect(cells).toHaveLength(3);
    expect(cells.map((cell) => cell.sizeMm)).toEqual([500, 500, 500]);
    expect(cells.map((cell) => Number(cell.intensity.toFixed(2)))).toEqual([0, 0.5, 1]);
    expect(illuminanceCells(null)).toEqual([]);
  });

  it("brightens monotonically along the ramp", () => {
    const lightness = (colour: string) => Number(/([\d.]+)%\)$/.exec(colour)?.[1] ?? 0);
    expect(lightness(luxColour(1))).toBeGreaterThan(lightness(luxColour(0.5)));
    expect(lightness(luxColour(0.5))).toBeGreaterThan(lightness(luxColour(0)));
  });
});

describe("underlay calibration", () => {
  const underlay = PlanUnderlaySchema.parse({
    file_name: "m1-underlay.png",
    sha256: "sha256:0",
    width_px: 1000,
    height_px: 800,
    mm_per_px: 10,
    origin_px: { x: 100, y: 700 },
    rotation_deg: 0,
    opacity: 0.5,
    evidence: "pdf_trace",
  });

  it("maps the calibrated origin to the plan origin and inverts cleanly", () => {
    const transform = underlayTransform(underlay);
    expect(transform.toPlan({ x: 100, y: 700 })).toEqual({ x: 0, y: 0 });
    // Image y points down, so a pixel above the origin is at positive plan y.
    expect(transform.toPlan({ x: 200, y: 600 })).toEqual({ x: 1000, y: 1000 });
    const round = transform.toPixel(transform.toPlan({ x: 640, y: 320 }));
    expect(round.x).toBeCloseTo(640, 6);
    expect(round.y).toBeCloseTo(320, 6);
  });

  it("derives the scale from a printed dimension and squares the drawing", () => {
    const result = calibrateUnderlay({ x: 0, y: 0 }, { x: 350, y: 0 }, 3500, "x");
    expect(result?.mm_per_px).toBeCloseTo(10);
    expect(result?.rotation_deg).toBeCloseTo(0);

    const skewed = calibrateUnderlay({ x: 0, y: 0 }, { x: 100, y: -100 }, 1414.2, "x");
    expect(skewed?.rotation_deg).toBeCloseTo(-45, 1);

    expect(calibrateUnderlay({ x: 0, y: 0 }, { x: 0, y: 0 }, 1000, null)).toBeNull();
    expect(calibrateUnderlay({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, null)).toBeNull();
  });
});

describe("north bearing", () => {
  it("mirrors the site bearing into the plan frame", () => {
    expect(northBearingInPlan(0)).toBe(0);
    expect(northBearingInPlan(30)).toBe(330);
    expect(northBearingInPlan(-30)).toBe(30);
  });
});


describe("grab targets at any zoom", () => {
  it("measures a pixel against the letterboxed axis", () => {
    // A 24 m by 15 m view in a 1000 by 800 canvas letterboxes on width.
    expect(millimetresPerPixel(24000, 15000, 1000, 800)).toBeCloseTo(24);
    expect(millimetresPerPixel(15000, 24000, 1000, 800)).toBeCloseTo(30);
  });

  it("survives a canvas that has not been measured yet", () => {
    // This is the case that produced a 369 metre grab radius: the callback ref
    // had not fired, so the canvas was one pixel wide.
    const unmeasured = millimetresPerPixel(24000, 15000, 0, 0);
    expect(Number.isFinite(unmeasured)).toBe(true);
    expect(snapRadii(unmeasured).pick).toBeLessThanOrEqual(800);
    expect(snapRadii(unmeasured).drag).toBeLessThanOrEqual(250);
  });

  it("keeps a usable grab radius across the whole zoom range", () => {
    for (const viewWidth of [1000, 5000, 24000, 120000]) {
      const { pick, drag } = snapRadii(millimetresPerPixel(viewWidth, viewWidth, 1000, 1000));
      expect(pick).toBeGreaterThanOrEqual(120);
      expect(pick).toBeLessThanOrEqual(800);
      expect(drag).toBeLessThan(pick);
    }
  });

  it("snaps a drag more tightly than a pick", () => {
    const { pick, drag } = snapRadii(millimetresPerPixel(24000, 15000, 1000, 800));
    expect(drag).toBeLessThan(pick);
    expect(drag).toBeLessThanOrEqual(250);
  });
});

describe("snapping while tracing", () => {
  const points = [{ id: "a", at: { x: 0, y: 0 } }, { id: "b", at: { x: 3000, y: 0 } }];
  const segments = [[{ x: 0, y: 0 }, { x: 3000, y: 0 }] as const];

  it("prefers a traced point over the line it sits on", () => {
    const result = snapToGeometry({ x: 60, y: 40 }, points, segments, 200, 200, 10);
    expect(result.pointId).toBe("a");
    expect(result.point).toEqual({ x: 0, y: 0 });
  });

  it("slides onto a wall when no corner is near", () => {
    const result = snapToGeometry({ x: 1500, y: 70 }, points, segments, 200, 200, 10);
    expect(result.pointId).toBeNull();
    expect(result.onLine).toBe(true);
    expect(result.point.y).toBe(0);
    expect(result.point.x).toBeCloseTo(1500);
  });

  it("falls back to the grid in open space", () => {
    const result = snapToGeometry({ x: 1504, y: 900 }, points, segments, 200, 200, 10);
    expect(result.onLine).toBe(false);
    expect(result.point).toEqual({ x: 1500, y: 900 });
  });
});

describe("dragging an opening along its wall", () => {
  const start = { x: 0, y: 0 };
  const end = { x: 3000, y: 0 };

  it("centres the opening on the pointer", () => {
    expect(offsetAlongEdge(start, end, { x: 1500, y: 0 }, 900)).toBe(1050);
  });

  it("cannot run off either end", () => {
    expect(offsetAlongEdge(start, end, { x: -500, y: 0 }, 900)).toBe(0);
    expect(offsetAlongEdge(start, end, { x: 4000, y: 0 }, 900)).toBe(2100);
  });

  it("works on a diagonal wall", () => {
    const diagonal = { x: 3000, y: 3000 };
    const offset = offsetAlongEdge(start, diagonal, { x: 1500, y: 1500 }, 1000);
    // Offsets snap to 5 mm, so compare against the snapped ideal.
    const ideal = Math.hypot(3000, 3000) / 2 - 500;
    expect(offset).toBe(Math.round(ideal / 5) * 5);
  });
});

describe("inserting a point into an outline", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
    { x: 0, y: 1000 },
  ];

  it("inserts on the nearest edge, not at the end", () => {
    // Near the first edge, so the new vertex belongs at index 1.
    expect(insertionIndex(square, { x: 500, y: 20 })).toBe(1);
    // Near the third edge.
    expect(insertionIndex(square, { x: 500, y: 980 })).toBe(3);
  });

  it("keeps the outline simple wherever the click lands", () => {
    // Points exactly on an edge, which is where a snapped click lands.
    for (const at of [{ x: 0, y: 500 }, { x: 1000, y: 500 }, { x: 500, y: 0 }]) {
      const at_index = insertionIndex(square, at);
      const grown = [...square.slice(0, at_index), at, ...square.slice(at_index)];
      // A simple square plus a point on one of its edges stays convex-ish: the
      // signed area must not collapse or flip.
      const area = grown.reduce((sum, p, i) => {
        const q = grown[(i + 1) % grown.length]!;
        return sum + (p.x * q.y - q.x * p.y);
      }, 0) / 2;
      expect(area).toBeCloseTo(1_000_000, -3);
    }
  });
});

describe("grabbing an opening does not move it", () => {
  const start = { x: 0, y: 0 };
  const end = { x: 3000, y: 0 };

  it("keeps the opening where it was when the grab offset is carried", () => {
    // Grabbed near the left end of an opening that starts at 1050.
    const grabbed = { x: 1200, y: 0 };
    const pointerOffset = offsetAlongEdge(start, end, grabbed, 900, 1);
    const grabOffset = 1050 - pointerOffset;
    // Releasing without moving must reproduce the original offset.
    expect(offsetAlongEdge(start, end, grabbed, 900, 5, grabOffset)).toBe(1050);
  });

  it("moves by the pointer delta, not to the pointer", () => {
    const grabbed = { x: 1200, y: 0 };
    const grabOffset = 1050 - offsetAlongEdge(start, end, grabbed, 900, 1);
    const moved = offsetAlongEdge(start, end, { x: 1500, y: 0 }, 900, 5, grabOffset);
    expect(moved).toBe(1350);
  });
});

describe("wallBand", () => {
  it("lays the band behind the face, never into the room", () => {
    const band = wallBand({
      start: { x: 0, y: 0 },
      end: { x: 3000, y: 0 },
      inward_normal: { x: 0, y: 1 },
      thickness_mm: 150,
    });
    expect(band).toEqual([
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: -150 },
      { x: 0, y: -150 },
    ]);
  });
});

describe("alignmentSnap", () => {
  const mark = (tag: string, x: number, y: number) => ({ tag, at: { x, y } });

  it("pulls a dragged light onto a neighbour's column and reports the line", () => {
    const snap = alignmentSnap([mark("SP03", 1012, 400)], [mark("SP01", 1000, 2400)], 60);
    expect(snap.dx).toBe(-12);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toEqual([
      { axis: "column", atMm: 1000, fromMm: 400, toMm: 2400, tags: ["SP03", "SP01"] },
    ]);
  });

  it("resolves each axis on its own, so a light can take a column and keep its row", () => {
    const snap = alignmentSnap(
      [mark("SP03", 1012, 400)],
      [mark("SP01", 1000, 2400), mark("SP02", 3000, 3000)],
      60,
    );
    expect(snap.dx).toBe(-12);
    expect(snap.dy).toBe(0);
    expect(snap.guides.map((guide) => guide.axis)).toEqual(["column"]);
  });

  it("leaves a light that is somewhere else on purpose alone", () => {
    const snap = alignmentSnap([mark("SP03", 1800, 400)], [mark("SP01", 1000, 2400)], 60);
    expect(snap).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("moves a whole selection by one offset, so their spacing survives", () => {
    const snap = alignmentSnap(
      [mark("SP03", 1012, 400), mark("SP04", 2012, 400)],
      [mark("SP01", 1000, 2400)],
      60,
    );
    expect(snap.dx).toBe(-12);
    expect(snap.guides.map((guide) => guide.tags)).toEqual([["SP03", "SP01"]]);
  });

  it("spans a guide across every light that shares the axis", () => {
    const snap = alignmentSnap(
      [mark("SP03", 1000, 400)],
      [mark("SP01", 1000, 2400), mark("SP02", 1000, 5000)],
      60,
    );
    expect(snap.guides).toEqual([
      { axis: "column", atMm: 1000, fromMm: 400, toMm: 5000, tags: ["SP03", "SP01", "SP02"] },
    ]);
  });

  it("has nothing to line up against when nothing else is placed", () => {
    expect(alignmentSnap([mark("SP01", 10, 10)], [], 60).guides).toEqual([]);
  });
});

describe("resolveDrag", () => {
  const origins = new Map([
    ["SP01", { x: 1000, y: 1000, z: 2700 }],
    ["SP02", { x: 1800, y: 1000, z: 2700 }],
  ]);

  it("snaps the grabbed spotlight to the grid and carries the rest by the same offset", () => {
    const { moves } = resolveDrag(origins, "SP01", { x: 260, y: 0 }, [], 250, 0);
    expect(moves).toEqual([
      { tag: "SP01", point: { x: 1250, y: 1000, z: 2700 } },
      { tag: "SP02", point: { x: 2050, y: 1000, z: 2700 } },
    ]);
  });

  it("keeps each spotlight's own elevation", () => {
    const mixed = new Map([
      ["SP01", { x: 0, y: 0, z: 2700 }],
      ["SP02", { x: 500, y: 0, z: 2400 }],
    ]);
    const { moves } = resolveDrag(mixed, "SP01", { x: 100, y: 0 }, [], 100, 0);
    expect(moves.map((move) => move.point.z)).toEqual([2700, 2400]);
  });

  it("reaches half a grid step to catch a neighbour the grid cannot land on", () => {
    const still = [{ tag: "SP09", at: { x: 1337, y: 4000 } }];
    const { moves, guides } = resolveDrag(origins, "SP01", { x: 300, y: 0 }, still, 250, 0);
    expect(moves[0]?.point.x).toBe(1337);
    expect(guides.map((guide) => guide.atMm)).toEqual([1337]);
  });

  it("leaves the grid alone when nothing is near enough to line up with", () => {
    const still = [{ tag: "SP09", at: { x: 4000, y: 4000 } }];
    const { moves, guides } = resolveDrag(origins, "SP01", { x: 300, y: 0 }, still, 250, 0);
    expect(moves[0]?.point.x).toBe(1250);
    expect(guides).toEqual([]);
  });

  it("reports nothing when the grabbed tag is not in the set", () => {
    expect(resolveDrag(origins, "SP99", { x: 100, y: 0 }, [], 250, 0)).toEqual({ moves: [], guides: [] });
  });
});
