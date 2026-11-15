import { Cache, Clock, Context, Duration, Effect, Layer, Schema, Semaphore } from 'effect';
import { HttpClient } from 'effect/http';
import { aircraftSources } from './catalog.ts';
import { type AircraftData, type AircraftNearby, UpstreamUnavailable } from './domain.ts';
import { type Columns, decodeJson, get, IngestError, okText, round } from './ingest/source.ts';

/**
 * Live aircraft near a point, from community ADS-B networks. No free source
 * offers the whole world to a cloud client (OpenSky drops connections from AWS;
 * adsb.lol sells `?all`), so Atlas asks for the area someone is looking at:
 * points snap to whole degrees, so every viewer of an area shares one upstream
 * request and one edge-cached answer.
 */
export const RADIUS_NM = 250;
/** How long an answer is reused; ADS-B networks update about once a second. */
const FRESH = Duration.seconds(8);
/** adsb.fi asks for at most one request per second per client. */
const SPACING = Duration.millis(1100);

const FEET = 0.3048;
const KNOTS = 0.514444;

const N = Schema.optionalKey(Schema.Finite);
const S = Schema.optionalKey(Schema.String);

/** One aircraft in readsb's JSON (https://github.com/wiedehopf/readsb/blob/dev/README-json.md). Extra keys are ignored. */
const ReadsbAircraft = Schema.Struct({
  hex: Schema.String,
  flight: S,
  r: S,
  t: S,
  category: S,
  lat: N,
  lon: N,
  alt_baro: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Literal('ground')])),
  alt_geom: N,
  gs: N,
  track: N,
  baro_rate: N,
  geom_rate: N,
  squawk: S,
  seen_pos: N,
});

/** adsb.fi lists aircraft under `aircraft` with `now` in seconds; adsb.lol under `ac` with `now` in ms. */
const ReadsbResponse = Schema.Struct({
  now: Schema.Finite,
  aircraft: Schema.optionalKey(Schema.Array(ReadsbAircraft)),
  ac: Schema.optionalKey(Schema.Array(ReadsbAircraft)),
});
type ReadsbResponse = typeof ReadsbResponse.Type;

/** Normalizes a readsb response to SI units, dropping aircraft without a position. */
export const parseReadsb = (
  response: ReadsbResponse,
): { readonly time: number; readonly data: AircraftData } => {
  const now = response.now > 1e11 ? response.now / 1000 : response.now;
  const out: Columns<AircraftData> = {
    icao: [],
    callsign: [],
    registration: [],
    type: [],
    category: [],
    lon: [],
    lat: [],
    altitude: [],
    onGround: [],
    speed: [],
    track: [],
    verticalRate: [],
    squawk: [],
    positionTime: [],
  };
  for (const a of response.aircraft ?? response.ac ?? []) {
    if (a.lat === undefined || a.lon === undefined) continue;
    const onGround = a.alt_baro === 'ground';
    const feet = a.alt_geom ?? (typeof a.alt_baro === 'number' ? a.alt_baro : undefined);
    const rate = a.geom_rate ?? a.baro_rate;
    out.icao.push(a.hex);
    out.callsign.push((a.flight ?? '').trim());
    out.registration.push(a.r ?? '');
    out.type.push(a.t ?? '');
    out.category.push(a.category ?? '');
    out.lon.push(round(a.lon, 4));
    out.lat.push(round(a.lat, 4));
    out.altitude.push(onGround ? 0 : feet === undefined ? null : Math.round(feet * FEET));
    out.onGround.push(onGround);
    out.speed.push(a.gs === undefined ? null : round(a.gs * KNOTS, 1));
    out.track.push(a.track === undefined ? null : round(a.track, 1));
    out.verticalRate.push(rate === undefined ? null : round((rate * FEET) / 60, 1));
    out.squawk.push(a.squawk ?? null);
    out.positionTime.push(round(now - (a.seen_pos ?? 0), 1));
  }
  return { time: Math.round(now * 1000), data: out };
};

const urls: Readonly<Record<string, (lat: number, lon: number) => string>> = {
  'adsb.fi': (lat, lon) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
  'adsb.lol': (lat, lon) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
};

export class AircraftNearbyLookup extends Context.Service<
  AircraftNearbyLookup,
  { near(lat: number, lon: number): Effect.Effect<AircraftNearby, UpstreamUnavailable> }
>()('atlas/AircraftNearbyLookup') {
  static readonly layer = Layer.effect(
    AircraftNearbyLookup,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      // Per network: one request at a time, and at least SPACING after the previous one.
      const gates = new Map(
        yield* Effect.forEach(aircraftSources, (source) =>
          Effect.map(Semaphore.make(1), (gate): [string, { gate: Semaphore.Semaphore; last: number }] => [
            source.name,
            { gate, last: Number.NEGATIVE_INFINITY },
          ]),
        ),
      );
      const spaced = <A, E, R>(source: string, request: Effect.Effect<A, E, R>) => {
        const entry = gates.get(source);
        if (!entry) return request;
        return Effect.gen(function* () {
          const wait = entry.last + Duration.toMillis(SPACING) - (yield* Clock.currentTimeMillis);
          if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
          entry.last = yield* Clock.currentTimeMillis;
          return yield* request;
        }).pipe(Semaphore.withPermit(entry.gate));
      };

      /** Asks each network in turn until one answers. */
      const fetchCell = Effect.fnUntraced(function* (cell: string) {
        const [lat = 0, lon = 0] = cell.split(',').map(Number);
        for (const source of aircraftSources) {
          const url = urls[source.name];
          if (!url) continue;
          const result = yield* spaced(
            source.name,
            get(url(lat, lon)).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(ReadsbResponse))),
          ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);
          if (result._tag === 'Success') {
            const { time, data } = parseReadsb(result.success);
            return {
              lat,
              lon,
              radiusNm: RADIUS_NM,
              time,
              source: source.name,
              data,
            } satisfies AircraftNearby;
          }
          yield* Effect.logWarning('aircraft source failed').pipe(
            Effect.annotateLogs({ source: source.name, error: result.failure.message }),
          );
        }
        return yield* new IngestError({ message: 'every aircraft source failed' });
      });

      const cache = yield* Cache.make({ lookup: fetchCell, capacity: 2000, timeToLive: FRESH });

      const near = Effect.fn('AircraftNearbyLookup.near')(function* (lat: number, lon: number) {
        const cell = `${Math.round(lat)},${Math.round(lon)}`;
        yield* Effect.annotateCurrentSpan({ cell });
        return yield* Cache.get(cache, cell).pipe(
          Effect.mapError(() => new UpstreamUnavailable({ source: 'ADS-B networks' })),
        );
      });
      return AircraftNearbyLookup.of({ near });
    }),
  );
}
