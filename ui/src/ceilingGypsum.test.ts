import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createArchitecturalMaterials } from "./architecturalMaterials";
import {
  fasciaEdges,
  insetRingAtReveals,
  isCeilingReveal,
  renderCeilingReveal,
  revealRuns,
} from "./ceilingGypsum";
import type { BuildingObject } from "./types";

function revealObject(tag: string, start: [number, number], end: [number, number]): BuildingObject {
  return {
    id: tag, ifc_class: "IfcBuildingElementProxy", kind: "shadow_gap", name: `${tag} reveal`, room_ids: ["r"],
    bounds: { minimum: { x: 0, y: 0, z: 3650 }, maximum: { x: 1, y: 1, z: 3730 } },
    properties: {
      Tag: tag,
      "Pset_HomeTwinReveal.WidthMm": 70,
      "Pset_HomeTwinReveal.DepthMm": 80,
      "Pset_HomeTwinReveal.StartX": start[0],
      "Pset_HomeTwinReveal.StartY": start[1],
      "Pset_HomeTwinReveal.EndX": end[0],
      "Pset_HomeTwinReveal.EndY": end[1],
    },
  };
}

const SQUARE = [
  { x: 0, y: 0 },
  { x: 4000, y: 0 },
  { x: 4000, y: 3000 },
  { x: 0, y: 3000 },
];

describe("perimeter gypsum reveals", () => {
  it("reads a reveal back from the properties the model authored", () => {
    const runs = revealRuns([revealObject("CRV-TV", [4000, 0], [4000, 3000])]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ tag: "CRV-TV", widthMm: 70, depthMm: 80 });
  });

  it("ignores an object that is not a reveal", () => {
    const plain: BuildingObject = {
      id: "beam", ifc_class: "IfcBeam", kind: "beam", name: "Beam", room_ids: ["r"],
      bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 1, y: 1, z: 1 } }, properties: {},
    };
    expect(revealRuns([plain])).toHaveLength(0);
    expect(isCeilingReveal(plain)).toBe(false);
    expect(isCeilingReveal(revealObject("CRV-TV", [4000, 0], [4000, 3000]))).toBe(true);
  });

  it("pulls the gypsum 70 mm off the wall a reveal follows and leaves the rest", () => {
    const inset = insetRingAtReveals(SQUARE, revealRuns([revealObject("CRV-E", [4000, 0], [4000, 3000])]));
    // The east edge moves in; both corners on it follow, and the west edge holds.
    expect(inset[1]).toEqual({ x: 3930, y: 0 });
    expect(inset[2]).toEqual({ x: 3930, y: 3000 });
    expect(inset[0]).toEqual({ x: 0, y: 0 });
    expect(inset[3]).toEqual({ x: 0, y: 3000 });
  });

  it("insets a turned wall along its own normal", () => {
    const diagonal = [
      { x: 0, y: 0 },
      { x: 3000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    const inset = insetRingAtReveals(diagonal, revealRuns([revealObject("CRV-D", [0, 0], [3000, 3000])]));
    // The corner stays on the west wall it still meets and slides up it instead,
    // by 70 / sin(45) because that wall is 45 degrees off the reveal.
    expect(inset[0]!.x).toBeCloseTo(0, 6);
    expect(inset[0]!.y).toBeCloseTo(70 * Math.SQRT2, 3);
    expect(inset[2]).toEqual({ x: 0, y: 3000 });
  });

  it("does not throw a corner across the room when the neighbour is near-parallel", () => {
    // The open plan's slanting wall is three faces about two degrees apart.
    // Mitring an inset edge against an un-inset one that shallow put this
    // corner six metres outside the room.
    const kinked = [
      { x: 9889, y: 10002 },
      { x: 9999, y: 9900 },
      { x: 20540, y: 350 },
      { x: 22106, y: 350 },
      { x: 22106, y: 10002 },
    ];
    const inset = insetRingAtReveals(kinked, revealRuns([revealObject("S", [9999, 9900], [20540, 350])]));
    for (const [index, vertex] of inset.entries()) {
      const moved = Math.hypot(vertex.x - kinked[index]!.x, vertex.y - kinked[index]!.y);
      expect(moved).toBeLessThanOrEqual(70 * 3);
    }
    // The corner it cannot mitre steps straight off the edge that moved.
    expect(Math.hypot(inset[1]!.x - 9999, inset[1]!.y - 9900)).toBeCloseTo(70, 3);
  });

  it("slides a mitred corner along the wall the gypsum still meets", () => {
    // The slanting wall meets the south wall at 42.2 degrees, so a 70 mm inset
    // moves that corner 70 / sin(42.2) along the south wall.
    const inset = insetRingAtReveals(
      [
        { x: 9999, y: 9900 },
        { x: 20540, y: 350 },
        { x: 22106, y: 350 },
        { x: 22106, y: 9900 },
      ],
      revealRuns([revealObject("S", [9999, 9900], [20540, 350])]),
    );
    expect(inset[1]!.y).toBeCloseTo(350, 6);
    expect(inset[1]!.x).toBeCloseTo(20540 + 70 / Math.sin(Math.atan2(9550, 10541)), 1);
  });

  it("leaves a ring alone when nothing is revealed", () => {
    expect(insetRingAtReveals(SQUARE, [])).toBe(SQUARE);
  });

  it("insets the same way whichever way round the reveal was authored", () => {
    const forward = insetRingAtReveals(SQUARE, revealRuns([revealObject("A", [4000, 0], [4000, 3000])]));
    const reversed = insetRingAtReveals(SQUARE, revealRuns([revealObject("A", [4000, 3000], [4000, 0])]));
    expect(reversed).toEqual(forward);
  });
});

describe("bulkhead fascia edges", () => {
  // An L in the north-east corner: two edges die into walls, four face the room.
  const SOFFIT = [
    { x: 2000, y: 2000 },
    { x: 3400, y: 2000 },
    { x: 3400, y: 500 },
    { x: 4000, y: 500 },
    { x: 4000, y: 3000 },
    { x: 2000, y: 3000 },
  ];

  it("returns only the edges that face the room", () => {
    const edges = fasciaEdges(SOFFIT, SQUARE);
    const described = edges.map(([a, b]) => `${a.x},${a.y}->${b.x},${b.y}`);
    expect(described).toEqual([
      "2000,2000->3400,2000",
      "3400,2000->3400,500",
      "3400,500->4000,500",
      "2000,3000->2000,2000",
    ]);
  });

  it("drops the edges lying on a wall", () => {
    const described = fasciaEdges(SOFFIT, SQUARE).map(([a, b]) => `${a.x},${a.y}->${b.x},${b.y}`);
    expect(described).not.toContain("4000,500->4000,3000");
    expect(described).not.toContain("4000,3000->2000,3000");
  });
});


describe("the reveal section", () => {
  const GYPSUM_Z = 3650;
  const STRUCTURAL_Z = 3750;

  function build(backingZ: number | null) {
    const materials = createArchitecturalMaterials();
    const resources: Array<THREE.Material | THREE.BufferGeometry> = [];
    const track = <T extends THREE.Material | THREE.BufferGeometry>(item: T): T => {
      resources.push(item);
      return item;
    };
    const group = new THREE.Group();
    const run = revealRuns([revealObject("CRV", [0, 4000], [6000, 4000])])[0]!;
    renderCeilingReveal(run, GYPSUM_Z, backingZ, materials, track, group);
    group.updateMatrixWorld(true);
    return {
      group,
      dispose: () => {
        for (const resource of [...resources, ...materials.resources]) resource.dispose();
      },
    };
  }

  it("closes the slot with the soffit above it", () => {
    const { group, dispose } = build(STRUCTURAL_Z);
    try {
      const soffit = group.getObjectByName("Reveal soffit");
      expect(soffit).toBeDefined();
      const box = new THREE.Box3().setFromObject(soffit!);
      // Its face lands on the slab, so it backs the slot without standing proud
      // of it or fighting the ceiling plane for the same depth.
      expect(box.max.z * 1000).toBeCloseTo(STRUCTURAL_Z, 3);
      expect(box.min.z * 1000).toBeCloseTo(STRUCTURAL_Z - 2, 3);
    } finally {
      dispose();
    }
  });

  it("leaves the soffit to the ceiling plane when that is already drawn", () => {
    const { group, dispose } = build(null);
    try {
      expect(group.getObjectByName("Reveal soffit")).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("keeps the slot open rather than filling it with the lip", () => {
    const { group, dispose } = build(null);
    try {
      let highestInSlot = GYPSUM_Z;
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || child.name === "Reveal upstand") return;
        highestInSlot = Math.max(highestInSlot, new THREE.Box3().setFromObject(child).max.z * 1000);
      });
      // The lip assembly sits in the bottom quarter of the 100 mm slot, so the
      // gap still shows the soffit rather than reading as a solid moulding.
      expect(highestInSlot - GYPSUM_Z).toBeLessThan(25);
    } finally {
      dispose();
    }
  });
});
