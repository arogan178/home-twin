type RoutePointM = { readonly x: number; readonly y: number; readonly z: number };

/** A service route stored in IFC millimetres, converted to viewer metres. */
export function parseRoute(value: unknown): RoutePointM[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const points = value.split(";").map((triple) => triple.split(",").map(Number));
  if (points.length < 2 || points.some((point) => point.length !== 3 || point.some((n) => !Number.isFinite(n)))) {
    return null;
  }
  return points.map(([x, y, z]) => ({ x: (x ?? 0) * 0.001, y: (y ?? 0) * 0.001, z: (z ?? 0) * 0.001 }));
}
