import { Metrics, Queues, type Secrets } from '@ericminassian/platform';
import { Context, DateTime, Effect, Layer, Result } from 'effect';
import type { HttpClient } from 'effect/http';
import { type FeedId, feedIds } from './domain.ts';
import { type FeedState, FeedStore } from './feeds.ts';
import { type Source, Sources, type Validators } from './ingest/index.ts';

/** Ticks arrive about a minute apart; a feed due within this margin runs now rather than a minute late. */
const SLACK_MS = 20_000;
/** First retry after a failure; doubles per consecutive failure, up to the feed's interval. */
const RETRY_MS = 60_000;

/** When `feed` should next refresh, given its state. */
export const isDue = (state: FeedState | undefined, intervalSeconds: number, now: number): boolean => {
  if (!state) return true;
  const interval = intervalSeconds * 1000;
  const wait =
    state.failures > 0 ? Math.min(interval, RETRY_MS * 2 ** Math.min(state.failures - 1, 10)) : interval;
  return now - state.attemptedAt >= wait - SLACK_MS;
};

/** Decides which feeds are due (`tick`) and refreshes one feed (`refresh`). */
export class Refresher extends Context.Service<
  Refresher,
  {
    /** Queues a refresh for every feed that is due; returns them. */
    readonly tick: Effect.Effect<ReadonlyArray<FeedId>>;
    /** Reads the feed's source and publishes a snapshot if it changed. Failures are recorded, not raised. */
    refresh(feed: FeedId): Effect.Effect<void>;
  }
>()('atlas/Refresher') {
  static readonly layer = Layer.effect(
    Refresher,
    Effect.gen(function* () {
      const sources = yield* Sources;
      const store = yield* FeedStore;
      const queues = yield* Queues;
      const metrics = yield* Metrics;
      // Sources read secrets (credentials) and call out over HTTP.
      const sourceContext = yield* Effect.context<HttpClient.HttpClient | Secrets>();
      const intervalOf = (feed: FeedId) => sources[feed].interval.pipe(Effect.provideContext(sourceContext));
      const now = Effect.map(DateTime.now, DateTime.toEpochMillis);

      const tick = Effect.gen(function* () {
        const at = yield* now;
        const states = yield* store.states;
        const due: FeedId[] = [];
        for (const feed of feedIds) {
          const interval = yield* intervalOf(feed);
          if (isDue(states.get(feed), interval, at)) due.push(feed);
        }
        if (due.length > 0)
          yield* queues.sendBatch(
            'refresh',
            due.map((feed) => ({ feed })),
          );
        return due;
      }).pipe(Effect.withSpan('Refresher.tick'));

      /** Reads `feed`'s source, typed per feed so it gets its own previous payload. */
      const read = <F extends FeedId>(feed: F, validators: Validators): ReturnType<Source<F>['read']> =>
        (sources[feed] as Source<F>).read(validators, store.payload(feed));

      const refresh = Effect.fn('Refresher.refresh')(function* (feed: FeedId) {
        const interval = yield* intervalOf(feed);
        const validators = yield* store.begin(feed, interval);
        const started = yield* now;
        const result = yield* read(feed, validators).pipe(
          Effect.provideContext(sourceContext),
          Effect.result,
        );
        const ms = (yield* now) - started;
        const log = Effect.annotateLogs({ feed, ms });

        if (Result.isFailure(result)) {
          yield* store.failed(feed, result.failure.message);
          yield* metrics.count(`refresh.${feed}.error`);
          yield* Effect.logWarning('refresh failed').pipe(
            log,
            Effect.annotateLogs({ error: result.failure.message }),
          );
          return;
        }
        const outcome = result.success;
        if (outcome._tag === 'NotModified' && !(yield* store.hasSnapshot(feed))) {
          // Nothing new, but nothing stored either: CelesTrak, for one, says so to any client whose IP
          // downloaded recently, and Lambda shares IPs. Retry (with backoff) rather than wait a full interval.
          yield* store.failed(feed, 'the source reported no change, and no snapshot is stored yet');
          yield* Effect.logWarning('no snapshot yet; will retry').pipe(log);
          return;
        }
        if (outcome._tag === 'NotModified') {
          yield* store.unchanged(feed);
          yield* Effect.logInfo('source unchanged').pipe(log);
          return;
        }
        const { version, bytes } = yield* store.publish(
          feed,
          outcome.data,
          outcome.count,
          outcome.validators,
        );
        yield* metrics.count(`refresh.${feed}.ok`);
        yield* metrics.value(`feed.${feed}.count`, outcome.count);
        yield* metrics.value(`feed.${feed}.bytes`, bytes, 'bytes');
        yield* Effect.logInfo('snapshot published').pipe(
          log,
          Effect.annotateLogs({ version, count: outcome.count, bytes }),
        );
      });

      return Refresher.of({ tick, refresh });
    }),
  );
}
