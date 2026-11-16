import { Context, Effect, Layer } from 'effect';
import { isTile, tileAt } from './area.ts';
import { areaZooms } from './catalog.ts';
import { derivedFrom } from './derived.ts';
import { type AirportData, type AirportsInTile, FeedNotReady, TileOutOfRange } from './domain.ts';
import { FeedStore } from './feeds.ts';
import { sliceAirports } from './views.ts';

/**
 * Every open airport by tile. The snapshot holds every open airport (~73,000,
 * with ~47,000 runways: about 12 MB), too much to send for a layer that's on by
 * default. Browsers read the large and medium ones worldwide from the snapshot's
 * `major` view (src/views.ts), drawn from regional zoom, and ask here for
 * everything in one zoom-8 tile (~150 km), runways and links included, at city
 * zoom and when an airport is selected.
 */
export const AIRPORT_ZOOM = areaZooms.airports;

interface Index {
  readonly data: AirportData;
  /** Airport indices by `x/y` at `AIRPORT_ZOOM`. */
  readonly byTile: ReadonlyMap<string, ReadonlyArray<number>>;
}

export class AirportIndex extends Context.Service<
  AirportIndex,
  {
    tile(z: number, x: number, y: number): Effect.Effect<AirportsInTile, FeedNotReady | TileOutOfRange>;
  }
>()('atlas/AirportIndex') {
  static readonly layer = Layer.effect(
    AirportIndex,
    Effect.gen(function* () {
      const store = yield* FeedStore;
      const index = derivedFrom(store, 'airports', (data): Index => {
        const byTile = new Map<string, number[]>();
        for (let i = 0; i < data.airports.ident.length; i++) {
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
        return { data, byTile };
      });
      const current = Effect.flatMap(index, (derived) =>
        Effect.fromOption(derived).pipe(Effect.mapError(() => new FeedNotReady({ feed: 'airports' }))),
      );

      const tile = Effect.fn('AirportIndex.tile')(function* (z: number, x: number, y: number) {
        if (z !== AIRPORT_ZOOM || !isTile(z, x, y)) return yield* new TileOutOfRange({ z, x, y });
        const { version, value } = yield* current;
        return { version, data: sliceAirports(value.data, value.byTile.get(`${x}/${y}`) ?? [], true) };
      });

      return AirportIndex.of({ tile });
    }),
  );
}
