import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  buildSpotlightGeometries,
  spotlightBodyProfile,
  spotlightFitting,
  spotlightTiltRad,
} from "./spotlightGeometry";
import type { RecessedSpotlight } from "./types";

const down = { x: 0, y: 0, z: -1 };
const k2Aim = { x: 0.42261826174069944, y: 0, z: -0.9063077870366499 };
const fixture = (model: string | null, direction = down) =>
  ({ spec: { model }, direction }) as unknown as Pick<RecessedSpotlight, "spec" | "direction">;

function extents(profile: ReturnType<typeof spotlightBodyProfile>) {
  const points = profile.flat();
  return {
    maxR: Math.max(...points.map(([r]) => r)),
    minZ: Math.min(...points.map(([, z]) => z)),
    maxZ: Math.max(...points.map(([, z]) => z)),
  };
}

function size(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

describe("spotlightFitting", () => {
  it("reads the fitting from the stated model and aim", () => {
    expect(spotlightFitting(fixture("Noxion PerfectColor GU10 PAR16 6.7W 930 60D in a deep-baffle IP20 trim"))).toBe("deep_baffle");
    expect(spotlightFitting(fixture("Radium RL-PAR16 80 DIM 930/60°/GU10 (44020758), 6.5 W, 50 x 54 mm"))).toBe("recessed_bowl");
    expect(spotlightFitting(fixture(null))).toBe("recessed_bowl");
    expect(spotlightFitting(fixture("Radium RL-PAR16 80 DIM 930/60°/GU10 (44020758), 6.5 W, 50 x 54 mm", k2Aim))).toBe("adjustable");
  });

  it("measures K2's stated aim as 25 degrees off vertical", () => {
    expect((spotlightTiltRad(k2Aim) * 180) / Math.PI).toBeCloseTo(25, 6);
    expect(spotlightTiltRad(down)).toBe(0);
  });
});

describe("spotlightBodyProfile", () => {
  it("keeps every fitting inside its trim, 3 mm below the ceiling and up to the lamp setback", () => {
    expect(extents(spotlightBodyProfile("recessed_bowl", 45, 40, 60))).toEqual({ maxR: 45, minZ: -3, maxZ: 30 });
    expect(extents(spotlightBodyProfile("deep_baffle", 47.5, 40, 90))).toEqual({ maxR: 47.5, minZ: -3, maxZ: 30 });
    // The adjustable sleeve rises to the 60 mm mounting depth less the terminal block above it.
    expect(extents(spotlightBodyProfile("adjustable", 45, 40, 60))).toEqual({ maxR: 45, minZ: -3, maxZ: 50 });
  });

  it("steps the deep baffle three times between the aperture and the lamp", () => {
    const treads = spotlightBodyProfile("deep_baffle", 47.5, 40, 90)
      .filter((run) => run.length === 2 && run[0]![1] === run[1]![1] && run[0]![1] > 0 && run[1]![0] < run[0]![0] && run[0]![0] < 40)
      .map((run) => [run[0]![0], run[1]![0], run[0]![1]]);
    expect(treads).toEqual([
      [37, 34, 7],
      [34, 31, 15],
      [31, 28, 23],
      [28, 22, 29],
    ]);
  });
});

describe("buildSpotlightGeometries", () => {
  it("builds a 90 mm trim whose housing stops at the 60 mm mounting depth", () => {
    const shapes = buildSpotlightGeometries("recessed_bowl", 45, 40, 60);
    const body = size(shapes.body);
    expect(body.max.x - body.min.x).toBeCloseTo(0.09, 4);
    expect(body.min.z).toBeCloseTo(-0.003, 6);
    expect(body.max.z).toBeCloseTo(0.03, 6);
    const housing = size(shapes.housing);
    expect(housing.max.z).toBeCloseTo(0.06, 6);
    expect(housing.max.x).toBeLessThanOrEqual(0.045);
    expect(shapes.module).toBeNull();
    expect(shapes.capMm).toBe(30);
  });

  it("leaves only the body wall's rim at the cap plane, so the cap cannot z-fight a face", () => {
    for (const fitting of ["recessed_bowl", "deep_baffle", "adjustable"] as const) {
      const shapes = buildSpotlightGeometries(fitting, 45, 40, 60);
      const position = shapes.body.getAttribute("position");
      const radii = new Set<number>();
      for (let index = 0; index < position.count; index += 1) {
        if (Math.abs(position.getZ(index) - shapes.capMm / 1000) < 1e-7) {
          radii.add(Math.round(Math.hypot(position.getX(index), position.getY(index)) * 1e5) / 100);
        }
      }
      expect([...radii]).toEqual([39.5]);
    }
  });

  it("gives an adjustable fitting a lamp cup and a cap over its taller sleeve", () => {
    const shapes = buildSpotlightGeometries("adjustable", 45, 40, 60);
    const cup = size(shapes.module!);
    expect(cup.max.x - cup.min.x).toBeCloseTo(0.056, 4);
    expect(cup.min.z).toBeCloseTo(-0.012, 6);
    expect(shapes.capMm).toBe(50);
  });
});
