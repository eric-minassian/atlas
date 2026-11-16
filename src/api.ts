/**
 * The HTTP API, defined once as schemas. The server implements it
 * (`src/http.ts`) and the web app calls it through a client generated from it
 * (`web/src/client.ts`). The web app imports this file: keep it free of
 * server-only imports.
 */
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import {
  AircraftNearby,
  Catalog,
  ClientConfig,
  EarthquakeSnapshot,
  EventSnapshot,
  FeedNotReady,
  FireSnapshot,
  Here,
  Latitude,
  Longitude,
  RadarSnapshot,
  SatelliteSnapshot,
  TileOutOfRange,
  UpstreamUnavailable,
} from './domain.ts';

const LatitudeParam = Schema.FiniteFromString.pipe(Schema.decodeTo(Latitude));
const LongitudeParam = Schema.FiniteFromString.pipe(Schema.decodeTo(Longitude));

export class SystemApi extends HttpApiGroup.make('system', { topLevel: true }).add(
  HttpApiEndpoint.get('health', '/health', {
    success: Schema.Struct({ ok: Schema.Literal(true), app: Schema.String, stage: Schema.String }),
  }),
  /** Keys for services the browser calls directly, and which keyed sources are configured. */
  HttpApiEndpoint.get('config', '/config', { success: ClientConfig }),
  /** Every feed's freshness: current version, last update, size and last error. */
  HttpApiEndpoint.get('catalog', '/catalog', { success: Catalog }),
  /** Conditions at a point (weather, elevation, time zone). */
  HttpApiEndpoint.get('here', '/here', {
    query: {
      lat: LatitudeParam,
      lon: LongitudeParam,
    },
    success: Here,
    error: UpstreamUnavailable,
  }),
) {}

/**
 * The current snapshot of each feed. Responses carry an ETag (the snapshot
 * version) and are cached at the edge for a fraction of the feed's interval.
 */
export class FeedsApi extends HttpApiGroup.make('feeds')
  .add(
    HttpApiEndpoint.get('satellites', '/satellites', { success: SatelliteSnapshot, error: FeedNotReady }),
    HttpApiEndpoint.get('earthquakes', '/earthquakes', { success: EarthquakeSnapshot, error: FeedNotReady }),
    HttpApiEndpoint.get('fires', '/fires', { success: FireSnapshot, error: FeedNotReady }),
    HttpApiEndpoint.get('events', '/events', { success: EventSnapshot, error: FeedNotReady }),
    HttpApiEndpoint.get('radar', '/radar', { success: RadarSnapshot, error: FeedNotReady }),
  )
  .prefix('/feeds') {}

/** Data looked up for the place someone is looking at, rather than refreshed on a schedule. */
export class LiveApi extends HttpApiGroup.make('live')
  .add(
    /**
     * Aircraft within 250 nm of a point, a few seconds old. Points snap to whole
     * degrees, so send whole degrees to share the edge cache with other viewers.
     */
    HttpApiEndpoint.get('aircraft', '/aircraft', {
      query: { lat: LatitudeParam, lon: LongitudeParam },
      success: AircraftNearby,
      error: UpstreamUnavailable,
    }),
  )
  .prefix('/live') {}

const TileCoordinate = Schema.FiniteFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 << 12 }))),
);

/**
 * Map tiles relayed from upstream services, so browsers load them from this
 * origin (no CORS) and every viewer shares one edge-cached copy.
 */
export class TilesApi extends HttpApiGroup.make('tiles')
  .add(
    /**
     * Global infrared cloud imagery (NOAA GMGSI via nowCOAST), 256 px tiles in
     * the geographic tiling scheme (2 x 1 tiles at level 0). Any query string
     * is ignored; clients vary it to pick up new hourly frames.
     */
    HttpApiEndpoint.get('clouds', '/clouds/:z/:x/:y', {
      params: { z: TileCoordinate, x: TileCoordinate, y: TileCoordinate },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: 'image/png' })),
      error: [UpstreamUnavailable, TileOutOfRange],
    }),
  )
  .prefix('/tiles') {}

export class Api extends HttpApi.make('atlas')
  .add(SystemApi)
  .add(FeedsApi)
  .add(LiveApi)
  .add(TilesApi)
  .prefix('/api')
  .annotateMerge(OpenApi.annotations({ title: 'atlas' })) {}
