/**
 * The analysis drawn into the 3D view: the illuminance surface as a coloured
 * coverage plane, and the dark-zone markers. Both show the lumen
 * approximation behind the plan's numbers, not a photometric result.
 */

import * as THREE from "three";

import { illuminanceCells, luxColour, type RenderableLightSurface } from "./plan";
import type { RoomView3DProps } from "./RoomView3D";

const MM = 0.001;

/** Display lift for the coverage surface, so a floor pass does not z-fight the floor. */
const COVERAGE_LIFT_M = 0.003;

type Surface = RenderableLightSurface;

type Track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Light>(value: T) => T;

function coverageTexture(grid: Surface): { texture: THREE.Texture; extent: THREE.Box2 } | null {
  const cells = illuminanceCells(grid);
  if (cells.length === 0) return null;
  const step = grid.step_mm;
  const minX = Math.min(...cells.map((cell) => cell.x)) - step / 2;
  const maxX = Math.max(...cells.map((cell) => cell.x)) + step / 2;
  const minY = Math.min(...cells.map((cell) => cell.y)) - step / 2;
  const maxY = Math.max(...cells.map((cell) => cell.y)) + step / 2;
  const columns = Math.max(1, Math.round((maxX - minX) / step));
  const rows = Math.max(1, Math.round((maxY - minY) / step));
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  for (const cell of cells) {
    const column = Math.floor((cell.x - minX) / step);
    const row = rows - 1 - Math.floor((cell.y - minY) / step);
    context.globalAlpha = 0.24 + 0.62 * cell.intensity;
    context.fillStyle = luxColour(cell.intensity);
    context.fillRect(column, row, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return {
    texture,
    extent: new THREE.Box2(new THREE.Vector2(minX * MM, minY * MM), new THREE.Vector2(maxX * MM, maxY * MM)),
  };
}

/** Add the coverage plane and dark-zone markers the toggles ask for. */
export function addCoverage(
  content: THREE.Group,
  props: Pick<RoomView3DProps, "showCoverage" | "showDarkZones" | "darkZones">,
  surface: Surface | null,
  track: Track,
) {
if (props.showCoverage && surface !== null) {
  const coverage = coverageTexture(surface);
  if (coverage !== null) {
    track(coverage.texture);
    const size = coverage.extent.getSize(new THREE.Vector2());
    const geometry = track(new THREE.PlaneGeometry(size.x, size.y));
    const material = track(
      new THREE.MeshBasicMaterial({
        map: coverage.texture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const plane = new THREE.Mesh(geometry, material);
    const middle = coverage.extent.getCenter(new THREE.Vector2());
    // Lifted clear of its own sample plane, as a sun patch is. A floor pass
    // samples at the floor, and two coplanar surfaces stipple against each
    // other. The offset is display only; the samples stay where they were.
    plane.position.set(middle.x, middle.y, surface.plane_elevation_mm * MM + COVERAGE_LIFT_M);
    plane.renderOrder = 2;
    content.add(plane);
  }
}

if (props.showDarkZones) {
  const material = track(new THREE.MeshBasicMaterial({ color: 0x2b3a55, transparent: true, opacity: 0.5 }));
  const geometry = track(new THREE.CircleGeometry(0.06, 12));
  for (const zone of props.darkZones) {
    const marker = new THREE.Mesh(geometry, material);
    marker.position.set(zone.point.x * MM, zone.point.y * MM, zone.point.z * MM + 0.004);
    marker.renderOrder = 3;
    content.add(marker);
  }
}
}
