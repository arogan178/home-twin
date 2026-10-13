import { describe, expect, it } from "vitest";

import { snapshotFilename, wrapCaption } from "./screenshot";

describe("snapshot", () => {
  it("names the file after the view and the minute it was taken", () => {
    expect(snapshotFilename("OpenPlan 3D", new Date(2026, 8, 23, 7, 5))).toBe(
      "home-twin-openplan-3d-2026-09-23-0705.png",
    );
    expect(snapshotFilename("  ", new Date(2026, 0, 1, 0, 0))).toBe("home-twin-view-2026-01-01-0000.png");
  });

  it("wraps each caption line at word boundaries", () => {
    const measure = (text: string) => text.length * 10;
    expect(wrapCaption(["one two three four", "five"], 100, measure)).toEqual(["one two", "three four", "five"]);
    expect(wrapCaption(["unbreakableword"], 50, measure)).toEqual(["unbreakableword"]);
  });
});
