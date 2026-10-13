import { describe, expect, it } from "vitest";

import { viewerAction } from "./viewerShortcuts";

const press = (key: string, extra: Partial<{ ctrlKey: boolean; target: EventTarget | null }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: null,
  ...extra,
});

describe("viewer shortcuts", () => {
  it("maps single keys in either case", () => {
    expect(viewerAction(press("m"))).toBe("measure");
    expect(viewerAction(press("T"))).toBe("plan");
    expect(viewerAction(press("?"))).toBe("help");
    expect(viewerAction(press("Escape"))).toBe("escape");
    expect(viewerAction(press("q"))).toBeNull();
  });

  it("leaves chords and typing alone", () => {
    expect(viewerAction(press("z", { ctrlKey: true }))).toBeNull();
    const input = document.createElement("input");
    expect(viewerAction(press("m", { target: input }))).toBeNull();
    const select = document.createElement("select");
    expect(viewerAction(press("r", { target: select }))).toBeNull();
  });
});
