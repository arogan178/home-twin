import { describe, expect, it } from "vitest";

import { humaniseId, idWords, plainText } from "./displayNames";

describe("display names", () => {
  it("turns a switching group id into a sentence-case label", () => {
    expect(humaniseId("BEDROOM_CORRIDOR")).toBe("Bedroom corridor");
    expect(humaniseId("OPEN_PLAN_MAIN")).toBe("Open plan main");
    expect(humaniseId("switch_group_empty")).toBe("Switch group empty");
  });

  it("keeps tokens that carry a number as written", () => {
    expect(humaniseId("K2_ISLAND")).toBe("K2 island");
    expect(idWords("direct_sun_patch_geometry_v1")).toBe("direct sun patch geometry v1");
  });

  it("spells out snake_case tokens inside prose and leaves the rest", () => {
    expect(plainText("Site evidence is site_location; confirm on site.")).toBe(
      "Site evidence is site location; confirm on site.",
    );
    expect(plainText("Plan +Y at 224.2°")).toBe("Plan +Y at 224.2°");
  });
});
