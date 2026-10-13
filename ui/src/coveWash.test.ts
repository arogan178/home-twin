import { describe, expect, it } from "vitest";

import { coveBasis, coveLuminance, coveWashes } from "./coveWash";

const wall = (
  wall_id: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  inward: { x: number; y: number },
) => ({
  wall_id,
  start,
  end,
  inward_normal: { x: inward.x, y: inward.y, z: 0 },
  thickness_mm: 150,
});

const rope = (path: Array<{ x: number; y: number; z: number }>) =>
  ({ kind: "rope_light", path }) as never;

describe("coveWash", () => {
  it("aims at the wall it runs alongside, against that wall's inward normal", () => {
    const walls = [wall("W-SOUTH", { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 0, y: 1 })];
    const [wash] = coveWashes(
      rope([
        { x: 1000, y: 35, z: 3650 },
        { x: 9000, y: 35, z: 3650 },
      ]),
      walls,
    );
    expect(wash?.wallId).toBe("W-SOUTH");
    expect(wash?.towards).toEqual({ x: -0, y: -1 });
    expect(wash?.centre).toEqual({ x: 5000, y: 35, z: 3650 });
    expect(wash?.lengthMm).toBe(8000);
    // The run's own axis, which a linear light has to be oriented along.
    expect(wash?.along).toEqual({ x: 1, y: 0 });
  });

  it("takes the nearer of two parallel walls", () => {
    const walls = [
      wall("W-FAR", { x: 0, y: 4000 }, { x: 10000, y: 4000 }, { x: 0, y: -1 }),
      wall("W-NEAR", { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 0, y: 1 }),
    ];
    const [wash] = coveWashes(
      rope([
        { x: 1000, y: 35, z: 3650 },
        { x: 9000, y: 35, z: 3650 },
      ]),
      walls,
    );
    expect(wash?.wallId).toBe("W-NEAR");
  });

  it("ignores a wall the run merely passes, however close", () => {
    const walls = [wall("W-CROSS", { x: 5000, y: -1000 }, { x: 5000, y: 1000 }, { x: 1, y: 0 })];
    expect(
      coveWashes(
        rope([
          { x: 1000, y: 35, z: 3650 },
          { x: 9000, y: 35, z: 3650 },
        ]),
        walls,
      ),
    ).toEqual([]);
  });

  it("follows a wall that slants, within tolerance", () => {
    // The open plan's diagonal: the run is inset from the face but parallel.
    const walls = [wall("W-DIAG", { x: 9999, y: 9900 }, { x: 20540, y: 350 }, { x: 0.671, y: 0.741 })];
    const [wash] = coveWashes(
      rope([
        { x: 10134, y: 9825, z: 3650 },
        { x: 18302, y: 2425, z: 3650 },
      ]),
      walls,
    );
    expect(wash?.wallId).toBe("W-DIAG");
    expect(wash?.towards.x).toBeCloseTo(-0.671, 2);
    expect(wash?.towards.y).toBeCloseTo(-0.741, 2);
    // Along the run, which is perpendicular to the way it faces.
    expect((wash?.along.x ?? 0) * wash!.towards.x + (wash?.along.y ?? 0) * wash!.towards.y).toBeCloseTo(0, 2);
  });

  it("reports nothing when no wall runs alongside", () => {
    expect(coveWashes(rope([{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }]), [])).toEqual([]);
  });

  it("gives a run that turns a corner one wash per straight length", () => {
    const walls = [
      wall("W-LONG", { x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 0, y: 1 }),
      wall("W-STUB", { x: 10000, y: 0 }, { x: 10300, y: 300 }, { x: -0.707, y: 0.707 }),
    ];
    const washes = coveWashes(
      rope([
        { x: 1000, y: 35, z: 3650 },
        { x: 9900, y: 35, z: 3650 },
        { x: 10150, y: 260, z: 3650 },
      ]),
      walls,
    );
    expect(washes.map((w) => w.wallId)).toEqual(["W-LONG", "W-STUB"]);
    // Each length faces its own wall, which is the whole reason for splitting.
    expect(washes[0]?.towards.y).toBeCloseTo(-1, 2);
    expect(washes[1]?.towards.y).toBeCloseTo(-0.707, 2);
  });
});

describe("coveLuminance", () => {
  it("turns a strip rating into the aperture's luminance", () => {
    // 1150 lm/m escaping a 70 mm mouth: 1150 / (pi * 0.07).
    expect(coveLuminance(1150, 0.07)).toBeCloseTo(5229, 0);
  });

  it("matches the closed form for an ordinary cove", () => {
    expect(coveLuminance(900, 0.05)).toBeCloseTo(900 / (Math.PI * 0.05), 9);
  });

  it("halves when the same flux escapes through twice the mouth", () => {
    expect(coveLuminance(1150, 0.14)).toBeCloseTo(coveLuminance(1150, 0.07) / 2, 6);
  });

  it("scales with the strip rating", () => {
    expect(coveLuminance(2300, 0.07)).toBeCloseTo(coveLuminance(1150, 0.07) * 2, 6);
  });

  it("reports darkness rather than a divide by zero", () => {
    expect(coveLuminance(0, 0.07)).toBe(0);
    expect(coveLuminance(1150, 0)).toBe(0);
  });
});

describe("coveBasis", () => {
  const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    a.x * b.x + a.y * b.y + a.z * b.z;

  it("keeps the width along the run, which is the whole point", () => {
    const basis = coveBasis({ x: 1, y: 0 }, { x: 0, y: 1 }, 0.35);
    expect(basis.x.x).toBeCloseTo(1, 6);
    expect(basis.x.y).toBeCloseTo(0, 6);
    expect(basis.x.z).toBeCloseTo(0, 6);
  });

  it("emits downwards, leaning at the wall", () => {
    const basis = coveBasis({ x: 1, y: 0 }, { x: 0, y: 1 }, 0.35);
    // Light travels along -z.
    const emit = { x: -basis.z.x, y: -basis.z.y, z: -basis.z.z };
    expect(emit.z).toBeLessThan(0);
    expect(emit.y).toBeGreaterThan(0);
    expect(Math.abs(emit.z)).toBeGreaterThan(Math.abs(emit.y));
  });

  it("falls straight down when nothing leans it", () => {
    const basis = coveBasis({ x: 1, y: 0 }, { x: 0, y: 1 }, 0);
    expect(-basis.z.z).toBeCloseTo(-1, 6);
  });

  it("stays orthonormal on a slanting run", () => {
    const basis = coveBasis({ x: 0.741, y: -0.671 }, { x: -0.671, y: -0.741 }, 0.35);
    for (const axis of [basis.x, basis.y, basis.z]) {
      expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 6);
    }
    expect(dot(basis.x, basis.y)).toBeCloseTo(0, 6);
    expect(dot(basis.y, basis.z)).toBeCloseTo(0, 6);
    expect(dot(basis.z, basis.x)).toBeCloseTo(0, 6);
  });

  it("puts the width along a slanting run too", () => {
    const along = { x: 0.741, y: -0.671 };
    const basis = coveBasis(along, { x: -0.671, y: -0.741 }, 0.35);
    expect(Math.abs(dot(basis.x, { x: along.x, y: along.y, z: 0 }))).toBeCloseTo(1, 3);
  });
});
