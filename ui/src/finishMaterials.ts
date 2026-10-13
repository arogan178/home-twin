import * as THREE from "three";

import type { ArchitecturalMaterials } from "./architecturalMaterials";

type Track = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(item: T) => T;

/** A display colour per authored finish name; anything unknown falls back to the house default. */
const TILE_COLOURS: Readonly<Record<string, number>> = {
  grey_tile: 0xcecfca,
  light_grey_tile: 0xd1d1cf,
  yellow_stone_tile: 0xdbd3c1,
  tamy_sand_tile: 0xd2c7b2,
  crema_di_roccia: 0xe0d7c6,
};

/** A skirting is too narrow to read a tile joint, so it draws as flat colour. */
const SKIRTING_COLOURS: Readonly<Record<string, number>> = {
  tamy_sand_tile: 0xd2c7b2,
  crema_di_roccia: 0xe0d7c6,
  brilliant_white: 0xf6f6f4,
};

function tileTexture(base: readonly [number, number, number], tilesPerMetre: number): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const grout = x < 2 || y < 2;
      const noise = ((x * 13 + y * 29 + x * y * 3) % 7) - 3;
      const offset = (y * size + x) * 4;
      const shade = grout ? -18 : noise;
      data[offset] = Math.max(0, Math.min(255, base[0] + shade));
      data[offset + 1] = Math.max(0, Math.min(255, base[1] + shade));
      data[offset + 2] = Math.max(0, Math.min(255, base[2] + shade));
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(tilesPerMetre, tilesPerMetre);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function tileMaterial(colour: number, track: Track, roughness: number): THREE.MeshStandardMaterial {
  const base = new THREE.Color(colour);
  const texture = track(
    tileTexture([Math.round(base.r * 255), Math.round(base.g * 255), Math.round(base.b * 255)], 1.7),
  );
  return track(new THREE.MeshStandardMaterial({ map: texture, color: 0xffffff, roughness, side: THREE.DoubleSide }));
}

/** The floor material for an authored finish, or the house default when none is stated. */
export function floorMaterialFor(
  finish: string | null | undefined,
  finishes: ArchitecturalMaterials,
  track: Track,
): THREE.MeshStandardMaterial {
  if (finish === "walnut_parquet_tile") return finishes.joineryWood;
  const colour = finish ? TILE_COLOURS[finish] : undefined;
  return colour === undefined ? finishes.floor : tileMaterial(colour, track, 0.55);
}

/** The wall material for an authored finish, or the painted default when none is stated. */
export function wallMaterialFor(
  finish: string | null | undefined,
  finishes: ArchitecturalMaterials,
  track: Track,
): THREE.MeshStandardMaterial {
  const colour = finish ? TILE_COLOURS[finish] : undefined;
  return colour === undefined ? finishes.wall : tileMaterial(colour, track, 0.45);
}

/** One wall painted differently from the rest of the room, drawn as flat matte paint. */
export function featureWallMaterial(colour: string, track: Track): THREE.MeshStandardMaterial {
  return track(new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.92, side: THREE.DoubleSide }));
}

/** The skirting or raking band material for an authored finish. */
export function skirtingMaterialFor(
  finish: string | null | undefined,
  finishes: ArchitecturalMaterials,
  track: Track,
): THREE.MeshStandardMaterial {
  const colour = finish ? SKIRTING_COLOURS[finish] : undefined;
  if (colour === undefined) return finishes.wall;
  return track(new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.6 }));
}
