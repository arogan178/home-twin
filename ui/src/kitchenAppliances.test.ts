import * as THREE from "three";
import { expect, it } from "vitest";
import { createArchitecturalMaterials } from "./architecturalMaterials";
import { addCooktopMarkings, addMixerTap } from "./kitchenAppliances";

it("places four induction zones inside the glass and stands the BP02 mixer on the deck behind the bowl", () => {
  const finishes = createArchitecturalMaterials();
  const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
  const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => { resources.push(item); return item; };
  try {
    const hob = new THREE.Group();
    addCooktopMarkings(0.8, 0.52, 0.02, finishes, track, hob);
    expect(hob.children.filter((child) => child.name === "Induction zone marking")).toHaveLength(4);
    expect(hob.children.filter((child) => child.name.startsWith("Extractor grille"))).toHaveLength(1);
    const bounds = new THREE.Box3().setFromObject(hob);
    expect(bounds.min.x).toBeGreaterThan(-0.4);
    expect(bounds.max.x).toBeLessThan(0.4);
    expect(bounds.min.y).toBeGreaterThan(-0.26);
    expect(bounds.max.y).toBeLessThan(0.26);
    const sink = new THREE.Group();
    addMixerTap(0.45, 0.2, finishes, track, sink);
    const tap = sink.children.find((child) => child.name === "Curved mixer tap");
    expect(tap).toBeInstanceOf(THREE.Mesh);
    if (!(tap instanceof THREE.Mesh)) throw new Error("Missing tap");
    // Bridgepoint's drawing: 400 high, the side lever ending 93 mm out, the head 217 mm forward of the pillar.
    const tapBounds = new THREE.Box3().setFromObject(tap);
    expect(tapBounds.min.z).toBeCloseTo(0.2, 6);
    expect(tapBounds.max.z).toBeCloseTo(0.6, 3);
    expect(tapBounds.max.x).toBeCloseTo(0.093, 3);
    expect(tapBounds.min.x).toBeCloseTo(-0.036, 3);
    const spray = sink.children.find((child) => child.name === "Curved mixer tap outlet");
    if (spray === undefined) throw new Error("Missing spray face");
    const face = new THREE.Box3().setFromObject(spray).getCenter(new THREE.Vector3());
    expect(face.y).toBeCloseTo(0.262 - 0.217, 3);
    expect(face.z).toBeCloseTo(0.41, 2);
  } finally {
    for (const resource of [...resources, ...finishes.resources]) resource.dispose();
  }
});
