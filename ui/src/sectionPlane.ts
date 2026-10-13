import * as THREE from "three";

/**
 * A single cut through a 3D view, in the building frame.
 *
 * `height` keeps what is below the cut, like a plan cut. `x` and `y` keep the
 * east and north side of a vertical cut, which is the side the default camera
 * looks towards. Flipping keeps the other side.
 */
export type SectionMode = "off" | "height" | "x" | "y";

export type Section = {
  readonly mode: SectionMode;
  /** Where the cut sits along its axis, in metres. */
  readonly atM: number;
  readonly flip: boolean;
};

/** A view's extent, in metres. */
export type ViewBounds = {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
};

export const SECTION_OFF: Section = { mode: "off", atM: 0, flip: false };

export const SECTION_LABELS: Readonly<Record<Exclude<SectionMode, "off">, string>> = {
  height: "Horizontal",
  x: "Across X (east)",
  y: "Across Y (north)",
};

/** The clipping plane for a section; three.js keeps the side with a positive distance. */
export function sectionPlane(section: Section): THREE.Plane | null {
  const sign = section.flip ? -1 : 1;
  switch (section.mode) {
    case "off":
      return null;
    case "height":
      return new THREE.Plane(new THREE.Vector3(0, 0, -sign), sign * section.atM);
    case "x":
      return new THREE.Plane(new THREE.Vector3(sign, 0, 0), -sign * section.atM);
    case "y":
      return new THREE.Plane(new THREE.Vector3(0, sign, 0), -sign * section.atM);
  }
}

/** The travel of a section's slider, and where a new cut starts. */
export function sectionRange(
  mode: Exclude<SectionMode, "off">,
  bounds: ViewBounds,
): { readonly min: number; readonly max: number; readonly initial: number } {
  if (mode === "height") {
    // A plan cut is conventionally about 1.2 m above the floor.
    return {
      min: bounds.minZ,
      max: bounds.maxZ,
      initial: Math.min(bounds.minZ + 1.2, (bounds.minZ + bounds.maxZ) / 2),
    };
  }
  const [min, max] = mode === "x" ? [bounds.minX, bounds.maxX] : [bounds.minY, bounds.maxY];
  return { min, max, initial: (min + max) / 2 };
}

/** Whether a picked point is on the kept side; a ray still hits what a cut hides. */
export function keptBySection(plane: THREE.Plane | null, point: THREE.Vector3): boolean {
  return plane === null || plane.distanceToPoint(point) >= 0;
}
