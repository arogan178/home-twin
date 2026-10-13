/**
 * What a click on a building element in the 3D view reads back.
 *
 * The meshes a detailed renderer draws for one IFC object carry that object's
 * identity in `userData.inspect`, so a click anywhere on a drawn cabinet
 * resolves to the cabinet, not to one of its panels. The details come from the
 * IFC-derived payload, never from the mesh: sizes are the object's IFC bounds
 * and identities are GlobalIds.
 */

import type * as THREE from "three";

import { formatMillimetres } from "./plan";
import type { BuildingObject, Opening, Stair, Wall } from "./types";

export type InspectTarget = {
  readonly kind: "object" | "wall" | "opening" | "stair";
  readonly id: string;
};

export type InspectionDetails = {
  readonly target: InspectTarget;
  readonly title: string;
  readonly subtitle: string;
  readonly globalId: string;
  readonly tag: string | null;
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly properties: ReadonlyArray<{ readonly group: string; readonly name: string; readonly value: string }>;
};

export type InspectionSources = {
  readonly objects: ReadonlyArray<BuildingObject>;
  readonly walls: ReadonlyArray<Wall>;
  readonly openings: ReadonlyArray<Opening>;
  readonly stairs: ReadonlyArray<Stair>;
  readonly floorElevationMm: number;
};

export function sameTarget(a: InspectTarget | null, b: InspectTarget | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);
}

export function inspectTargetOf(userData: Record<string, unknown> | undefined): InspectTarget | null {
  const value = userData?.inspect;
  if (typeof value !== "object" || value === null) return null;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  if (typeof id !== "string") return null;
  if (kind !== "object" && kind !== "wall" && kind !== "opening" && kind !== "stair") return null;
  return { kind, id };
}

/** Mark `root` and everything under it that is not already claimed. */
export function markInspectable(root: THREE.Object3D, target: InspectTarget): void {
  root.traverse((node) => {
    if (node.userData.inspect === undefined) node.userData.inspect = target;
  });
}

const mm = (value: number) => `${formatMillimetres(value)} mm`;

function formatValue(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? formatMillimetres(value) : String(Number(value.toFixed(3)));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Group `Pset_X.Name` keys by property set; bare keys are IFC attributes. */
export function propertyRows(properties: Readonly<Record<string, unknown>>): InspectionDetails["properties"] {
  return Object.entries(properties)
    .map(([key, value]) => {
      const dot = key.indexOf(".");
      return dot < 0
        ? { group: "Attributes", name: key, value: formatValue(value) }
        : { group: key.slice(0, dot), name: key.slice(dot + 1), value: formatValue(value) };
    })
    .sort((a, b) => (a.group === b.group ? 0 : a.group === "Attributes" ? -1 : b.group === "Attributes" ? 1 : a.group.localeCompare(b.group)));
}

function planLength(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function describeInspection(target: InspectTarget, sources: InspectionSources): InspectionDetails | null {
  if (target.kind === "object") {
    const object = sources.objects.find((item) => item.id === target.id);
    if (object === undefined) return null;
    const { minimum, maximum } = object.bounds;
    const tag = object.properties.Tag;
    return {
      target,
      title: object.name,
      subtitle: `${object.ifc_class} · ${object.kind.replaceAll("_", " ")}`,
      globalId: object.id,
      tag: typeof tag === "string" && tag.length > 0 ? tag : null,
      facts: [
        {
          label: "Size W × D × H",
          value: `${formatMillimetres(maximum.x - minimum.x)} × ${formatMillimetres(maximum.y - minimum.y)} × ${mm(maximum.z - minimum.z)}`,
        },
        { label: "Base above floor", value: mm(minimum.z - sources.floorElevationMm) },
        { label: "Top above floor", value: mm(maximum.z - sources.floorElevationMm) },
        { label: "Plan origin", value: `${formatMillimetres(minimum.x)}, ${formatMillimetres(minimum.y)}` },
      ],
      properties: propertyRows(object.properties),
    };
  }
  if (target.kind === "wall") {
    const wall = sources.walls.find((item) => item.wall_id === target.id);
    if (wall === undefined) return null;
    const hosted = sources.openings.filter((opening) => opening.host_wall_id === wall.wall_id).length;
    return {
      target,
      title: "Wall face",
      subtitle: "Wall · the face this room sees",
      globalId: wall.wall_id,
      tag: null,
      facts: [
        { label: "Face length", value: mm(planLength(wall.start, wall.end)) },
        { label: "Thickness", value: mm(wall.thickness_mm) },
        ...(wall.base_elevation_mm == null ? [] : [{ label: "Base", value: `Z ${mm(wall.base_elevation_mm)}` }]),
        ...(wall.top_elevation_mm == null ? [] : [{ label: "Top", value: `Z ${mm(wall.top_elevation_mm)}` }]),
        { label: "Openings", value: String(hosted) },
      ],
      properties: [],
    };
  }
  if (target.kind === "opening") {
    const opening = sources.openings.find((item) => item.id === target.id);
    if (opening === undefined) return null;
    return {
      target,
      title: opening.name,
      subtitle: `${opening.kind.replaceAll("_", " ")} · ${opening.exposure}`,
      globalId: opening.id,
      tag: null,
      facts: [
        { label: "Clear width", value: mm(planLength(opening.start, opening.end)) },
        { label: "Sill", value: mm(opening.sill_height_mm) },
        { label: "Head", value: mm(opening.head_height_mm) },
        ...(opening.swing == null ? [] : [{ label: "Swing", value: opening.swing }]),
        ...(opening.glazing_fraction === undefined
          ? []
          : [{ label: "Glazed", value: `${Math.round(opening.glazing_fraction * 100)}%` }]),
      ],
      properties: [{ group: "Evidence", name: "Source", value: opening.evidence }],
    };
  }
  const stair = sources.stairs.find((item) => item.id === target.id);
  if (stair === undefined) return null;
  return {
    target,
    title: stair.name,
    subtitle: `Stair · ${stair.kind.replaceAll("_", " ")}`,
    globalId: stair.id,
    tag: null,
    facts: [
      { label: "Rise", value: mm(stair.rise_mm) },
      { label: "Risers", value: `${stair.riser_count} × ${mm(stair.riser_height_mm)}` },
      { label: "Going", value: `${stair.tread_count} × ${mm(stair.tread_depth_mm)}` },
      { label: "Up bearing", value: `${stair.up_bearing_deg.toFixed(0)}° clockwise from plan +Y` },
    ],
    properties: [{ group: "Evidence", name: "Source", value: stair.evidence }],
  };
}
