import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import * as THREE from "three";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { afterEach, expect, it, vi } from "vitest";

import { RoomView3D } from "./RoomView3D";
import { WholePlanModel } from "./WholePlanModel";
import * as rendering from "./render";
import { RoomIdSchema, WholePlanSchema } from "./types";

vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  class TestRenderer {
    readonly domElement = document.createElement("canvas");
    readonly shadowMap = {};
    readonly capabilities = { maxTextures: 16 };
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    getSize(size: THREE.Vector2) { return size.set(320, 240); }
    setSize() {}
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: TestRenderer };
});

vi.mock("./render", async () => {
  const actual = await vi.importActual<typeof import("./render")>("./render");
  return { ...actual, createEnvironment: () => new THREE.Texture() };
});

afterEach(() => vi.restoreAllMocks());

const props: ComponentProps<typeof RoomView3D> = {
  polygon: { outer: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { x: 0, y: 3000 }], holes: [] },
  walls: [], openings: [], objects: [], fixtures: [], switches: [],
  offGroups: new Set(), illuminance: null, baked: null,
  stairs: [], darkZones: [], sunPatches: [],
  sunDirection: { x: 0, y: 0, z: 1 }, sunAltitudeDeg: 90, trueNorthDeg: 0,
  floorElevationMm: 0, ceilingElevationMm: 2600, structuralCeilingElevationMm: 2800,
  floorFinish: null, wallFinish: null, featureWallId: null, featureWallColour: null,
  skirting: null, skirtingHeightMm: null, skirtingThicknessMm: null, cladWallIds: [],
  showCeiling: true, isExternal: false, showGypsum: true,
  soffits: [{
    id: "test-bulkhead", kind: "bulkhead", room_id: RoomIdSchema.parse("test-room"),
    name: "Test bulkhead",
    footprint: { outer: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 600 }, { x: 0, y: 600 }], holes: [] },
    elevation_mm: 2400, height_above_floor_mm: 2400, evidence: "test",
  }],
  lowerLevels: [], taskPlaneElevationMm: 800, targetLux: 300, utilizationFactor: 0.6,
  selectedTags: new Set(), showLightRendering: true, showCoverage: false, showDarkZones: false,
  snapMm: 100, onSelect() {}, onMove() {}, onMoveSwitch() {}, onToggleGroup() {},
};

it("releases room ceiling geometry and sun shadow targets when the scene rebuilds", () => {
  const created = rendering.createComposer;
  const scenes: THREE.Scene[] = [];
  vi.spyOn(rendering, "createComposer").mockImplementation((renderer, scene, camera) => {
    scenes.push(scene);
    const composer = created(renderer, scene, camera);
    vi.spyOn(composer, "render").mockImplementation(() => {});
    return composer;
  });
  const view = render(<RoomView3D {...props} />);
  const scene = scenes[0];
  expect(scene).toBeDefined();
  let ceilingGeometryCount = 0;
  let ceilingDisposals = 0;
  let shadowCount = 0;
  let shadowDisposals = 0;
  scene?.traverse((node) => {
    if (node instanceof THREE.Mesh && node.geometry instanceof THREE.ShapeGeometry) {
      ceilingGeometryCount += 1;
      node.geometry.addEventListener("dispose", () => { ceilingDisposals += 1; });
    }
    if (node instanceof THREE.DirectionalLight && node.castShadow) {
      shadowCount += 1;
      node.shadow.map = new THREE.WebGLRenderTarget(16, 16);
      node.shadow.map.addEventListener("dispose", () => { shadowDisposals += 1; });
    }
  });
  expect(ceilingGeometryCount).toBe(3);
  expect(shadowCount).toBe(1);
  view.rerender(<RoomView3D {...props} targetLux={350} />);
  expect({ ceilingDisposals, shadowDisposals }).toEqual({ ceilingDisposals: 3, shadowDisposals: 1 });
  view.unmount();
});

it("releases all postprocessing materials, noise textures, and targets on unmount", () => {
  const created = rendering.createComposer;
  const resources: Array<THREE.Material | THREE.Texture | THREE.WebGLRenderTarget> = [];
  vi.spyOn(rendering, "createComposer").mockImplementation((renderer, scene, camera) => {
    const composer = created(renderer, scene, camera);
    vi.spyOn(composer, "render").mockImplementation(() => {});
    for (const pass of composer.passes) {
      if (pass instanceof GTAOPass) {
        resources.push(
          pass.gtaoNoiseTexture, pass.pdNoiseTexture,
          pass.gtaoRenderTarget, pass.pdRenderTarget,
          pass.gtaoMaterial, pass.pdMaterial, pass.copyMaterial,
          pass.depthRenderMaterial, pass.blendMaterial, pass.normalMaterial,
        );
      } else if (pass instanceof OutputPass) resources.push(pass.material);
    }
    return composer;
  });
  const view = render(<RoomView3D {...props} />);
  expect(resources).toHaveLength(11);
  const disposed = new Set<THREE.Material | THREE.Texture | THREE.WebGLRenderTarget>();
  for (const resource of resources) resource.addEventListener("dispose", () => { disposed.add(resource); });
  view.unmount();
  expect(disposed.size).toBe(11);
});

it("releases the whole-floor sun shadow target on unmount", () => {
  const created = rendering.createComposer;
  const scenes: THREE.Scene[] = [];
  vi.spyOn(rendering, "createComposer").mockImplementation((renderer, scene, camera) => {
    scenes.push(scene);
    const composer = created(renderer, scene, camera);
    vi.spyOn(composer, "render").mockImplementation(() => {});
    return composer;
  });
  const plan = WholePlanSchema.parse({
    revision: "sha256:test",
    site: { id: "site", name: "Unlocated", latitude_deg: null, longitude_deg: null,
      elevation_mm: 0, true_north_deg: 0, timezone: null, evidence: "unstated" },
    constraints: {
      wall_clearance_mm: 500, minimum_spacing_mm: 900, obstruction_clearance_mm: 250,
      shadow_gap_clearance_mm: 200, alignment_tolerance_mm: 50, collision_tolerance_mm: 10,
      target_lux: 300, task_plane_height_mm: 800, utilization_factor: 0.6,
      grid_step_mm: 500, avoid_object_kinds: [],
    },
    rooms: [{
      room: { id: "test-room", name: "Test", storey_id: "storey", elevation_mm: 0,
        bounds: { minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 3000, y: 3000, z: 2800 } } },
      ceiling: { room_id: "test-room", polygon: props.polygon, elevation_mm: 2600, source: "test" },
      walls: [], openings: [], daylight_sources: [], furniture: [], obstructions: [], fixtures: [],
    }],
  });
  const view = render(<WholePlanModel
    plan={plan} selectedRoomId={null} onSelectRoom={() => {}}
    showCeiling={true} showGypsum={true} seeThroughWalls={true}
    offGroups={new Set()} onToggleGroup={() => {}} hour={12}
  />);
  let shadowCount = 0;
  let shadowDisposals = 0;
  scenes[0]?.traverse((node) => {
    if (node instanceof THREE.DirectionalLight && node.castShadow) {
      shadowCount += 1;
      node.shadow.map = new THREE.WebGLRenderTarget(16, 16);
      node.shadow.map.addEventListener("dispose", () => { shadowDisposals += 1; });
    }
  });
  expect(shadowCount).toBe(1);
  view.unmount();
  expect(shadowDisposals).toBe(1);
});
