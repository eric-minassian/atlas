import { defineWorker, Platform } from '@ericminassian/platform';
import { Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { RefreshJob } from './domain.ts';
import { FeedStore } from './feeds.ts';
import { Sources } from './ingest/index.ts';
import { Refresher } from './refresh.ts';

/** The refresh pipeline on the real platform; tests build it on `Platform.layerMemory()`. */
export const RefresherLive = Refresher.layer.pipe(
  Layer.provide([FeedStore.layer, Sources.layer]),
  Layer.provideMerge(Layer.mergeAll(Platform.layer, FetchHttpClient.layer)),
);

// `tick` (every minute) queues a refresh per due feed; each `refresh` message
// reads one source. A refresh records its own failures, so a message only
// fails (and retries) on a defect.
export default defineWorker({
  layer: RefresherLive,

  crons: {
    tick: () => Effect.flatMap(Refresher, (refresher) => refresher.tick),
  },

  queues: {
    refresh: (message) =>
      Effect.gen(function* () {
        const { feed } = yield* Schema.decodeEffect(RefreshJob)(message.body);
        yield* (yield* Refresher).refresh(feed);
      }),
  },
});
