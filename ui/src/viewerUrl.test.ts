import { afterEach, describe, expect, it } from "vitest";

import { formatCameraFrame, parseCameraFrame, readCameraFrame, writeCameraFrame, writeViewState } from "./viewerUrl";

const frame = { position: { x: 1.234, y: -5, z: 7.5 }, target: { x: 2, y: 3, z: 0.9 } };

afterEach(() => window.history.replaceState(null, "", "/"));

describe("viewer URL", () => {
  it("round-trips a camera at centimetre precision", () => {
    expect(formatCameraFrame(frame)).toBe("1.23,-5.00,7.50,2.00,3.00,0.90");
    expect(parseCameraFrame(formatCameraFrame(frame))).toEqual({
      position: { x: 1.23, y: -5, z: 7.5 },
      target: { x: 2, y: 3, z: 0.9 },
    });
  });

  it("rejects a malformed or degenerate camera", () => {
    expect(parseCameraFrame(null)).toBeNull();
    expect(parseCameraFrame("1,2,3")).toBeNull();
    expect(parseCameraFrame("1,2,3,a,5,6")).toBeNull();
    expect(parseCameraFrame("1,2,3,1,2,3")).toBeNull();
  });

  it("writes the camera beside the parameters the app already reads", () => {
    window.history.replaceState(null, "", "/?room=Kitchen&debug=1");
    writeCameraFrame(frame);
    expect(new URLSearchParams(window.location.search).get("debug")).toBe("1");
    expect(readCameraFrame()?.target).toEqual({ x: 2, y: 3, z: 0.9 });
    writeCameraFrame(null);
    expect(window.location.search).toBe("?room=Kitchen&debug=1");
  });

  it("writes view, scope and room in the form the loader reads", () => {
    window.history.replaceState(null, "", "/?room=Office");
    writeViewState({ view: "model", scope: "room", roomId: null });
    expect(window.location.search).toBe("?room=Office&view=3d");
    writeViewState({ view: "plan", scope: "whole", roomId: "0Aw3$x" });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("view")).toBeNull();
    expect(params.get("scope")).toBe("whole");
    expect(params.get("room")).toBe("0Aw3$x");
  });
});
