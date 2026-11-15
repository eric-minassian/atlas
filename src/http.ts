import { AppInfo, Secrets } from '@ericminassian/platform';
import { Effect, Layer, Option } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import type { HttpServerRequest } from 'effect/http/HttpServerRequest';
import { AircraftNearbyLookup } from './aircraft.ts';
import { Api } from './api.ts';
import { feeds } from './catalog.ts';
import { type FeedId, FeedNotReady, feedIds } from './domain.ts';
import { FeedStore } from './feeds.ts';
import { HereLookup } from './here.ts';
import { Sources } from './ingest/index.ts';
import { Tiles } from './tiles.ts';

/** Sets `Cache-Control` on the response the current handler produces. */
const cacheFor = (value: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', value)),
  );

/**
 * Edge and browser caching for a feed: a sixth of its refresh interval (10 s
 * to 5 min), then served stale while revalidating. Revalidation is cheap: the
 * ETag is the snapshot version, so an unchanged feed answers 304.
 */
export const feedCacheControl = (feed: FeedId): string => {
  const maxAge = Math.min(300, Math.max(10, Math.round(feeds[feed].intervalSeconds / 6)));
  return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 3}`;
};

const SystemHandlers = HttpApiBuilder.group(
  Api,
  'system',
  Effect.fn(function* (handlers) {
    const app = yield* AppInfo;
    const store = yield* FeedStore;
    const sources = yield* Sources;
    const secrets = yield* Secrets;
    const here = yield* HereLookup;
    return handlers
      .handle('health', () => Effect.succeed({ ok: true as const, app: app.name, stage: app.stage }))
      .handle('catalog', () =>
        Effect.gen(function* () {
          yield* cacheFor('public, max-age=10, stale-while-revalidate=30');
          const states = yield* store.states;
          const statuses = yield* Effect.forEach(feedIds, (feed) =>
            Effect.map(sources[feed].interval.pipe(Effect.provideService(Secrets, secrets)), (interval) =>
              store.status(feed, interval, states.get(feed)),
            ),
          );
          return { feeds: statuses };
        }),
      )
      .handle('here', ({ query }) =>
        Effect.gen(function* () {
          const result = yield* here.at(query.lat, query.lon);
          yield* cacheFor('public, max-age=600');
          return result;
        }),
      );
  }),
);

/** Serves the stored snapshot as-is: it was encoded with the feed's schema when it was published. */
const serveFeed = (store: FeedStore['Service'], feed: FeedId) => (request: { request: HttpServerRequest }) =>
  Effect.gen(function* () {
    const snapshot = yield* store.read(feed);
    if (Option.isNone(snapshot)) return yield* new FeedNotReady({ feed });
    const headers = { etag: `"${snapshot.value.version}"`, 'cache-control': feedCacheControl(feed) };
    if (request.request.headers['if-none-match'] === headers.etag)
      return HttpServerResponse.empty({ status: 304, headers });
    return HttpServerResponse.text(snapshot.value.body, { contentType: 'application/json', headers });
  });

const TilesHandlers = HttpApiBuilder.group(
  Api,
  'tiles',
  Effect.fn(function* (handlers) {
    const tiles = yield* Tiles;
    return handlers.handle('clouds', ({ params }) =>
      Effect.gen(function* () {
        const png = yield* tiles.clouds(params.z, params.x, params.y);
        // Clients put the frame's half hour in the query string, so each URL can be cached for long.
        yield* cacheFor('public, max-age=3600, stale-while-revalidate=3600');
        return png;
      }),
    );
  }),
);

const LiveHandlers = HttpApiBuilder.group(
  Api,
  'live',
  Effect.fn(function* (handlers) {
    const aircraft = yield* AircraftNearbyLookup;
    return handlers.handle('aircraft', ({ query }) =>
      Effect.gen(function* () {
        const nearby = yield* aircraft.near(query.lat, query.lon);
        yield* cacheFor('public, max-age=8, stale-while-revalidate=20');
        return nearby;
      }),
    );
  }),
);

const FeedsHandlers = HttpApiBuilder.group(
  Api,
  'feeds',
  Effect.fn(function* (handlers) {
    const store = yield* FeedStore;
    return handlers
      .handle('satellites', serveFeed(store, 'satellites'))
      .handle('earthquakes', serveFeed(store, 'earthquakes'))
      .handle('fires', serveFeed(store, 'fires'))
      .handle('events', serveFeed(store, 'events'))
      .handle('radar', serveFeed(store, 'radar'));
  }),
);

/**
 * The API's routes with their handlers, still needing the platform's services
 * and an HTTP client (for point lookups): `src/server.ts` provides the real
 * ones, tests in-memory ones. The OpenAPI document is at `/api/openapi.json`.
 */
export const HttpLive = HttpApiBuilder.layer(Api, { openapiPath: '/api/openapi.json' }).pipe(
  Layer.provide([SystemHandlers, FeedsHandlers, LiveHandlers, TilesHandlers]),
  Layer.provide([FeedStore.layer, Sources.layer, HereLookup.layer, Tiles.layer, AircraftNearbyLookup.layer]),
);
