import * as THREE from "three";

export type ArchitecturalMaterials = {
  readonly floor: THREE.MeshStandardMaterial;
  readonly selectedFloor: THREE.MeshStandardMaterial;
  readonly ground: THREE.MeshStandardMaterial;
  readonly ceiling: THREE.MeshStandardMaterial;
  readonly gypsum: THREE.MeshStandardMaterial;
  readonly wall: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshPhysicalMaterial;
  readonly stair: THREE.MeshStandardMaterial;
  readonly timber: THREE.MeshStandardMaterial;
  readonly frame: THREE.MeshStandardMaterial;
  readonly object: THREE.MeshStandardMaterial;
  readonly joineryWood: THREE.MeshStandardMaterial;
  readonly worktop: THREE.MeshStandardMaterial;
  readonly applianceGlass: THREE.MeshStandardMaterial;
  readonly stainless: THREE.MeshStandardMaterial;
  readonly plinth: THREE.MeshStandardMaterial;
  readonly fabric: THREE.MeshStandardMaterial;
  readonly rug: THREE.MeshStandardMaterial;
  readonly tvScreen: THREE.MeshStandardMaterial;
  readonly pillow: THREE.MeshStandardMaterial;
  readonly hobZone: THREE.MeshStandardMaterial;
  readonly downdraftGrille: THREE.MeshStandardMaterial;
  readonly flexibleDuct: THREE.MeshStandardMaterial;
  readonly anodisedBlack: THREE.MeshStandardMaterial;
  readonly linenOak: THREE.MeshStandardMaterial;
  readonly chrome: THREE.MeshStandardMaterial;
  readonly gunMetal: THREE.MeshStandardMaterial;
  readonly resources: ReadonlyArray<THREE.Material | THREE.Texture>;
};

type Pixel = readonly [number, number, number];

/** Pixels of the large textures, kept because every scene rebuild would otherwise regenerate them. */
const pixelCache = new Map<string, Uint8Array>();

function proceduralTexture(
  pixel: (x: number, y: number) => Pixel,
  repeat: number,
  size = 64,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
  cacheKey?: string,
): THREE.DataTexture {
  let data = cacheKey === undefined ? undefined : pixelCache.get(cacheKey);
  if (data === undefined) {
    data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const [red, green, blue] = pixel(x, y);
        const offset = (y * size + x) * 4;
        data[offset] = red;
        data[offset + 1] = green;
        data[offset + 2] = blue;
        data[offset + 3] = 255;
      }
    }
    if (cacheKey !== undefined) pixelCache.set(cacheKey, data);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.colorSpace = colorSpace;
  // A DataTexture defaults to nearest sampling without mipmaps, which shimmers
  // on every floor and worktop seen at a glancing angle.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) that wraps every `period` cells, so a tile repeats without a seam. */
export function periodicNoise(x: number, y: number, period: number, seed = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number) => hash(((i % period) + period) % period, ((j % period) + period) % period, seed);
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Layered noise over a square tile of `size` texels, starting at `cells` cells across. */
function clouds(x: number, y: number, size: number, cells: number, seed: number): number {
  let total = 0;
  let weight = 0;
  for (let octave = 0, amplitude = 1; octave < 3; octave += 1, amplitude *= 0.5) {
    const period = cells * 2 ** octave;
    total += periodicNoise((x / size) * period, (y / size) * period, period, seed + octave) * amplitude;
    weight += amplitude;
  }
  return total / weight;
}

/**
 * Honed cloudy stone, after the `cloudy` stone of blender/render_finishes.py:
 * a broad mottle that turns toward grey where the noise sits mid-range, with
 * no vein line. Its colours are that material's, converted to sRGB, and the
 * cloud is mixed in at 40% so the slab stays a pale stone.
 */
export function stonePixel(x: number, y: number, size: number): Pixel {
  const noise = clouds(x, y, size, 2, 11);
  const ramp = noise < 0.5 ? (noise - 0.36) / 0.14 : (0.66 - noise) / 0.16;
  const cloud = Math.max(0, Math.min(1, ramp)) * 0.4;
  const speck = hash(x, y, 5) > 0.992 ? -6 : 0;
  const mix = (base: number, grey: number) => clampByte(base + (grey - base) * cloud + speck);
  return [mix(240, 197), mix(239, 197), mix(236, 196)];
}

/** Coverage of a printed ring of radius `ringPx`, `widthPx` wide, centred on a `size` tile. */
export function ringCoverage(x: number, y: number, size: number, ringPx: number, widthPx: number): number {
  const radius = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
  return Math.max(0, Math.min(1, widthPx / 2 + 0.5 - Math.abs(radius - ringPx)));
}

function grain(x: number, y: number): number {
  return ((x * 17 + y * 31 + x * y * 7) % 9) - 4;
}

/** Neutral display finishes; these are visual aids, not authored BIM materials. */
export function createArchitecturalMaterials(): ArchitecturalMaterials {
  // Crown Clean Extreme White with a drop of black:
  // Pure titanium white base let down with carbon black tint.
  // Carbon black absorbs longer wavelengths while Rayleigh-scattering the blue end,
  // giving the cured scrubbable matt film its characteristic subtle cool/steel-blue undertone.
  const crownWhite = proceduralTexture((x, y) => {
    const noise = grain(x, y);
    return [235 + noise, 238 + noise, 243 + noise];
  }, 3);
  const plaster = proceduralTexture((x, y) => {
    const noise = grain(x, y);
    return [239 + noise, 236 + noise, 229 + noise];
  }, 3);
  const limestone = proceduralTexture((x, y) => {
    const grout = x === 0 || y === 0;
    const noise = grain(x, y);
    return grout ? [203, 196, 183] : [218 + noise, 211 + noise, 198 + noise];
  }, 1);
  const paving = proceduralTexture((x, y) => {
    const stagger = Math.floor(y / 16) % 2 === 0 ? 0 : 16;
    const joint = y % 16 < 2 || (x + stagger) % 32 < 2;
    const noise = grain(x, y);
    return joint ? [126, 130, 119] : [164 + noise, 169 + noise, 153 + noise];
  }, 1);
  const oak = proceduralTexture((x, y) => {
    const narrowGrain = (x + Math.floor(Math.sin(y / 11) * 2)) % 17 === 0 ? -7 : 0;
    const variation = Math.round(Math.sin(x / 6) * 3) + Math.round(grain(x, y) / 3);
    return [154 + variation + narrowGrain, 113 + variation + narrowGrain, 77 + variation];
  }, 2);
  // Subtle walnut grain; an illustrative finish, not a manufacturer texture.
  const joineryWoodTexture = proceduralTexture((x, y) => {
    const u = x / 512;
    const v = y / 512;
    const drift = Math.sin(v * Math.PI * 2) * 0.8 + Math.sin(v * Math.PI * 4) * 0.3;
    const ribbons = Math.sin(u * Math.PI * 48 + drift) * 2;
    const pores = Math.pow(Math.abs(Math.sin(u * Math.PI * 186 + drift * 0.4)), 16) * -3;
    const variation = Math.round(ribbons + pores + Math.sin(u * Math.PI * 8) * 3 + grain(x, y) / 3);
    return [136 + variation, 101 + variation, 72 + variation];
  }, 1, 512, THREE.SRGBColorSpace, "walnut");
  // 1.25 m a tile, so an island shows its cloud without the repeat reading.
  const marbleTexture = proceduralTexture((x, y) => stonePixel(x, y, 256), 0.8, 256, THREE.SRGBColorSpace, "stone");
  // Rings drawn into a texture: a 0.8 mm line as geometry is thinner than a pixel and shimmers.
  const hobZoneTexture = proceduralTexture((x, y) => {
    const value = clampByte(ringCoverage(x, y, 128, 60, 2) * 255);
    return [value, value, value];
  }, 1, 128, THREE.NoColorSpace);
  // One rib a tile, repeated once per authored rib, so mipmaps average the grille instead of aliasing it.
  const grilleTexture = proceduralTexture((_x, y) => {
    const rib = Math.max(0, 1 - Math.abs(y + 0.5 - 16) / 3);
    return [clampByte(20 + rib * 150), clampByte(21 + rib * 153), clampByte(22 + rib * 156)];
  }, 1, 32);
  grilleTexture.repeat.set(1, 15);
  // A corrugation profile, one ridge a tile along the duct.
  const ductRibTexture = proceduralTexture((x) => {
    const ridge = clampByte(128 + 127 * Math.cos((2 * Math.PI * (x + 0.5)) / 32));
    return [ridge, ridge, ridge];
  }, 1, 32, THREE.NoColorSpace);
  // Japandi textured bouclé / linen upholstery fabric (warm cream/oatmeal):
  const boucleTexture = proceduralTexture((x, y) => {
    const weave = ((x % 4 < 2 ? 1 : -1) * (y % 4 < 2 ? 1 : -1));
    const noise = grain(x, y);
    const base = 232 + weave * 6 + noise;
    return [base, base - 5, base - 12];
  }, 4);
  // Textured ribbed woven wool rug:
  const woolRugTexture = proceduralTexture((x, y) => {
    const rib = Math.sin(y / 1.8) * 8;
    const noise = grain(x, y);
    const base = Math.round(224 + rib + noise);
    return [base, base - 4, base - 10];
  }, 3);

  const floor = new THREE.MeshStandardMaterial({ map: limestone, color: 0xffffff, roughness: 0.82, metalness: 0 });
  const selectedFloor = new THREE.MeshStandardMaterial({ map: limestone, color: 0xffd79a, roughness: 0.78 });
  const ground = new THREE.MeshStandardMaterial({ map: paving, color: 0xffffff, roughness: 0.96 });
  // Brilliant white, which is a lighter thing than the walls under it.
  const ceiling = new THREE.MeshStandardMaterial({ color: 0xf6f6f4, roughness: 0.95, side: THREE.DoubleSide });
  const gypsum = new THREE.MeshStandardMaterial({ map: plaster, color: 0xffffff, roughness: 0.98, side: THREE.DoubleSide });
  // NCS S 1002-Y, the house paint, tinting the plaster texture.
  const wall = new THREE.MeshStandardMaterial({ map: crownWhite, color: 0xe8e4d9, roughness: 0.9, side: THREE.DoubleSide });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x91b6bd,
    roughness: 0.12,
    metalness: 0,
    transmission: 0.18,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Crema di Roccia: a warm beige Italian marble, honed rather than polished,
  // so it reads warmer and less matte than the limestone floor it sits on.
  const stair = new THREE.MeshStandardMaterial({ map: limestone, color: 0xd9cdb6, roughness: 0.62 });
  const timber = new THREE.MeshStandardMaterial({ map: oak, color: 0xffffff, roughness: 0.72 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x4e5555, roughness: 0.62, metalness: 0.08 });
  const object = new THREE.MeshStandardMaterial({ color: 0xbcb3a5, roughness: 0.84 });
  const joineryWood = new THREE.MeshStandardMaterial({
    map: joineryWoodTexture,
    color: 0xffffff,
    roughness: 0.65,
    metalness: 0.0,
  });
  const worktop = new THREE.MeshStandardMaterial({
    map: marbleTexture,
    color: 0xfbfaf8,
    // Honed, not polished: a soft sheen rather than a mirror.
    roughness: 0.42,
    metalness: 0.02,
  });
  // Ceramic and appliance glass is a dielectric; as a metal it reflected nothing but black.
  const applianceGlass = new THREE.MeshStandardMaterial({
    color: 0x141618,
    roughness: 0.1,
    metalness: 0,
  });
  const stainless = new THREE.MeshStandardMaterial({
    color: 0x9fa4aa,
    roughness: 0.32,
    metalness: 0.88,
  });
  const plinth = new THREE.MeshStandardMaterial({
    color: 0x211f1e,
    roughness: 0.95,
  });
  const fabric = new THREE.MeshStandardMaterial({
    map: boucleTexture,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
  });
  const rug = new THREE.MeshStandardMaterial({
    map: woolRugTexture,
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0.0,
  });
  const tvScreen = new THREE.MeshStandardMaterial({
    color: 0x08090b,
    roughness: 0.08,
    metalness: 0,
  });
  const pillow = new THREE.MeshStandardMaterial({
    color: 0x544f47,
    roughness: 0.88,
    metalness: 0.0,
  });
  const hobZone = new THREE.MeshStandardMaterial({
    color: 0x8a8d90,
    alphaMap: hobZoneTexture,
    transparent: true,
    depthWrite: false,
    roughness: 0.48,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const downdraftGrille = new THREE.MeshStandardMaterial({
    map: grilleTexture,
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  // Flexible white PVC, as the duct is authored: ridges in relief, no colour banding.
  const flexibleDuct = new THREE.MeshStandardMaterial({
    color: 0xf3f3f1,
    bumpMap: ductRibTexture,
    bumpScale: 1.5,
    roughness: 0.55,
  });
  // Black anodised aluminium, as a gola profile or a sliding-door track is sold:
  // a satin metal, so the channel reads as a fitting rather than as a hole.
  const anodisedBlack = new THREE.MeshStandardMaterial({
    color: 0x1c1c1d,
    roughness: 0.45,
    metalness: 0.6,
  });
  // A pale warm oak for joinery interiors: the oak figure lifted by a colour
  // above one rather than a second texture, so the grain stays the same scale.
  const linenOak = new THREE.MeshStandardMaterial({
    map: oak,
    color: new THREE.Color(1.36, 1.34, 1.3),
    roughness: 0.7,
  });
  // The scene's environment is deliberately faint, so a high metalness reflects
  // almost nothing and reads black. These hold their colour at 0.3.
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.3, roughness: 0.22 });
  // Bridgepoint gun metal, as the BP02 tap and the BPS sink are sold.
  const gunMetal = new THREE.MeshStandardMaterial({ color: 0x77716b, metalness: 0.3, roughness: 0.3 });

  return {
    floor,
    selectedFloor,
    ground,
    ceiling,
    gypsum,
    wall,
    glass,
    stair,
    timber,
    frame,
    object,
    joineryWood,
    worktop,
    applianceGlass,
    stainless,
    plinth,
    fabric,
    rug,
    tvScreen,
    pillow,
    hobZone,
    downdraftGrille,
    flexibleDuct,
    anodisedBlack,
    linenOak,
    chrome,
    gunMetal,
    resources: [
      crownWhite,
      plaster,
      limestone,
      paving,
      oak,
      joineryWoodTexture,
      marbleTexture,
      boucleTexture,
      woolRugTexture,
      hobZoneTexture,
      grilleTexture,
      ductRibTexture,
      floor,
      selectedFloor,
      ground,
      ceiling,
      gypsum,
      wall,
      glass,
      stair,
      timber,
      frame,
      object,
      joineryWood,
      worktop,
      applianceGlass,
      stainless,
      plinth,
      fabric,
      rug,
      tvScreen,
      pillow,
      hobZone,
      downdraftGrille,
      flexibleDuct,
      anodisedBlack,
      linenOak,
      chrome,
      gunMetal,
    ],
  };
}

export function slabGeometry(shape: THREE.Shape, depthM = 0.08): THREE.ExtrudeGeometry {
  return new THREE.ExtrudeGeometry(shape, { depth: depthM, bevelEnabled: false, curveSegments: 1 });
}

/** An extrusion with a rounded arris, inset so it fills exactly the shape and depth it is given. */
export function softExtrudeGeometry(shape: THREE.Shape, depthM: number, arrisM: number, curveSegments = 12): THREE.ExtrudeGeometry {
  const arris = Math.min(arrisM, depthM / 4);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depthM - arris * 2,
    bevelEnabled: true,
    bevelThickness: arris,
    bevelSize: arris,
    bevelOffset: -arris,
    bevelSegments: 2,
    curveSegments,
  });
  geometry.translate(0, 0, arris);
  return geometry;
}

export function finishMesh(mesh: THREE.Mesh, castShadow = true): THREE.Mesh {
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}
