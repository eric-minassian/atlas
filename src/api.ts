/**
 * The HTTP API, defined once as schemas. The server implements it
 * (`src/http.ts`) and the web app calls it through a client generated from it
 * (`web/src/client.ts`). The web app imports this file: keep it free of
 * server-only imports.
 */
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { TileParams } from './area.ts';
import {
  AircraftNearby,
  AirportsInTile,
  BikeStations,
  Catalog,
  ClientConfig,
  FeedNotReady,
  Here,
  Latitude,
  Longitude,
  SightingArea,
  SourceNotConfigured,
  TileOutOfRange,
  TransitVehicles,
  UnknownCamera,
  UpstreamUnavailable,
  WebcamArea,
} from './domain.ts';

const LatitudeParam = Schema.FiniteFromString.pipe(Schema.decodeTo(Latitude));
const LongitudeParam = Schema.FiniteFromString.pipe(Schema.decodeTo(Longitude));

export class SystemApi extends HttpApiGroup.make('system', { topLevel: true }).add(
  HttpApiEndpoint.get('health', '/health', {
    success: Schema.Struct({ ok: Schema.Literal(true), app: Schema.String, stage: Schema.String }),
  }),
  /** Keys for services the browser calls directly, and which keyed sources are configured. */
  HttpApiEndpoint.get('config', '/config', { success: ClientConfig }),
  /**
   * Every feed's freshness: current version, last update, size and last error.
   * Browsers fetch each snapshot from the public `feeds` store, at the key
   * `snapshotKey` (src/catalog.ts) gives for its version.
   */
  HttpApiEndpoint.get('catalog', '/catalog', { success: Catalog }),
  /** Conditions at a point (weather, air quality, elevation, time zone). */
  HttpApiEndpoint.get('here', '/here', {
    query: {
      lat: LatitudeParam,
      lon: LongitudeParam,
    },
    success: Here,
    error: UpstreamUnavailable,
  }),
) {}

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
    /** Every open airport in a zoom-8 tile, with runways and full details. */
    HttpApiEndpoint.get('airports', '/airports/:z/:x/:y', {
      params: TileParams,
      success: AirportsInTile,
      error: [FeedNotReady, TileOutOfRange],
    }),
    /** Transit vehicles in a zoom-10 tile, from every keyless GTFS-realtime feed covering it. */
    HttpApiEndpoint.get('transit', '/transit/:z/:x/:y', {
      params: TileParams,
      success: TransitVehicles,
      error: [FeedNotReady, TileOutOfRange],
    }),
    /** Bike-share stations in a zoom-11 tile, with bikes and docks available now. */
    HttpApiEndpoint.get('bikes', '/bikes/:z/:x/:y', {
      params: TileParams,
      success: BikeStations,
      error: [FeedNotReady, TileOutOfRange],
    }),
    /**
     * The most viewed webcams in a tile (Windy), at most a couple of minutes old:
     * Windy's image URLs expire. 404 when this deployment has no Windy key.
     */
    HttpApiEndpoint.get('webcams', '/webcams/:z/:x/:y', {
      params: TileParams,
      success: WebcamArea,
      error: [UpstreamUnavailable, TileOutOfRange, SourceNotConfigured],
    }),
    /** The latest wildlife sightings with photos in a tile (iNaturalist). */
    HttpApiEndpoint.get('wildlife', '/wildlife/:z/:x/:y', {
      params: TileParams,
      success: SightingArea,
      error: [UpstreamUnavailable, TileOutOfRange],
    }),
    /**
     * The latest frame of a traffic camera whose operator serves it only over
     * HTTP (`relayed` in the cameras feed), by camera id. Any query string is
     * ignored; clients vary it to pick up new frames.
     */
    HttpApiEndpoint.get('cameraImage', '/cameras/:id/image', {
      params: { id: Schema.String.check(Schema.isPattern(/^[a-z]+-[\w.-]{1,120}$/)) },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: 'image/jpeg' })),
      error: [UnknownCamera, UpstreamUnavailable],
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
  .add(LiveApi)
  .add(TilesApi)
  .prefix('/api')
  .annotateMerge(OpenApi.annotations({ title: 'atlas' })) {}
