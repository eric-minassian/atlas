import { assert, layer } from '@effect/vitest';
import { Platform, Storage } from '@ericminassian/platform';
import { createPlatformFetch } from '@ericminassian/platform/server';
import { Effect, Layer, Option, Schema } from 'effect';
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
    it.effect('publishes snapshots, serves the current one and keeps only the previous', () =>
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

        const stored = yield* (yield* Storage).store('snapshots').list('earthquakes/');
        assert.deepStrictEqual(
          stored.objects.map((o) => o.key).toSorted(),
          versions
            .slice(1)
            .map((v) => `earthquakes/${v}.json`)
            .toSorted(),
        );

        const snapshot = Option.getOrThrow(yield* store.read('earthquakes'));
        assert.strictEqual(snapshot.version, versions[2]);

        const fetch = createPlatformFetch(app);
        const res = yield* Effect.promise(() => fetch(new Request('http://localhost/api/feeds/earthquakes')));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('etag'), `"${versions[2]}"`);
      }),
    );
  },
);
