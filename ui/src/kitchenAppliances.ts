import * as THREE from "three";
import type { ArchitecturalMaterials } from "./architecturalMaterials";
import { addTap, type TapEnvelope } from "./tapGeometry";

type Track = <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T;

/** BP02 from its drawing: Ø45 body, 245 projection, 400 high. */
const BP02_ENVELOPE: TapEnvelope = { bodyRadius: 0.0225, reach: 0.245, height: 0.4 };

/** Illustrative appliance details in cabinet-local coordinates, with Z upright. */
export function addMixerTap(depth: number, height: number, finishes: ArchitecturalMaterials, track: Track, group: THREE.Group) {
  const rear = depth / 2 + 0.037;
  // The sink's stated mixer is the Bridgepoint BP028303GM in gun metal; its drawing sets the size.
  addTap(finishes, track, group, {
    model: "bridgepoint-bp02",
    envelope: BP02_ENVELOPE,
    finish: "gunmetal",
    name: "Curved mixer tap",
    position: new THREE.Vector3(0, rear, height),
    rotation: 0,
  });
  const drain = new THREE.Mesh(track(new THREE.CircleGeometry(0.027, 24)), finishes.plinth);
  drain.position.set(0, 0, 0.0128);
  drain.name = "Sink drain";
  group.add(drain);
  const ring = new THREE.Mesh(track(new THREE.RingGeometry(0.024, 0.032, 32)), finishes.stainless);
  ring.position.z = 0.013;
  group.add(ring);
}

export function addCooktopMarkings(width: number, depth: number, height: number, finishes: ArchitecturalMaterials, track: Track, group: THREE.Group) {
  const radius = Math.min(width * 0.18, depth * 0.19);
  // The texture prints its ring at 60 of 64 texels from the centre.
  const zone = track(new THREE.CircleGeometry(radius * 64 / 60, 48));
  for (const x of [-width * 0.29, width * 0.29]) {
    for (const y of [-depth * 0.25, depth * 0.25]) {
      const ring = new THREE.Mesh(zone, finishes.hobZone);
      ring.position.set(x, y, height + 0.0006);
      ring.name = "Induction zone marking";
      group.add(ring);
    }
  }
  const grateDepth = Math.min(depth - 0.1, 0.36);
  const opening = new THREE.Mesh(track(new THREE.BoxGeometry(0.085, grateDepth, 0.003)), finishes.plinth);
  opening.position.z = height + 0.002;
  opening.name = "Downdraft opening";
  group.add(opening);
  const grille = new THREE.Mesh(track(new THREE.PlaneGeometry(0.078, grateDepth)), finishes.downdraftGrille);
  grille.position.z = height + 0.004;
  grille.name = "Extractor grille";
  group.add(grille);
}
