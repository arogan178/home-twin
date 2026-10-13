import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createRenderScheduler } from "./renderScheduler";

describe("render scheduler", () => {
  it("draws the first frame, then only after a change", () => {
    const camera = new THREE.PerspectiveCamera();
    const scheduler = createRenderScheduler();
    expect(scheduler.consume(camera)).toBe(true);
    expect(scheduler.consume(camera)).toBe(false);
    scheduler.invalidate();
    expect(scheduler.consume(camera)).toBe(true);
    expect(scheduler.consume(camera)).toBe(false);
  });

  it("draws when the camera moves or turns", () => {
    const camera = new THREE.PerspectiveCamera();
    const scheduler = createRenderScheduler();
    scheduler.consume(camera);
    camera.position.x += 0.01;
    expect(scheduler.consume(camera)).toBe(true);
    camera.lookAt(1, 2, 3);
    expect(scheduler.consume(camera)).toBe(true);
    expect(scheduler.consume(camera)).toBe(false);
  });

  it("treats the tail of orbit damping as still", () => {
    const camera = new THREE.PerspectiveCamera();
    const scheduler = createRenderScheduler();
    scheduler.consume(camera);
    camera.position.x += 5e-6;
    expect(scheduler.consume(camera)).toBe(false);
  });
});
