import { Schema } from 'effect';

/** Street-level imagery services. Both are open: Panoramax needs no key, Mapillary a client token. */
export type ProviderId = 'panoramax' | 'mapillary';

/** A 360° panorama, as the viewer needs it. */
export interface Pano {
  readonly provider: ProviderId;
  readonly id: string;
  readonly lon: number;
  readonly lat: number;
  /** Compass bearing (degrees) the image's center column faces. */
  readonly heading: number;
  /** About 2048 px wide: loads fast. */
  readonly image: string;
  /** Larger, loaded after `image` when it's a size a GPU takes comfortably. */
  readonly sharper: string | undefined;
  readonly thumbnail: string;
  /** Epoch ms. */
  readonly capturedAt: number | undefined;
  readonly author: string | undefined;
  readonly license: { readonly label: string; readonly href: string | undefined };
  /** The image on the provider's own site. */
  readonly page: string;
  readonly sequence: string | undefined;
}

/** An adjacent panorama in the same sequence. */
export interface Neighbor {
  readonly provider: ProviderId;
  readonly id: string;
  readonly lon: number;
  readonly lat: number;
}

export interface StreetProvider {
  readonly id: ProviderId;
  readonly name: string;
  /** The nearest 360° panorama within `radius` meters, if any. */
  nearest(lon: number, lat: number, radius: number, signal?: AbortSignal): Promise<Pano | undefined>;
  load(id: string, signal?: AbortSignal): Promise<Pano>;
  neighbors(pano: Pano, signal?: AbortSignal): Promise<ReadonlyArray<Neighbor>>;
}

/** Above this width the full image is decoded at a size that strains phones; the 2048 px one is used. */
const MAX_SHARPER_WIDTH = 8192;
const METERS_PER_DEGREE = 111_320;

const box = (lon: number, lat: number, radius: number) => {
  const dLat = radius / METERS_PER_DEGREE;
  const dLon = radius / (METERS_PER_DEGREE * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat] as const;
};

/** Ground distance in meters, flat approximation (fine over a street's length). */
export const distance = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => {
  const x = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(x, b.lat - a.lat) * METERS_PER_DEGREE;
};

/** Compass bearing from a to b, degrees. */
export const bearing = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => {
  const x = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return ((Math.atan2(x, b.lat - a.lat) * 180) / Math.PI + 360) % 360;
};

const fetchJson = async <S extends Schema.Top>(
  schema: S,
  url: string,
  init: RequestInit = {},
): Promise<S['Type']> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
  return Schema.decodeUnknownPromise(schema as unknown as Schema.Codec<S['Type'], unknown>)(
    await response.json(),
  );
};

// ---------------------------------------------------------------------------
// Panoramax (federated, STAC API)
// ---------------------------------------------------------------------------

const PANORAMAX = 'https://api.panoramax.xyz/api';

const Point = Schema.Struct({
  type: Schema.Literal('Point'),
  coordinates: Schema.Tuple([Schema.Finite, Schema.Finite]),
});
const Href = Schema.Struct({ href: Schema.String });
const StacItem = Schema.Struct({
  id: Schema.String,
  collection: Schema.optionalKey(Schema.String),
  geometry: Point,
  properties: Schema.Struct({
    datetime: Schema.optionalKey(Schema.NullOr(Schema.String)),
    'view:azimuth': Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    license: Schema.optionalKey(Schema.NullOr(Schema.String)),
    'pers:interior_orientation': Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          field_of_view: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
          sensor_array_dimensions: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Finite))),
        }),
      ),
    ),
  }),
  assets: Schema.Struct({ sd: Href, hd: Schema.optionalKey(Href), thumb: Href }),
  links: Schema.Array(
    Schema.Struct({
      rel: Schema.String,
      href: Schema.optionalKey(Schema.NullOr(Schema.String)),
      id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      geometry: Schema.optionalKey(Schema.NullOr(Point)),
    }),
  ),
  providers: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
});
type StacItem = typeof StacItem.Type;
const StacSearch = Schema.Struct({ features: Schema.Array(StacItem) });

const fromStac = (item: StacItem): Pano => {
  const [lon, lat] = item.geometry.coordinates;
  const width = item.properties['pers:interior_orientation']?.sensor_array_dimensions?.[0];
  const via = item.links.find((l) => l.rel === 'via')?.href ?? 'https://api.panoramax.xyz';
  const time = item.properties.datetime ? Date.parse(item.properties.datetime) : Number.NaN;
  const license = item.properties.license ?? 'CC-BY-SA-4.0';
  return {
    provider: 'panoramax',
    id: item.id,
    lon,
    lat,
    heading: item.properties['view:azimuth'] ?? 0,
    image: item.assets.sd.href,
    sharper:
      item.assets.hd && width !== undefined && width <= MAX_SHARPER_WIDTH ? item.assets.hd.href : undefined,
    thumbnail: item.assets.thumb.href,
    capturedAt: Number.isFinite(time) ? time : undefined,
    author: item.providers?.[0]?.name,
    license: {
      label: license === 'etalab-2.0' ? 'Licence Ouverte 2.0' : license.replaceAll('-', ' '),
      href: item.links.find((l) => l.rel === 'license')?.href ?? undefined,
    },
    page: `${via.replace(/\/$/, '')}/#focus=pic&pic=${item.id}`,
    sequence: item.collection,
  };
};

export const panoramax: StreetProvider = {
  id: 'panoramax',
  name: 'Panoramax',
  async nearest(lon, lat, radius, signal) {
    const [w, s, e, n] = box(lon, lat, radius);
    const found = await fetchJson(
      StacSearch,
      `${PANORAMAX}/search?bbox=${w},${s},${e},${n}&filter=${encodeURIComponent('field_of_view=360')}&limit=10`,
      signal ? { signal } : {},
    );
    const panos = found.features.map(fromStac);
    return panos.toSorted((a, b) => distance({ lon, lat }, a) - distance({ lon, lat }, b))[0];
  },
  async load(id, signal) {
    const found = await fetchJson(
      StacSearch,
      `${PANORAMAX}/search?ids=${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    );
    const item = found.features[0];
    if (!item) throw new Error(`Panoramax picture ${id} not found`);
    return fromStac(item);
  },
  async neighbors(pano, signal) {
    // The item lists its neighbors in the sequence (with their positions) as prev/next links.
    const found = await fetchJson(
      StacSearch,
      `${PANORAMAX}/search?ids=${encodeURIComponent(pano.id)}`,
      signal ? { signal } : {},
    );
    const item = found.features[0];
    return (item?.links ?? []).flatMap((link) =>
      (link.rel === 'prev' || link.rel === 'next') && link.id && link.geometry
        ? [
            {
              provider: 'panoramax' as const,
              id: link.id,
              lon: link.geometry.coordinates[0],
              lat: link.geometry.coordinates[1],
            },
          ]
        : [],
    );
  },
};

// ---------------------------------------------------------------------------
// Mapillary (Graph API v4)
// ---------------------------------------------------------------------------

const MAPILLARY = 'https://graph.mapillary.com';
const FIELDS = [
  'id',
  'is_pano',
  'width',
  'computed_compass_angle',
  'compass_angle',
  'computed_geometry',
  'geometry',
  'captured_at',
  'sequence',
  'creator',
  'thumb_256_url',
  'thumb_2048_url',
  'thumb_original_url',
].join(',');

const MapillaryImage = Schema.Struct({
  id: Schema.String,
  is_pano: Schema.optionalKey(Schema.Boolean),
  width: Schema.optionalKey(Schema.Finite),
  computed_compass_angle: Schema.optionalKey(Schema.Finite),
  compass_angle: Schema.optionalKey(Schema.Finite),
  computed_geometry: Schema.optionalKey(Point),
  geometry: Schema.optionalKey(Point),
  captured_at: Schema.optionalKey(Schema.Finite),
  sequence: Schema.optionalKey(Schema.String),
  creator: Schema.optionalKey(Schema.Struct({ username: Schema.optionalKey(Schema.String) })),
  thumb_256_url: Schema.optionalKey(Schema.String),
  thumb_2048_url: Schema.optionalKey(Schema.String),
  thumb_original_url: Schema.optionalKey(Schema.String),
});
type MapillaryImage = typeof MapillaryImage.Type;
const MapillaryList = Schema.Struct({ data: Schema.Array(MapillaryImage) });
const MapillaryIds = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

const fromMapillary = (image: MapillaryImage): Pano | undefined => {
  const point = image.computed_geometry ?? image.geometry;
  if (!point || !image.thumb_2048_url) return undefined;
  const [lon, lat] = point.coordinates;
  return {
    provider: 'mapillary',
    id: image.id,
    lon,
    lat,
    heading: image.computed_compass_angle ?? image.compass_angle ?? 0,
    image: image.thumb_2048_url,
    sharper:
      image.thumb_original_url && image.width !== undefined && image.width <= MAX_SHARPER_WIDTH
        ? image.thumb_original_url
        : undefined,
    thumbnail: image.thumb_256_url ?? image.thumb_2048_url,
    capturedAt: image.captured_at,
    author: image.creator?.username,
    license: { label: 'CC BY-SA 4.0', href: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    page: `https://www.mapillary.com/app/?pKey=${image.id}&focus=photo`,
    sequence: image.sequence,
  };
};

/** Mapillary's client token is meant for browsers; it's restricted to Atlas's domains at Mapillary. */
export const mapillary = (token: string): StreetProvider => {
  const init = (signal?: AbortSignal): RequestInit => ({
    headers: { authorization: `OAuth ${token}` },
    ...(signal ? { signal } : {}),
  });
  return {
    id: 'mapillary',
    name: 'Mapillary',
    async nearest(lon, lat, radius, signal) {
      const [w, s, e, n] = box(lon, lat, radius);
      const found = await fetchJson(
        MapillaryList,
        `${MAPILLARY}/images?fields=${FIELDS}&bbox=${w},${s},${e},${n}&is_pano=true&limit=20`,
        init(signal),
      );
      const panos = found.data.flatMap((image) =>
        image.is_pano === false ? [] : (fromMapillary(image) ?? []),
      );
      return panos.toSorted((a, b) => distance({ lon, lat }, a) - distance({ lon, lat }, b))[0];
    },
    async load(id, signal) {
      const image = await fetchJson(
        MapillaryImage,
        `${MAPILLARY}/${encodeURIComponent(id)}?fields=${FIELDS}`,
        init(signal),
      );
      const pano = fromMapillary(image);
      if (!pano) throw new Error(`Mapillary image ${id} has no position or image`);
      return pano;
    },
    async neighbors(pano, signal) {
      if (!pano.sequence) return [];
      const ids = await fetchJson(
        MapillaryIds,
        `${MAPILLARY}/image_ids?sequence_id=${encodeURIComponent(pano.sequence)}`,
        init(signal),
      );
      const index = ids.data.findIndex((entry) => entry.id === pano.id);
      const adjacent = [ids.data[index - 1], ids.data[index + 1]].flatMap((entry) =>
        entry ? [entry.id] : [],
      );
      if (index < 0 || adjacent.length === 0) return [];
      const found = await fetchJson(
        MapillaryList,
        `${MAPILLARY}/images?image_ids=${adjacent.join(',')}&fields=id,computed_geometry,geometry`,
        init(signal),
      );
      return found.data.flatMap((image) => {
        const point = image.computed_geometry ?? image.geometry;
        return point
          ? [
              {
                provider: 'mapillary' as const,
                id: image.id,
                lon: point.coordinates[0],
                lat: point.coordinates[1],
              },
            ]
          : [];
      });
    },
  };
};
