/**
 * Place search results ("go to a city, an address, a landmark") and the
 * Photon geocoder (OpenStreetMap data), which the browser calls directly.
 * No DOM or Cesium imports, so tests can run it.
 */
import { Schema } from 'effect';
import type { Bounds } from '../../../src/area.ts';

/** A place to fly to. */
export interface PlaceHit {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly lat: number;
  readonly lon: number;
  /** Its extent, when the geocoder gave one. */
  readonly bounds?: Bounds;
  /** Camera height to view it from when there's no (usable) extent, meters. */
  readonly height: number;
}

/** How high to view a point of each Photon `type` from. */
const heights: Readonly<Record<string, number>> = {
  house: 1_200,
  street: 2_500,
  locality: 6_000,
  district: 8_000,
  city: 25_000,
  county: 120_000,
  state: 700_000,
  country: 3_000_000,
};

const Text = Schema.optionalKey(Schema.String);

export const PhotonResponse = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      geometry: Schema.Struct({ coordinates: Schema.Tuple([Schema.Finite, Schema.Finite]) }),
      properties: Schema.Struct({
        osm_type: Text,
        osm_id: Schema.optionalKey(Schema.Finite),
        osm_key: Text,
        osm_value: Text,
        /** `house`, `street`, `locality`, `district`, `city`, `county`, `state`, `country` or `other`. */
        type: Text,
        name: Text,
        housenumber: Text,
        street: Text,
        district: Text,
        city: Text,
        state: Text,
        country: Text,
        /** `[west, north, east, south]`. */
        extent: Schema.optionalKey(
          Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
        ),
      }),
    }),
  ),
});

/**
 * Photon's location-bias zoom for a camera height: roughly the web-map zoom
 * showing the same area, so nearby matches win when zoomed in and prominent
 * ones from anywhere when looking at the whole globe.
 */
export const biasZoom = (height: number): number =>
  Math.max(3, Math.min(16, Math.round(Math.log2((4 * 40_075_000) / (1.15 * Math.max(height, 1))))));

export const photonUrl = (
  query: string,
  near?: { readonly lat: number; readonly lon: number; readonly zoom: number },
): string => {
  const params = new URLSearchParams({ q: query, limit: '6', lang: 'en' });
  if (near) {
    params.set('lat', near.lat.toFixed(3));
    params.set('lon', near.lon.toFixed(3));
    params.set('zoom', String(near.zoom));
    // Lets a well-known place elsewhere still outrank an obscure one nearby.
    params.set('location_bias_scale', '0.4');
  }
  return `https://photon.komoot.io/api/?${params}`;
};

const words = (value: string) => value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

/** Results as hits, dropping repeats (a city often comes back as both a place and its boundary). */
export const parsePhoton = (response: typeof PhotonResponse.Type): PlaceHit[] => {
  const hits: PlaceHit[] = [];
  const seen = new Set<string>();
  for (const { geometry, properties: p } of response.features) {
    const address = [p.housenumber, p.street].filter(Boolean).join(' ');
    const title = p.name ?? (address || p.city || p.state || p.country);
    if (!title) continue;
    // Boundaries say what they bound through `type`; everything else through its OSM tag.
    const tag = p.osm_key === 'boundary' ? p.type : p.osm_value;
    const kind = tag && tag !== 'yes' && tag !== 'other' ? words(tag) : undefined;
    const where = [p.name ? address : undefined, p.city ?? p.district, p.state, p.country].filter(
      (part, i, all): part is string => !!part && part !== title && all.indexOf(part) === i,
    );
    const subtitle = [kind, where.join(', ')].filter(Boolean).join(' · ');
    const dedupe = `${title}|${where.join(', ')}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const [lon, lat] = geometry.coordinates;
    const extent = p.extent;
    hits.push({
      key: `photon:${p.osm_type ?? ''}${p.osm_id ?? hits.length}`,
      title,
      subtitle,
      lat,
      lon,
      ...(extent ? { bounds: { west: extent[0], north: extent[1], east: extent[2], south: extent[3] } } : {}),
      height: heights[p.type ?? ''] ?? 3_000,
    });
  }
  return hits;
};
