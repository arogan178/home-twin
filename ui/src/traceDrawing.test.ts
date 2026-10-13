import { describe, expect, it } from "vitest";

import {
  describePreview,
  orthoLock,
  pointAtLength,
  rectangleCorners,
  snapOnAxis,
  wallOffset,
} from "./traceDrawing";

describe("orthoLock", () => {
  it("keeps the larger axis of the drag", () => {
    expect(orthoLock({ x: 100, y: 200 }, { x: 900, y: 260 })).toEqual({ x: 900, y: 200 });
    expect(orthoLock({ x: 100, y: 200 }, { x: 40, y: -700 })).toEqual({ x: 100, y: -700 });
  });
});

describe("snapOnAxis", () => {
  it("grid-snaps only the free coordinate", () => {
    expect(snapOnAxis({ x: 5000, y: 5003.4 }, { x: 6004, y: 5100 }, [], 120, 10)).toEqual({
      point: { x: 6000, y: 5003.4 },
      snap: "grid",
      pointId: null,
    });
  });

  it("lands on a traced point only when it lies on the locked axis", () => {
    const points = [
      { id: "on", at: { x: 3000, y: 0 } },
      { id: "off", at: { x: 3010, y: 50 } },
    ];
    expect(snapOnAxis({ x: 0, y: 0 }, { x: 3040, y: 60 }, points, 120, 10)).toEqual({
      point: { x: 3000, y: 0 },
      snap: "point",
      pointId: "on",
    });
    expect(snapOnAxis({ x: 0, y: 0 }, { x: 3040, y: 60 }, points.slice(1), 120, 10).snap).toBe("grid");
  });
});

describe("pointAtLength", () => {
  it("measures the typed length along the aim", () => {
    expect(pointAtLength({ x: 1000, y: 2000 }, { x: 1000, y: 2300 }, 3000)).toEqual({ x: 1000, y: 5000 });
    expect(pointAtLength({ x: 0, y: 0 }, { x: 3, y: 4 }, 1000)).toEqual({ x: 600, y: 800 });
  });

  it("has no answer without a direction", () => {
    expect(pointAtLength({ x: 5, y: 5 }, { x: 5, y: 5 }, 3000)).toBeNull();
  });
});

describe("rectangleCorners", () => {
  it("returns four anticlockwise corners from either diagonal", () => {
    const expected = [
      { x: 1000, y: 500 },
      { x: 4000, y: 500 },
      { x: 4000, y: 3000 },
      { x: 1000, y: 3000 },
    ];
    expect(rectangleCorners({ x: 1000, y: 500 }, { x: 4000, y: 3000 })).toEqual(expected);
    expect(rectangleCorners({ x: 4000, y: 500 }, { x: 1000, y: 3000 })).toEqual(expected);
  });

  it("refuses a rectangle with no width or depth", () => {
    expect(rectangleCorners({ x: 0, y: 0 }, { x: 0, y: 900 })).toBeNull();
  });
});

describe("wallOffset", () => {
  const start = { x: 0, y: 0 };
  const end = { x: 3500, y: 0 };

  it("moves only perpendicular to the wall, onto the grid", () => {
    expect(wallOffset(start, end, { x: 1750, y: 0 }, { x: 2150, y: -503 }, [], 10, 60)).toEqual({
      offsetMm: { x: 0, y: -500 },
      snap: "grid",
    });
  });

  it("lands a moved axis wall on a grid line, not a grid step", () => {
    expect(wallOffset({ x: 0, y: 3 }, { x: 3500, y: 3 }, { x: 10, y: 3 }, { x: 10, y: 250 }, [], 10, 60)).toEqual({
      offsetMm: { x: 0, y: 247 },
      snap: "grid",
    });
  });

  it("snaps onto a parallel traced wall within reach", () => {
    const lines = [
      [{ x: 4000, y: 1234 }, { x: 6000, y: 1234 }],
      [{ x: 0, y: 0 }, { x: 0, y: 1210 }],
    ] as const;
    expect(wallOffset(start, end, { x: 1000, y: 0 }, { x: 1000, y: 1200 }, lines, 10, 60)).toEqual({
      offsetMm: { x: 0, y: 1234 },
      snap: "line",
    });
  });

  it("moves an oblique wall in whole grid steps along its normal", () => {
    const result = wallOffset({ x: 0, y: 0 }, { x: 3000, y: 4000 }, { x: 0, y: 0 }, { x: 81, y: -62 }, [], 10, 60);
    // Normal is (-0.8, 0.6); the drag's component along it is -102, so -100.
    expect(result?.snap).toBe("grid");
    expect(result?.offsetMm.x).toBeCloseTo(80, 9);
    expect(result?.offsetMm.y).toBeCloseTo(-60, 9);
  });
});

describe("describePreview", () => {
  it("reads out the rubber band, snap target and close cue", () => {
    expect(
      describePreview({
        fromMm: { x: 3000, y: 0 },
        preview: { point: { x: 0, y: 0 }, snap: "point", pointId: "p1" },
        closing: true,
        locked: true,
        rectangle: null,
      }),
    ).toBe("Length 3000 mm · locked to plan X · snaps to point p1 at x 0, y 0 mm · click to close");
  });

  it("reads out a cursor before the first corner and a dragged rectangle", () => {
    expect(
      describePreview({
        fromMm: null,
        preview: { point: { x: 120, y: 40 }, snap: "grid", pointId: null },
        closing: false,
        locked: false,
        rectangle: null,
      }),
    ).toBe("snaps to grid at x 120, y 40 mm");
    expect(
      describePreview({
        fromMm: null,
        preview: { point: { x: 0, y: 0 }, snap: "grid", pointId: null },
        closing: false,
        locked: false,
        rectangle: rectangleCorners({ x: 0, y: 0 }, { x: 3000, y: 2500 }),
      }),
    ).toBe("Rectangle 3000 × 2500 mm");
  });
});
