import { describe, expect, it } from "vitest";

import { distributeEvenly, duplicateOffsetMm, snapToGridMm } from "./fixtureArrangement";

const at = (tag: string, x: number, y: number) => ({ tag, point: { x, y, z: 2700 } });

describe("distributeEvenly", () => {
  it("keeps the furthest pair fixed and spaces the rest in spatial order, not tag order", () => {
    const result = distributeEvenly([at("SP01", 1500, 0), at("SP02", 3000, 0), at("SP03", 0, 0), at("SP04", 1200, 0)]);
    expect(Object.fromEntries(result.map((mark) => [mark.tag, mark.point]))).toEqual({
      SP03: { x: 0, y: 0, z: 2700 },
      SP04: { x: 1000, y: 0, z: 2700 },
      SP01: { x: 2000, y: 0, z: 2700 },
      SP02: { x: 3000, y: 0, z: 2700 },
    });
  });

  it("puts off-line fixtures onto the line between the extremes", () => {
    const result = distributeEvenly([at("SP01", 0, 0), at("SP02", 900, 300), at("SP03", 2000, 2000)]);
    expect(result).toEqual([at("SP01", 0, 0), at("SP02", 1000, 1000), at("SP03", 2000, 2000)]);
  });

  it("breaks a projection tie by tag", () => {
    const result = distributeEvenly([at("SP01", 0, 0), at("SP09", 1000, 500), at("SP05", 1000, -500), at("SP02", 3000, 0)]);
    expect(result.map((mark) => mark.tag)).toEqual(["SP01", "SP05", "SP09", "SP02"]);
    expect(result.map((mark) => mark.point.x)).toEqual([0, 1000, 2000, 3000]);
  });

  it("leaves fewer than three fixtures alone", () => {
    const pair = [at("SP01", 0, 0), at("SP02", 500, 0)];
    expect(distributeEvenly(pair)).toBe(pair);
  });
});

describe("duplicateOffsetMm", () => {
  it("steps one grid square east and south", () => {
    expect(duplicateOffsetMm(250)).toEqual({ x: 250, y: -250 });
  });

  it("falls back to 100 mm when the grid is off", () => {
    expect(duplicateOffsetMm(0)).toEqual({ x: 100, y: -100 });
  });
});

describe("snapToGridMm", () => {
  it("rounds a drop point to the nearest grid node", () => {
    expect(snapToGridMm({ x: 1234, y: -1260 }, 50)).toEqual({ x: 1250, y: -1250 });
  });
});
