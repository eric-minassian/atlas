import { Effect, Schema } from 'effect';
import { feeds } from '../catalog.ts';
import type { AirQualityData } from '../domain.ts';
import { type Columns, decodeJson, get, notModified, okText, round, type Source, updated } from './source.ts';

/**
 * Every particulate sensor's 5-minute average (~9,500 sensors). The same
 * format as `data.json`, which adds temperature, noise and other sensors this
 * feed doesn't use, at twice the size.
 */
const DATA_URL = 'https://data.sensor.community/static/v2/data.dust.min.json';

/**
 * Low-cost optical sensors saturate near 1,000 µg/m³ (the SDS011 reports
 * 999.9) and read fog as dust: outdoor PM2.5 beyond 500 is almost always an
 * artifact. PM2.5 is a fraction of PM10, so it can't meaningfully exceed it.
 */
const MAX_PM25 = 500;
const MAX_PM10 = 990;

const Reading = Schema.Struct({
  timestamp: Schema.String,
  location: Schema.Struct({
    latitude: Schema.String,
    longitude: Schema.String,
    indoor: Schema.optionalKey(Schema.Unknown),
  }),
  sensor: Schema.Struct({
    id: Schema.Int,
    sensor_type: Schema.Struct({ name: Schema.String }),
  }),
  sensordatavalues: Schema.Array(Schema.Struct({ value: Schema.String, value_type: Schema.String })),
});
type Reading = typeof Reading.Type;
export const Readings = Schema.Array(Reading);

const plausible = (pm25: number, pm10: number) =>
  Number.isFinite(pm25) &&
  Number.isFinite(pm10) &&
  pm25 >= 0 &&
  pm10 >= 0 &&
  pm25 < MAX_PM25 &&
  pm10 < MAX_PM10 &&
  pm25 <= pm10 * 1.1 + 1;

/**
 * Outdoor sensors with plausible PM2.5 (`P2`) and PM10 (`P1`) readings, one
 * per location: sensors within ~10 m of each other (often two sensors on one
 * station) count as one, keeping the latest reading.
 */
export const parseAirQuality = (
  readings: ReadonlyArray<Reading>,
): { data: AirQualityData; dropped: number } => {
  const kept = new Map<
    string,
    { readonly time: number; readonly r: Reading; readonly pm25: number; readonly pm10: number }
  >();
  let dropped = 0;
  for (const r of readings) {
    if (r.location.indoor === 1 || r.location.indoor === '1') continue;
    const lat = Number(r.location.latitude);
    const lon = Number(r.location.longitude);
    // Timestamps are UTC without a zone.
    const time = Date.parse(`${r.timestamp.replace(' ', 'T')}Z`);
    let pm25 = Number.NaN;
    let pm10 = Number.NaN;
    for (const v of r.sensordatavalues) {
      if (v.value_type === 'P2') pm25 = Number(v.value);
      else if (v.value_type === 'P1') pm10 = Number(v.value);
    }
    if (r.location.latitude === '' || r.location.longitude === '' || !Number.isFinite(time)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (!plausible(pm25, pm10)) {
      // Sensors without particulate values at all aren't errors: only implausible readings count.
      if (Number.isFinite(pm25) || Number.isFinite(pm10)) dropped++;
      continue;
    }
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const seen = kept.get(key);
    if (!seen || seen.time < time) kept.set(key, { time, r, pm25, pm10 });
  }

  const entries = [...kept.values()];
  const since = entries.reduce((min, e) => Math.min(min, e.time), Number.POSITIVE_INFINITY);
  const out: Columns<Omit<AirQualityData, 'since'>> = {
    sensor: [],
    model: [],
    lon: [],
    lat: [],
    observed: [],
    pm25: [],
    pm10: [],
  };
  for (const { time, r, pm25, pm10 } of entries) {
    out.sensor.push(r.sensor.id);
    out.model.push(r.sensor.sensor_type.name);
    out.lat.push(round(Number(r.location.latitude), 4));
    out.lon.push(round(Number(r.location.longitude), 4));
    out.observed.push(Math.round((time - since) / 60_000));
    out.pm25.push(round(pm25, 1));
    out.pm10.push(round(pm10, 1));
  }
  return { data: { since: Number.isFinite(since) ? since : 0, ...out }, dropped };
};

export const makeAirQualitySource = (): Source<'airQuality'> => ({
  interval: Effect.succeed(feeds.airQuality.intervalSeconds),
  read: (validators) =>
    Effect.gen(function* () {
      // The server now and then drops the connection partway through the 4 MB body: read it again once.
      const read = yield* Effect.gen(function* () {
        const response = yield* get(DATA_URL, { validators });
        return response.status === 304 ? undefined : { response, text: yield* okText(response) };
      }).pipe(Effect.retry({ times: 1 }));
      if (!read) return notModified;
      const { response, text } = read;
      const { data, dropped } = parseAirQuality(yield* decodeJson(Readings)(text));
      if (dropped > 0)
        yield* Effect.logInfo('dropped implausible particulate readings').pipe(
          Effect.annotateLogs({ dropped }),
        );
      return updated<'airQuality'>(data, data.sensor.length, response);
    }),
});
