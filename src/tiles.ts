import { Context, Effect, Layer, Schedule } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { TileOutOfRange, UpstreamUnavailable } from './domain.ts';

const GMGSI_WMS = 'https://nowcoast.noaa.gov/geoserver/satellite/wms';
/** GMGSI is ~8 km per pixel; level 5 tiles are ~5.5 km per pixel. */
export const MAX_CLOUD_LEVEL = 5;

/** A tile's bounds in degrees in the geographic scheme: 2 x 1 tiles at level 0, 180° square. */
export const tileBounds = (z: number, x: number, y: number) => {
  if (z > MAX_CLOUD_LEVEL || x >= 2 << z || y >= 1 << z) return undefined;
  const size = 180 / (1 << z);
  const west = -180 + x * size;
  const north = 90 - y * size;
  return { west, south: north - size, east: west + size, north };
};

/** Relays map tiles from upstream imagery services. */
export class Tiles extends Context.Service<
  Tiles,
  { clouds(z: number, x: number, y: number): Effect.Effect<Uint8Array, UpstreamUnavailable | TileOutOfRange> }
>()('atlas/Tiles') {
  static readonly layer = Layer.effect(
    Tiles,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

      const clouds = Effect.fn('Tiles.clouds')(
        function* (z: number, x: number, y: number) {
          const b = tileBounds(z, x, y);
          if (!b) return yield* new TileOutOfRange({ z, x, y });
          const request = HttpClientRequest.get(GMGSI_WMS).pipe(
            HttpClientRequest.setUrlParams({
              service: 'WMS',
              version: '1.1.1',
              request: 'GetMap',
              layers: 'global_longwave_imagery_mosaic',
              styles: '',
              srs: 'EPSG:4326',
              bbox: `${b.west},${b.south},${b.east},${b.north}`,
              width: '256',
              height: '256',
              format: 'image/png',
              transparent: 'true',
            }),
          );
          // nowCOAST now and then fails a request or leaves it hanging while the next one answers
          // in ~200 ms: give each attempt a few seconds and retry.
          return yield* client.execute(request).pipe(
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.timeout('5 seconds'),
            Effect.retry({ times: 2, schedule: Schedule.exponential('200 millis') }),
            Effect.map((buffer) => new Uint8Array(buffer)),
          );
        },
        Effect.catchTags({
          HttpClientError: () => Effect.fail(new UpstreamUnavailable({ source: 'NOAA nowCOAST' })),
          TimeoutError: () => Effect.fail(new UpstreamUnavailable({ source: 'NOAA nowCOAST' })),
        }),
      );

      return Tiles.of({ clouds });
    }),
  );
}
