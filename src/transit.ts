import { Cache, Clock, Context, Duration, Effect, Exit, Layer, Option } from 'effect';
import { HttpClient } from 'effect/http';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { contains, isTile, overlaps, tileBounds } from './area.ts';
import { derivedFrom } from './derived.ts';
import { FeedNotReady, TileOutOfRange, type TransitMode, type TransitVehicles } from './domain.ts';
import { FeedStore } from './feeds.ts';
import { makeHostGate } from './gate.ts';
import { type Columns, get, IngestError, round } from './ingest/source.ts';
import { readSchedule, type Route } from './schedules.ts';

/**
 * Live transit vehicles for the area in view, from the keyless GTFS-realtime
 * feeds the Mobility Database lists (the `transitFeeds` snapshot). A tile asks
 * every feed whose area overlaps it; feeds are cached by URL, not by tile, so
 * one download serves every tile a feed covers (a national feed covers
 * hundreds).
 */
export const TRANSIT_ZOOM = 10;
/** How long a feed's download is reused; producers update every 10–30 s. */
const FRESH = Duration.seconds(15);
/** A feed that doesn't answer in time is reported as such; the others still come back. */
const FEED_TIMEOUT = Duration.seconds(10);
/** Positions older than this are vehicles a feed forgot to drop. */
const STALE_S = 30 * 60;
/** Route names and modes change with timetables, a few times a year. */
const SCHEDULE_FRESH = Duration.hours(24);
/** Reading `routes.txt` takes three or four small range requests. */
const SCHEDULE_TIMEOUT = Duration.seconds(15);

const { transit_realtime } = GtfsRealtimeBindings;

/** One vehicle as a feed reports it. */
export interface Vehicle {
  readonly id: string;
  readonly label: string;
  readonly route: string;
  readonly trip: string;
  readonly lon: number;
  readonly lat: number;
  readonly bearing: number | null;
  readonly speed: number | null;
  readonly timestamp: number | null;
}

const toNumber = (value: number | { toNumber(): number } | null | undefined): number | null =>
  value === null || value === undefined ? null : typeof value === 'number' ? value : value.toNumber();

/**
 * Decodes a GTFS-realtime feed into its vehicles with positions. Protobuf
 * fills unset optional fields with defaults (a bearing of 0), so presence is
 * checked on the decoded object itself.
 */
export const parseVehiclePositions = (bytes: Uint8Array): Vehicle[] | IngestError => {
  let message: InstanceType<typeof transit_realtime.FeedMessage>;
  try {
    message = transit_realtime.FeedMessage.decode(bytes);
  } catch (cause) {
    return new IngestError({
      message: `not GTFS-realtime: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  const sent = toNumber(message.header.timestamp);
  const vehicles: Vehicle[] = [];
  for (const entity of message.entity) {
    const v = entity.vehicle;
    const p = v?.position;
    if (!v || !p) continue;
    const { latitude: lat, longitude: lon } = p;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (lat === 0 && lon === 0) continue;
    const descriptor = v.vehicle;
    const trip = v.trip;
    vehicles.push({
      id: descriptor?.id || trip?.tripId || entity.id,
      label: descriptor?.label ?? '',
      route: trip?.routeId ?? '',
      trip: trip?.tripId ?? '',
      lon: round(lon, 5),
      lat: round(lat, 5),
      bearing: Object.hasOwn(p, 'bearing') ? round(p.bearing ?? 0, 0) : null,
      speed: Object.hasOwn(p, 'speed') ? round(p.speed ?? 0, 1) : null,
      timestamp: Object.hasOwn(v, 'timestamp') ? toNumber(v.timestamp) : sent,
    });
  }
  return vehicles;
};

export class TransitLookup extends Context.Service<
  TransitLookup,
  { tile(z: number, x: number, y: number): Effect.Effect<TransitVehicles, FeedNotReady | TileOutOfRange> }
>()('atlas/TransitLookup') {
  static readonly layer = Layer.effect(
    TransitLookup,
    Effect.gen(function* () {
      const store = yield* FeedStore;
      const client = yield* HttpClient.HttpClient;
      const catalog = derivedFrom(store, 'transitFeeds', (data) => data);
      // Aggregators host dozens of feeds (transport.data.gouv.fr, Trafiklab): one request at a time each.
      const gate = makeHostGate();

      const feeds = yield* Cache.make({
        lookup: (url: string) =>
          gate(
            url,
            get(url).pipe(
              Effect.flatMap((response) =>
                response.status >= 200 && response.status < 300
                  ? response.arrayBuffer.pipe(
                      Effect.mapError((cause) => new IngestError({ message: String(cause) })),
                    )
                  : Effect.fail(new IngestError({ message: `HTTP ${response.status}` })),
              ),
              Effect.timeout(FEED_TIMEOUT),
            ),
          ).pipe(
            Effect.flatMap((buffer) => {
              const vehicles = parseVehiclePositions(new Uint8Array(buffer));
              return vehicles instanceof IngestError ? Effect.fail(vehicles) : Effect.succeed(vehicles);
            }),
            Effect.mapError((e) => new IngestError({ message: e.message })),
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        capacity: 1000,
        timeToLive: FRESH,
      });

      const schedules = yield* Cache.makeWith(
        (url: string) =>
          readSchedule(url).pipe(
            Effect.timeout(SCHEDULE_TIMEOUT),
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        {
          capacity: 1000,
          // An archive that can't be read now is tried again within the hour, not on every request.
          timeToLive: (exit) => (Exit.isSuccess(exit) ? SCHEDULE_FRESH : Duration.hours(1)),
        },
      );
      /** Routes from all of a feed's schedules; best effort, so modes are simply unknown without them. */
      const routesOf = (urls: ReadonlyArray<string>) =>
        Effect.forEach(urls, (url) => Effect.option(Cache.get(schedules, url)), {
          concurrency: 'unbounded',
        }).pipe(
          Effect.map((maps) => {
            const merged = new Map<string, Route>();
            for (const map of maps)
              if (Option.isSome(map)) for (const [id, route] of map.value) merged.set(id, route);
            return merged;
          }),
        );

      const tile = Effect.fn('TransitLookup.tile')(function* (z: number, x: number, y: number) {
        if (z !== TRANSIT_ZOOM || !isTile(z, x, y)) return yield* new TileOutOfRange({ z, x, y });
        const derived = yield* catalog;
        if (Option.isNone(derived)) return yield* new FeedNotReady({ feed: 'transitFeeds' });
        const data = derived.value.value;
        const bounds = tileBounds(z, x, y);
        const covering: number[] = [];
        for (let i = 0; i < data.id.length; i++)
          if (
            overlaps(bounds, {
              west: data.west[i] as number,
              south: data.south[i] as number,
              east: data.east[i] as number,
              north: data.north[i] as number,
            })
          )
            covering.push(i);
        yield* Effect.annotateCurrentSpan({ feeds: covering.length });

        const answers = yield* Effect.forEach(
          covering,
          (i) =>
            Effect.all([Cache.get(feeds, data.url[i] as string), routesOf(data.schedules[i] ?? [])], {
              concurrency: 2,
            }).pipe(Effect.result),
          { concurrency: 'unbounded' },
        );
        const now = (yield* Clock.currentTimeMillis) / 1000;
        const out: Columns<TransitVehicles['data']> = {
          feed: [],
          id: [],
          label: [],
          route: [],
          routeName: [],
          trip: [],
          mode: [],
          lon: [],
          lat: [],
          bearing: [],
          speed: [],
          timestamp: [],
        };
        const listed: Array<TransitVehicles['feeds'][number]> = [];
        for (let k = 0; k < covering.length; k++) {
          const i = covering[k] as number;
          const answer = answers[k];
          const ok = answer?._tag === 'Success';
          if (!ok && answer)
            yield* Effect.logDebug('transit feed unavailable').pipe(
              Effect.annotateLogs({ feed: data.id[i], error: answer.failure.message }),
            );
          const before = out.id.length;
          if (ok) {
            const [vehicles, routes] = answer.success;
            for (const v of vehicles) {
              if (!contains(bounds, v.lon, v.lat)) continue;
              if (v.timestamp !== null && now - v.timestamp > STALE_S) continue;
              const route = routes.get(v.route);
              out.feed.push(listed.length);
              out.id.push(v.id);
              out.label.push(v.label);
              out.route.push(v.route);
              out.routeName.push(route?.name ?? '');
              out.trip.push(v.trip);
              out.mode.push((route?.mode ?? null) satisfies TransitMode | null);
              out.lon.push(v.lon);
              out.lat.push(v.lat);
              out.bearing.push(v.bearing);
              out.speed.push(v.speed);
              out.timestamp.push(v.timestamp);
            }
          }
          // List a feed only if it has vehicles here or failed: one covering the tile with none in it is noise.
          if (!ok || out.id.length > before)
            listed.push({ id: data.id[i] as string, provider: data.provider[i] as string, ok });
        }
        return { time: Math.round(now * 1000), feeds: listed, data: out } satisfies TransitVehicles;
      });

      return TransitLookup.of({ tile });
    }),
  );
}
