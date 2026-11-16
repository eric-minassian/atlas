import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

/**
 * OpenStreetMap vector tiles (OpenMapTiles schema) from OpenFreeMap: no key,
 * no request limits, CORS open. One decoded copy of each tile is shared by
 * everything drawn from it (roads, names, points of interest).
 */
const TILEJSON = 'https://tiles.openfreemap.org/planet';
/** The deepest zoom OpenFreeMap serves; deeper views reuse these tiles. */
export const MAX_VECTOR_ZOOM = 14;
const CACHE_SIZE = 96;

export const openStreetMapCredit =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

let template: Promise<string> | undefined;

/** The tile URL template: OpenFreeMap versions it weekly, so it's read from their TileJSON. */
const tileTemplate = (): Promise<string> => {
  template ??= (async () => {
    const response = await fetch(TILEJSON);
    if (!response.ok) throw new Error(`OpenFreeMap TileJSON: HTTP ${response.status}`);
    const json: unknown = await response.json();
    const tiles = typeof json === 'object' && json !== null ? (json as { tiles?: unknown }).tiles : undefined;
    const url: unknown = Array.isArray(tiles) ? tiles[0] : undefined;
    if (typeof url !== 'string') throw new Error('OpenFreeMap TileJSON has no tile URL');
    return url;
  })().catch((error: unknown) => {
    template = undefined;
    throw error;
  });
  return template;
};

const cache = new Map<string, Promise<VectorTile | undefined>>();

/** The decoded tile at z/x/y (at most zoom 14); undefined where there's no tile (open ocean). */
export const vectorTile = (z: number, x: number, y: number): Promise<VectorTile | undefined> => {
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    // Refresh its place in the LRU order.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const loading = (async () => {
    const url = (await tileTemplate())
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const response = await fetch(url);
    if (response.status === 404 || response.status === 204) return undefined;
    if (!response.ok) throw new Error(`OpenFreeMap tile ${key}: HTTP ${response.status}`);
    return new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer())));
  })();
  loading.catch(() => cache.delete(key));
  cache.set(key, loading);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return loading;
};

/** OSM element behind a feature: OpenMapTiles ids are the OSM id times ten plus 1 (node), 2 (way) or 3 (relation). */
export const osmElement = (
  id: number | undefined,
): { readonly type: string; readonly id: number } | undefined => {
  if (id === undefined || !Number.isFinite(id)) return undefined;
  const type = ['', 'node', 'way', 'relation'][id % 10];
  return type ? { type, id: Math.floor(id / 10) } : undefined;
};

/**
 * A feature's name: the local name (`name`), which is what's on the street
 * signs, falling back to the Latin-script international name.
 */
export const nameOf = (properties: Readonly<Record<string, unknown>>): string | undefined => {
  const name = properties.name ?? properties.name_int ?? properties.name_en;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
};
