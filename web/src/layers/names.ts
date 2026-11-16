import type { VectorTileFeature, VectorTileLayer } from '@mapbox/vector-tile';
import { nameOf } from '../data/vectortiles.ts';
import { formatInt } from '../lib/format.ts';
import { type Candidate, type Extract, toLonLat } from './vectorlabels.ts';

/** Place classes in OpenMapTiles, most important first, with the camera height below which each is named. */
const places: ReadonlyArray<{
  readonly cls: string;
  readonly below: number;
  readonly size: number;
  readonly weight: 500 | 600;
}> = [
  { cls: 'city', below: Number.POSITIVE_INFINITY, size: 16, weight: 600 },
  { cls: 'town', below: 120_000, size: 14, weight: 600 },
  { cls: 'village', below: 40_000, size: 13, weight: 500 },
  { cls: 'suburb', below: 40_000, size: 13, weight: 500 },
  { cls: 'quarter', below: 12_000, size: 12, weight: 500 },
  { cls: 'neighbourhood', below: 12_000, size: 12, weight: 500 },
  { cls: 'hamlet', below: 12_000, size: 12, weight: 500 },
];
const placeRank = new Map(places.map((p, i) => [p.cls, i]));

const WATER_COLOR = '#b4dcff';
const STREET_BELOW = 3_000;
/** Residential streets crowd out everything else until the camera is closer. */
const MINOR_STREET_BELOW = 1_500;
const HOUSE_NUMBER_BELOW = 400;
const PEAK_BELOW = 40_000;
const PARK_BELOW = 8_000;

const point = (
  feature: VectorTileFeature,
  layer: VectorTileLayer,
  at: { readonly z: number; readonly x: number; readonly y: number },
) => {
  const first = feature.loadGeometry()[0]?.[0];
  return first ? toLonLat(at.z, at.x, at.y, layer.extent, first.x, first.y) : undefined;
};

/** The point halfway along a line feature's longest part. */
const midpoint = (
  feature: VectorTileFeature,
  layer: VectorTileLayer,
  at: { readonly z: number; readonly x: number; readonly y: number },
) => {
  let best: { x: number; y: number }[] = [];
  let bestLength = 0;
  for (const part of feature.loadGeometry()) {
    let length = 0;
    for (let i = 1; i < part.length; i++) {
      const a = part[i - 1] as { x: number; y: number };
      const b = part[i] as { x: number; y: number };
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (length > bestLength) {
      bestLength = length;
      best = part;
    }
  }
  let remaining = bestLength / 2;
  for (let i = 1; i < best.length; i++) {
    const a = best[i - 1] as { x: number; y: number };
    const b = best[i] as { x: number; y: number };
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (step >= remaining && step > 0) {
      const t = remaining / step;
      return toLonLat(at.z, at.x, at.y, layer.extent, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
    remaining -= step;
  }
  const only = best[0];
  return only ? toLonLat(at.z, at.x, at.y, layer.extent, only.x, only.y) : undefined;
};

const streetClasses = new Map([
  ['motorway', 0],
  ['trunk', 0],
  ['primary', 1],
  ['secondary', 2],
  ['tertiary', 3],
  ['minor', 4],
  ['service', 5],
]);

/**
 * Names on the ground at the detail the camera is at: cities from afar, then
 * towns, neighbourhoods, water and peaks, then streets and house numbers.
 */
export const extractNames: Extract = (tile, at) => {
  const out: Candidate[] = [];
  const { height } = at;

  const placeLayer = tile.layers.place;
  for (let i = 0; i < (placeLayer?.length ?? 0); i++) {
    const feature = (placeLayer as VectorTileLayer).feature(i);
    const cls = String(feature.properties.class ?? '');
    const rank = placeRank.get(cls);
    const style = rank === undefined ? undefined : places[rank];
    const name = nameOf(feature.properties);
    if (!style || !name || height > style.below) continue;
    const where = point(feature, placeLayer as VectorTileLayer, at);
    if (!where) continue;
    out.push({
      key: `place:${feature.id ?? `${name}:${where.lon.toFixed(3)}`}`,
      text: name,
      ...where,
      priority: (rank ?? 9) * 100 + Number(feature.properties.rank ?? 50),
      size: style.size,
      weight: style.weight,
      color: '#ffffff',
    });
  }

  const water = tile.layers.water_name;
  for (let i = 0; i < (water?.length ?? 0); i++) {
    const feature = (water as VectorTileLayer).feature(i);
    const name = nameOf(feature.properties);
    const cls = String(feature.properties.class ?? '');
    const big = cls === 'ocean' || cls === 'sea';
    if (!name || (!big && height > 60_000)) continue;
    const where =
      feature.type === 2
        ? midpoint(feature, water as VectorTileLayer, at)
        : point(feature, water as VectorTileLayer, at);
    if (!where) continue;
    out.push({
      key: `water:${name}:${where.lon.toFixed(2)}:${where.lat.toFixed(2)}`,
      text: name,
      ...where,
      priority: big ? 150 : 450,
      size: big ? 14 : 12,
      color: WATER_COLOR,
    });
  }

  const peaks = height < PEAK_BELOW ? tile.layers.mountain_peak : undefined;
  for (let i = 0; i < (peaks?.length ?? 0); i++) {
    const feature = (peaks as VectorTileLayer).feature(i);
    const name = nameOf(feature.properties);
    const where = point(feature, peaks as VectorTileLayer, at);
    if (!name || !where) continue;
    const ele = Number(feature.properties.ele);
    out.push({
      key: `peak:${feature.id ?? name}`,
      text: Number.isFinite(ele) ? `${name} ${formatInt(ele)} m` : name,
      ...where,
      priority: 500 + Number(feature.properties.rank ?? 50),
      size: 11,
      color: '#eadfc8',
    });
  }

  const parks = height < PARK_BELOW ? tile.layers.park : undefined;
  for (let i = 0; i < (parks?.length ?? 0); i++) {
    const feature = (parks as VectorTileLayer).feature(i);
    const name = nameOf(feature.properties);
    // Park polygons carry their label point as a separate point feature.
    if (!name || feature.type !== 1) continue;
    const where = point(feature, parks as VectorTileLayer, at);
    if (!where) continue;
    out.push({
      key: `park:${feature.id ?? name}`,
      text: name,
      ...where,
      priority: 600 + Number(feature.properties.rank ?? 50),
      near: true,
      size: 11,
      color: '#c4e8b8',
    });
  }

  const streets = height < STREET_BELOW ? tile.layers.transportation_name : undefined;
  for (let i = 0; i < (streets?.length ?? 0); i++) {
    const feature = (streets as VectorTileLayer).feature(i);
    const cls = streetClasses.get(String(feature.properties.class ?? ''));
    const name = nameOf(feature.properties);
    if (cls === undefined || !name || (cls >= 4 && height > MINOR_STREET_BELOW)) continue;
    const where = midpoint(feature, streets as VectorTileLayer, at);
    if (!where) continue;
    out.push({
      key: `street:${name}`,
      text: name,
      ...where,
      priority: 700 + cls * 10,
      near: true,
      size: 12,
      color: '#f4f4f4',
    });
  }

  const numbers = height < HOUSE_NUMBER_BELOW ? tile.layers.housenumber : undefined;
  for (let i = 0; i < (numbers?.length ?? 0); i++) {
    const feature = (numbers as VectorTileLayer).feature(i);
    const text = feature.properties.housenumber;
    const where = point(feature, numbers as VectorTileLayer, at);
    if (typeof text !== 'string' || !where) continue;
    out.push({
      key: `number:${feature.id ?? `${text}:${where.lon.toFixed(5)}:${where.lat.toFixed(5)}`}`,
      text,
      ...where,
      priority: 900,
      near: true,
      size: 10,
      weight: 400,
      color: '#d8d8d8',
    });
  }
  return out;
};
