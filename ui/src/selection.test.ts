import { describe, expect, it } from "vitest";

import { pressSelection, releaseSelection } from "./selection";

const set = (...tags: string[]) => new Set(tags);

describe("pressSelection", () => {
  it("makes an unselected light the whole selection", () => {
    expect(pressSelection(set("SP01"), "SP02", false)).toEqual(set("SP02"));
  });

  it("keeps the selection when pressing one of its members, so the set can drag", () => {
    const current = set("SP01", "SP02");
    expect(pressSelection(current, "SP01", false)).toBe(current);
  });

  it("adds a light to the selection when the modifier is held", () => {
    expect(pressSelection(set("SP01"), "SP02", true)).toEqual(set("SP01", "SP02"));
  });

  it("drops a light that was already in the selection", () => {
    expect(pressSelection(set("SP01", "SP02"), "SP02", true)).toEqual(set("SP01"));
  });

  it("empties the selection when its last member is toggled off", () => {
    expect(pressSelection(set("SP01"), "SP01", true)).toEqual(set());
  });
});

describe("releaseSelection", () => {
  it("narrows to the light that was clicked when the press did not drag", () => {
    expect(releaseSelection(set("SP01", "SP02", "SP03"), "SP02", false, false)).toEqual(set("SP02"));
  });

  it("leaves a set alone when the press turned into a drag", () => {
    expect(releaseSelection(set("SP01", "SP02"), "SP01", false, true)).toBeNull();
  });

  it("leaves a set alone when the modifier is held, because that press already toggled", () => {
    expect(releaseSelection(set("SP01", "SP02"), "SP01", true, false)).toBeNull();
  });

  it("changes nothing when only one light is selected", () => {
    expect(releaseSelection(set("SP01"), "SP01", false, false)).toBeNull();
  });

  it("changes nothing when the released light is not in the selection", () => {
    expect(releaseSelection(set("SP01", "SP02"), "SP09", false, false)).toBeNull();
  });
});
