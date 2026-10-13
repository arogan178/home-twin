import { describe, expect, it } from "vitest";

import {
  isStacked,
  labelSizeMm,
  objectLabelRequests,
  objectLabelTexts,
  placeLabels,
  routeLabelOptions,
  scaleBarMm,
  type LabelledObject,
} from "./planLabels";

const beside = (key: string, text: string) => ({
  key,
  options: [{ text, fontPx: 10, placement: { kind: "beside", at: { x: 0, y: 0 }, clearMm: 10 } as const }],
});

function cabinet(id: string, minZ: number, maxZ: number, box = { minX: 0, minY: 0, maxX: 600, maxY: 600 }): LabelledObject {
  return { id, name: `Cabinet ${id}`, tag: id, box, minZ, maxZ };
}

describe("labelSizeMm", () => {
  it("sizes a monospace label from its length, font size and zoom", () => {
    expect(labelSizeMm("SP01", 11, 2)).toEqual({ width: 64.8, height: 27.5 });
  });
});

describe("placeLabels", () => {
  it("moves a second label beside the same mark to the other side", () => {
    const placed = placeLabels([beside("A", "AB"), beside("B", "CD")], 1);
    expect(placed.map((label) => [label.key, label.x, label.y])).toEqual([
      ["A", 19, 0],
      ["B", -19, 0],
    ]);
  });

  it("keeps a label off an occupied mark", () => {
    const mark = { minX: 10, minY: -5, maxX: 40, maxY: 5 };
    const [label] = placeLabels([beside("A", "AB")], 1, [mark]);
    expect([label?.x, label?.y]).toEqual([-19, 0]);
  });

  it("drops a label that has nowhere free to go", () => {
    const everywhere = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    expect(placeLabels([beside("A", "AB")], 1, [everywhere])).toEqual([]);
  });

  it("keeps a label inside the visible bounds", () => {
    const [label] = placeLabels([beside("A", "AB")], 1, [], { minX: -100, minY: -100, maxX: 15, maxY: 100 });
    expect([label?.x, label?.y]).toEqual([-19, 0]);
  });

  it("keeps a label off a wall line", () => {
    const wall = [{ x: 15, y: -50 }, { x: 15, y: 50 }] as const;
    const [label] = placeLabels([beside("A", "AB")], 1, [], null, [wall]);
    expect([label?.x, label?.y]).toEqual([-19, 0]);
  });

  it("does not run a leader through a wall it would cross", () => {
    const wall = { minX: 5, minY: -50, maxX: 6, maxY: 50 };
    const request = {
      key: "A",
      options: [{ text: "AB", fontPx: 10, leader: { x: 0, y: 0 }, placement: { kind: "beside", at: { x: 0, y: 0 }, clearMm: 10 } as const }],
    };
    const [label] = placeLabels([request], 1, [wall]);
    expect([label?.x, label?.y]).toEqual([-19, 0]);
  });

  it("drops a second callout whose only free spot would cross the first leader", () => {
    const callout = (key: string, at: { x: number; y: number }, avoid: ReadonlyArray<{ minX: number; minY: number; maxX: number; maxY: number }> = []) => ({
      key,
      options: [{ text: "AB", fontPx: 10, leader: at, avoid, placement: { kind: "beside", at, clearMm: 30 } as const }],
    });
    const everywhereButAbove = [
      { minX: 40, minY: -100, maxX: 100, maxY: 100 },
      { minX: -100, minY: -100, maxX: -5, maxY: 100 },
      { minX: -5, minY: 30, maxX: 40, maxY: 100 },
    ];
    const placed = placeLabels([callout("A", { x: 0, y: 0 }), callout("B", { x: 15, y: 20 }, everywhereButAbove)], 1);
    expect(placed.map((label) => [label.key, label.x, label.y])).toEqual([["A", 39, 0]]);
    const alone = placeLabels([callout("B", { x: 15, y: 20 }, everywhereButAbove)], 1);
    expect(alone.map((label) => [label.key, label.x, label.y])).toEqual([["B", 15, -16.25]]);
  });

  it("falls back to a shorter text that fits inside its object", () => {
    const within = { minX: 0, minY: 0, maxX: 60, maxY: 20 };
    const request = {
      key: "hob",
      options: ["Hob, Elica NikolaTesla", "Hob"].map((text) => ({
        text,
        fontPx: 10,
        placement: { kind: "inside", at: { x: 30, y: 10 }, within } as const,
      })),
    };
    expect(placeLabels([request], 1).map((label) => label.text)).toEqual(["Hob"]);
    expect(placeLabels([request], 4)).toEqual([]);
  });

  it("turns a label's footprint with the wall it runs along", () => {
    const [label] = placeLabels(
      [{ key: "wall", options: [{ text: "AB", fontPx: 10, placement: { kind: "at", at: { x: 0, y: 0 }, angleDeg: 90 } }] }],
      1,
    );
    expect(label?.box.minX).toBeCloseTo(-6.25);
    expect(label?.box.maxY).toBeCloseTo(9);
  });
});

describe("routeLabelOptions", () => {
  it("runs a line-set label beside its longest leg, on either side", () => {
    const route = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 200 }];
    const options = routeLabelOptions(route, "LS03A", 10, 1, 50);
    expect(options.slice(0, 3).map((option) => option.placement)).toEqual([
      { kind: "at", at: { x: 500, y: 50 }, angleDeg: 0 },
      { kind: "at", at: { x: 500, y: -50 }, angleDeg: 0 },
      { kind: "at", at: { x: 950, y: 100 }, angleDeg: 90 },
    ]);
  });

  it("offers nowhere when no leg is long enough to carry the label", () => {
    expect(routeLabelOptions([{ x: 0, y: 0 }, { x: 30, y: 0 }], "LS03A", 10, 1, 50)).toEqual([]);
  });
});

describe("around placement", () => {
  it("puts a callout just outside its room box before trying further out", () => {
    const room = { minX: 0, minY: 0, maxX: 100, maxY: 40 };
    const [label] = placeLabels(
      [{ key: "R", options: [{ text: "AB", fontPx: 10, placement: { kind: "around", box: room, gapMm: 5 } }] }],
      1,
      [{ minX: 100, minY: -100, maxX: 200, maxY: 100 }],
    );
    expect([label?.x, label?.y]).toEqual([-14, 20]);
  });

  it("lets a leader leave through its own wall but not through a second one", () => {
    const room = { minX: 0, minY: 0, maxX: 100, maxY: 40 };
    const ownWall = [{ x: 100, y: -100 }, { x: 100, y: 100 }] as const;
    const neighbourWall = [{ x: 103, y: -100 }, { x: 103, y: 100 }] as const;
    const request = {
      key: "R",
      options: [{ text: "AB", fontPx: 10, leader: { x: 50, y: 20 }, placement: { kind: "around", box: room, gapMm: 5 } as const }],
    };
    expect(placeLabels([request], 1, [], null, [ownWall]).map((label) => label.x)).toEqual([114]);
    expect(placeLabels([request], 1, [], null, [ownWall, neighbourWall]).map((label) => label.x)).toEqual([-14]);
  });
});

describe("object labels", () => {
  it("prefers the Tag, then the name, then the name before its first comma", () => {
    expect(objectLabelTexts("Hob, Elica NikolaTesla", "KIT-I3")).toEqual(["KIT-I3", "Hob, Elica NikolaTesla", "Hob"]);
    expect(objectLabelTexts("Drinks cabinet", null)).toEqual(["Drinks cabinet"]);
  });

  it("treats an upper cabinet over a base run as stacked, not the base", () => {
    const base = cabinet("KIT-B1", 1050, 1920);
    const upper = cabinet("KIT-U1", 2960, 3450, { minX: 0, minY: 0, maxX: 600, maxY: 350 });
    expect(isStacked(upper, [base, upper])).toBe(true);
    expect(isStacked(base, [base, upper])).toBe(false);
  });

  it("labels the smallest object first and skips stacked and duplicate labels", () => {
    const base = cabinet("KIT-B1", 1050, 1920);
    const upper = cabinet("KIT-U1", 2960, 3450);
    const small = cabinet("KIT-A1", 1950, 2300, { minX: 1000, minY: 0, maxX: 1300, maxY: 300 });
    const twin = { ...cabinet("other", 1050, 1920, { minX: 2000, minY: 0, maxX: 2900, maxY: 900 }), tag: "KIT-A1" };
    expect(objectLabelRequests([base, upper, small, twin]).map((request) => request.key)).toEqual(["KIT-A1", "KIT-B1"]);
  });
});

describe("scaleBarMm", () => {
  it("picks the longest round length that stays under the limit", () => {
    expect(scaleBarMm(8)).toBe(500);
    expect(scaleBarMm(20)).toBe(2000);
    expect(scaleBarMm(1)).toBe(100);
  });
});
