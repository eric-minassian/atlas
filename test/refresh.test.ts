import { assert, describe, it } from '@effect/vitest';
import { Platform, Storage } from '@ericminassian/platform';
import { Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { FeedStore } from '../src/feeds.ts';
import { Sources } from '../src/ingest/index.ts';
import { isDue, Refresher } from '../src/refresh.ts';
import { fakeHttp, recorded, type Upstream } from './support.ts';

/** The refresh pipeline on the in-memory platform, reading from `upstream`. */
const pipeline = (upstream: Upstream = recorded) =>
  Refresher.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(FeedStore.layer, Sources.layer)),
    Layer.provideMerge(Layer.mergeAll(Platform.layerMemory(), fakeHttp(upstream).layer)),
  );

const state = (feed: 'earthquakes' | 'satellites') =>
  Effect.flatMap(FeedStore, (store) => Effect.map(store.states, (states) => states.get(feed)));

describe('refresh', () => {
  it.effect('queues every feed on the first tick, then each one as it comes due', () =>
    Effect.gen(function* () {
      const refresher = yield* Refresher;
      const memory = yield* Platform.Memory;

      const first = yield* refresher.tick;
      assert.deepStrictEqual(first, ['aircraft', 'satellites', 'earthquakes', 'fires', 'events', 'radar']);
      assert.deepStrictEqual(
        (yield* memory.sent).map((m) => m.body),
        first.map((feed) => ({ feed })),
      );
      for (const feed of first) yield* refresher.refresh(feed);

      assert.deepStrictEqual(yield* refresher.tick, []);
      yield* TestClock.adjust('1 minute');
      assert.deepStrictEqual(yield* refresher.tick, ['earthquakes']);
      yield* refresher.refresh('earthquakes');
      yield* TestClock.adjust('5 minutes');
      // Anonymous OpenSky access refreshes every 15 minutes.
      assert.deepStrictEqual(yield* refresher.tick, ['earthquakes', 'radar']);
    }).pipe(Effect.provide(pipeline())),
  );

  it.effect('publishes snapshots and keeps one previous version for readers mid-switch', () =>
    Effect.gen(function* () {
      const refresher = yield* Refresher;
      const store = yield* FeedStore;
      const snapshots = (yield* Storage).store('snapshots');

      for (let i = 0; i < 3; i++) {
        yield* refresher.refresh('earthquakes');
        yield* TestClock.adjust('1 minute');
      }
      const current = yield* state('earthquakes');
      assert.strictEqual(current?.count, 3);
      assert.isUndefined(current?.error);
      const stored = yield* snapshots.list('earthquakes/');
      assert.deepStrictEqual(
        stored.objects.map((o) => o.key).toSorted(),
        [`earthquakes/${current?.previousVersion}.json`, `earthquakes/${current?.version}.json`].toSorted(),
      );

      const snapshot = Option.getOrThrow(yield* store.read('earthquakes'));
      assert.strictEqual(snapshot.version, current?.version);
      const body = JSON.parse(snapshot.body) as { feed: string; count: number; data: { events: unknown[] } };
      assert.strictEqual(body.feed, 'earthquakes');
      assert.strictEqual(body.data.events.length, 3);
    }).pipe(Effect.provide(pipeline())),
  );

  it.effect('records a failure without failing the job, and retries sooner than the interval', () =>
    Effect.gen(function* () {
      const refresher = yield* Refresher;
      yield* refresher.refresh('satellites');
      const failed = yield* state('satellites');
      assert.strictEqual(failed?.failures, 1);
      assert.include(failed?.error, 'HTTP 503');
      assert.isUndefined(failed?.version);

      yield* TestClock.adjust('1 minute');
      assert.include(yield* refresher.tick, 'satellites');
    }).pipe(
      Effect.provide(
        pipeline((call) =>
          call.url.host === 'celestrak.org' ? new Response('down', { status: 503 }) : recorded(call),
        ),
      ),
    ),
  );

  it.effect('keeps the snapshot when the source has nothing new', () => {
    let calls = 0;
    const upstream: Upstream = (call) => {
      if (call.url.host !== 'celestrak.org') return recorded(call);
      calls++;
      return calls === 1
        ? recorded(call)
        : new Response('GP data has not updated since your last successful download of GROUP=active', {
            status: 403,
          });
    };
    return Effect.gen(function* () {
      const refresher = yield* Refresher;
      yield* refresher.refresh('satellites');
      const before = yield* state('satellites');
      yield* TestClock.adjust('2 hours');
      yield* refresher.refresh('satellites');
      const after = yield* state('satellites');
      assert.strictEqual(after?.version, before?.version);
      assert.strictEqual(after?.checkedAt, 2 * 60 * 60 * 1000);
      assert.strictEqual(after?.lastModified, 'Sun, 15 Nov 2026 22:00:00 GMT');
    }).pipe(Effect.provide(pipeline(upstream)));
  });
  it.effect('retries soon when the source has nothing new but no snapshot is stored yet', () =>
    Effect.gen(function* () {
      const refresher = yield* Refresher;
      yield* refresher.refresh('satellites');
      const after = yield* state('satellites');
      assert.strictEqual(after?.failures, 1);
      assert.include(after?.error, 'no snapshot is stored yet');
      yield* TestClock.adjust('1 minute');
      assert.include(yield* refresher.tick, 'satellites');
    }).pipe(
      Effect.provide(
        pipeline((call) =>
          call.url.host === 'celestrak.org'
            ? new Response(
                'GP data has not updated since your last successful\r\ndownload of GROUP=active at 2026-11-15 22:19:06 UTC.',
                { status: 403 },
              )
            : recorded(call),
        ),
      ),
    ),
  );
});

describe('isDue', () => {
  const base = { kind: 'feed' as const, feed: 'radar' as const, intervalSeconds: 300, failures: 0 };
  it('runs a feed that has never run', () => assert.isTrue(isDue(undefined, 300, 0)));
  it('waits for the interval, less a little slack for tick jitter', () => {
    assert.isFalse(isDue({ ...base, attemptedAt: 0 }, 300, 270_000));
    assert.isTrue(isDue({ ...base, attemptedAt: 0 }, 300, 285_000));
  });
  it('backs off exponentially after failures, never beyond the interval', () => {
    assert.isTrue(isDue({ ...base, attemptedAt: 0, failures: 1 }, 7200, 45_000));
    assert.isFalse(isDue({ ...base, attemptedAt: 0, failures: 3 }, 7200, 200_000));
    assert.isTrue(isDue({ ...base, attemptedAt: 0, failures: 3 }, 7200, 225_000));
    assert.isTrue(isDue({ ...base, attemptedAt: 0, failures: 20 }, 300, 285_000));
  });
});
