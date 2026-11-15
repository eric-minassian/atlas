import { Effect, Schema } from 'effect';
import { feeds } from '../catalog.ts';
import { AlertLevel, type Earthquake, type EarthquakeData } from '../domain.ts';
import { decodeJson, get, notModified, okText, round, type Source, updated } from './source.ts';

/** Magnitude 2.5 and up, worldwide, past seven days; regenerated every minute. */
const FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';

const Feature = Schema.Struct({
  id: Schema.String,
  properties: Schema.Struct({
    mag: Schema.NullOr(Schema.Finite),
    magType: Schema.NullOr(Schema.String),
    place: Schema.NullOr(Schema.String),
    time: Schema.Finite,
    url: Schema.String,
    felt: Schema.NullOr(Schema.Finite),
    alert: Schema.NullOr(AlertLevel),
    tsunami: Schema.Finite,
  }),
  geometry: Schema.Struct({
    coordinates: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.NullOr(Schema.Finite)]),
  }),
});

export const FeatureCollection = Schema.Struct({ features: Schema.Array(Feature) });
type FeatureCollection = typeof FeatureCollection.Type;

/** Newest first, as USGS orders them. */
export const parseQuakes = (collection: FeatureCollection): EarthquakeData => ({
  events: collection.features.map((f): Earthquake => ({
    id: f.id,
    time: f.properties.time,
    lon: round(f.geometry.coordinates[0], 4),
    lat: round(f.geometry.coordinates[1], 4),
    depth: round(f.geometry.coordinates[2] ?? 0, 1),
    magnitude: f.properties.mag === null ? null : round(f.properties.mag, 1),
    magnitudeType: f.properties.magType,
    place: f.properties.place,
    url: f.properties.url,
    tsunami: f.properties.tsunami === 1,
    alert: f.properties.alert,
    felt: f.properties.felt === null ? null : Math.round(f.properties.felt),
  })),
});

export const makeEarthquakeSource = (): Source<'earthquakes'> => ({
  interval: Effect.succeed(feeds.earthquakes.intervalSeconds),
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(FEED_URL, { validators });
      if (response.status === 304) return notModified;
      const data = parseQuakes(yield* decodeJson(FeatureCollection)(yield* okText(response)));
      return updated<'earthquakes'>(data, data.events.length, response);
    }),
});
