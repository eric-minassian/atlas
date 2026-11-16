import { Db, Storage } from '@ericminassian/platform';
import { Context, DateTime, Effect, Layer, Option, Random, Schema } from 'effect';
import { feeds, snapshotKey } from './catalog.ts';
import { type FeedData, FeedId, type FeedStatus, Snapshots } from './domain.ts';
import type { Validators } from './ingest/index.ts';
import { views } from './views.ts';

/**
 * A feed's bookkeeping, one document per feed. `version` names the snapshot
 * file currently served; `previousVersion` is kept one more cycle for
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
  /**
   * The snapshot files are in the public `feeds` store. Snapshots published
   * before they moved there are in the private `snapshots` store, which
   * browsers can't read: such a feed reads as never refreshed (no state at
   * all), and its files there are deleted when it next refreshes.
   */
  public: Schema.optionalKey(Schema.Literal(true)),
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

/** Versions are never reused, so a snapshot's files never change. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

const isLegacy = (state: FeedState) => state.version !== undefined && state.public !== true;

/** A feed's first state, as its first refresh starts. */
const fresh = (feed: FeedId, intervalSeconds: number, attemptedAt: number): FeedState => ({
  kind: 'feed',
  feed,
  intervalSeconds,
  attemptedAt,
  failures: 0,
});

const toStatus = (feed: FeedId, intervalSeconds: number, state: FeedState | undefined): FeedStatus => ({
  id: feed,
  version: state?.version ?? null,
  fetchedAt: state?.fetchedAt ?? null,
  checkedAt: state?.checkedAt ?? null,
  count: state?.count ?? null,
  error: state?.error ?? null,
  intervalSeconds: state?.intervalSeconds ?? intervalSeconds,
});

/** Feed state in the db and snapshots in the public `feeds` store. */
export class FeedStore extends Context.Service<
  FeedStore,
  {
    readonly states: Effect.Effect<ReadonlyMap<FeedId, FeedState>>;
    status(feed: FeedId, intervalSeconds: number, state: FeedState | undefined): FeedStatus;
    /** Records that a refresh started, and returns the validators for a conditional read. */
    begin(feed: FeedId, intervalSeconds: number): Effect.Effect<Validators>;
    /** Stores a new snapshot (and its browser view, if the feed has one) and points the feed at it. */
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
    /** The current snapshot's payload, decoded; none if there is none or it no longer decodes. */
    payload<F extends FeedId>(feed: F): Effect.Effect<Option.Option<FeedData[F]>>;
    hasSnapshot(feed: FeedId): Effect.Effect<boolean>;
  }
>()('atlas/FeedStore') {
  static readonly layer = Layer.effect(
    FeedStore,
    Effect.gen(function* () {
      const db = yield* Db;
      const storage = yield* Storage;
      const files = storage.store('feeds');
      const legacyFiles = storage.store('snapshots');
      const collection = db.collection('feeds', { schema: FeedState, partition: 'kind', sort: 'feed' });
      const cache = new Map<FeedId, Snapshot>();

      const now = Effect.map(DateTime.now, DateTime.toEpochMillis);
      const get = (feed: FeedId) =>
        Effect.map(
          collection.get({ kind: 'feed', feed }),
          Option.filter((state) => !isLegacy(state)),
        );

      /**
       * The state a write starts from. A legacy state's files are deleted first: nothing
       * reads them, and the write that follows replaces the state that named them.
       */
      const load = Effect.fnUntraced(function* (feed: FeedId) {
        const stored = yield* collection.get({ kind: 'feed', feed });
        if (Option.isNone(stored) || !isLegacy(stored.value)) return stored;
        const { version, previousVersion } = stored.value;
        for (const old of [version, previousVersion])
          if (old) yield* legacyFiles.delete(snapshotKey(feed, old));
        return Option.none<FeedState>();
      });

      /** Applies `change` to the feed's document; each feed has one writer, one refresh at a time. */
      const modify = Effect.fnUntraced(function* (feed: FeedId, change: (state: FeedState) => FeedState) {
        const state = yield* load(feed);
        if (Option.isNone(state)) return yield* Effect.die(new Error(`feed ${feed} has no state`));
        return yield* collection.put(change(state.value));
      });

      const isFeedId = Schema.is(FeedId);
      const states = Effect.map(
        collection.queryAll({ kind: 'feed' }),
        (docs) =>
          new Map(docs.flatMap((d) => (isFeedId(d.feed) && !isLegacy(d) ? [[d.feed, d] as const] : []))),
      );

      const begin = Effect.fn('FeedStore.begin')(function* (feed: FeedId, intervalSeconds: number) {
        const attemptedAt = yield* now;
        const base = Option.getOrElse(yield* load(feed), () => fresh(feed, intervalSeconds, attemptedAt));
        yield* collection.put({ ...base, intervalSeconds, attemptedAt });
        return { etag: base.etag, lastModified: base.lastModified };
      });

      const deleteFiles = (feed: FeedId, version: string) =>
        Effect.gen(function* () {
          yield* files.delete(snapshotKey(feed, version));
          const view = feeds[feed].browserView;
          if (view) yield* files.delete(snapshotKey(feed, version, view));
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
        const write = (key: string, body: string) =>
          files.put(key, body, { contentType: 'application/json', cacheControl: IMMUTABLE });

        // Files first, then the pointer: whoever sees the new version can fetch it.
        const view = feeds[feed].browserView;
        const cut = views[feed];
        if (view && cut) {
          const viewed = cut(data);
          yield* write(
            snapshotKey(feed, version, view),
            JSON.stringify({ feed, version, fetchedAt, count: viewed.count, data: viewed.data }),
          );
        }
        const body = JSON.stringify({ feed, version, fetchedAt, count, data });
        yield* write(snapshotKey(feed, version), body);
        const bytes = new TextEncoder().encode(body).byteLength;

        // A streamed feed publishes without a `begin`, so its first publish creates the document.
        const state = Option.getOrElse(yield* load(feed), () =>
          fresh(feed, feeds[feed].intervalSeconds, fetchedAt),
        );
        const { error: _, ...rest } = state;
        yield* collection.put({
          ...rest,
          // A streamed feed has no `begin` to bring its interval up to date.
          intervalSeconds: feeds[feed].intervalSeconds,
          public: true,
          failures: 0,
          version,
          fetchedAt,
          checkedAt: fetchedAt,
          count,
          bytes,
          ...(state.version ? { previousVersion: state.version } : {}),
          ...(validators.etag ? { etag: validators.etag } : {}),
          ...(validators.lastModified ? { lastModified: validators.lastModified } : {}),
        });
        if (state.previousVersion) yield* deleteFiles(feed, state.previousVersion);
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
        const body = yield* files.getText(snapshotKey(feed, version.value));
        if (Option.isNone(body)) return Option.fromUndefinedOr(cached);
        const snapshot: Snapshot = {
          version: version.value,
          fetchedAt: Option.getOrThrow(state).fetchedAt ?? 0,
          body: body.value,
        };
        cache.set(feed, snapshot);
        return Option.some(snapshot);
      });

      const payload = Effect.fn('FeedStore.payload')(function* <F extends FeedId>(feed: F) {
        const snapshot = yield* read(feed);
        if (Option.isNone(snapshot)) return Option.none<FeedData[F]>();
        // A schema change can leave a stored snapshot that no longer decodes: start over then.
        const schema = Schema.fromJsonString(
          Snapshots[feed] as unknown as Schema.Codec<{ data: FeedData[F] }>,
        );
        const decoded = yield* Schema.decodeEffect(schema)(snapshot.value.body).pipe(Effect.option);
        return Option.map(decoded, (s) => s.data);
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
        payload,
      });
    }),
  );
}
