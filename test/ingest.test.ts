import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Effect, Layer } from 'effect';
import type { FeedId } from '../src/domain.ts';
import { makeAircraftSource } from '../src/ingest/aircraft.ts';
import { makeEarthquakeSource } from '../src/ingest/earthquakes.ts';
import { makeEventSource } from '../src/ingest/events.ts';
import { makeFireSource, parseFires } from '../src/ingest/fires.ts';
import { makeRadarSource } from '../src/ingest/radar.ts';
import { groupOf, makeSatelliteSource } from '../src/ingest/satellites.ts';
import { IngestError, type IngestResult, type Source } from '../src/ingest/source.ts';
import { fakeHttp, fixture, type Upstream } from './support.ts';

/** Runs a source's read against `upstream`, with optional secrets. */
const read = <F extends FeedId>(
  source: Source<F>,
  upstream?: Upstream,
  secrets: Record<string, string> = {},
) => {
  const http = fakeHttp(upstream);
  return source.read({}).pipe(
    Effect.provide(Layer.merge(http.layer, Platform.layerMemory({ secrets }))),
    Effect.map((result) => ({ result, calls: http.calls })),
  );
};

const updatedData = <F extends FeedId>(result: IngestResult<F>) => {
  if (result._tag !== 'Updated') throw new Error(`expected an update, got ${result._tag}`);
  return result;
};

describe('aircraft (OpenSky)', () => {
  it.effect('keeps positioned aircraft, trims callsigns, and prefers geometric altitude', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeAircraftSource());
      const { data, count } = updatedData(result);
      assert.strictEqual(count, 3);
      assert.strictEqual(data.icao.length, 3);
      assert.strictEqual(data.callsign[0], 'XAA4341');
      assert.strictEqual(data.altitude[0], 6180); // geo_altitude, not baro_altitude (6217.92)
      assert.deepStrictEqual(data.category, [3, 3, 3]);
      assert.isTrue(data.icao.every((_, i) => Number.isFinite(data.lon[i]) && Number.isFinite(data.lat[i])));
    }),
  );

  it.effect('reports an exhausted quota', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.map(
          read(
            makeAircraftSource(),
            () => new Response('', { status: 429, headers: { 'x-rate-limit-retry-after-seconds': '120' } }),
          ),
          ({ result }) => result,
        ),
      );
      assert.instanceOf(error, IngestError);
      assert.include(error.message, 'retry in 120s');
    }),
  );

  it.effect('signs in with API client credentials and reuses the token', () =>
    Effect.gen(function* () {
      const source = makeAircraftSource();
      const secrets = { OPENSKY_CLIENT_ID: 'atlas', OPENSKY_CLIENT_SECRET: 's3cret' };
      let tokens = 0;
      const upstream: Upstream = ({ url }) => {
        if (url.host === 'auth.opensky-network.org') {
          tokens++;
          return Response.json({ access_token: `t${tokens}`, expires_in: 1800 });
        }
        return new Response(fixture('opensky.json'));
      };
      const first = yield* read(source, upstream, secrets);
      const second = yield* read(source, upstream, secrets);
      assert.strictEqual(tokens, 1);
      assert.strictEqual(first.calls.at(-1)?.headers.authorization, 'Bearer t1');
      assert.strictEqual(second.calls.at(-1)?.headers.authorization, 'Bearer t1');
      assert.strictEqual(yield* source.interval.pipe(Effect.provide(Platform.layerMemory({ secrets }))), 90);
      assert.strictEqual(yield* source.interval.pipe(Effect.provide(Platform.layerMemory())), 900);
    }),
  );
});

describe('satellites (CelesTrak)', () => {
  it.effect('reads elements and sorts satellites into groups', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeSatelliteSource());
      const { data, validators } = updatedData(result);
      assert.deepStrictEqual(data.group, ['station', 'starlink', 'gnss', 'gnss', 'weather', 'other']);
      assert.strictEqual(data.noradId[0], 25544);
      assert.strictEqual(validators.lastModified, 'Sun, 15 Nov 2026 22:00:00 GMT');
    }),
  );

  it.effect('treats a repeat download within the update cycle as unchanged', () =>
    Effect.gen(function* () {
      const { result } = yield* read(
        makeSatelliteSource(),
        () =>
          new Response(
            'GP data has not updated since your last successful download of GROUP=active at 2026-11-15 22:19:06 UTC.',
            { status: 403 },
          ),
      );
      assert.strictEqual(result._tag, 'NotModified');
    }),
  );

  it.effect('fails on other refusals', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.map(
          read(makeSatelliteSource(), () => new Response('blocked', { status: 403 })),
          (r) => r.result,
        ),
      );
      assert.include(error.message, 'HTTP 403');
    }),
  );

  it('classifies GLONASS by its navigation orbit', () => {
    assert.strictEqual(
      groupOf({ OBJECT_NAME: 'COSMOS 2433 (720)', MEAN_MOTION: 2.131, INCLINATION: 64.8 }),
      'gnss',
    );
    assert.strictEqual(
      groupOf({ OBJECT_NAME: 'COSMOS 2558', MEAN_MOTION: 15.2, INCLINATION: 97.6 }),
      'other',
    );
  });
});

describe('earthquakes (USGS)', () => {
  it.effect('normalizes features and sends validators on the next read', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeEarthquakeSource());
      const { data, validators } = updatedData(result);
      assert.strictEqual(data.events.length, 3);
      const [first] = data.events;
      assert.isString(first?.id);
      assert.isTrue(Number.isFinite(first?.depth));
      assert.strictEqual(validators.lastModified, 'Sun, 15 Nov 2026 22:18:37 GMT');

      const http = fakeHttp(({ headers }) =>
        headers['if-modified-since'] ? new Response(null, { status: 304 }) : undefined,
      );
      const again = yield* makeEarthquakeSource()
        .read(validators)
        .pipe(Effect.provide(Layer.merge(http.layer, Platform.layerMemory())));
      assert.strictEqual(again._tag, 'NotModified');
    }),
  );
});

describe('fires (FIRMS)', () => {
  it('parses detections, skipping malformed rows', () => {
    const parsed = parseFires(fixture('firms.csv'));
    if (parsed instanceof IngestError) throw parsed;
    const { data, skipped } = parsed;
    assert.strictEqual(skipped, 2);
    assert.strictEqual(data.lat.length, 5);
    assert.strictEqual(data.since, Date.parse('2026-11-14T00:41:00Z'));
    assert.deepStrictEqual(data.acquired, [6, 0, 6, 0, 744]);
    assert.deepStrictEqual(data.confidence, [1, 1, 1, 1, 2]);
    assert.deepStrictEqual(data.day, [0, 0, 0, 0, 1]);
  });

  it('rejects a file without the expected columns', () => {
    assert.instanceOf(parseFires('lat,lon\n1,2\n'), IngestError);
  });

  it.effect('keeps the ETag for a conditional read', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeFireSource());
      assert.strictEqual(updatedData(result).validators.etag, '"firms-1"');
    }),
  );
});

describe('natural events (EONET)', () => {
  it.effect('places events at their latest observation and keeps earlier ones as a track', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeEventSource());
      const { data } = updatedData(result);
      const storm = data.events.find((e) => e.category === 'severeStorms');
      assert.isDefined(storm);
      assert.isAbove(storm?.track.length ?? 0, 1);
      const volcano = data.events.find((e) => e.id === 'EONET_TEST_POLY');
      assert.deepStrictEqual([volcano?.lon, volcano?.lat], [11, 21]);
      assert.deepStrictEqual(volcano?.track, []);
    }),
  );
});

describe('radar (RainViewer)', () => {
  it.effect('lists frames oldest first', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeRadarSource());
      const { data } = updatedData(result);
      assert.strictEqual(data.host, 'https://tilecache.rainviewer.com');
      const times = data.frames.map((f) => f.time);
      assert.deepStrictEqual(
        times,
        times.toSorted((a, b) => a - b),
      );
    }),
  );
});
