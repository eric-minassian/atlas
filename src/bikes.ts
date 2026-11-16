import { Cache, Clock, Context, Duration, Effect, Layer, Option, type Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { contains, isTile, overlaps, tileBounds } from './area.ts';
import { derivedFrom } from './derived.ts';
import { type BikeStations, FeedNotReady, TileOutOfRange } from './domain.ts';
import { FeedStore } from './feeds.ts';
import { makeHostGate } from './gate.ts';
import { electricBikeTypes, flag, nameOf, StationInformation, StationStatus, VehicleTypes } from './gbfs.ts';
import { type Columns, decodeJson, get, IngestError, okText, round } from './ingest/source.ts';

/**
 * Bike-share stations for the area in view, from each covering system's GBFS
 * feeds (located by the `bikeSystems` snapshot). Feeds are cached per URL, so
 * one download serves every tile a system covers: station status for a
 * minute (systems publish every 10–60 s), station locations and vehicle
 * types for an hour.
 */
export const BIKES_ZOOM = 11;
const STATUS_FRESH = Duration.seconds(60);
const INFORMATION_FRESH = Duration.hours(1);
const SYSTEM_TIMEOUT = Duration.seconds(10);

export class BikeLookup extends Context.Service<
  BikeLookup,
  { tile(z: number, x: number, y: number): Effect.Effect<BikeStations, FeedNotReady | TileOutOfRange> }
>()('atlas/BikeLookup') {
  static readonly layer = Layer.effect(
    BikeLookup,
    Effect.gen(function* () {
      const store = yield* FeedStore;
      const client = yield* HttpClient.HttpClient;
      const catalog = derivedFrom(store, 'bikeSystems', (data) => data);
      // Platforms host many systems (nextbike, PBSC, Lyft): one request at a time per host.
      const gate = makeHostGate();
      const fetchJson = <S extends Schema.Top>(schema: S) => {
        const decode = decodeJson(schema);
        return (url: string) =>
          gate(url, get(url).pipe(Effect.flatMap(okText))).pipe(
            Effect.flatMap(decode),
            Effect.mapError((e) => new IngestError({ message: e.message })),
            Effect.provideService(HttpClient.HttpClient, client),
          );
      };
      const information = yield* Cache.make({
        lookup: fetchJson(StationInformation),
        capacity: 500,
        timeToLive: INFORMATION_FRESH,
      });
      const status = yield* Cache.make({
        lookup: fetchJson(StationStatus),
        capacity: 500,
        timeToLive: STATUS_FRESH,
      });
      const types = yield* Cache.make({
        lookup: fetchJson(VehicleTypes),
        capacity: 500,
        timeToLive: INFORMATION_FRESH,
      });

      const tile = Effect.fn('BikeLookup.tile')(function* (z: number, x: number, y: number) {
        if (z !== BIKES_ZOOM || !isTile(z, x, y)) return yield* new TileOutOfRange({ z, x, y });
        const derived = yield* catalog;
        if (Option.isNone(derived)) return yield* new FeedNotReady({ feed: 'bikeSystems' });
        const data = derived.value.value;
        const bounds = tileBounds(z, x, y);
        const covering: number[] = [];
        for (let i = 0; i < data.id.length; i++) {
          const west = data.west[i];
          const south = data.south[i];
          const east = data.east[i];
          const north = data.north[i];
          if (west == null || south == null || east == null || north == null) continue;
          if (!data.information[i] || !data.status[i]) continue;
          if (overlaps(bounds, { west, south, east, north })) covering.push(i);
        }
        yield* Effect.annotateCurrentSpan({ systems: covering.length });

        const answers = yield* Effect.forEach(
          covering,
          (i) =>
            Effect.all(
              [
                Cache.get(information, data.information[i] as string),
                Cache.get(status, data.status[i] as string),
                // Vehicle types only tell e-bikes apart: without them, e-bikes are just unknown.
                data.vehicleTypes[i]
                  ? Effect.option(Cache.get(types, data.vehicleTypes[i])).pipe(
                      Effect.map(Option.getOrUndefined),
                    )
                  : Effect.undefined,
              ],
              { concurrency: 3 },
            ).pipe(Effect.timeout(SYSTEM_TIMEOUT), Effect.result),
          { concurrency: 'unbounded' },
        );

        const out: Columns<BikeStations['data']> = {
          system: [],
          id: [],
          name: [],
          lon: [],
          lat: [],
          bikes: [],
          ebikes: [],
          docks: [],
          capacity: [],
          renting: [],
          returning: [],
          reported: [],
        };
        const listed: Array<BikeStations['systems'][number]> = [];
        for (let k = 0; k < covering.length; k++) {
          const i = covering[k] as number;
          const answer = answers[k];
          const ok = answer?._tag === 'Success';
          if (!ok && answer)
            yield* Effect.logDebug('bike-share system unavailable').pipe(
              Effect.annotateLogs({ system: data.id[i], error: String(answer.failure) }),
            );
          const before = out.id.length;
          if (ok) {
            const [info, now, vehicleTypes] = answer.success;
            const electric = electricBikeTypes(vehicleTypes);
            const statusById = new Map(now.data.stations.map((s) => [String(s.station_id), s]));
            for (const station of info.data.stations) {
              if (!contains(bounds, station.lon, station.lat)) continue;
              const id = String(station.station_id);
              const s = statusById.get(id);
              // A station without status, or not on the street, isn't in service.
              if (!s || !flag(s.is_installed, true)) continue;
              out.system.push(listed.length);
              out.id.push(id);
              out.name.push(nameOf(station.name));
              out.lon.push(round(station.lon, 5));
              out.lat.push(round(station.lat, 5));
              out.bikes.push(Math.max(0, Math.round(s.num_bikes_available ?? s.num_vehicles_available ?? 0)));
              out.ebikes.push(ebikesAt(s, electric));
              out.docks.push(
                s.num_docks_available === undefined ? null : Math.max(0, Math.round(s.num_docks_available)),
              );
              out.capacity.push(station.capacity === undefined ? null : Math.round(station.capacity));
              out.renting.push(flag(s.is_renting, true));
              out.returning.push(flag(s.is_returning, true));
              out.reported.push(reportedAt(s.last_reported));
            }
          }
          if (!ok || out.id.length > before)
            listed.push({
              id: data.id[i] as string,
              name: data.name[i] as string,
              website: data.website[i] as string,
              ok,
            });
        }
        return { time: yield* Clock.currentTimeMillis, systems: listed, data: out } satisfies BikeStations;
      });

      return BikeLookup.of({ tile });
    }),
  );
}

type Status = StationStatus['data']['stations'][number];

/** E-bikes at a station, from whichever way the system reports them; null when it doesn't. */
export const ebikesAt = (s: Status, electric: ReadonlySet<string>): number | null => {
  if (s.num_ebikes_available !== undefined) return Math.round(s.num_ebikes_available);
  if (s.vehicle_types_available && electric.size > 0)
    return s.vehicle_types_available
      .filter((t) => electric.has(String(t.vehicle_type_id)))
      .reduce((sum, t) => sum + Math.round(t.count), 0);
  const smovengo = s.num_bikes_available_types?.find((t) => 'ebike' in t);
  if (smovengo) return Math.round(smovengo.ebike ?? 0);
  return null;
};

/** Epoch seconds, from a POSIX time (before GBFS 3.0) or an RFC 3339 one. */
export const reportedAt = (value: number | string | undefined): number | null => {
  if (value === undefined) return null;
  if (typeof value === 'number') return value > 1e11 ? Math.round(value / 1000) : value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
};
