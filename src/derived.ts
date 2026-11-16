import { Effect, Option, Schema, Semaphore } from 'effect';
import { type FeedData, type FeedId, Snapshots } from './domain.ts';
import type { FeedStore, Snapshot } from './feeds.ts';

export interface Derived<A> {
  readonly version: string;
  readonly fetchedAt: number;
  readonly value: A;
}

/**
 * Something computed from a feed's current snapshot (an index, a subset),
 * recomputed only when the snapshot changes. Lookups that consult a feed on
 * every request use it so they decode the snapshot once per version, not per
 * request. None until the feed's first snapshot, or while it doesn't decode.
 */
export const derivedFrom = <F extends FeedId, A>(
  store: FeedStore['Service'],
  feed: F,
  derive: (data: FeedData[F], snapshot: Snapshot) => A,
): Effect.Effect<Option.Option<Derived<A>>> => {
  const decode = Schema.decodeEffect(
    Schema.fromJsonString(Snapshots[feed] as unknown as Schema.Codec<{ data: FeedData[F] }>),
  );
  let current: Derived<A> | undefined;
  // One decode at a time: concurrent requests for a new version wait for the first to finish it.
  const lock = Semaphore.makeUnsafe(1);
  const compute = (snapshot: Snapshot) =>
    Effect.suspend(() => {
      if (current?.version === snapshot.version) return Effect.succeedSome(current);
      return decode(snapshot.body).pipe(
        Effect.map(({ data }) => {
          current = {
            version: snapshot.version,
            fetchedAt: snapshot.fetchedAt,
            value: derive(data, snapshot),
          };
          return Option.some(current);
        }),
        Effect.catch((error) =>
          Effect.logWarning('snapshot does not decode').pipe(
            Effect.annotateLogs({ feed, version: snapshot.version, error: error.message }),
            Effect.as(Option.none<Derived<A>>()),
          ),
        ),
      );
    }).pipe(Semaphore.withPermit(lock));
  return Effect.flatMap(store.read(feed), (snapshot) => {
    if (Option.isNone(snapshot)) return Effect.succeedNone;
    if (current?.version === snapshot.value.version) return Effect.succeedSome(current);
    return compute(snapshot.value);
  });
};
