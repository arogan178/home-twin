import { describe, expect, it } from "vitest";

import { panelCourses, panelSpans } from "./wallPanelGeometry";

describe("panelSpans", () => {
  it("divides a run into equal panels closest to the target width", () => {
    const spans = panelSpans(3.433, 1.0, 0.006);
    expect(spans).toHaveLength(3);
    const widths = spans.map((span) => span.toM - span.fromM);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1e-9);
    expect(spans.at(-1)?.toM).toBeCloseTo(3.433, 9);
  });

  it("leaves a gap of exactly the stated width between panels", () => {
    const spans = panelSpans(2.343, 1.0, 0.006);
    expect(spans.length).toBeGreaterThan(1);
    for (const [index, span] of spans.slice(1).entries()) {
      expect(span.fromM - spans[index]!.toM).toBeCloseTo(0.006, 9);
    }
  });

  it("gives a run shorter than one panel a single piece", () => {
    expect(panelSpans(0.4, 1.0, 0.006)).toEqual([{ fromM: 0, toM: 0.4 }]);
  });
});

describe("panelCourses", () => {
  it("leaves a run within the board length in one piece", () => {
    expect(panelCourses(2.588, 2.8, 0.006)).toEqual([{ fromM: 0, toM: 2.588 }]);
  });

  it("splits a run taller than the board into equal courses", () => {
    const courses = panelCourses(3.51, 2.8, 0.006);
    expect(courses).toHaveLength(2);
    for (const course of courses) expect(course.toM - course.fromM).toBeLessThan(2.8);
    expect(courses.at(-1)?.toM).toBeCloseTo(3.51, 9);
  });
});
