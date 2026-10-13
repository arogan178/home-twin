/**
 * The room's lights in the 3D view: each fixture's body, beam and WebGL light,
 * grouped so a drag moves them as one, with the sensors and wall switches.
 * Every light is indexed for selection and dimming without a rebuild.
 */

import * as THREE from "three";

import type { ArchitecturalMaterials } from "./architecturalMaterials";
import { renderConcealedCove } from "./coveRendering";
import { coveBasis, coveLuminance, coveWashes } from "./coveWash";
import {
  addPendant,
  addRope,
  addSpotlight,
  addSwitch,
  createFixtureMaterials,
  pendantShadeCentre,
  pendantShadeMaterial,
} from "./fixtureRendering";
import { beamFootprint, unitDirection } from "./plan";
import { FIELD_PENUMBRA, beamCandela, fieldHalfAngle } from "./render";
import type { Scene } from "./roomEngine";
import type { RoomView3DProps } from "./RoomView3D";
import { switchPoint } from "./switchGeometry";
import type { Fixture } from "./types";

const MM = 0.001;

/** The mouth a cove escapes through, and how far it leans off vertical. */
const COVE_WASH_HEIGHT_M = 0.07;
// A wall wash falls down the face rather than firing across it, so the aim is
// mostly downward with a lean at the wall: 0.35 is about 19 degrees off plumb.
const COVE_WASH_TILT = 0.35;
/** WebGL keeps a bounded number of real lights; extra fixtures still draw a beam. */
export const MAX_REAL_LIGHTS = 16;
/**
 * Texture units a lit material binds besides light shadows: its map, the
 * environment, two area-light lookups, the sun's shadow, and one spare.
 */
const RESERVED_TEXTURE_UNITS = 6;

type Track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T) => T;

/** Add the fixtures, sensors and switches, and index them on the room view for selection and dimming. */
export function addRoomFixtures(
  current: Scene,
  props: Pick<
    RoomView3DProps,
    | "fixtures"
    | "sensors"
    | "switches"
    | "walls"
    | "objects"
    | "offGroups"
    | "floorElevationMm"
    | "taskPlaneElevationMm"
    | "utilizationFactor"
    | "showLightRendering"
    | "showGypsum"
  >,
  finishes: ArchitecturalMaterials,
  track: Track,
  pickable: THREE.Object3D[],
  centre: { readonly span: number },
) {
  const { content, fixtureGroups } = current;
const fixtureMaterials = createFixtureMaterials(track, current.renderer.toneMappingExposure);
const selectedMaterial = track(
  new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0x5a3600, roughness: 0.4 }),
);
// Selection only swaps materials and shows beams, so picking a light does
// not rebuild the room; each selectable mesh remembers what it wears.
current.selectedMaterial = selectedMaterial;
const { selectables, cones, dimTargets } = current;
const selectable = (tag: string, mesh: THREE.Mesh) => {
  const entries = selectables.get(tag) ?? [];
  entries.push({ mesh, normal: mesh.material as THREE.Material });
  selectables.set(tag, entries);
};
const dimLight = (fixture: Fixture, light: THREE.Light) => {
  const base = light.intensity;
  dimTargets.push({
    group: fixture.switching_group,
    dimmable: fixture.spec.dimmable,
    apply: (fraction) => {
      light.intensity = base * fraction;
    },
  });
};
const dimGlow = (fixture: Fixture, material: THREE.MeshStandardMaterial) => {
  const base = material.emissiveIntensity;
  dimTargets.push({
    group: fixture.switching_group,
    dimmable: fixture.spec.dimmable,
    apply: (fraction) => {
      material.emissiveIntensity = base * fraction;
    },
  });
};
// One lamp face per group, so a dimmed group's apertures dim with it.
const lampMaterials = new Map<string, THREE.MeshBasicMaterial>();
const lampMaterialFor = (fixture: Fixture) => {
  const key = `${fixture.switching_group}\u0000${fixture.spec.dimmable}`;
  const existing = lampMaterials.get(key);
  if (existing !== undefined) return existing;
  const lamp = track(new THREE.MeshBasicMaterial({ color: 0xfff2cf, toneMapped: false }));
  const base = lamp.color.clone();
  dimTargets.push({
    group: fixture.switching_group,
    dimmable: fixture.spec.dimmable,
    apply: (fraction) => {
      lamp.color.copy(base).multiplyScalar(0.15 + 0.85 * fraction);
    },
  });
  lampMaterials.set(key, lamp);
  return lamp;
};

let realLightCount = 0;
// A light without a shadow shines through walls, but each shadow map takes a
// texture unit in every lit shader, so the GPU sets the cap. Pendants and
// lights above furniture get the first maps.
const shadowBudget = Math.min(
  MAX_REAL_LIGHTS,
  current.renderer.capabilities.maxTextures - RESERVED_TEXTURE_UNITS,
);
const shadowPriority = (fixture: Fixture): number => {
  if (fixture.kind === "pendant_bulb") return 0;
  if (fixture.kind === "rope_light") return 3;
  return props.objects.some((object) => (
    !object.name.toLowerCase().includes("rug")
    && fixture.point.x >= object.bounds.minimum.x && fixture.point.x <= object.bounds.maximum.x
    && fixture.point.y >= object.bounds.minimum.y && fixture.point.y <= object.bounds.maximum.y
  )) ? 1 : 2;
};
const renderingOrder = [...props.fixtures].sort((a, b) => shadowPriority(a) - shadowPriority(b));
fixtureGroups.clear();
renderingOrder.forEach((fixture) => {
  const active = !props.offGroups.has(fixture.switching_group);
  // One group per light, so a drag moves its body, beam and lamp together
  // without rebuilding the room on every pointer move.
  const group = new THREE.Group();
  content.add(group);
  fixtureGroups.set(fixture.tag, group);
  if (fixture.kind === "rope_light") {
    const material = track(new THREE.MeshStandardMaterial({
      color: active ? 0xfff1dc : 0xd9d3c7,
      emissive: active ? 0xffd5a4 : 0x000000,
      emissiveIntensity: active
        ? (fixture.spec.lumens_per_m ?? 900) / (Math.PI ** 2 * fixture.spec.diameter_mm * MM)
        : 0,
      roughness: 0.35,
    }));
    dimGlow(fixture, material);
    if (fixture.spec.mounting === "concealed") {
      // The wall decides which way the section faces as well as where the
      // wash lands, so it is resolved before either is drawn. A run that
      // turns a corner has one per straight length.
      const washes = coveWashes(fixture, props.walls);
      const wash = washes[0] ?? null;
      const emitters = renderConcealedCove(
        fixture,
        material,
        finishes,
        track,
        group,
        wash?.towards ?? null,
        props.showGypsum,
      );
      for (const emitter of emitters) selectable(fixture.tag, emitter);
      pickable.push(...emitters);
      // A cove is a wall wash. Without a light aimed at the wall the slot
      // glows and lights nothing, which reads as a switched-off strip.
      for (const run of active && props.showLightRendering ? washes : []) {
        const light = track(new THREE.RectAreaLight(
          new THREE.Color(...cctToLinearRgb(fixture.spec.cct_kelvin ?? 2700)),
          coveLuminance(fixture.spec.lumens_per_m ?? 900, COVE_WASH_HEIGHT_M),
          Math.max(run.lengthMm * MM, 0.1),
          COVE_WASH_HEIGHT_M,
        ));
        light.position.set(run.centre.x * MM, run.centre.y * MM, run.centre.z * MM);
        // lookAt would orient the emitting face but take the width axis
        // from the default up vector, leaving an 11 m aperture lying across
        // its own run and radiating like a point at the middle of it.
        const basis = coveBasis(run.along, run.towards, COVE_WASH_TILT);
        light.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(
            new THREE.Vector3(basis.x.x, basis.x.y, basis.x.z),
            new THREE.Vector3(basis.y.x, basis.y.y, basis.y.z),
            new THREE.Vector3(basis.z.x, basis.z.y, basis.z.z),
          ),
        );
        group.add(light);
        dimLight(fixture, light);
        realLightCount += 1;
      }
      return;
    }
    const rope = addRope(group, fixture, material, track);
    pickable.push(rope);
    selectable(fixture.tag, rope);
    return;
  }
  if (fixture.kind === "pendant_bulb") {
    const shadeMaterial = track(pendantShadeMaterial(fixture, active));
    dimGlow(fixture, shadeMaterial);
    const handles = addPendant(group, fixture, shadeMaterial, fixtureMaterials, track);
    for (const handle of handles) {
      pickable.push(handle);
      selectable(fixture.tag, handle);
    }
    if (
      active
      && props.showLightRendering
      && fixture.spec.lumens !== null
      && realLightCount < MAX_REAL_LIGHTS
    ) {
      const light = track(new THREE.PointLight(
        new THREE.Color(...cctToLinearRgb(fixture.spec.cct_kelvin ?? 2700)),
        fixture.spec.lumens / (4 * Math.PI),
        0,
        2,
      ));
      if (realLightCount < shadowBudget) {
        light.castShadow = true;
        light.shadow.mapSize.set(512, 512);
        light.shadow.bias = -0.0008;
      }
      light.position.copy(pendantShadeCentre(fixture));
      group.add(light);
      dimLight(fixture, light);
      realLightCount += 1;
    }
    return;
  }

  for (const handle of addSpotlight(
    group,
    fixture,
    active ? lampMaterialFor(fixture) : fixtureMaterials.baffle,
    fixtureMaterials,
    track,
    props.showGypsum,
  )) {
    pickable.push(handle);
    selectable(fixture.tag, handle);
  }

  if (!props.showLightRendering || !active) return;

  const aim = unitDirection(fixture.direction);
  const footprint = beamFootprint(fixture, props.taskPlaneElevationMm);
  const throwM = Math.max(fixture.point.z - props.taskPlaneElevationMm, 0) * MM;
  if (footprint.radiusMm > 0 && throwM > 0.05) {
    const coneGeometry = track(
      new THREE.ConeGeometry(footprint.radiusMm * MM, throwM, 28, 1, true),
    );
    coneGeometry.translate(0, -throwM / 2, 0);
    // An unlit colour is still tone-mapped at the room's lux exposure, which
    // left the beam invisible over the floor; dividing it out restores it.
    const coneMaterial = track(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0xffd782).multiplyScalar(1 / current.renderer.toneMappingExposure),
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const cone = new THREE.Mesh(coneGeometry, coneMaterial);
    cone.position.set(fixture.point.x * MM, fixture.point.y * MM, fixture.point.z * MM);
    cone.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(aim[0], aim[1], aim[2]).normalize(),
    );
    cone.renderOrder = 4;
    cone.visible = false;
    group.add(cone);
    cones.set(fixture.tag, cone);
  }

  if (realLightCount < MAX_REAL_LIGHTS && fixture.spec.lumens !== null) {
    // Candela from the rated lumens over the beam solid angle, inverse
    // square, no cutoff: the same quantities the illuminance grid uses.
    const light = track(new THREE.SpotLight(
      new THREE.Color(...cctToLinearRgb(fixture.spec.cct_kelvin ?? 3000)),
      beamCandela(fixture.spec.lumens * props.utilizationFactor, fixture.spec.beam_angle_deg),
      0,
      fieldHalfAngle(fixture.spec.beam_angle_deg),
      FIELD_PENUMBRA,
      2,
    ));
    if (realLightCount < shadowBudget) {
      light.castShadow = true;
      // Sixteen maps at 2048 would hold half a gigabyte of video memory.
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.0008;
      light.shadow.camera.near = 0.15;
      light.shadow.camera.far = Math.max(centre.span * 1.5, 8);
    }
    light.position.set(fixture.point.x * MM, fixture.point.y * MM, fixture.point.z * MM - 0.03);
    light.target.position.set(
      fixture.point.x * MM + aim[0],
      fixture.point.y * MM + aim[1],
      fixture.point.z * MM + aim[2],
    );
    group.add(light);
    group.add(light.target);
    dimLight(fixture, light);
    realLightCount += 1;
  }
});

// A sensor selects but does not drag in 3D, like a rope light: the plan is
// where a ceiling position is set, and picking here is for reading it.
const sensorMaterial = track(new THREE.MeshStandardMaterial({ color: 0xdce7d4, roughness: 0.6 }));
for (const sensor of props.sensors ?? []) {
  const puck = new THREE.Mesh(
    track(
      new THREE.CylinderGeometry(
        (sensor.spec.diameter_mm / 2) * MM,
        (sensor.spec.diameter_mm / 2) * MM,
        sensor.spec.mounting_depth_mm * MM,
        24,
      ),
    ),
    sensorMaterial,
  );
  puck.rotation.x = Math.PI / 2;
  puck.position.set(
    sensor.point.x * MM,
    sensor.point.y * MM,
    (sensor.point.z - sensor.spec.mounting_depth_mm / 2) * MM,
  );
  puck.userData.tag = sensor.tag;
  content.add(puck);
  pickable.push(puck);
  selectable(sensor.tag, puck);
}

const switchOnMaterial = track(new THREE.MeshStandardMaterial({ color: 0xf6f0e7, roughness: 0.3 }));
const switchOffMaterial = track(new THREE.MeshStandardMaterial({ color: 0x606568, roughness: 0.75 }));
for (const device of props.switches) {
  const point = switchPoint(device, props.walls, props.floorElevationMm);
  const wall = props.walls.find((candidate) => candidate.wall_id === device.host_wall_id);
  if (point === null || wall === undefined) continue;
  const plate = addSwitch(
    content,
    device,
    wall,
    point,
    props.offGroups.has(device.switching_group) ? switchOffMaterial : switchOnMaterial,
    fixtureMaterials.trim,
    track,
  );
  pickable.push(plate);
  selectable(device.tag, plate);
}
}

/** A rough correlated-colour-temperature tint, for appearance only. */
function cctToLinearRgb(kelvin: number): readonly [number, number, number] {
  const warmth = Math.min(1, Math.max(0, (6500 - kelvin) / 4000));
  return [1, 1 - 0.16 * warmth, 1 - 0.42 * warmth];
}
