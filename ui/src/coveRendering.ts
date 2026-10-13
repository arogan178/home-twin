import * as THREE from "three";
import type { ArchitecturalMaterials } from "./architecturalMaterials";
import type { Vec2 } from "./plan";
import type { Fixture } from "./types";

/** Illustrative gypsum reveal around the retained concealed-light centreline. */
export function renderConcealedCove(
  fixture: Extract<Fixture, { kind: "rope_light" }>,
  material: THREE.Material,
  finishes: ArchitecturalMaterials,
  track: <T extends THREE.Material | THREE.BufferGeometry>(item: T) => T,
  content: THREE.Group,
  /** Plan direction of the wall this cove washes, or null when unknown. */
  towards: Vec2 | null = null,
  /**
   * Whether the ceiling construction the cove sits in is drawn. Without it the
   * profile still casts, as the hidden slab does, but writes nothing, so the
   * strip does not float as a line across the room. Returns no emitters then.
   */
  drawn = true,
): THREE.Mesh[] {
  const emitters: THREE.Mesh[] = [];
  const unseen = drawn
    ? null
    : track(new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  fixture.path.slice(1).forEach((end, index) => {
    const start = fixture.path[index]!;
    const dx = (end.x - start.x) / 1000;
    const dy = (end.y - start.y) / 1000;
    const length = Math.hypot(dx, dy);
    if (!length) return;
    const group = new THREE.Group();
    group.position.set((start.x + end.x) / 2000, (start.y + end.y) / 2000, (start.z + end.z) / 2000);
    group.rotation.z = Math.atan2(dy, dx);
    content.add(group);
    const box = (depth: number, height: number, y: number, z: number, finish: THREE.Material) => {
      const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(length, depth, height)), unseen ?? finish);
      mesh.position.set(0, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    // The reveal already cuts the slot and returns the gypsum edge, so a section
    // drawn here too reads as trunking sitting inside the slot. Only what the
    // slot holds belongs here: the extrusion on the return, and the strip in it.
    // Local +Y is left of the run, so the wall is whichever way `towards` leans.
    const left = { x: -dy / length, y: dx / length };
    const side = towards === null || towards.x * left.x + towards.y * left.y >= 0 ? 1 : -1;
    box(0.02, 0.02, -0.02 * side, 0.055, finishes.stainless);
    const emitter = box(0.012, 0.004, -0.006 * side, 0.045, material);
    if (unseen !== null) return;
    emitter.userData.tag = fixture.tag;
    emitters.push(emitter);
  });
  return emitters;
}
