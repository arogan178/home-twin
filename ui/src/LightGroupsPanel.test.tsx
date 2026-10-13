import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LightGroupsPanel } from "./LightGroupsPanel";

const groups = [
  { group: "BEDROOM_CORRIDOR", fixtures: 2, dimmableFixtures: 2, switchTags: ["SW01"], hasDimmer: false },
  { group: "K2_ISLAND", fixtures: 1, dimmableFixtures: 0, switchTags: [], hasDimmer: false },
];

describe("LightGroupsPanel", () => {
  it("names groups for people and switches every group off at once", () => {
    const onSetGroupsOff = vi.fn();
    render(
      <LightGroupsPanel
        groups={groups}
        offGroups={new Set()}
        dimLevels={new Map()}
        onToggleGroup={vi.fn()}
        onSetGroupsOff={onSetGroupsOff}
        onDim={vi.fn()}
      />,
    );

    expect(screen.getByText("Bedroom corridor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch off K2 island" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All off" }));
    expect(onSetGroupsOff).toHaveBeenCalledWith(["BEDROOM_CORRIDOR", "K2_ISLAND"], true);
  });

  it("offers to switch everything back on once every group is off", () => {
    const onSetGroupsOff = vi.fn();
    render(
      <LightGroupsPanel
        groups={groups}
        offGroups={new Set(["BEDROOM_CORRIDOR", "K2_ISLAND"])}
        dimLevels={new Map()}
        onToggleGroup={vi.fn()}
        onSetGroupsOff={onSetGroupsOff}
        onDim={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "All on" }));
    expect(onSetGroupsOff).toHaveBeenCalledWith(["BEDROOM_CORRIDOR", "K2_ISLAND"], false);
  });
});
