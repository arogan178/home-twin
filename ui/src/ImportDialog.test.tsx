import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportDialog } from "./ImportDialog";
import { RevisionSchema } from "./types";

const summary = {
  import_id: "import-1",
  file_name: "house.ifc",
  size_bytes: 2_097_152,
  building: {
    id: "building",
    name: "Test house",
    schema: "IFC4",
    units: "mm",
    origin: { x: 0, y: 0, z: 0 },
    axes: "+X east, +Y north, +Z up",
    revision: "sha256:next",
  },
  room_count: 2,
  ready_room_count: 2,
  blockers: [],
  warnings: [],
  can_adopt: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("ImportDialog", () => {
  it("lands focus on the review step's first control", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));
    const { container } = render(<ImportDialog revision={RevisionSchema.parse("sha256:test")} onClose={vi.fn()} onAdopted={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>("input[type='file']")!;
    const file = new File(["ISO-10303-21;"], "house.ifc");
    Object.defineProperty(input, "files", { value: { length: 1, item: () => file } });
    fireEvent.change(input);

    const another = await screen.findByRole("button", { name: "Choose another" });
    expect(another).toHaveFocus();
  });

  it("opens as a native modal and closes on cancel", () => {
    const onClose = vi.fn();
    const { container } = render(<ImportDialog revision={RevisionSchema.parse("sha256:test")} onClose={onClose} onAdopted={vi.fn()} />);
    const dialog = container.querySelector("dialog")!;
    expect(dialog).toHaveAttribute("open");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
