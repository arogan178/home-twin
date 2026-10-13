import * as THREE from "three";

import { formatMillimetres } from "./plan";

/**
 * A two-point distance picked on the 3D view's displayed surfaces.
 *
 * The points are wherever the ray met a drawn surface, so the result is as
 * good as the display geometry: exact for wall faces, floors and IFC bounds,
 * illustrative for detailed joinery. Holding Shift locks the second point to
 * the dominant axis, which is how a clearance is usually read.
 */
export type Measurement = {
  readonly from: THREE.Vector3;
  readonly to: THREE.Vector3;
  readonly distanceMm: number;
  readonly dxMm: number;
  readonly dyMm: number;
  readonly dzMm: number;
  readonly axis: "free" | "x" | "y" | "z";
};

export const MEASURE_METHOD =
  "Picked on the displayed surfaces, to the nearest millimetre. Detailed joinery is illustrative; IFC bounds and the plan govern.";

export function measureBetween(from: THREE.Vector3, to: THREE.Vector3, lockAxis = false): Measurement {
  const delta = to.clone().sub(from);
  let axis: Measurement["axis"] = "free";
  if (lockAxis) {
    const x = Math.abs(delta.x);
    const y = Math.abs(delta.y);
    const z = Math.abs(delta.z);
    axis = x >= y && x >= z ? "x" : y >= z ? "y" : "z";
    delta.set(axis === "x" ? delta.x : 0, axis === "y" ? delta.y : 0, axis === "z" ? delta.z : 0);
  }
  const end = from.clone().add(delta);
  return {
    from: from.clone(),
    to: end,
    distanceMm: Math.round(delta.length() * 1000),
    dxMm: Math.round(delta.x * 1000),
    dyMm: Math.round(delta.y * 1000),
    dzMm: Math.round(delta.z * 1000),
    axis,
  };
}

export function measurementLabel(measurement: Measurement): string {
  return `${formatMillimetres(measurement.distanceMm)} mm`;
}

const MEASURE_COLOUR = "#ff5a36";

function labelSprite(text: string): THREE.Sprite | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const scale = 2;
  const font = `600 ${13 * scale}px "IBM Plex Mono Variable", monospace`;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width) + 16 * scale;
  const height = 24 * scale;
  canvas.width = width;
  canvas.height = height;
  context.font = font;
  context.fillStyle = "rgba(18, 38, 58, 0.92)";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(text, 8 * scale, height / 2 + scale);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false, sizeAttenuation: false }),
  );
  // Without attenuation the scale is a share of the viewport height.
  const labelHeight = 0.034;
  sprite.scale.set(labelHeight * (width / height), labelHeight, 1);
  sprite.renderOrder = 12;
  return sprite;
}

/** The line, end marks and label a measurement draws, kept on the view's overlay. */
export class MeasureOverlay {
  private readonly group = new THREE.Group();
  private readonly lineMaterial = new THREE.LineBasicMaterial({
    color: MEASURE_COLOUR,
    depthTest: false,
    toneMapped: false,
  });
  private readonly markMaterial = new THREE.MeshBasicMaterial({
    color: MEASURE_COLOUR,
    depthTest: false,
    toneMapped: false,
  });
  private readonly markGeometry = new THREE.SphereGeometry(0.018, 12, 8);

  constructor(parent: THREE.Object3D) {
    parent.add(this.group);
  }

  /** Draw the first point alone, or the whole measurement. */
  show(from: THREE.Vector3, measurement: Measurement | null): void {
    this.clear();
    this.addMark(from);
    if (measurement === null) return;
    this.addMark(measurement.to);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([measurement.from, measurement.to]),
      this.lineMaterial,
    );
    line.renderOrder = 11;
    this.group.add(line);
    const label = labelSprite(measurementLabel(measurement));
    if (label !== null) {
      label.position.copy(measurement.from).lerp(measurement.to, 0.5);
      this.group.add(label);
    }
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Line) child.geometry.dispose();
      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
    this.group.clear();
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.lineMaterial.dispose();
    this.markMaterial.dispose();
    this.markGeometry.dispose();
  }

  private addMark(point: THREE.Vector3): void {
    const mark = new THREE.Mesh(this.markGeometry, this.markMaterial);
    mark.position.copy(point);
    mark.renderOrder = 11;
    this.group.add(mark);
  }
}
