import { describe, expect, it } from "vitest";

import { planBoxToScreen, toolbarPosition } from "./selectionToolbar";

const view = { x: 0, y: -3000, width: 4000, height: 3000 };

describe("planBoxToScreen", () => {
  it("maps plan millimetres to canvas pixels with Y flipped", () => {
    const box = [{ x: 1000, y: 1000 }, { x: 2000, y: 2000 }];
    expect(planBoxToScreen(box, view, { width: 800, height: 600 })).toEqual({ left: 200, top: 200, width: 200, height: 200 });
  });

  it("adds the letterbox margin on the looser axis", () => {
    expect(planBoxToScreen([{ x: 0, y: 0 }], view, { width: 1000, height: 600 })).toEqual({ left: 100, top: 600, width: 0, height: 0 });
  });
});

describe("toolbarPosition", () => {
  const canvas = { width: 800, height: 600 };
  const toolbar = { width: 120, height: 30 };

  it("centres the toolbar above the selection", () => {
    expect(toolbarPosition({ left: 200, top: 200, width: 200, height: 200 }, toolbar, canvas)).toEqual({ left: 240, top: 162, placement: "above" });
  });

  it("flips below when there is no room above", () => {
    expect(toolbarPosition({ left: 200, top: 20, width: 200, height: 100 }, toolbar, canvas)).toEqual({ left: 240, top: 128, placement: "below" });
  });

  it("clamps inside the canvas edges", () => {
    expect(toolbarPosition({ left: 780, top: 300, width: 10, height: 10 }, toolbar, canvas)).toEqual({ left: 672, top: 262, placement: "above" });
    expect(toolbarPosition({ left: -50, top: 590, width: 10, height: 400 }, toolbar, canvas)).toEqual({ left: 8, top: 552, placement: "above" });
    expect(toolbarPosition({ left: 0, top: 0, width: 10, height: 600 }, toolbar, canvas)).toEqual({ left: 8, top: 562, placement: "below" });
  });
});
