/**
 * Outlines for sources that have them (alert zones, fire perimeters, disaster
 * areas): GeoJSON in, simplified flat rings out, so a snapshot holding
 * hundreds of them stays small.
 */
import { Schema } from 'effect';
import type { Polygon } from '../domain.ts';
import { round } from './source.ts';

/** A GeoJSON position; a third (height) coordinate is ignored. */
const Position = Schema.Array(Schema.Finite);
export const GeoJsonPolygon = Schema.Struct({
  type: Schema.Literal('Polygon'),
  coordinates: Schema.Array(Schema.Array(Position)),
});
export const GeoJsonMultiPolygon = Schema.Struct({
  type: Schema.Literal('MultiPolygon'),
  coordinates: Schema.Array(Schema.Array(Schema.Array(Position))),
});
export const GeoJsonArea = Schema.Union([GeoJsonPolygon, GeoJsonMultiPolygon]);
export type GeoJsonArea = typeof GeoJsonArea.Type;

type Position = ReadonlyArray<number>;

const distanceToSegment = (p: Position, a: Position, b: Position): number => {
  const [px = 0, py = 0] = p;
  const [ax = 0, ay = 0] = a;
  const [bx = 0, by = 0] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Douglas-Peucker on an open path, keeping both ends. Iterative: zone outlines run to 30,000 vertices. */
const simplifyPath = (points: ReadonlyArray<Position>, tolerance: number): Position[] => {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<readonly [number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as readonly [number, number];
    let farthest = -1;
    let max = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i] as Position, points[first] as Position, points[last] as Position);
      if (d > max) {
        max = d;
        farthest = i;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([first, farthest], [farthest, last]);
  }
  return points.filter((_, i) => keep[i] === 1);
};

/** Twice the signed area, in square degrees. */
const area2 = (ring: ReadonlyArray<number>): number => {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    sum += (ring[i] as number) * (ring[j + 1] as number) - (ring[j] as number) * (ring[i + 1] as number);
  }
  return sum;
};

/**
 * Simplifies a GeoJSON ring to within `tolerance` degrees and rounds it to
 * `digits` decimals, as a flat ring without the closing vertex. Undefined
 * when nothing visible is left (a sliver, or an islet smaller than the
 * tolerance).
 */
export const simplifyRing = (
  ring: ReadonlyArray<Position>,
  tolerance: number,
  digits: number,
): number[] | undefined => {
  const first = ring[0];
  const last = ring.at(-1);
  const open = first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
  if (open.length < 3) return undefined;
  // Split at the vertex farthest from the first, so the two halves keep the ring's extent.
  const origin = open[0] as Position;
  let split = 1;
  let max = -1;
  for (let i = 1; i < open.length; i++) {
    const p = open[i] as Position;
    const d = Math.hypot((p[0] ?? 0) - (origin[0] ?? 0), (p[1] ?? 0) - (origin[1] ?? 0));
    if (d > max) {
      max = d;
      split = i;
    }
  }
  const kept = [
    ...simplifyPath(open.slice(0, split + 1), tolerance).slice(0, -1),
    ...simplifyPath([...open.slice(split), origin], tolerance).slice(0, -1),
  ];
  const flat: number[] = [];
  for (const [lon = 0, lat = 0] of kept) {
    const x = round(lon, digits);
    const y = round(lat, digits);
    if (flat.length >= 2 && flat[flat.length - 2] === x && flat[flat.length - 1] === y) continue;
    flat.push(x, y);
  }
  if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1])
    flat.splice(-2);
  if (flat.length < 6 || Math.abs(area2(flat)) < tolerance * tolerance * 2) return undefined;
  return flat;
};

const simplifyArea = (area: GeoJsonArea, tolerance: number, digits: number): Polygon[] => {
  const parts = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
  const polygons: Polygon[] = [];
  for (const rings of parts) {
    const [outer, ...holes] = rings;
    const shell = outer ? simplifyRing(outer, tolerance, digits) : undefined;
    if (!shell) continue;
    const kept = holes.flatMap((hole) => {
      const ring = simplifyRing(hole, tolerance, digits);
      return ring ? [ring] : [];
    });
    polygons.push([shell, ...kept]);
  }
  return polygons;
};

/**
 * A GeoJSON polygon or multipolygon as simplified polygons; parts with nothing
 * visible left are dropped. With `maxVertices`, an outline still over it after
 * simplifying is simplified again more coarsely (a fjord coast, an island
 * chain), so a few intricate shapes don't outweigh hundreds of simple ones.
 */
export const toPolygons = (
  area: GeoJsonArea,
  tolerance: number,
  digits: number,
  maxVertices = Number.POSITIVE_INFINITY,
): Polygon[] => {
  let polygons = simplifyArea(area, tolerance, digits);
  for (let coarser = tolerance * 2, tries = 0; vertexCount(polygons) > maxVertices && tries < 4; tries++) {
    polygons = simplifyArea(area, coarser, digits);
    coarser *= 2;
  }
  return polygons;
};

/**
 * A point to label polygons with: the centroid of the largest outer ring, or
 * its first vertex if that's degenerate. Undefined for no polygons.
 */
export const centerOf = (polygons: ReadonlyArray<Polygon>): readonly [number, number] | undefined => {
  let best: ReadonlyArray<number> | undefined;
  let bestArea = -1;
  for (const polygon of polygons) {
    const shell = polygon[0];
    if (!shell) continue;
    const a = Math.abs(area2(shell));
    if (a > bestArea) {
      bestArea = a;
      best = shell;
    }
  }
  if (!best || best.length < 2) return undefined;
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < best.length; i += 2) {
    const j = (i + 2) % best.length;
    const [x0, y0, x1, y1] = [best[i], best[i + 1], best[j], best[j + 1]] as [number, number, number, number];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-12) return [best[0] as number, best[1] as number];
  return [round(cx / (3 * a), 4), round(cy / (3 * a), 4)];
};

/** Vertices across polygons, for logging how much a source sends. */
export const vertexCount = (polygons: ReadonlyArray<Polygon>): number =>
  polygons.reduce((n, polygon) => n + polygon.reduce((m, ring) => m + ring.length / 2, 0), 0);
