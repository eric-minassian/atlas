import { Effect } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { type Reader, unzip } from 'unzipit';
import type { TransitMode } from './domain.ts';
import { readCsv } from './ingest/csv.ts';
import { IngestError } from './ingest/source.ts';

export interface Route {
  /** `route_short_name`, else `route_long_name`. */
  readonly name: string;
  readonly mode: TransitMode;
}

/**
 * GTFS route types, basic (0–12) and extended (Google's hierarchical codes,
 * https://developers.google.com/transit/gtfs/reference/extended-route-types),
 * by mode.
 */
export const modeOf = (routeType: number): TransitMode => {
  if (routeType === 0 || routeType === 5 || (routeType >= 900 && routeType < 1000)) return 'tram';
  if (routeType === 1 || routeType === 12 || (routeType >= 400 && routeType < 500)) return 'metro';
  if (routeType === 2 || (routeType >= 100 && routeType < 200)) return 'rail';
  if (
    routeType === 3 ||
    routeType === 11 ||
    (routeType >= 200 && routeType < 300) ||
    (routeType >= 700 && routeType < 900)
  )
    return 'bus';
  if (routeType === 4 || (routeType >= 1000 && routeType < 1100) || routeType === 1200) return 'ferry';
  if (routeType === 6 || routeType === 7 || (routeType >= 1300 && routeType < 1500)) return 'cable';
  return 'other';
};

/** Route names and modes by `route_id`, from a GTFS `routes.txt`. */
export const parseRoutes = (csv: string): ReadonlyMap<string, Route> | IngestError => {
  const table = readCsv(csv, ['route_id', 'route_type'], 'GTFS routes', [
    'route_short_name',
    'route_long_name',
  ]);
  if (table instanceof IngestError) return table;
  const { column } = table;
  const routes = new Map<string, Route>();
  for (const row of table.rows) {
    const id = row[column.route_id]?.trim();
    const type = Number(row[column.route_type]);
    if (!id || !Number.isInteger(type)) continue;
    const name = row[column.route_short_name]?.trim() || row[column.route_long_name]?.trim() || '';
    routes.set(id, { name, mode: modeOf(type) });
  }
  return routes;
};

/** A zip reader over HTTP range requests, so only the parts of the archive that are read are downloaded. */
const rangeReader = (
  url: string,
  run: <A>(effect: Effect.Effect<A, IngestError, HttpClient.HttpClient>) => Promise<A>,
): Reader => {
  const fail = (message: string) => new IngestError({ message: `${new URL(url).host}: ${message}` });
  return {
    getLength: () =>
      run(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client
            .execute(HttpClientRequest.head(url))
            .pipe(Effect.mapError((e) => fail(e.message)));
          const length = Number(response.headers['content-length']);
          if (response.status !== 200 || !Number.isFinite(length))
            return yield* fail(`HEAD answered ${response.status}`);
          return length;
        }),
      ),
    read: (offset, size) =>
      run(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client
            .execute(
              HttpClientRequest.get(url).pipe(
                HttpClientRequest.setHeader('range', `bytes=${offset}-${offset + size - 1}`),
              ),
            )
            .pipe(Effect.mapError((e) => fail(e.message)));
          // A 200 would be the whole archive (tens of MB): only a partial answer will do.
          if (response.status !== 206) return yield* fail(`range request answered ${response.status}`);
          const buffer = yield* response.arrayBuffer.pipe(Effect.mapError((e) => fail(e.message)));
          return new Uint8Array(buffer);
        }),
      ),
  };
};

/**
 * Reads the routes of a static GTFS archive (the Mobility Database's copy).
 * Archives run to hundreds of megabytes; `routes.txt` is a few kilobytes of
 * one, so it's read with range requests: the zip's directory, then that entry.
 */
export const readSchedule = Effect.fnUntraced(function* (url: string) {
  const context = yield* Effect.context<HttpClient.HttpClient>();
  const run = Effect.runPromiseWith(context);
  const text = yield* Effect.tryPromise({
    try: async () => {
      const { entries } = await unzip(rangeReader(url, run));
      const routes =
        entries['routes.txt'] ?? Object.values(entries).find((e) => e.name.endsWith('/routes.txt'));
      return routes ? routes.text() : undefined;
    },
    catch: (cause) =>
      cause instanceof IngestError ? cause : new IngestError({ message: `reading ${url}: ${String(cause)}` }),
  });
  if (text === undefined) return yield* new IngestError({ message: `${url} has no routes.txt` });
  const routes = parseRoutes(text);
  if (routes instanceof IngestError) return yield* routes;
  return routes;
});
