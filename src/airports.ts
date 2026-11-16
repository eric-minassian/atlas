import { Context, Effect, Layer } from 'effect';
import { isTile, tileAt } from './area.ts';
import { derivedFrom } from './derived.ts';
import { type AirportData, type AirportsInTile, FeedNotReady, TileOutOfRange } from './domain.ts';
import { FeedStore } from './feeds.ts';
import type { Columns } from './ingest/source.ts';

/**
 * How airports reach the browser. The snapshot holds every open airport
 * (~73,000, with ~47,000 runways: about 12 MB), too much to send for a layer
 * that's on by default. So it's served in two cuts, both made from the decoded
 * snapshot once per version:
 *
 * - `/api/feeds/airports`: the ~5,300 large and medium airports worldwide,
 *   without runways (~150 KB compressed), drawn from regional zoom;
 * - `/api/live/airports/8/x/y`: everything in one zoom-8 tile (~150 km),
 *   runways included, loaded at city zoom and when an airport is selected.
 */
export const AIRPORT_ZOOM = 8;

const emptyRunways = (): Columns<AirportData['runways']> => ({
  airport: [],
  low: [],
  high: [],
  length: [],
  width: [],
  surface: [],
  lighted: [],
  lowLon: [],
  lowLat: [],
  highLon: [],
  highLat: [],
});

const emptyAirports = (): Columns<AirportData['airports']> => ({
  ident: [],
  type: [],
  name: [],
  lon: [],
  lat: [],
  elevation: [],
  country: [],
  municipality: [],
  icao: [],
  iata: [],
  local: [],
  scheduled: [],
  website: [],
  wikipedia: [],
});

/** The airports at `indices`, with their runways (re-pointed at the new positions). */
export const sliceAirports = (
  data: AirportData,
  indices: ReadonlyArray<number>,
  withRunways: boolean,
): AirportData => {
  const airports = emptyAirports();
  const runways = emptyRunways();
  const at = new Map<number, number>();
  const keys = Object.keys(airports) as Array<keyof AirportData['airports']>;
  for (const i of indices) {
    at.set(i, airports.ident.length);
    for (const key of keys) (airports[key] as unknown[]).push(data.airports[key][i]);
  }
  if (withRunways) {
    const runwayKeys = Object.keys(runways) as Array<keyof AirportData['runways']>;
    for (let r = 0; r < data.runways.airport.length; r++) {
      const airport = at.get(data.runways.airport[r] as number);
      if (airport === undefined) continue;
      for (const key of runwayKeys)
        (runways[key] as unknown[]).push(key === 'airport' ? airport : data.runways[key][r]);
    }
  }
  return { airports, runways };
};

interface Index {
  readonly data: AirportData;
  /** The global cut, encoded once: it's served as-is. */
  readonly majorBody: string;
  /** Airport indices by `x/y` at `AIRPORT_ZOOM`. */
  readonly byTile: ReadonlyMap<string, ReadonlyArray<number>>;
}

export class AirportIndex extends Context.Service<
  AirportIndex,
  {
    /** The large and medium airports, as a snapshot body with its version (the ETag). */
    readonly major: Effect.Effect<{ readonly version: string; readonly body: string }, FeedNotReady>;
    tile(z: number, x: number, y: number): Effect.Effect<AirportsInTile, FeedNotReady | TileOutOfRange>;
  }
>()('atlas/AirportIndex') {
  static readonly layer = Layer.effect(
    AirportIndex,
    Effect.gen(function* () {
      const store = yield* FeedStore;
      const index = derivedFrom(store, 'airports', (data, snapshot): Index => {
        const major: number[] = [];
        const byTile = new Map<string, number[]>();
        for (let i = 0; i < data.airports.ident.length; i++) {
          const type = data.airports.type[i];
          if (type === 'large' || type === 'medium') major.push(i);
          const { x, y } = tileAt(
            AIRPORT_ZOOM,
            data.airports.lon[i] as number,
            data.airports.lat[i] as number,
          );
          const key = `${x}/${y}`;
          const list = byTile.get(key);
          if (list) list.push(i);
          else byTile.set(key, [i]);
        }
        const cut = sliceAirports(data, major, false);
        const majorBody = JSON.stringify({
          feed: 'airports',
          version: snapshot.version,
          fetchedAt: snapshot.fetchedAt,
          count: major.length,
          data: cut,
        });
        return { data, majorBody, byTile };
      });
      const current = Effect.flatMap(index, (derived) =>
        Effect.fromOption(derived).pipe(Effect.mapError(() => new FeedNotReady({ feed: 'airports' }))),
      );

      const major = Effect.map(current, ({ version, value }) => ({ version, body: value.majorBody })).pipe(
        Effect.withSpan('AirportIndex.major'),
      );

      const tile = Effect.fn('AirportIndex.tile')(function* (z: number, x: number, y: number) {
        if (z !== AIRPORT_ZOOM || !isTile(z, x, y)) return yield* new TileOutOfRange({ z, x, y });
        const { version, value } = yield* current;
        return { version, data: sliceAirports(value.data, value.byTile.get(`${x}/${y}`) ?? [], true) };
      });

      return AirportIndex.of({ major, tile });
    }),
  );
}
