import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TraceShortcutsDialog } from "./TraceShortcutsDialog";

describe("TraceShortcutsDialog", () => {
  it("opens as a native modal and closes on cancel", () => {
    const onClose = vi.fn();
    const { container } = render(<TraceShortcutsDialog onClose={onClose} />);
    const dialog = container.querySelector("dialog")!;
    expect(dialog).toHaveAttribute("open");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
