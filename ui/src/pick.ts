/**
 * What the 3D view found under the cursor.
 *
 * A switch plate and a light body are both pickable meshes and both answer the
 * left button, so which one was hit decides whether the press starts a slide
 * along a wall, a slide along the ceiling, or an orbit. The meshes carry that
 * answer in `userData`, and reading it is separated from the pointer handler so
 * it can be tested without a WebGL context.
 */

export type Pick =
  | { readonly kind: "switch"; readonly tag: string; readonly group: string }
  | { readonly kind: "fixture"; readonly tag: string }
  | { readonly kind: "empty" };

/** Classify the `userData` of the nearest pickable mesh, if anything was hit. */
export function classifyPick(userData: Record<string, unknown> | undefined): Pick {
  const switchTag = userData?.switchTag;
  const controlGroup = userData?.controlGroup;
  // A plate without its group would drag but never toggle, so both must be there.
  if (typeof switchTag === "string" && typeof controlGroup === "string") {
    return { kind: "switch", tag: switchTag, group: controlGroup };
  }
  const tag = userData?.tag;
  if (typeof tag === "string") return { kind: "fixture", tag };
  return { kind: "empty" };
}
