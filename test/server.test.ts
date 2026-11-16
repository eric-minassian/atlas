import { assert, describe, it } from '@effect/vitest';
import { Platform, Storage, toFetchHandler } from '@ericminassian/platform';
import {
  captureTelemetry,
  createPlatformFetch,
  resetPlatform,
  useTestBindings,
} from '@ericminassian/platform/testing';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { afterEach, beforeEach } from 'vitest';
import { AIRPORT_ZOOM } from '../src/airports.ts';
import { Api } from '../src/api.ts';
import { tileAt } from '../src/area.ts';
import { BIKES_ZOOM } from '../src/bikes.ts';
import { snapshotKey } from '../src/catalog.ts';
import { type ScheduledFeedId, Snapshots } from '../src/domain.ts';
import { FeedStore } from '../src/feeds.ts';
import { HttpLive } from '../src/http.ts';
import { parseAirports } from '../src/ingest/airports.ts';
import { makeCameraSource } from '../src/ingest/cameras.ts';
import { FeatureCollection, parseQuakes } from '../src/ingest/earthquakes.ts';
import { type Source, Sources } from '../src/ingest/index.ts';
import { IngestError } from '../src/ingest/source.ts';
import { parseTransitFeeds } from '../src/ingest/transit-feeds.ts';
import { TRANSIT_ZOOM } from '../src/transit.ts';
import { fakeHttp, fixture, fixtureBytes, recorded, type Upstream, updatedData } from './support.ts';

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
    const sources = Context.get(
      yield* Layer.build(Sources.layer.pipe(Layer.provide(Layer.succeedContext(platform)))),
      Sources,
    );
    /** Reads a feed's source from the recorded fixtures, as the worker would. */
    const read = <F extends ScheduledFeedId>(feed: F) =>
      (sources[feed] as Source<F>)
        .read({}, Effect.succeedNone)
        .pipe(Effect.provide([Layer.succeedContext(platform), fakeHttp(recorded).layer]));
    const files = Context.get(platform, Storage).store('feeds');
    return { client, store, files, get, read, calls: http.calls };
  });

const quakes = parseQuakes(
  Schema.decodeSync(Schema.fromJsonString(FeatureCollection))(fixture('usgs.geojson')),
);

const { transit_realtime } = GtfsRealtimeBindings;
/** A GTFS-realtime feed with every vehicle's position time set to now. */
const restamped = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const message = transit_realtime.FeedMessage.decode(bytes);
  const now = Math.floor(Date.now() / 1000);
  message.header.timestamp = now;
  for (const entity of message.entity) if (entity.vehicle) entity.vehicle.timestamp = now;
  return new Uint8Array(transit_realtime.FeedMessage.encode(message).finish());
};

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

  it.effect('gives the browser the keys it uses, and says which keyed sources are set up', () =>
    Effect.gen(function* () {
      const { client, get } = yield* setup();
      assert.deepStrictEqual(yield* client.config(), {
        keys: { cesiumIon: null, arcgis: null, mapillary: null },
        sources: { aisstream: false, windy: false },
      });
      assert.strictEqual(
        (yield* get('/api/config')).headers.get('cache-control'),
        'public, max-age=300, stale-while-revalidate=600',
      );
    }),
  );

  it.effect('passes configured keys through, but never a server-side one', () =>
    Effect.gen(function* () {
      const { client, get } = yield* setup(openMeteo, {
        CESIUM_ION_TOKEN: 'ion-token',
        MAPILLARY_TOKEN: 'MLY|token',
        AISSTREAM_KEY: 'ais-secret',
      });
      assert.deepStrictEqual(yield* client.config(), {
        keys: { cesiumIon: 'ion-token', arcgis: null, mapillary: 'MLY|token' },
        sources: { aisstream: true, windy: false },
      });
      const response = yield* get('/api/config');
      const body = yield* Effect.promise(() => response.text());
      assert.notInclude(body, 'ais-secret');
    }),
  );

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
          ['ships', null, 60],
          ['airports', null, 86400],
          ['transitFeeds', null, 86400],
          ['bikeSystems', null, 900],
          ['lightning', null, 60],
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

  it.effect(
    'publishes each weather, hazard and camera feed where browsers read it, as its schema encodes it',
    () =>
      Effect.gen(function* () {
        const { client, store, read, files } = yield* setup();
        const published = [
          'metars',
          'buoys',
          'airQuality',
          'disasters',
          'tsunamis',
          'weatherAlerts',
          'firePerimeters',
          'volcanoes',
          'aurora',
          'rivers',
          'cameras',
        ] as const;
        for (const feed of published) {
          const result = yield* read(feed);
          const data = updatedData(result);
          yield* store.begin(feed, 60);
          const { version } = yield* store.publish(
            feed,
            data,
            result._tag === 'Updated' ? result.count : 0,
            {},
          );
          const status = (yield* client.catalog()).feeds.find((f) => f.id === feed);
          assert.strictEqual(status?.version, version, feed);
          const body = Option.getOrThrow(yield* files.getText(snapshotKey(feed, version)));
          const snapshot = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Snapshots[feed] as unknown as Schema.Codec<{ version: string; data: unknown }>,
            ),
          )(body);
          assert.strictEqual(snapshot.version, version, feed);
          assert.deepStrictEqual(snapshot.data, data, feed);
        }
      }),
  );

  it.effect('reports an unreachable weather source as 502', () =>
    Effect.gen(function* () {
      const { client } = yield* setup(() => new Response('down', { status: 500 }));
      const error = yield* Effect.flip(client.here({ query: { lat: 0, lon: 0 } }));
      assert.strictEqual(error._tag, 'UpstreamUnavailable');
    }),
  );

  it.effect('serves every airport by tile, with runways and links', () =>
    Effect.gen(function* () {
      const { client, store, get } = yield* setup();
      const boston = tileAt(AIRPORT_ZOOM, -71.0079, 42.36197);
      const before = yield* Effect.flip(client.live.airports({ params: { z: AIRPORT_ZOOM, ...boston } }));
      assert.strictEqual(before._tag, 'FeedNotReady');
      yield* store.begin('airports', 86400);
      const { version } = yield* store.publish(
        'airports',
        airports.data,
        airports.data.airports.ident.length,
        {},
      );

      const tile = yield* client.live.airports({ params: { z: AIRPORT_ZOOM, ...boston } });
      assert.strictEqual(tile.version, version);
      assert.includeMembers([...tile.data.airports.ident], ['KBOS', 'KBED', '04MA', '01MA']);
      assert.notInclude([...tile.data.airports.ident], 'EGLL');
      const bos = tile.data.airports.ident.indexOf('KBOS');
      assert.strictEqual(tile.data.airports.website[bos], 'http://www.massport.com/logan/');
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
      // The API runs on the real clock: the recorded vehicles, re-stamped as just reported.
      const { client, store, get } = yield* setup((call) =>
        call.url.host === 'cdn.mbta.com'
          ? new Response(restamped(fixtureBytes('mbta-vehicles.pb')))
          : openMeteo(call),
      );
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
        Effect.provide(
          Sources.layer.pipe(Layer.provideMerge(Layer.mergeAll(fakeHttp().layer, Platform.layerMemory()))),
        ),
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
