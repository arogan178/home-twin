export type PanelSpan = { readonly fromM: number; readonly toM: number };

/**
 * Divide a panelled run into equal panels separated by shadow gaps.
 *
 * The panels are equal rather than a row of target-width pieces and a narrow
 * offcut at the end: a run that closes on a 200 mm sliver reads as sheet goods,
 * which is the whole thing the panelling is trying not to look like.
 */
export function panelSpans(spanM: number, targetM: number, gapM: number): ReadonlyArray<PanelSpan> {
  if (spanM <= 0) return [];
  const count = Math.max(1, Math.round(spanM / targetM));
  const panelM = (spanM - gapM * (count - 1)) / count;
  if (panelM <= 0) return [{ fromM: 0, toM: spanM }];
  return Array.from({ length: count }, (_, index) => {
    const fromM = index * (panelM + gapM);
    return { fromM, toM: fromM + panelM };
  });
}

/**
 * The same division, but never exceeding the board it is cut from.
 *
 * Egger boards are 2800 long with the grain running the length, so a run taller
 * than that cannot be a single vertical-grain piece and has to take a joint.
 */
export function panelCourses(heightM: number, boardM: number, gapM: number): ReadonlyArray<PanelSpan> {
  if (heightM <= boardM) return [{ fromM: 0, toM: heightM }];
  const count = Math.ceil(heightM / boardM);
  return panelSpans(heightM, heightM / count, gapM);
}
