import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Context, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { contains, tileAt, tileBounds } from '../src/area.ts';
import { FeedStore } from '../src/feeds.ts';
import { IngestError } from '../src/ingest/source.ts';
import { parseTransitFeeds } from '../src/ingest/transit-feeds.ts';
import { modeOf, readSchedule } from '../src/schedules.ts';
import { parseVehiclePositions, TRANSIT_ZOOM, TransitLookup } from '../src/transit.ts';
import { fakeHttp, fixture, fixtureBytes, recorded, type Upstream } from './support.ts';

const catalog = (() => {
  const parsed = parseTransitFeeds(fixture('mobilitydatabase.csv'));
  if (parsed instanceof IngestError) throw parsed;
  return parsed.data;
})();

/** The lookup over a store holding the fixture catalog, reading from `upstream`. */
const lookup = (upstream: Upstream = recorded) => {
  const http = fakeHttp(upstream);
  const layer = Layer.effectContext(
    Effect.gen(function* () {
      const platform = yield* Layer.build(Platform.layerMemory());
      const store = Context.get(
        yield* Layer.build(FeedStore.layer.pipe(Layer.provide(Layer.succeedContext(platform)))),
        FeedStore,
      );
      yield* store.begin('transitFeeds', 86400);
      yield* store.publish('transitFeeds', catalog, catalog.id.length, {});
      return yield* Layer.build(
        TransitLookup.layer.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(FeedStore)(store), http.layer))),
      );
    }),
  );
  return { calls: http.calls, layer };
};

const vehicles = (() => {
  const parsed = parseVehiclePositions(fixtureBytes('mbta-vehicles.pb'));
  if (parsed instanceof IngestError) throw parsed;
  return parsed;
})();
const first = vehicles[0] as (typeof vehicles)[number];
const bostonTile = tileAt(TRANSIT_ZOOM, first.lon, first.lat);

describe('transit vehicles', () => {
  it('decodes GTFS-realtime vehicle positions, telling unset fields from zeros', () => {
    assert.strictEqual(vehicles.length, 10);
    assert.deepStrictEqual(first, {
      id: 'ynk230',
      label: '230',
      route: 'Shuttle-Generic',
      trip: 'BL-40770992',
      lon: -71.15163,
      lat: 42.33603,
      bearing: null,
      speed: null,
      timestamp: 1794791869,
    });
    assert.isTrue(vehicles.some((v) => v.bearing !== null));
    assert.instanceOf(parseVehiclePositions(new Uint8Array([0xff, 0xff, 0xff])), IngestError);
  });

  it.effect('reads route names and modes from a static GTFS archive by range requests', () =>
    Effect.gen(function* () {
      const http = fakeHttp();
      const routes = yield* readSchedule('https://files.mobilitydatabase.org/mdb-437/latest.zip').pipe(
        Effect.provide(http.layer),
      );
      assert.deepStrictEqual(routes.get('Red'), { name: 'Red Line', mode: 'metro' });
      assert.deepStrictEqual(routes.get('Green-B'), { name: 'B', mode: 'tram' });
      assert.deepStrictEqual(routes.get('743'), { name: 'SL3', mode: 'bus' });
      // The archive's directory and one entry, never the whole file.
      assert.isTrue(http.calls.every((c) => c.method === 'HEAD' || c.headers.range !== undefined));
    }),
  );

  it('maps basic and extended route types to modes', () => {
    assert.deepStrictEqual([0, 1, 2, 3, 4, 6, 7, 11, 12, 109, 401, 700, 900, 1000, 1300, 1700].map(modeOf), [
      'tram',
      'metro',
      'rail',
      'bus',
      'ferry',
      'cable',
      'cable',
      'bus',
      'metro',
      'rail',
      'metro',
      'bus',
      'tram',
      'ferry',
      'cable',
      'other',
    ]);
  });

  it.effect('answers a tile from every feed covering it, sharing each download between tiles', () => {
    const { calls, layer } = lookup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_794_792_041_000);
      const transit = yield* TransitLookup;
      const answer = yield* transit.tile(TRANSIT_ZOOM, bostonTile.x, bostonTile.y);
      assert.deepStrictEqual(answer.feeds, [
        { id: 'mdb-1602', provider: 'Massachusetts Bay Transportation Authority (MBTA)', ok: true },
      ]);
      const bounds = tileBounds(TRANSIT_ZOOM, bostonTile.x, bostonTile.y);
      const { data } = answer;
      assert.isAbove(data.id.length, 0);
      for (let i = 0; i < data.id.length; i++)
        assert.isTrue(contains(bounds, data.lon[i] as number, data.lat[i] as number));
      const shuttle = data.id.indexOf('ynk230');
      assert.deepStrictEqual([data.routeName[shuttle], data.mode[shuttle]], ['Shuttle', 'bus']);

      const feedCalls = () => calls.filter((c) => c.url.host === 'cdn.mbta.com').length;
      assert.strictEqual(feedCalls(), 1);
      // A neighbouring tile within the MBTA's area: the same download.
      yield* transit.tile(TRANSIT_ZOOM, bostonTile.x + 1, bostonTile.y);
      assert.strictEqual(feedCalls(), 1);
      yield* TestClock.adjust('20 seconds');
      yield* transit.tile(TRANSIT_ZOOM, bostonTile.x, bostonTile.y);
      assert.strictEqual(feedCalls(), 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('reports a feed that fails', () => {
    const { layer } = lookup((call) =>
      call.url.host === 'cdn.mbta.com' ? new Response('down', { status: 503 }) : recorded(call),
    );
    return Effect.gen(function* () {
      const answer = yield* (yield* TransitLookup).tile(TRANSIT_ZOOM, bostonTile.x, bostonTile.y);
      assert.deepStrictEqual(
        answer.feeds.map((f) => f.ok),
        [false],
      );
      assert.strictEqual(answer.data.id.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect('drops positions older than half an hour', () => {
    const { layer } = lookup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_794_792_041_000 + 2 * 3_600_000);
      const answer = yield* (yield* TransitLookup).tile(TRANSIT_ZOOM, bostonTile.x, bostonTile.y);
      assert.strictEqual(answer.data.id.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect('serves only its zoom', () => {
    const { layer } = lookup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* TransitLookup).tile(9, 0, 0));
      assert.strictEqual(error._tag, 'TileOutOfRange');
    }).pipe(Effect.provide(layer));
  });
});
