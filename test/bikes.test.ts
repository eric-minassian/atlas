import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Context, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { tileAt } from '../src/area.ts';
import { BIKES_ZOOM, BikeLookup, ebikesAt, reportedAt } from '../src/bikes.ts';
import { FeedStore } from '../src/feeds.ts';
import { makeBikeSystemSource } from '../src/ingest/bike-systems.ts';
import { fakeHttp, recorded, type Upstream } from './support.ts';

/** The lookup over a store holding the systems the walk located from the fixtures. */
const lookup = (upstream: Upstream = recorded) => {
  const http = fakeHttp(upstream);
  const layer = Layer.effectContext(
    Effect.gen(function* () {
      const platform = yield* Layer.build(Platform.layerMemory());
      const store = Context.get(
        yield* Layer.build(FeedStore.layer.pipe(Layer.provide(Layer.succeedContext(platform)))),
        FeedStore,
      );
      const walked = yield* makeBikeSystemSource()
        .read({}, Effect.succeedNone)
        .pipe(Effect.provide(Layer.merge(fakeHttp().layer, Layer.succeedContext(platform))));
      if (walked._tag !== 'Updated') throw new Error('expected an update');
      yield* store.begin('bikeSystems', 900);
      yield* store.publish('bikeSystems', walked.data, walked.count, {});
      return yield* Layer.build(
        BikeLookup.layer.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(FeedStore)(store), http.layer))),
      );
    }),
  );
  return { calls: http.calls, layer };
};

const timesSquare = tileAt(BIKES_ZOOM, -73.9866, 40.7551);
const paris = tileAt(BIKES_ZOOM, 2.3488, 48.8534);

describe('bike-share stations', () => {
  it.effect("joins Citi Bike's station locations and status, leaving out stations not in service", () => {
    const { layer } = lookup();
    return Effect.gen(function* () {
      const answer = yield* (yield* BikeLookup).tile(BIKES_ZOOM, timesSquare.x, timesSquare.y);
      assert.deepStrictEqual(answer.systems, [
        { id: 'lyft_nyc', name: 'Citi Bike', website: 'https://www.citibikenyc.com', ok: true },
      ]);
      const { data } = answer;
      // Broadway & W 41 St isn't installed; Washington Park and Lorraine St are in other tiles.
      assert.deepStrictEqual(data.name.toSorted(), [
        'Grand Concourse & E 164 St',
        'Southern Blvd & E 180 St',
        'W 171 St & St Nicholas Ave',
        'W 25 St & 6 Ave',
        'Walker St & Baxter St',
      ]);
      const i = data.name.indexOf('W 25 St & 6 Ave');
      assert.deepStrictEqual(
        [data.bikes[i], data.ebikes[i], data.docks[i], data.capacity[i], data.renting[i], data.returning[i]],
        [48, 44, 0, 51, true, true],
      );
      assert.isAbove(data.reported[i] ?? 0, 1_794_000_000);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads Vélib's GBFS 1.0 feeds and its own e-bike counts", () => {
    const { layer } = lookup();
    return Effect.gen(function* () {
      const { data, systems } = yield* (yield* BikeLookup).tile(BIKES_ZOOM, paris.x, paris.y);
      assert.deepStrictEqual(
        systems.map((s) => s.id),
        ['Paris'],
      );
      const i = data.name.indexOf('Saint-Sulpice');
      assert.deepStrictEqual(
        [data.bikes[i], data.ebikes[i], data.docks[i], data.capacity[i]],
        [16, 1, 3, 21],
      );
      assert.notInclude([...data.name], 'Benjamin Godard - Victor Hugo');
    }).pipe(Effect.provide(layer));
  });

  it.effect('reuses station locations for an hour and status for a minute', () => {
    const { calls, layer } = lookup();
    return Effect.gen(function* () {
      const bikes = yield* BikeLookup;
      const count = (feed: string) => calls.filter((c) => c.url.pathname.endsWith(`${feed}.json`)).length;
      yield* bikes.tile(BIKES_ZOOM, paris.x, paris.y);
      yield* bikes.tile(BIKES_ZOOM, paris.x, paris.y + 1);
      assert.deepStrictEqual([count('station_information'), count('station_status')], [1, 1]);
      yield* TestClock.adjust('2 minutes');
      yield* bikes.tile(BIKES_ZOOM, paris.x, paris.y);
      assert.deepStrictEqual([count('station_information'), count('station_status')], [1, 2]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('reports a system that fails', () => {
    const { layer } = lookup((call) =>
      call.url.pathname.endsWith('station_status.json')
        ? new Response('down', { status: 500 })
        : recorded(call),
    );
    return Effect.gen(function* () {
      const answer = yield* (yield* BikeLookup).tile(BIKES_ZOOM, paris.x, paris.y);
      assert.deepStrictEqual(
        answer.systems.map((s) => [s.id, s.ok]),
        [['Paris', false]],
      );
      assert.strictEqual(answer.data.id.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it('counts e-bikes however a system reports them', () => {
    const electric = new Set(['2']);
    assert.strictEqual(ebikesAt({ station_id: 'a', num_ebikes_available: 3 }, electric), 3);
    assert.strictEqual(
      ebikesAt(
        {
          station_id: 'a',
          vehicle_types_available: [
            { vehicle_type_id: '1', count: 4 },
            { vehicle_type_id: '2', count: 2 },
          ],
        },
        electric,
      ),
      2,
    );
    assert.strictEqual(
      ebikesAt({ station_id: 'a', num_bikes_available_types: [{ mechanical: 1 }, { ebike: 5 }] }, electric),
      5,
    );
    assert.isNull(ebikesAt({ station_id: 'a', num_bikes_available: 4 }, new Set()));
  });

  it('reads report times in either GBFS form', () => {
    assert.strictEqual(reportedAt(1_794_791_607), 1_794_791_607);
    assert.strictEqual(reportedAt('2026-11-16T00:59:12Z'), Date.parse('2026-11-16T00:59:12Z') / 1000);
    assert.isNull(reportedAt(undefined));
  });
});
