import { describe, expect, it } from "vitest";

import { classifyPick } from "./pick";

describe("classifyPick", () => {
  it("reads a wall switch and the group it controls", () => {
    expect(classifyPick({ switchTag: "SW01", controlGroup: "OPEN_PLAN_MAIN" })).toEqual({
      kind: "switch",
      tag: "SW01",
      group: "OPEN_PLAN_MAIN",
    });
  });

  it("reads a light body", () => {
    expect(classifyPick({ tag: "SP01" })).toEqual({ kind: "fixture", tag: "SP01" });
  });

  it("reports nothing when the ray missed every pickable mesh", () => {
    expect(classifyPick(undefined)).toEqual({ kind: "empty" });
  });

  it("reports nothing for a mesh carrying no identity", () => {
    expect(classifyPick({})).toEqual({ kind: "empty" });
  });

  it("does not treat a plate without its group as a switch", () => {
    // Dragging it would work and flicking it would not, which reads as a dead switch.
    expect(classifyPick({ switchTag: "SW01" })).toEqual({ kind: "empty" });
  });

  it("prefers the switch when a mesh somehow carries both identities", () => {
    expect(classifyPick({ switchTag: "SW01", controlGroup: "MAIN", tag: "SP01" })).toEqual({
      kind: "switch",
      tag: "SW01",
      group: "MAIN",
    });
  });
});
