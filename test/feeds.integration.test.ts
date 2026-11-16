import { assert, layer } from '@effect/vitest';
import { Platform, Storage } from '@ericminassian/platform';
import { createPlatformFetch } from '@ericminassian/platform/server';
import { Effect, Layer, Option, Schema } from 'effect';
import { snapshotKey } from '../src/catalog.ts';
import { FeedStore } from '../src/feeds.ts';
import { FeatureCollection, parseQuakes } from '../src/ingest/earthquakes.ts';
import app from '../src/server.ts';
import { fixture } from './support.ts';

// Runs under `plat test`: FeedStore and the server against DynamoDB and S3 in
// the AWS Emulator, with the bindings a deployed stage gets.
const quakes = parseQuakes(
  Schema.decodeSync(Schema.fromJsonString(FeatureCollection))(fixture('usgs.geojson')),
);

layer(Layer.provideMerge(FeedStore.layer, Platform.layer), { excludeTestServices: true })(
  'integration',
  (it) => {
    it.effect(
      'publishes snapshots to the public store, offers the current one and keeps only the previous',
      () =>
        Effect.gen(function* () {
          const store = yield* FeedStore;
          const versions: string[] = [];
          for (let i = 0; i < 3; i++) {
            yield* store.begin('earthquakes', 60);
            versions.push((yield* store.publish('earthquakes', quakes, quakes.events.length, {})).version);
          }
          const state = (yield* store.states).get('earthquakes');
          assert.strictEqual(state?.version, versions[2]);
          assert.strictEqual(state?.previousVersion, versions[1]);

          const files = (yield* Storage).store('feeds');
          const stored = yield* files.list('earthquakes/');
          assert.deepStrictEqual(
            stored.objects.map((o) => o.key).toSorted(),
            versions
              .slice(1)
              .map((v) => snapshotKey('earthquakes', v))
              .toSorted(),
          );
          const url = new URL(yield* files.publicUrl(snapshotKey('earthquakes', versions[2] as string)));
          assert.strictEqual(url.pathname, `/__platform/storage/feeds/earthquakes/${versions[2]}.json`);

          const snapshot = Option.getOrThrow(yield* store.read('earthquakes'));
          assert.strictEqual(snapshot.version, versions[2]);

          const fetch = createPlatformFetch(app);
          const res = yield* Effect.promise(() => fetch(new Request('http://localhost/api/catalog')));
          const catalog = (yield* Effect.promise(() => res.json())) as {
            feeds: Array<{ id: string; version: string | null }>;
          };
          assert.strictEqual(catalog.feeds.find((f) => f.id === 'earthquakes')?.version, versions[2]);
        }),
    );
  },
);
