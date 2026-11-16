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
import { tileAt } from '../src/area.ts';
import { FeedStore } from '../src/feeds.ts';
import { HttpLive } from '../src/http.ts';
import { makeCameraSource } from '../src/ingest/cameras.ts';
import { FeatureCollection, parseQuakes } from '../src/ingest/earthquakes.ts';
import { fakeHttp, fixture, recorded, type Upstream } from './support.ts';

const BASE = 'http://atlas.localhost';

const openMeteo: Upstream = (call) =>
  call.url.host === 'api.open-meteo.com'
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
const setup = (upstream: Upstream = openMeteo, secrets: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const http = fakeHttp(upstream);
    const platform = yield* Layer.build(Platform.layerMemory({ secrets }));
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
    return { client, store, get, calls: http.calls };
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
          ['cameras', null, 3600],
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
      assert.include(calls[0]?.url.search, 'latitude=34.06&longitude=-118.25');
      assert.strictEqual(
        (yield* get('/api/here?lat=1&lon=2')).headers.get('cache-control'),
        'public, max-age=600',
      );
      assert.strictEqual((yield* get('/api/here?lat=91&lon=0')).status, 400);
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

  it.effect('serves the traffic camera feed', () =>
    Effect.gen(function* () {
      const { client, store, get } = yield* setup();
      const cameras = yield* readCameras;
      yield* store.begin('cameras', 3600);
      const { version } = yield* store.publish('cameras', cameras, cameras.id.length, {});
      const snapshot = yield* client.feeds.cameras();
      assert.strictEqual(snapshot.version, version);
      assert.deepStrictEqual(snapshot.data, cameras);
      assert.strictEqual(
        (yield* get('/api/feeds/cameras')).headers.get('cache-control'),
        'public, max-age=300, stale-while-revalidate=900',
      );
    }),
  );

  it.effect('relays frames of HTTP-only cameras by id, and nothing else', () =>
    Effect.gen(function* () {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const { store, get, calls } = yield* setup((call) =>
        call.url.host === 'www.trimarc.org' && call.url.protocol === 'http:'
          ? new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
          : undefined,
      );
      const cameras = yield* readCameras;
      // Before the first snapshot, no camera is known.
      assert.strictEqual((yield* get('/api/live/cameras/trimarc-1/image')).status, 404);
      yield* store.begin('cameras', 3600);
      yield* store.publish('cameras', cameras, cameras.id.length, {});

      const relayed = cameras.id[cameras.relayed.indexOf(true)] as string;
      const frame = yield* get(`/api/live/cameras/${relayed}/image?t=123`);
      assert.strictEqual(frame.status, 200);
      assert.strictEqual(frame.headers.get('content-type'), 'image/jpeg');
      assert.strictEqual(frame.headers.get('cache-control'), 'public, max-age=30');
      assert.deepStrictEqual(new Uint8Array(yield* Effect.promise(() => frame.arrayBuffer())), jpeg);
      assert.strictEqual(
        calls.at(-1)?.url.href,
        'http://www.trimarc.org/images/milestone/CCTV_03_RussellvilleRd_and_CampbellLn.jpg',
      );

      const before = calls.length;
      // A camera that browsers load directly, an id that doesn't exist, and something that isn't an id.
      assert.strictEqual((yield* get('/api/live/cameras/tfl-00002.00865/image')).status, 404);
      assert.strictEqual((yield* get('/api/live/cameras/tfl-99999/image')).status, 404);
      assert.strictEqual((yield* get('/api/live/cameras/http%3A%2F%2Fexample.com/image')).status, 400);
      assert.strictEqual(calls.length, before);
      assert.deepStrictEqual(errors(), []);
    }),
  );

  it.effect('reports a camera whose operator sends no image as unavailable', () =>
    Effect.gen(function* () {
      const { store, get } = yield* setup((call) =>
        call.url.host === 'www.trimarc.org' ? new Response('<html>maintenance</html>') : undefined,
      );
      const cameras = yield* readCameras;
      yield* store.begin('cameras', 3600);
      yield* store.publish('cameras', cameras, cameras.id.length, {});
      const relayed = cameras.id[cameras.relayed.indexOf(true)] as string;
      assert.strictEqual((yield* get(`/api/live/cameras/${relayed}/image`)).status, 502);
    }),
  );

  it.effect('looks up webcams by tile at their zoom, briefly cached', () =>
    Effect.gen(function* () {
      const { client, get } = yield* setup(recorded, { WINDY_WEBCAMS_KEY: 'k' });
      const { x, y } = tileAt(8, -0.1276, 51.5072);
      const area = yield* client.live.webcams({ params: { z: 8, x, y } });
      assert.strictEqual(area.webcams[0]?.page, 'https://windy.com/webcams/1420893641');
      assert.strictEqual(
        (yield* get(`/api/live/webcams/8/${x}/${y}`)).headers.get('cache-control'),
        'public, max-age=60, stale-while-revalidate=60',
      );
      assert.strictEqual((yield* get(`/api/live/webcams/9/${x}/${y}`)).status, 404);
    }),
  );

  it.effect('answers 404 for webcams without a Windy key', () =>
    Effect.gen(function* () {
      const { client } = yield* setup(recorded);
      const error = yield* Effect.flip(client.live.webcams({ params: { z: 8, x: 127, y: 85 } }));
      assert.strictEqual(error._tag, 'SourceNotConfigured');
    }),
  );

  it.effect('looks up wildlife sightings by tile at their zoom', () =>
    Effect.gen(function* () {
      const { client, get } = yield* setup(recorded);
      const { x, y } = tileAt(11, -0.1276, 51.5072);
      const area = yield* client.live.wildlife({ params: { z: 11, x, y } });
      assert.strictEqual(area.sightings.length, 5);
      assert.strictEqual(
        (yield* get(`/api/live/wildlife/11/${x}/${y}`)).headers.get('cache-control'),
        'public, max-age=900, stale-while-revalidate=900',
      );
      assert.strictEqual((yield* get(`/api/live/wildlife/12/${x}/${y}`)).status, 404);
      assert.strictEqual((yield* get(`/api/live/wildlife/11/${2 ** 11}/0`)).status, 404);
    }),
  );
});

/** The camera feed's payload, read from the recorded camera lists. */
const readCameras = Effect.gen(function* () {
  const result = yield* makeCameraSource()
    .read({}, Effect.succeedNone)
    .pipe(Effect.provide(Layer.merge(fakeHttp(recorded).layer, Platform.layerMemory())));
  if (result._tag !== 'Updated') throw new Error('expected camera data');
  return result.data;
});
