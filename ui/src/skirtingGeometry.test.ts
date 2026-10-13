import { describe, expect, it } from "vitest";

import { skirtingRuns } from "./skirtingGeometry";

describe("skirtingRuns", () => {
  it("runs the whole wall where nothing opens through it", () => {
    expect(skirtingRuns(4, 0.06, [])).toEqual([{ fromM: 0, toM: 4 }]);
  });

  it("breaks at a door, which reaches the floor", () => {
    expect(skirtingRuns(4, 0.06, [{ fromM: 1, toM: 1.9, sillM: 0 }])).toEqual([
      { fromM: 0, toM: 1 },
      { fromM: 1.9, toM: 4 },
    ]);
  });

  it("passes behind a window, whose sill is above it", () => {
    expect(skirtingRuns(4, 0.06, [{ fromM: 1, toM: 2.5, sillM: 0.9 }])).toEqual([{ fromM: 0, toM: 4 }]);
  });

  it("merges overlapping doors into one break", () => {
    expect(
      skirtingRuns(5, 0.06, [
        { fromM: 1, toM: 2.2, sillM: 0 },
        { fromM: 2, toM: 3, sillM: 0 },
      ]),
    ).toEqual([
      { fromM: 0, toM: 1 },
      { fromM: 3, toM: 5 },
    ]);
  });

  it("drops a sliver left between a door and the wall end", () => {
    expect(skirtingRuns(2, 0.06, [{ fromM: 0, toM: 1.995, sillM: 0 }])).toEqual([]);
  });
});
