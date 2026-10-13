/**
 * What a press and a release do to a selection.
 *
 * The plan and the 3D view both select the same lights, so they share the rule
 * rather than each keeping their own copy of it. A press cannot narrow a
 * selection, because the press might be the start of dragging the whole set;
 * narrowing waits for a release that turned out not to be a drag.
 */

export type Selection<Tag extends string> = ReadonlySet<Tag>;

/**
 * The selection a press on `tag` produces.
 *
 * Holding the modifier adds or removes one member. Otherwise pressing an
 * outsider makes it the whole selection, and pressing a member leaves the
 * selection alone so the press can drag every one of them.
 */
export function pressSelection<Tag extends string>(
  current: Selection<Tag>,
  tag: Tag,
  additive: boolean,
): Selection<Tag> {
  if (additive) {
    const toggled = new Set(current);
    if (toggled.has(tag)) toggled.delete(tag);
    else toggled.add(tag);
    return toggled;
  }
  return current.has(tag) ? current : new Set([tag]);
}

/**
 * The selection a release on `tag` produces, or null when it changes nothing.
 *
 * A plain click on one of several selected lights means that one, but only once
 * the release proves it was a click and not the start of a drag.
 */
export function releaseSelection<Tag extends string>(
  current: Selection<Tag>,
  tag: Tag,
  additive: boolean,
  moved: boolean,
): Selection<Tag> | null {
  if (additive || moved) return null;
  if (current.size <= 1 || !current.has(tag)) return null;
  return new Set([tag]);
}
