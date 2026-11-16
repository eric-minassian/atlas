/**
 * Area lookups: data fetched for the part of the world someone is looking at,
 * rather than refreshed globally on a schedule. Browsers ask by Web Mercator
 * tile at a fixed zoom per source, so everyone looking at the same area shares
 * one upstream request and one edge-cached answer.
 *
 * Shared by the server and the web app: keep it free of server-only imports.
 */
import { Schema } from 'effect';

/** A box in degrees. `west` > `east` when it crosses the antimeridian. */
export interface Bounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

const latOf = (y: number, n: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/** A Web Mercator (XYZ) tile's bounds in degrees. */
export const tileBounds = (z: number, x: number, y: number): Bounds => {
  const n = 2 ** z;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: latOf(y, n),
    south: latOf(y + 1, n),
  };
};

/** The tile at `z` containing a point. */
export const tileAt = (z: number, lon: number, lat: number): { x: number; y: number } => {
  const n = 2 ** z;
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const r = (clamped * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
};

export const contains = (b: Bounds, lon: number, lat: number): boolean =>
  lat >= b.south &&
  lat <= b.north &&
  (b.west <= b.east ? lon >= b.west && lon <= b.east : lon >= b.west || lon <= b.east);

/** Splits bounds that cross the antimeridian into two that don't. */
export const unwrap = (b: Bounds): ReadonlyArray<Bounds> =>
  b.west <= b.east
    ? [b]
    : [
        { ...b, east: 180 },
        { ...b, west: -180 },
      ];

/** Whether two bounds overlap. */
export const overlaps = (a: Bounds, b: Bounds): boolean =>
  unwrap(a).some((p) =>
    unwrap(b).some((q) => p.west <= q.east && q.west <= p.east && p.south <= q.north && q.south <= p.north),
  );

const Coordinate = Schema.FiniteFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
);

/** Path params of an area endpoint: `/:z/:x/:y`. Each source checks `z` is the zoom it serves. */
export const TileParams = { z: Coordinate, x: Coordinate, y: Coordinate };

/** Whether x/y exist at zoom z. */
export const isTile = (z: number, x: number, y: number): boolean => x < 2 ** z && y < 2 ** z;
