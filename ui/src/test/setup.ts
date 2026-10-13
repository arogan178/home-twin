import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest does not run without `globals`, so React Testing Library's automatic
// unmount never registers. Without this, rendered trees leak between tests.
afterEach(cleanup);

// jsdom has no ResizeObserver, and components that measure their own canvas
// need one to exist even if it never fires.
if (!("ResizeObserver" in globalThis)) {
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
}

// jsdom implements MouseEvent but not PointerEvent, so `fireEvent.pointerDown`
// falls back to a bare Event and silently drops `button`, `shiftKey`, and
// `pointerId`. Every handler that reads them then sees undefined.
if (!("PointerEvent" in globalThis)) {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  globalThis.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

// jsdom has no showModal/close on <dialog>; model the `open` attribute and the
// `close` event so modal components can be exercised.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
