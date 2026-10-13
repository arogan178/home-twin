/**
 * Shared lighting setup for the two derived 3D views.
 *
 * Light here is quantitative: a spotlight is driven at the candela its rated
 * lumens and beam angle imply, falls off with inverse square, and sits under an
 * indirect term the model itself states, so the picture and the numbers move
 * together. What the renderer adds on top of that - the environment sheen, the
 * softened cone edge, ambient occlusion, and the exposure that fits lux into a
 * display - is appearance and carries no lighting claim.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

/** Task-plane illuminance a view exposes for when the layout states no target. */
export const DEFAULT_REFERENCE_LUX = 300;

/**
 * Real downlights fade past their rated beam, so the cone is drawn out to a
 * wider field angle with the half-intensity crossing back at the rated edge.
 */
const FIELD_ANGLE_RATIO = 1.3;

/** Puts the smoothstep midpoint of the cone back on the rated beam angle. */
export const FIELD_PENUMBRA = 1 - (2 - FIELD_ANGLE_RATIO) / FIELD_ANGLE_RATIO;

/** Widest cone three.js will accept, less a margin for the field widening. */
const MAX_CONE_ANGLE = Math.PI / 2 - 0.01;

/**
 * Share of the target illuminance used as indirect light before a shadow pass
 * has stated the room's own interreflection. Appearance only: it stops
 * unlit surfaces reading as black, and says nothing about where bounce lands.
 */
const ASSUMED_INDIRECT_SHARE = 0.15;

/**
 * Display radiance a pale surface reaches at the reference illuminance, times
 * pi. Derived from `L = E x rho / pi` for a 0.8-reflectance surface landing
 * near the top of the tone curve.
 */
const REFERENCE_EXPOSURE_PRODUCT = 3.5;

/**
 * Axial candela for a fixture's rated lumens spread over its beam solid angle.
 *
 * three.js light intensity is candela, and its own `power` setter divides by a
 * fixed pi steradians, so a 15 degree and a 120 degree downlight of the same
 * output would render equally bright. The beam solid angle is the whole point
 * of a downlight, so the conversion uses it.
 */
export function beamCandela(lumens: number, beamAngleDeg: number): number {
  const halfAngle = (Math.min(Math.max(beamAngleDeg, 1), 180) * Math.PI) / 360;
  return lumens / (2 * Math.PI * (1 - Math.cos(halfAngle)));
}

/** Half-angle of the drawn cone, wider than the rated beam by the field ratio. */
export function fieldHalfAngle(beamAngleDeg: number): number {
  const halfAngle = (Math.min(Math.max(beamAngleDeg, 1), 180) * Math.PI) / 360;
  return Math.min(halfAngle * FIELD_ANGLE_RATIO, MAX_CONE_ANGLE);
}

/**
 * Indirect irradiance the view lights surfaces with, in lux.
 *
 * A shadow pass states the room's own interreflection, so use it when there is
 * one. Shadow maps only subtract light, so without a standing indirect term
 * every shadowed surface renders black.
 */
export function indirectIrradianceLux(bounceLux: number | null, referenceLux: number): number {
  if (bounceLux !== null && bounceLux > 0) return bounceLux;
  return referenceLux * ASSUMED_INDIRECT_SHARE;
}

/**
 * Tone-mapping exposure that puts a pale surface at the reference illuminance
 * near the top of the display range.
 *
 * Lights are driven in lux, which a display would otherwise clip to white.
 * Exposing against the layout's own target keeps brightness monotonic in lux
 * and comparable between two layouts of the same room.
 */
export function exposureForReferenceLux(referenceLux: number): number {
  return REFERENCE_EXPOSURE_PRODUCT / Math.max(referenceLux, 1);
}

/**
 * An indoor image-based light.
 *
 * `MeshStandardMaterial` without one has no indirect specular term at all, so
 * every surface returns a single flat colour however it is lit.
 */
export function createEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const generator = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const target = generator.fromScene(environment, 0.04);
  generator.dispose();
  environment.dispose();
  return target.texture;
}

class ViewComposer extends EffectComposer {
  override dispose(): void {
    for (const pass of this.passes) {
      pass.dispose();
      // Three's GTAOPass.dispose omits these two owned shader materials.
      if (pass instanceof GTAOPass) {
        pass.gtaoMaterial.dispose();
        pass.blendMaterial.dispose();
      }
    }
    super.dispose();
  }
}

/**
 * The render pipeline: the scene, ambient occlusion, then tone mapping.
 *
 * Occlusion is what makes a corner read as a corner and an object read as
 * standing on the floor rather than floating over it.
 */
export function createComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): EffectComposer {
  const composer = new ViewComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const occlusion = new GTAOPass(scene, camera);
  occlusion.output = GTAOPass.OUTPUT.Default;
  occlusion.blendIntensity = 0.85;
  occlusion.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.6, thickness: 0.4, scale: 1.1 });
  composer.addPass(occlusion);
  composer.addPass(new OutputPass());
  return composer;
}
