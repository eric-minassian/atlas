import { defineService, Metrics, Platform, Secrets, traced } from '@ericminassian/platform';
import { Clock, Context, Duration, Effect, Layer, Option, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Socket } from 'effect/socket';
import { feeds } from './catalog.ts';
import type { ShipData } from './domain.ts';
import { FeedStore } from './feeds.ts';
import {
  mergeShips,
  mergeStatic,
  type Position,
  readDigitraffic,
  STATIONARY_TTL_S,
  type Static,
  streamAisstream,
} from './ingest/ships.ts';

/** How often the vessels heard are published. */
const PUBLISH_EVERY = Duration.seconds(feeds.ships.intervalSeconds);
const POLL_EVERY = Duration.minutes(1);
/** Each Digitraffic poll reaches back this far past the previous one's start, so nothing falls between. */
const POLL_OVERLAP_MS = 30_000;

/**
 * Every vessel heard, in memory, as of the last publish plus what arrived since.
 * It belongs to the container rather than to one connection, so a reconnect to
 * aisstream.io loses nothing, and it starts from the published snapshot, so a
 * deploy or restart doesn't empty the map.
 */
export class ShipTracker extends Context.Service<
  ShipTracker,
  {
    /** Takes position reports and static data as they arrive, from either source. */
    hear(positions: Iterable<Position>, statics: Iterable<Static>): Effect.Effect<void>;
    /** Publishes the vessels heard recently, without those unheard for too long, as the `ships` snapshot. */
    readonly publish: Effect.Effect<ShipData>;
  }
>()('atlas/ShipTracker') {
  static readonly layer = Layer.effect(
    ShipTracker,
    Effect.gen(function* () {
      const store = yield* FeedStore;
      const metrics = yield* Metrics;
      let vessels = Option.getOrUndefined(yield* store.payload('ships'));
      /** The latest position per vessel since the last publish. */
      let positions = new Map<number, Position>();
      /**
       * Static data by vessel, kept between publishes: it comes every few minutes, and
       * can arrive before the vessel's first position. Epoch seconds it was last heard.
       */
      const statics = new Map<number, { readonly value: Static; readonly at: number }>();
      /** Position reports taken since the last publish. */
      let reports = 0;

      const hear = (heard: Iterable<Position>, said: Iterable<Static>) =>
        Effect.map(Clock.currentTimeMillis, (ms) => {
          const at = ms / 1000;
          for (const p of heard) {
            const known = positions.get(p.mmsi);
            if (!known || known.time <= p.time) positions.set(p.mmsi, p);
            reports++;
          }
          for (const s of said)
            statics.set(s.mmsi, { value: mergeStatic(statics.get(s.mmsi)?.value, s), at });
        });

      const publish = Effect.gen(function* () {
        const now = (yield* Clock.currentTimeMillis) / 1000;
        for (const [mmsi, s] of statics) if (now - s.at > STATIONARY_TTL_S) statics.delete(mmsi);
        const heard = positions;
        const taken = reports;
        positions = new Map();
        reports = 0;
        // The merge is the new state even if writing it out fails: the next publish builds on it.
        const data = mergeShips(
          vessels,
          heard.values(),
          Array.from(statics.values(), (s) => s.value),
          now,
        );
        vessels = data;
        const { version, bytes } = yield* store.publish('ships', data, data.mmsi.length, {});
        yield* metrics.value('feed.ships.count', data.mmsi.length);
        yield* metrics.value('feed.ships.bytes', bytes, 'bytes');
        yield* metrics.value('ships.reports', taken);
        yield* Effect.logInfo('snapshot published').pipe(
          Effect.annotateLogs({ feed: 'ships', version, count: data.mmsi.length, reports: taken, bytes }),
        );
        return data;
      }).pipe(Effect.withSpan('ShipTracker.publish'));

      return ShipTracker.of({ hear, publish });
    }),
  );
}

/**
 * Publishes every minute while the container runs, and once more when it
 * stops, so a deploy keeps what was heard since the last publish. A failed
 * publish is reported (`traced`) and the next one carries it.
 */
const Publishing = Layer.effectDiscard(
  Effect.gen(function* () {
    const tracker = yield* ShipTracker;
    const publish = tracker.publish.pipe(traced('publish'), Effect.ignoreCause);
    // Finalizers run last-added first: the loop stops before the final publish.
    yield* Effect.addFinalizer(() => publish);
    yield* Effect.forkScoped(publish.pipe(Effect.delay(PUBLISH_EVERY), Effect.forever));
  }),
);

/**
 * Polls Digitraffic (the Baltic) every minute, each poll reaching back past
 * the previous one. A failed poll is reported, and the next reaches back to the
 * last that succeeded.
 */
const Polling = Layer.effectDiscard(
  Effect.gen(function* () {
    const tracker = yield* ShipTracker;
    let since: number | undefined;
    const poll = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const { positions, statics } = yield* readDigitraffic(started, since);
      yield* tracker.hear(positions, statics);
      since = started - POLL_OVERLAP_MS;
    }).pipe(traced('digitraffic'), Effect.ignoreCause);
    yield* Effect.forkScoped(poll.pipe(Effect.andThen(Effect.sleep(POLL_EVERY)), Effect.forever));
  }),
);

/** The tracker with its publishing and polling, on whatever platform and HTTP client it's given. */
export const ShipsLayer = Layer.mergeAll(Publishing, Polling).pipe(
  Layer.provideMerge(ShipTracker.layer),
  Layer.provide(FeedStore.layer),
);

/**
 * One run: one aisstream.io connection, heard into the tracker. Without a key
 * there's nothing to connect to, and the run waits for the service to stop.
 */
export const listen = Effect.gen(function* () {
  const key = yield* (yield* Secrets).getOptional('AISSTREAM_KEY');
  if (Option.isNone(key)) {
    yield* Effect.logWarning('AISSTREAM_KEY is not set: ships come from Digitraffic (the Baltic) only');
    return yield* Effect.never;
  }
  const tracker = yield* ShipTracker;
  const { messages, ended } = yield* streamAisstream(Redacted.value(key.value), (batch) =>
    tracker.hear(batch.positions.values(), batch.statics.values()),
  );
  return yield* Effect.logWarning('aisstream.io connection ended').pipe(
    Effect.annotateLogs({ messages, ended }),
  );
});

/**
 * The `ships` service: the tracker publishes and polls Digitraffic for the
 * container's life, and each run holds one aisstream.io connection. When a
 * connection ends, the platform starts the run again a second later; when it
 * fails (a refused key), the failure is reported and the run retried with a
 * growing backoff.
 */
export default defineService({
  layer: ShipsLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Platform.layer, FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal),
    ),
  ),
  run: listen,
});
