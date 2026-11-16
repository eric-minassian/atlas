import { Context, Effect, Layer, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { type CurrentAirQuality, type CurrentWeather, type Here, UpstreamUnavailable } from './domain.ts';
import { decodeJson, get, okText } from './ingest/source.ts';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
/** Open-Meteo's air quality API: the CAMS global and European models (CC BY 4.0, credit CAMS). */
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const AIR_QUALITY = ['us_aqi', 'pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide'] as const;
const CURRENT = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'weather_code',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'pressure_msl',
  'is_day',
] as const;

const N = Schema.NullOr(Schema.Finite);
const Forecast = Schema.Struct({
  elevation: N,
  timezone: Schema.NullOr(Schema.String),
  utc_offset_seconds: Schema.NullOr(Schema.Int),
  current: Schema.optionalKey(
    Schema.Struct({
      time: Schema.String,
      temperature_2m: N,
      apparent_temperature: N,
      relative_humidity_2m: N,
      precipitation: N,
      weather_code: Schema.NullOr(Schema.Int),
      cloud_cover: N,
      wind_speed_10m: N,
      wind_direction_10m: N,
      wind_gusts_10m: N,
      pressure_msl: N,
      is_day: Schema.NullOr(Schema.Int),
    }),
  ),
});
type Forecast = typeof Forecast.Type;

const AirQuality = Schema.Struct({
  current: Schema.optionalKey(
    Schema.Struct({
      time: Schema.String,
      us_aqi: N,
      pm2_5: N,
      pm10: N,
      ozone: N,
      nitrogen_dioxide: N,
    }),
  ),
});
type AirQuality = typeof AirQuality.Type;

const toAirQuality = (current: AirQuality['current']): CurrentAirQuality | null =>
  current
    ? {
        time: current.time,
        usAqi: current.us_aqi,
        pm25: current.pm2_5,
        pm10: current.pm10,
        ozone: current.ozone,
        nitrogenDioxide: current.nitrogen_dioxide,
      }
    : null;

/** Points within ~1 km share an answer, so the edge cache can serve nearby clicks. */
export const snap = (value: number): number => Math.round(value * 100) / 100;

const toWeather = (current: Forecast['current']): CurrentWeather | null => {
  if (!current) return null;
  const c = current;
  if (c.temperature_2m === null || c.weather_code === null) return null;
  return {
    time: c.time,
    temperature: c.temperature_2m,
    apparentTemperature: c.apparent_temperature ?? c.temperature_2m,
    humidity: c.relative_humidity_2m ?? 0,
    precipitation: c.precipitation ?? 0,
    weatherCode: c.weather_code,
    cloudCover: c.cloud_cover ?? 0,
    windSpeed: c.wind_speed_10m ?? 0,
    windDirection: c.wind_direction_10m ?? 0,
    windGusts: c.wind_gusts_10m ?? 0,
    pressure: c.pressure_msl ?? 0,
    isDay: c.is_day === 1,
  };
};

/** Conditions at any point on Earth (Open-Meteo), looked up when someone clicks the globe. */
export class HereLookup extends Context.Service<
  HereLookup,
  { at(lat: number, lon: number): Effect.Effect<Here, UpstreamUnavailable> }
>()('atlas/HereLookup') {
  static readonly layer = Layer.effect(
    HereLookup,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const at = Effect.fn('HereLookup.at')(function* (lat: number, lon: number) {
        const point = { lat: snap(lat), lon: snap(lon) };
        const where = `latitude=${point.lat}&longitude=${point.lon}`;
        const [forecast, air] = yield* Effect.all(
          [
            get(`${FORECAST_URL}?${where}&current=${CURRENT.join(',')}&timezone=auto`).pipe(
              Effect.flatMap(okText),
              Effect.flatMap(decodeJson(Forecast)),
              Effect.mapError(() => new UpstreamUnavailable({ source: 'Open-Meteo' })),
            ),
            // Air quality is a separate service: without it, the weather still answers.
            get(`${AIR_QUALITY_URL}?${where}&current=${AIR_QUALITY.join(',')}&timezone=auto`).pipe(
              Effect.flatMap(okText),
              Effect.flatMap(decodeJson(AirQuality)),
              Effect.map((body) => toAirQuality(body.current)),
              Effect.catch((error) =>
                Effect.as(
                  Effect.logWarning('air quality unavailable').pipe(
                    Effect.annotateLogs({ error: error.message }),
                  ),
                  null,
                ),
              ),
            ),
          ],
          { concurrency: 2 },
        ).pipe(Effect.provideService(HttpClient.HttpClient, client));
        return {
          ...point,
          elevation: forecast.elevation,
          timezone: forecast.timezone,
          utcOffsetSeconds: forecast.utc_offset_seconds,
          weather: toWeather(forecast.current),
          airQuality: air,
        };
      });
      return HereLookup.of({ at });
    }),
  );
}
