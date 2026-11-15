import { Db, Storage } from '@ericminassian/platform';
import { Context, DateTime, Effect, Layer, Option, Random, Schema } from 'effect';
import { type FeedData, FeedId, type FeedStatus } from './domain.ts';
import type { Validators } from './ingest/index.ts';

/**
 * A feed's bookkeeping, one document per feed. `version` names the snapshot
 * object currently served; `previousVersion` is kept one more cycle for
 * readers that saw the old pointer, then deleted.
 */
export const FeedState = Schema.Struct({
  kind: Schema.Literal('feed'),
  /** A plain string, so a feed removed from the code leaves a document that still decodes (and is ignored). */
  feed: Schema.String,
  intervalSeconds: Schema.Int,
  /** Epoch ms the latest refresh started. */
  attemptedAt: Schema.Finite,
  /** Consecutive failed refreshes. */
  failures: Schema.Int,
  version: Schema.optionalKey(Schema.String),
  previousVersion: Schema.optionalKey(Schema.String),
  fetchedAt: Schema.optionalKey(Schema.Finite),
  checkedAt: Schema.optionalKey(Schema.Finite),
  count: Schema.optionalKey(Schema.Int),
  bytes: Schema.optionalKey(Schema.Int),
  error: Schema.optionalKey(Schema.String),
  etag: Schema.optionalKey(Schema.String),
  lastModified: Schema.optionalKey(Schema.String),
});
export type FeedState = typeof FeedState.Type;

export interface Snapshot {
  readonly version: string;
  readonly fetchedAt: number;
  /** The snapshot as stored: JSON matching the feed's schema in `Snapshots`. */
  readonly body: string;
}

const objectKey = (feed: FeedId, version: string) => `${feed}/${version}.json`;

const toStatus = (feed: FeedId, intervalSeconds: number, state: FeedState | undefined): FeedStatus => ({
  id: feed,
  version: state?.version ?? null,
  fetchedAt: state?.fetchedAt ?? null,
  checkedAt: state?.checkedAt ?? null,
  count: state?.count ?? null,
  error: state?.error ?? null,
  intervalSeconds: state?.intervalSeconds ?? intervalSeconds,
});

/** Feed state in the db and snapshots in the `snapshots` store. */
export class FeedStore extends Context.Service<
  FeedStore,
  {
    readonly states: Effect.Effect<ReadonlyMap<FeedId, FeedState>>;
    status(feed: FeedId, intervalSeconds: number, state: FeedState | undefined): FeedStatus;
    /** Records that a refresh started, and returns the validators for a conditional read. */
    begin(feed: FeedId, intervalSeconds: number): Effect.Effect<Validators>;
    /** Stores a new snapshot and points the feed at it. */
    publish<F extends FeedId>(
      feed: F,
      data: FeedData[F],
      count: number,
      validators: Validators,
    ): Effect.Effect<{ readonly version: string; readonly bytes: number }>;
    /** The source had nothing new. */
    unchanged(feed: FeedId): Effect.Effect<void>;
    failed(feed: FeedId, error: string): Effect.Effect<void>;
    /** The current snapshot, cached in memory by version. */
    read(feed: FeedId): Effect.Effect<Option.Option<Snapshot>>;
    hasSnapshot(feed: FeedId): Effect.Effect<boolean>;
  }
>()('atlas/FeedStore') {
  static readonly layer = Layer.effect(
    FeedStore,
    Effect.gen(function* () {
      const db = yield* Db;
      const store = (yield* Storage).store('snapshots');
      const collection = db.collection('feeds', { schema: FeedState, partition: 'kind', sort: 'feed' });
      const cache = new Map<FeedId, Snapshot>();

      const now = Effect.map(DateTime.now, DateTime.toEpochMillis);
      const get = (feed: FeedId) => collection.get({ kind: 'feed', feed });
      /** Applies `change` to the feed's document; the worker is its only writer, one refresh per feed at a time. */
      const modify = Effect.fnUntraced(function* (feed: FeedId, change: (state: FeedState) => FeedState) {
        const current = yield* get(feed);
        if (Option.isNone(current)) return yield* Effect.die(new Error(`feed ${feed} has no state`));
        return yield* collection.put(change(current.value));
      });

      const isFeedId = Schema.is(FeedId);
      const states = Effect.map(
        collection.queryAll({ kind: 'feed' }),
        (docs) => new Map(docs.flatMap((d) => (isFeedId(d.feed) ? [[d.feed, d] as const] : []))),
      );

      const begin = Effect.fn('FeedStore.begin')(function* (feed: FeedId, intervalSeconds: number) {
        const attemptedAt = yield* now;
        const current = yield* get(feed);
        const base: FeedState = Option.getOrElse(current, () => ({
          kind: 'feed' as const,
          feed,
          intervalSeconds,
          attemptedAt,
          failures: 0,
        }));
        yield* collection.put({ ...base, intervalSeconds, attemptedAt });
        return { etag: base.etag, lastModified: base.lastModified };
      });

      const publish = Effect.fn('FeedStore.publish')(function* <F extends FeedId>(
        feed: F,
        data: FeedData[F],
        count: number,
        validators: Validators,
      ) {
        const fetchedAt = yield* now;
        const suffix = yield* Random.nextIntBetween(0, 36 ** 4);
        const version = `${fetchedAt.toString(36)}${suffix.toString(36).padStart(4, '0')}`;
        const body = JSON.stringify({ feed, version, fetchedAt, count, data });
        yield* store.put(objectKey(feed, version), body, { contentType: 'application/json' });
        const bytes = new TextEncoder().encode(body).byteLength;
        let stale: string | undefined;
        yield* modify(feed, (state) => {
          stale = state.previousVersion;
          const { error: _, ...rest } = state;
          return {
            ...rest,
            failures: 0,
            version,
            fetchedAt,
            checkedAt: fetchedAt,
            count,
            bytes,
            ...(state.version ? { previousVersion: state.version } : {}),
            ...(validators.etag ? { etag: validators.etag } : {}),
            ...(validators.lastModified ? { lastModified: validators.lastModified } : {}),
          };
        });
        if (stale) yield* store.delete(objectKey(feed, stale));
        return { version, bytes };
      });

      const unchanged = Effect.fn('FeedStore.unchanged')(function* (feed: FeedId) {
        const checkedAt = yield* now;
        yield* modify(feed, ({ error: _, ...state }) => ({ ...state, failures: 0, checkedAt }));
      });

      const failed = Effect.fn('FeedStore.failed')(function* (feed: FeedId, error: string) {
        yield* modify(feed, (state) => ({ ...state, failures: state.failures + 1, error }));
      });

      const read = Effect.fn('FeedStore.read')(function* (feed: FeedId) {
        const state = yield* get(feed);
        const version = Option.flatMapNullishOr(state, (s) => s.version);
        if (Option.isNone(version)) return Option.none<Snapshot>();
        const cached = cache.get(feed);
        if (cached?.version === version.value) return Option.some(cached);
        const body = yield* store.getText(objectKey(feed, version.value));
        if (Option.isNone(body)) return Option.fromUndefinedOr(cached);
        const snapshot: Snapshot = {
          version: version.value,
          fetchedAt: Option.getOrThrow(state).fetchedAt ?? 0,
          body: body.value,
        };
        cache.set(feed, snapshot);
        return Option.some(snapshot);
      });

      const hasSnapshot = (feed: FeedId) =>
        Effect.map(get(feed), (state) => Option.isSome(state) && state.value.version !== undefined);

      return FeedStore.of({
        hasSnapshot,
        states,
        status: toStatus,
        begin,
        publish,
        unchanged,
        failed,
        read,
      });
    }),
  );
}
