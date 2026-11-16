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
import { AIRPORT_ZOOM } from '../src/airports.ts';
import { Api } from '../src/api.ts';
import { tileAt } from '../src/area.ts';
import { BIKES_ZOOM } from '../src/bikes.ts';
import { FeedStore } from '../src/feeds.ts';
import { HttpLive } from '../src/http.ts';
import { parseAirports } from '../src/ingest/airports.ts';
import { FeatureCollection, parseQuakes } from '../src/ingest/earthquakes.ts';
import { Sources } from '../src/ingest/index.ts';
import { makeShipSource } from '../src/ingest/ships.ts';
import { IngestError } from '../src/ingest/source.ts';
import { parseTransitFeeds } from '../src/ingest/transit-feeds.ts';
import { TRANSIT_ZOOM } from '../src/transit.ts';
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
    return { client, store, get, calls: http.calls };
  });

const quakes = parseQuakes(
  Schema.decodeSync(Schema.fromJsonString(FeatureCollection))(fixture('usgs.geojson')),
);

const parsedOrThrow = <A>(parsed: A | IngestError): A => {
  if (parsed instanceof IngestError) throw parsed;
  return parsed;
};
const airports = parsedOrThrow(
  parseAirports(fixture('ourairports-airports.csv'), fixture('ourairports-runways.csv')),
);
const transitFeeds = parsedOrThrow(parseTransitFeeds(fixture('mobilitydatabase.csv')));

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
          ['ships', null, 300],
          ['airports', null, 86400],
          ['transitFeeds', null, 86400],
          ['bikeSystems', null, 900],
          ['lightning', null, 60],
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

  it.effect('serves ships, read from Digitraffic without an aisstream key', () =>
    Effect.gen(function* () {
      const { client, store } = yield* setup();
      const result = yield* makeShipSource()
        .read({}, Effect.succeedNone)
        .pipe(Effect.provide(Layer.merge(fakeHttp().layer, Platform.layerMemory())));
      if (result._tag !== 'Updated') throw new Error('expected an update');
      yield* store.begin('ships', 300);
      yield* store.publish('ships', result.data, result.count, {});
      const snapshot = yield* client.feeds.ships();
      assert.include([...snapshot.data.name], 'SILVA');
    }),
  );

  it.effect('serves large and medium airports globally, and every airport by tile with runways', () =>
    Effect.gen(function* () {
      const { client, store, get } = yield* setup();
      assert.strictEqual((yield* Effect.flip(client.feeds.airports()))._tag, 'FeedNotReady');
      yield* store.begin('airports', 86400);
      const { version } = yield* store.publish(
        'airports',
        airports.data,
        airports.data.airports.ident.length,
        {},
      );

      const global = yield* client.feeds.airports();
      assert.strictEqual(global.version, version);
      assert.deepStrictEqual(global.data.airports.ident, ['KBOS', 'EGLL', 'KBED']);
      assert.strictEqual(global.count, 3);
      assert.deepStrictEqual(global.data.runways.airport, []);
      const response = yield* get('/api/feeds/airports');
      assert.strictEqual(response.headers.get('etag'), `"${version}"`);
      assert.strictEqual(
        response.headers.get('cache-control'),
        'public, max-age=300, stale-while-revalidate=900',
      );
      assert.strictEqual(
        (yield* get('/api/feeds/airports', { 'if-none-match': `"${version}"` })).status,
        304,
      );

      const boston = tileAt(AIRPORT_ZOOM, -71.0079, 42.36197);
      const tile = yield* client.live.airports({ params: { z: AIRPORT_ZOOM, ...boston } });
      assert.strictEqual(tile.version, version);
      assert.includeMembers([...tile.data.airports.ident], ['KBOS', 'KBED', '04MA', '01MA']);
      assert.notInclude([...tile.data.airports.ident], 'EGLL');
      const bos = tile.data.airports.ident.indexOf('KBOS');
      assert.strictEqual(tile.data.runways.airport.filter((a) => a === bos).length, 6);
      assert.strictEqual(
        (yield* get(`/api/live/airports/8/${boston.x}/${boston.y}`)).headers.get('cache-control'),
        'public, max-age=3600, stale-while-revalidate=86400',
      );
      assert.strictEqual((yield* get(`/api/live/airports/9/${boston.x}/${boston.y}`)).status, 404);
      assert.strictEqual((yield* get('/api/live/airports/8/256/0')).status, 404);
    }),
  );

  it.effect('serves transit vehicles by tile once the feed catalog is in', () =>
    Effect.gen(function* () {
      const { client, store, get } = yield* setup();
      const boston = tileAt(TRANSIT_ZOOM, -71.1516, 42.336);
      const before = yield* Effect.flip(client.live.transit({ params: { z: TRANSIT_ZOOM, ...boston } }));
      assert.strictEqual(before._tag, 'FeedNotReady');
      yield* store.begin('transitFeeds', 86400);
      yield* store.publish('transitFeeds', transitFeeds.data, transitFeeds.data.id.length, {});
      const answer = yield* client.live.transit({ params: { z: TRANSIT_ZOOM, ...boston } });
      assert.deepStrictEqual(
        answer.feeds.map((f) => f.id),
        ['mdb-1602'],
      );
      assert.isAbove(answer.data.id.length, 0);
      assert.strictEqual(
        (yield* get(`/api/live/transit/10/${boston.x}/${boston.y}`)).headers.get('cache-control'),
        'public, max-age=15, stale-while-revalidate=30',
      );
      assert.strictEqual((yield* get(`/api/live/transit/12/${boston.x}/${boston.y}`)).status, 404);
      assert.deepStrictEqual(errors(), []);
    }),
  );

  it.effect('serves bike-share stations by tile', () =>
    Effect.gen(function* () {
      const { client, store, get } = yield* setup();
      const paris = tileAt(BIKES_ZOOM, 2.3488, 48.8534);
      assert.strictEqual((yield* get(`/api/live/bikes/11/${paris.x}/${paris.y}`)).status, 404);
      const systems = yield* Sources.pipe(
        Effect.flatMap((sources) => sources.bikeSystems.read({}, Effect.succeedNone)),
        Effect.provide(Layer.mergeAll(Sources.layer, fakeHttp().layer, Platform.layerMemory())),
      );
      if (systems._tag !== 'Updated') throw new Error('expected an update');
      yield* store.begin('bikeSystems', 900);
      yield* store.publish('bikeSystems', systems.data, systems.count, {});
      const answer = yield* client.live.bikes({ params: { z: BIKES_ZOOM, ...paris } });
      assert.include([...answer.data.name], 'Saint-Sulpice');
      assert.strictEqual(
        (yield* get(`/api/live/bikes/11/${paris.x}/${paris.y}`)).headers.get('cache-control'),
        'public, max-age=60, stale-while-revalidate=120',
      );
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
