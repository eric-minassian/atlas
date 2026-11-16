import { AppInfo, Secrets } from '@ericminassian/platform';
import { Effect, Layer, Option, Redacted } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { AircraftNearbyLookup } from './aircraft.ts';
import { AirportIndex } from './airports.ts';
import { Api } from './api.ts';
import { BikeLookup } from './bikes.ts';
import { CameraRelay } from './cameras.ts';
import { feeds } from './catalog.ts';
import { feedIds } from './domain.ts';
import { FeedStore } from './feeds.ts';
import { HereLookup } from './here.ts';
import { Tiles } from './tiles.ts';
import { TransitLookup } from './transit.ts';
import { WebcamLookup } from './webcams.ts';
import { WildlifeLookup } from './wildlife.ts';

/** Sets `Cache-Control` on the response the current handler produces. */
const cacheFor = (value: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', value)),
  );

const SystemHandlers = HttpApiBuilder.group(
  Api,
  'system',
  Effect.fn(function* (handlers) {
    const app = yield* AppInfo;
    const store = yield* FeedStore;
    const secrets = yield* Secrets;
    const here = yield* HereLookup;
    return handlers
      .handle('health', () => Effect.succeed({ ok: true as const, app: app.name, stage: app.stage }))
      .handle('config', () =>
        Effect.gen(function* () {
          const key = (name: Parameters<typeof secrets.getOptional>[0]) =>
            Effect.map(secrets.getOptional(name), (value) =>
              Option.getOrNull(Option.map(value, Redacted.value)),
            );
          // Short: a key set or rotated with `plat secrets set` shows up within minutes.
          yield* cacheFor('public, max-age=300, stale-while-revalidate=600');
          return {
            keys: {
              cesiumIon: yield* key('CESIUM_ION_TOKEN'),
              arcgis: yield* key('ARCGIS_API_KEY'),
              mapillary: yield* key('MAPILLARY_TOKEN'),
            },
            sources: {
              aisstream: (yield* key('AISSTREAM_KEY')) !== null,
              windy: (yield* key('WINDY_WEBCAMS_KEY')) !== null,
            },
          };
        }),
      )
      .handle('catalog', () =>
        Effect.gen(function* () {
          yield* cacheFor('public, max-age=10, stale-while-revalidate=30');
          const states = yield* store.states;
          const statuses = feedIds.map((feed) =>
            store.status(feed, feeds[feed].intervalSeconds, states.get(feed)),
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
    const airports = yield* AirportIndex;
    const transit = yield* TransitLookup;
    const bikes = yield* BikeLookup;
    const webcams = yield* WebcamLookup;
    const wildlife = yield* WildlifeLookup;
    const cameras = yield* CameraRelay;
    return handlers
      .handle('aircraft', ({ query }) =>
        Effect.gen(function* () {
          const nearby = yield* aircraft.near(query.lat, query.lon);
          yield* cacheFor('public, max-age=8, stale-while-revalidate=20');
          return nearby;
        }),
      )
      .handle('airports', ({ params }) =>
        Effect.gen(function* () {
          const tile = yield* airports.tile(params.z, params.x, params.y);
          // The snapshot changes daily; a tile a few hours old is still right.
          yield* cacheFor('public, max-age=3600, stale-while-revalidate=86400');
          return tile;
        }),
      )
      .handle('transit', ({ params }) =>
        Effect.gen(function* () {
          const vehicles = yield* transit.tile(params.z, params.x, params.y);
          yield* cacheFor('public, max-age=15, stale-while-revalidate=30');
          return vehicles;
        }),
      )
      .handle('bikes', ({ params }) =>
        Effect.gen(function* () {
          const stations = yield* bikes.tile(params.z, params.x, params.y);
          yield* cacheFor('public, max-age=60, stale-while-revalidate=120');
          return stations;
        }),
      )
      .handle('webcams', ({ params }) =>
        Effect.gen(function* () {
          const area = yield* webcams.area(params.z, params.x, params.y);
          // Short: Windy's image URLs expire 10 minutes after Windy hands them out.
          yield* cacheFor('public, max-age=60, stale-while-revalidate=60');
          return area;
        }),
      )
      .handle('wildlife', ({ params }) =>
        Effect.gen(function* () {
          const area = yield* wildlife.area(params.z, params.x, params.y);
          yield* cacheFor('public, max-age=900, stale-while-revalidate=900');
          return area;
        }),
      )
      .handle('cameraImage', ({ params }) =>
        Effect.map(cameras.frame(params.id), (frame) =>
          HttpServerResponse.uint8Array(frame.bytes, {
            contentType: frame.contentType,
            headers: { 'cache-control': 'public, max-age=30' },
          }),
        ),
      );
  }),
);

/**
 * The API's routes with their handlers, still needing the platform's services
 * and an HTTP client (for point lookups): `src/server.ts` provides the real
 * ones, tests in-memory ones. The OpenAPI document is at `/api/openapi.json`.
 */
export const HttpLive = HttpApiBuilder.layer(Api, { openapiPath: '/api/openapi.json' }).pipe(
  Layer.provide([SystemHandlers, LiveHandlers, TilesHandlers]),
  // Lookups that read published snapshots (airports, transit and bike catalogs, camera lists).
  Layer.provide([AirportIndex.layer, TransitLookup.layer, BikeLookup.layer, CameraRelay.layer]),
  Layer.provide([
    FeedStore.layer,
    HereLookup.layer,
    Tiles.layer,
    AircraftNearbyLookup.layer,
    WebcamLookup.layer,
    WildlifeLookup.layer,
  ]),
);
