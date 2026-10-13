import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  applyWallOcclusion,
  createSeeThroughWallMaterial,
  invalidateWallOcclusion,
  refreshWallOcclusion,
  floorProbePoints,
  trackWallForOcclusion,
  wallsInTheWay,
} from "./wallOcclusion";

/** A stand-in for a 3D view, mutable so a test can flip the toggle. */
type TestView = {
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3 };
  walls: THREE.Mesh[];
  seeThrough: THREE.Material;
  veiledSince: { from: THREE.Vector3; to: THREE.Vector3 };
  seeThroughEnabled: boolean;
};

function testView(walls: THREE.Mesh[], seeThrough: THREE.Material): TestView {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -5, 1.2);
  return {
    camera,
    controls: { target: new THREE.Vector3(0, 5, 1.2) },
    walls,
    seeThrough,
    veiledSince: { from: new THREE.Vector3(Infinity, 0, 0), to: new THREE.Vector3(Infinity, 0, 0) },
    seeThroughEnabled: true,
  };
}

const SOLID = new THREE.MeshStandardMaterial({ color: 0xffffff });

/** A thin upright slab spanning `fromX` to `toX` at `y`, in metres. */
function wall(fromX: number, toX: number, y: number, name = "wall"): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(toX - fromX, 0.15, 2.4), SOLID);
  mesh.position.set((fromX + toX) / 2, y, 1.2);
  mesh.name = name;
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("wallsInTheWay", () => {
  const camera = new THREE.Vector3(0, -5, 1.2);

  it("takes out the wall between the camera and what it is aimed at", () => {
    const between = wall(-3, 3, 0, "between");
    const found = wallsInTheWay(camera, new THREE.Vector3(0, 5, 1.2), [between]);

    expect(found).toEqual([between]);
  });

  it("leaves a wall standing behind the target", () => {
    const beyond = wall(-3, 3, 8, "beyond");

    expect(wallsInTheWay(camera, new THREE.Vector3(0, 5, 1.2), [beyond])).toEqual([]);
  });

  it("leaves the wall the viewer aimed at, whose face is where the target sits", () => {
    // A double-click puts the target on the surface it hit, so the wall it
    // belongs to is exactly at the target distance and must stay solid.
    const faced = wall(-3, 3, 0, "faced");

    expect(wallsInTheWay(camera, new THREE.Vector3(0, -0.075, 1.2), [faced])).toEqual([]);
  });

  it("takes a wall that covers the view without crossing its centre", () => {
    // The centre ray passes at x = 0 and misses; the ring probe reaches x = 0.3.
    const offCentre = wall(0.2, 4, 0, "offCentre");

    expect(wallsInTheWay(camera, new THREE.Vector3(0, 5, 1.2), [offCentre])).toEqual([offCentre]);
    expect(wallsInTheWay(camera, new THREE.Vector3(0, 5, 1.2), [offCentre], 0)).toEqual([]);
  });

  it("takes only the first wall, leaving the depth behind it readable", () => {
    const near = wall(-3, 3, 0, "near");
    const behind = wall(-3, 3, 3, "behind");

    const found = wallsInTheWay(camera, new THREE.Vector3(0, 6, 1.2), [near, behind]);

    expect(found.map((item) => item.name)).toEqual(["near"]);
  });

  it("leaves every wall standing from a plan view, where the ceiling toggle is the control", () => {
    const below = wall(-3, 3, 0, "below");

    const target = new THREE.Vector3(0, 2, 0.2);
    expect(wallsInTheWay(new THREE.Vector3(0, 0, 20), new THREE.Vector3(0, 0, 0), [below])).toEqual([]);
    // 70 degrees below the horizon is still a plan view. 32 is someone
    // standing back and looking into a room, where the wall is in the way.
    expect(wallsInTheWay(new THREE.Vector3(0, -1.1, 8.72), target, [below])).toEqual([]);
    expect(wallsInTheWay(new THREE.Vector3(0, -4, 4), target, [below])).toEqual([below]);
  });

  it("reports nothing for no walls or a target on the camera", () => {
    expect(wallsInTheWay(camera, new THREE.Vector3(0, 5, 1.2), [])).toEqual([]);
    expect(wallsInTheWay(camera, camera.clone(), [wall(-3, 3, 0)])).toEqual([]);
  });
});

describe("applyWallOcclusion", () => {
  it("swaps a wall to the faint material and back, and keeps its shadow", () => {
    const walls: THREE.Mesh[] = [];
    const near = wall(-3, 3, 0, "near");
    const far = wall(-3, 3, 8, "far");
    near.castShadow = true;
    far.castShadow = true;
    trackWallForOcclusion(near, walls);
    trackWallForOcclusion(far, walls);
    const faint = createSeeThroughWallMaterial();

    applyWallOcclusion(walls, [near], faint);
    expect(near.material).toBe(faint);
    expect(near.castShadow).toBe(true);
    expect(far.material).toBe(SOLID);
    expect(far.castShadow).toBe(true);

    applyWallOcclusion(walls, [], faint);
    expect(near.material).toBe(SOLID);
    expect(near.castShadow).toBe(true);
    faint.dispose();
  });

  it("leaves a wall alone when its own material was never recorded", () => {
    const stray = wall(-3, 3, 0, "stray");
    const faint = createSeeThroughWallMaterial();

    applyWallOcclusion([stray], [stray], faint);

    expect(stray.material).toBe(SOLID);
    faint.dispose();
  });
});

describe("refreshWallOcclusion", () => {
  it("does no work while the view is still, and picks up again once it moves", () => {
    const walls: THREE.Mesh[] = [];
    const between = wall(-3, 3, 0, "between");
    trackWallForOcclusion(between, walls);
    const faint = createSeeThroughWallMaterial();
    const view = testView(walls, faint);

    refreshWallOcclusion(view);
    expect(between.material).toBe(faint);

    // Put it back by hand: a still view must not notice, which is the proof
    // that the second call did nothing at all.
    between.material = SOLID;
    refreshWallOcclusion(view);
    expect(between.material).toBe(SOLID);

    view.camera.position.set(0.5, -5, 1.2);
    refreshWallOcclusion(view);
    expect(between.material).toBe(faint);
    faint.dispose();
  });

  it("restores every wall when the viewer turns the fading off", () => {
    const walls: THREE.Mesh[] = [];
    const between = wall(-3, 3, 0, "between");
    trackWallForOcclusion(between, walls);
    const faint = createSeeThroughWallMaterial();
    const view = testView(walls, faint);

    refreshWallOcclusion(view);
    expect(between.material).toBe(faint);

    view.seeThroughEnabled = false;
    invalidateWallOcclusion(view);
    refreshWallOcclusion(view);

    expect(between.material).toBe(SOLID);
    faint.dispose();
  });

  it("settles a rebuilt wall without waiting for the view to move", () => {
    // A switch click rebuilds the content, so the walls arrive solid while
    // the camera has not moved at all.
    const faint = createSeeThroughWallMaterial();
    const view = testView([], faint);
    refreshWallOcclusion(view);

    const rebuilt = wall(-3, 3, 0, "rebuilt");
    trackWallForOcclusion(rebuilt, view.walls);
    invalidateWallOcclusion(view);
    refreshWallOcclusion(view);

    expect(rebuilt.material).toBe(faint);
    faint.dispose();
  });
});

describe("the reported case: looking at the kitchen past the slanting wall", () => {
  /** A wall built the way both 3D views build one, from the plan's own metres. */
  function planWall(
    sx: number,
    sy: number,
    ex: number,
    ey: number,
    thicknessM: number,
    baseZ: number,
    topZ: number,
    name: string,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(Math.hypot(ex - sx, ey - sy), thicknessM, topZ - baseZ),
      SOLID,
    );
    mesh.rotation.z = Math.atan2(ey - sy, ex - sx);
    mesh.position.set((sx + ex) / 2, (sy + ey) / 2, (baseZ + topZ) / 2);
    mesh.name = name;
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  it("gives way on the diagonal facade and leaves the walls that are not in the way", () => {
    // An open plan with a 250 mm diagonal south-west facade, the east wall
    // beside the kitchen, and the island the viewer wants to see.
    const slant = planWall(9.999, 9.9, 20.54, 0.35, 0.25, 1.05, 3.65, "slant");
    const east = planWall(19.228, 5.337, 19.228, 9.739, 0.15, 1.05, 3.65, "east");
    const island = new THREE.Vector3(17.328, 6.939, 1.92);

    // 4 m up and south of the facade. From much higher the view clears the
    // wall head anyway, which is the zooming and craning being replaced.
    const found = wallsInTheWay(new THREE.Vector3(17, 1, 4), island, [slant, east]);

    expect(found.map((wall) => wall.name)).toEqual(["slant"]);
  });
});

describe("floor probes", () => {
  it("draws each corner 0.25 m in towards the middle, and adds the middle, just above the floor", () => {
    const points = floorProbePoints([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], 1);
    const inset = 0.25 / Math.SQRT2;
    expect(points.map((point) => point.toArray().map((value) => Number(value.toFixed(4))))).toEqual([
      [Number(inset.toFixed(4)), Number(inset.toFixed(4)), 1.05],
      [Number((4 - inset).toFixed(4)), Number(inset.toFixed(4)), 1.05],
      [Number((4 - inset).toFixed(4)), Number((4 - inset).toFixed(4)), 1.05],
      [Number(inset.toFixed(4)), Number((4 - inset).toFixed(4)), 1.05],
      [2, 2, 1.05],
    ]);
  });

  it("fades both near walls of a small room seen from its corner, not only the one on the centre ray", () => {
    const south = wall(0, 3, 0, "south");
    const west = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3, 2.4), SOLID);
    west.position.set(0, 1.5, 1.2);
    west.name = "west";
    west.updateMatrixWorld(true);
    const camera = new THREE.Vector3(-1.2, -4.5, 4.2);
    const target = new THREE.Vector3(1.5, 1.5, 0.9);
    const probes = floorProbePoints([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }], 0);

    expect(wallsInTheWay(camera, target, [south, west]).map((item) => item.name)).toEqual(["south"]);
    expect(wallsInTheWay(camera, target, [south, west], 0.6, probes).map((item) => item.name).sort()).toEqual([
      "south",
      "west",
    ]);
  });
});

describe("wall groups", () => {
  it("fades every piece of a wall with the one the sightline met, and nothing else", () => {
    const faint = createSeeThroughWallMaterial();
    const walls: THREE.Mesh[] = [];
    const left = wall(-3, -1, 0, "left of the door");
    const lintel = wall(-1, 1, 0, "over the door");
    const other = wall(-3, 3, 4, "another wall");
    trackWallForOcclusion(left, walls, "W1");
    trackWallForOcclusion(lintel, walls, "W1");
    trackWallForOcclusion(other, walls, "W2");

    applyWallOcclusion(walls, [left], faint);

    expect(walls.map((item) => item.material === faint)).toEqual([true, true, false]);
  });
});
