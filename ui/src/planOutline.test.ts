import { describe, expect, it } from "vitest";

import { planLongAxis, planOutlineAngle } from "./planOutline";

describe("plan outline rotation", () => {
  it.each([
    ["east", 0, [1, 0]],
    ["north", 90, [0, -1]],
    ["west", 180, [-1, 0]],
    ["south", 270, [0, 1]],
  ] as const)("points the long axis %s on screen", (_name, bearing, expected) => {
    const [x, y] = planLongAxis(bearing);
    expect(x).toBeCloseTo(expected[0], 6);
    expect(y).toBeCloseTo(expected[1], 6);
  });

  it("matches the slanting wall at 138 degrees", () => {
    // Building +X east, +Y north; screen y is flipped, so a bearing of 138 deg
    // points west-north-west in plan and up-left on screen.
    const [x, y] = planLongAxis(138);
    expect(x).toBeCloseTo(Math.cos((138 * Math.PI) / 180), 6);
    expect(y).toBeCloseTo(-Math.sin((138 * Math.PI) / 180), 6);
    expect(planOutlineAngle(138)).toBeCloseTo(-228, 6);
  });
});
