import { describe, expect, it } from "vitest";

import {
  DEFAULT_REFERENCE_LUX,
  FIELD_PENUMBRA,
  beamCandela,
  exposureForReferenceLux,
  fieldHalfAngle,
  indirectIrradianceLux,
} from "./render";

describe("beamCandela", () => {
  it("spreads the rated lumens over the beam solid angle", () => {
    // 650 lm through a 36 degree cone: 2*pi*(1-cos 18) sr.
    const solidAngle = 2 * Math.PI * (1 - Math.cos((18 * Math.PI) / 180));
    expect(beamCandela(650, 36)).toBeCloseTo(650 / solidAngle, 6);
  });

  it("makes a narrow beam brighter than a wide one of the same output", () => {
    expect(beamCandela(650, 15)).toBeGreaterThan(beamCandela(650, 60) * 10);
  });

  it("caps the spread at a hemisphere, which is 2 pi steradians", () => {
    expect(beamCandela(2 * Math.PI, 180)).toBeCloseTo(1, 6);
    expect(beamCandela(2 * Math.PI, 300)).toBeCloseTo(1, 6);
  });

  it("scales linearly with output", () => {
    expect(beamCandela(1300, 36)).toBeCloseTo(2 * beamCandela(650, 36), 6);
  });
});

describe("fieldHalfAngle", () => {
  it("opens the cone past the rated beam", () => {
    expect(fieldHalfAngle(36)).toBeCloseTo(((18 * Math.PI) / 180) * 1.3, 9);
  });

  it("never exceeds the widest cone three.js accepts", () => {
    expect(fieldHalfAngle(180)).toBeLessThanOrEqual(Math.PI / 2);
  });

  it("puts the half-intensity crossing back on the rated beam edge", () => {
    // three.js holds full intensity to angle*(1-penumbra) and fades to zero at
    // angle, so the midpoint of that band is the rated half-angle.
    const beamHalf = (18 * Math.PI) / 180;
    const field = fieldHalfAngle(36);
    expect((field + field * (1 - FIELD_PENUMBRA)) / 2).toBeCloseTo(beamHalf, 9);
  });
});

describe("indirectIrradianceLux", () => {
  it("uses the room interreflection the shadow pass reported", () => {
    expect(indirectIrradianceLux(47.2, 300)).toBe(47.2);
  });

  it("falls back to a share of the target before a shadow pass has run", () => {
    expect(indirectIrradianceLux(null, 300)).toBeCloseTo(45, 6);
  });

  it("treats a zero bounce as no reading rather than darkness", () => {
    expect(indirectIrradianceLux(0, 300)).toBeGreaterThan(0);
  });
});

describe("exposureForReferenceLux", () => {
  it("dims as the target illuminance rises, so lux stays comparable", () => {
    expect(exposureForReferenceLux(600)).toBeCloseTo(exposureForReferenceLux(300) / 2, 9);
  });

  it("keeps a pale surface at the target inside the display range", () => {
    const radiance = (DEFAULT_REFERENCE_LUX * 0.8) / Math.PI;
    const exposed = radiance * exposureForReferenceLux(DEFAULT_REFERENCE_LUX);
    expect(exposed).toBeGreaterThan(0.5);
    expect(exposed).toBeLessThan(1.2);
  });

  it("does not divide by zero on an unlit target", () => {
    expect(Number.isFinite(exposureForReferenceLux(0))).toBe(true);
  });
});
