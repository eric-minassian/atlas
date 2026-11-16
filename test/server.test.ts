import { assert, describe, it } from '@effect/vitest';
import { Platform, toFetchHandler } from '@ericminassian/platform';
import {
  captureTelemetry,
  createPlatformFetch,
  resetPlatform,
  useTestBindings,
} from '@ericminassian/platform/testing';
import { Context, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { afterEach, beforeEach } from 'vitest';
import { Api } from '../src/api.ts';
import type { FeedId } from '../src/domain.ts';
import { FeedStore } from '../src/feeds.ts';
import { HttpLive } from '../src/http.ts';
import { FeatureCollection, parseQuakes } from '../src/ingest/earthquakes.ts';
import { type Source, Sources } from '../src/ingest/index.ts';
import { fakeHttp, fixture, recorded, type Upstream, updatedData } from './support.ts';

const BASE = 'http://atlas.localhost';

const airQuality = {
  latitude: 34.1,
  longitude: -118.2,
  current: {
    time: '2026-11-15T14:00',
    us_aqi: 76,
    pm2_5: 14.7,
    pm10: 18.1,
    ozone: 74,
    nitrogen_dioxide: 28.2,
  },
};

const openMeteo: Upstream = (call) =>
  call.url.host === 'air-quality-api.open-meteo.com'
    ? Response.json(airQuality)
    : call.url.host === 'api.open-meteo.com'
      ? Response.json({
          latitude: 34.06,
          longitude: -118.25,
          elevation: 89,
          timezone: 'America/Los_Angeles',
          utc_offset_seconds: -28800,
          current: {
            time: '2026-11-15T14:30',
            temperature_2m: 19.4,
            apparent_temperature: 18.2,
            relative_humidity_2m: 41,
            precipitation: 0,
            weather_code: 1,
            cloud_cover: 12,
            wind_speed_10m: 9.4,
            wind_direction_10m: 250,
            wind_gusts_10m: 18.7,
            pressure_msl: 1016.2,
            is_day: 1,
          },
        })
      : recorded(call);

/** The app on a fresh in-memory platform, plus a FeedStore over the same storage to publish with. */
const setup = (upstream: Upstream = openMeteo) =>
  Effect.gen(function* () {
    const http = fakeHttp(upstream);
    const platform = yield* Layer.build(Platform.layerMemory());
    const app = toFetchHandler(HttpLive.pipe(Layer.provide([Layer.succeedContext(platform), http.layer])));
    yield* Effect.addFinalizer(() => Effect.promise(app.dispose));
    const fetch = createPlatformFetch(app);
    const store = Context.get(
      yield* Layer.build(FeedStore.layer.pipe(Layer.provide(Layer.succeedContext(platform)))),
      FeedStore,
    );
    const client = yield* HttpApiClient.make(Api, { baseUrl: BASE }).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch)((input, init) => fetch(new Request(input, init))),
          ),
        ),
      ),
    );
    const get = (path: string, headers: Record<string, string> = {}) =>
      Effect.promise(() => fetch(new Request(`${BASE}${path}`, { headers })));
    const sources = Context.get(
      yield* Layer.build(Sources.layer.pipe(Layer.provide(Layer.succeedContext(platform)))),
      Sources,
    );
    /** Reads a feed's source from the recorded fixtures, as the worker would. */
    const read = <F extends FeedId>(feed: F) =>
      (sources[feed] as Source<F>)
        .read({}, Effect.succeedNone)
        .pipe(Effect.provide([Layer.succeedContext(platform), fakeHttp(recorded).layer]));
    return { client, store, get, read, calls: http.calls };
  });

const quakes = parseQuakes(
  Schema.decodeSync(Schema.fromJsonString(FeatureCollection))(fixture('usgs.geojson')),
);

describe('api', () => {
  let telemetry: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    useTestBindings({ app: 'atlas' });
    telemetry = captureTelemetry();
  });
  afterEach(() => {
    telemetry.stop();
    resetPlatform();
  });
  const errors = () => telemetry.events.filter((e) => e.t === 'err');

  it.effect('reports health', () =>
    Effect.gen(function* () {
      const { client } = yield* setup();
      assert.deepStrictEqual(yield* client.health(), { ok: true, app: 'test-app', stage: 'test' });
    }),
  );

  it.effect('lists every feed in the catalog, before and after its first snapshot', () =>
    Effect.gen(function* () {
      const { client, store, get } = yield* setup();
      const before = yield* client.catalog();
      assert.deepStrictEqual(
        before.feeds.map((f) => [f.id, f.version, f.intervalSeconds]),
        [
          ['satellites', null, 7200],
          ['earthquakes', null, 60],
          ['fires', null, 1800],
          ['events', null, 900],
          ['radar', null, 300],
          ['metars', null, 300],
          ['buoys', null, 600],
          ['airQuality', null, 300],
          ['disasters', null, 600],
          ['tsunamis', null, 120],
          ['weatherAlerts', null, 120],
          ['firePerimeters', null, 900],
          ['volcanoes', null, 86400],
          ['aurora', null, 300],
          ['rivers', null, 900],
        ],
      );

      yield* store.begin('earthquakes', 60);
      const { version } = yield* store.publish('earthquakes', quakes, quakes.events.length, {});
      const after = (yield* client.catalog()).feeds.find((f) => f.id === 'earthquakes');
      assert.strictEqual(after?.version, version);
      assert.strictEqual(after?.count, 3);
      assert.strictEqual(
        (yield* get('/api/catalog')).headers.get('cache-control'),
        'public, max-age=10, stale-while-revalidate=30',
      );
    }),
  );

  it.effect('answers 404 for a feed without a snapshot yet, without recording an error', () =>
    Effect.gen(function* () {
      const { client } = yield* setup();
      const error = yield* Effect.flip(client.feeds.earthquakes());
      assert.strictEqual(error._tag, 'FeedNotReady');
      assert.deepStrictEqual(errors(), []);
    }),
  );

  it.effect('serves the stored snapshot with its version as ETag, and 304 when unchanged', () =>
    Effect.gen(function* () {
      const { client, store, get } = yield* setup();
      yield* store.begin('earthquakes', 60);
      const { version } = yield* store.publish('earthquakes', quakes, quakes.events.length, {});

      const snapshot = yield* client.feeds.earthquakes();
      assert.strictEqual(snapshot.version, version);
      assert.deepStrictEqual(snapshot.data, quakes);

      const response = yield* get('/api/feeds/earthquakes');
      assert.strictEqual(response.headers.get('etag'), `"${version}"`);
      assert.strictEqual(
        response.headers.get('cache-control'),
        'public, max-age=10, stale-while-revalidate=30',
      );
      const revalidated = yield* get('/api/feeds/earthquakes', { 'if-none-match': `"${version}"` });
      assert.strictEqual(revalidated.status, 304);
    }),
  );

  it.effect('looks up conditions at a point, snapped so nearby clicks share a cache entry', () =>
    Effect.gen(function* () {
      const { client, get, calls } = yield* setup();
      const here = yield* client.here({ query: { lat: 34.0612, lon: -118.2468 } });
      assert.deepStrictEqual([here.lat, here.lon], [34.06, -118.25]);
      assert.strictEqual(here.timezone, 'America/Los_Angeles');
      assert.strictEqual(here.weather?.temperature, 19.4);
      assert.isTrue(here.weather?.isDay);
      assert.deepStrictEqual(here.airQuality, {
        time: '2026-11-15T14:00',
        usAqi: 76,
        pm25: 14.7,
        pm10: 18.1,
        ozone: 74,
        nitrogenDioxide: 28.2,
      });
      assert.strictEqual(calls.length, 2);
      for (const call of calls) assert.include(call.url.search, 'latitude=34.06&longitude=-118.25');
      assert.strictEqual(
        (yield* get('/api/here?lat=1&lon=2')).headers.get('cache-control'),
        'public, max-age=600',
      );
      assert.strictEqual((yield* get('/api/here?lat=91&lon=0')).status, 400);
    }),
  );

  it.effect('still answers with the weather when air quality is unavailable', () =>
    Effect.gen(function* () {
      const { client } = yield* setup((call) =>
        call.url.host === 'air-quality-api.open-meteo.com'
          ? new Response('busy', { status: 503 })
          : openMeteo(call),
      );
      const here = yield* client.here({ query: { lat: 34.06, lon: -118.25 } });
      assert.strictEqual(here.weather?.temperature, 19.4);
      assert.isNull(here.airQuality);
    }),
  );

  it.effect('serves each weather and hazard feed from its endpoint', () =>
    Effect.gen(function* () {
      const { client, store, get, read } = yield* setup();
      const endpoints = [
        ['metars', '/api/feeds/metars', client.feeds.metars()],
        ['buoys', '/api/feeds/buoys', client.feeds.buoys()],
        ['airQuality', '/api/feeds/air-quality', client.feeds.airQuality()],
        ['disasters', '/api/feeds/disasters', client.feeds.disasters()],
        ['tsunamis', '/api/feeds/tsunamis', client.feeds.tsunamis()],
        ['weatherAlerts', '/api/feeds/weather-alerts', client.feeds.weatherAlerts()],
        ['firePerimeters', '/api/feeds/fire-perimeters', client.feeds.firePerimeters()],
        ['volcanoes', '/api/feeds/volcanoes', client.feeds.volcanoes()],
        ['aurora', '/api/feeds/aurora', client.feeds.aurora()],
        ['rivers', '/api/feeds/rivers', client.feeds.rivers()],
      ] as const;
      for (const [feed, path, fetchSnapshot] of endpoints) {
        assert.strictEqual((yield* get(path)).status, 404, `${feed} before its first refresh`);
        const result = yield* read(feed);
        const data = updatedData(result);
        yield* store.begin(feed, 60);
        const { version } = yield* store.publish(
          feed,
          data,
          result._tag === 'Updated' ? result.count : 0,
          {},
        );
        const snapshot = yield* fetchSnapshot;
        assert.strictEqual(snapshot.version, version, feed);
        assert.deepStrictEqual(snapshot.data, data, feed);
      }
      assert.strictEqual(
        (yield* get('/api/feeds/weather-alerts')).headers.get('cache-control'),
        'public, max-age=20, stale-while-revalidate=60',
      );
      assert.strictEqual(
        (yield* get('/api/feeds/volcanoes')).headers.get('cache-control'),
        'public, max-age=300, stale-while-revalidate=900',
      );
    }),
  );

  it.effect('reports an unreachable weather source as 502', () =>
    Effect.gen(function* () {
      const { client } = yield* setup(() => new Response('down', { status: 500 }));
      const error = yield* Effect.flip(client.here({ query: { lat: 0, lon: 0 } }));
      assert.strictEqual(error._tag, 'UpstreamUnavailable');
    }),
  );

  it.effect('relays cloud tiles for the geographic tiling scheme, and rejects tiles outside it', () =>
    Effect.gen(function* () {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      let attempts = 0;
      const { get, calls } = yield* setup((call) => {
        if (call.url.host !== 'nowcoast.noaa.gov') return undefined;
        attempts++;
        // The first attempt fails, as nowCOAST occasionally does; the relay retries.
        return attempts === 1
          ? new Response('busy', { status: 503 })
          : new Response(png, { headers: { 'content-type': 'image/png' } });
      });
      const tile = yield* get('/api/tiles/clouds/1/3/0?frame=123');
      assert.strictEqual(tile.status, 200);
      assert.strictEqual(tile.headers.get('content-type'), 'image/png');
      assert.strictEqual(
        tile.headers.get('cache-control'),
        'public, max-age=3600, stale-while-revalidate=3600',
      );
      assert.deepStrictEqual(new Uint8Array(yield* Effect.promise(() => tile.arrayBuffer())), png);
      assert.strictEqual(calls.at(-1)?.url.searchParams.get('bbox'), '90,0,180,90');
      assert.strictEqual((yield* get('/api/tiles/clouds/1/4/0')).status, 404);
      assert.strictEqual((yield* get('/api/tiles/clouds/9/0/0')).status, 404);
    }),
  );
});
