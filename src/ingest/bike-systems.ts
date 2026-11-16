import { Clock, Duration, Effect, Option, Schema } from 'effect';
import { feeds } from '../catalog.ts';
import type { BikeSystemData } from '../domain.ts';
import { makeHostGate } from '../gate.ts';
import { Discovery, feedUrls, StationInformation } from '../gbfs.ts';
import { readCsv } from './csv.ts';
import { type Columns, decodeJson, get, IngestError, okText, round, type Source, updated } from './source.ts';

/**
 * Locates bike-share systems for `/api/live/bikes`. MobilityData's GBFS
 * systems list is the authoritative directory (1,200+ systems) but has no
 * coordinates, so each refresh walks a batch of systems, least recently
 * checked first: their `gbfs.json`, then `station_information`, whose
 * stations give the system's extent. Every system is revisited within a few
 * hours, which keeps up with new systems and moved stations.
 *
 * CityBikes' network list has locations in one request, but only a center
 * point per network (no extent), a GBFS link for about a third of them, and a
 * 300-requests-an-hour budget with attribution terms on top; walking the GBFS
 * feeds themselves yields real extents and the feed URLs the lookup needs.
 */
const SYSTEMS_URL = 'https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv';
/** Systems checked per refresh, at most; the time budget usually ends a batch first. */
const BATCH = 200;
const CONCURRENCY = 10;
/** Stop starting checks after this long, leaving the worker time to publish. */
const BUDGET = Duration.seconds(70);
const REQUEST_TIMEOUT = Duration.seconds(15);

const COLUMNS = ['System ID', 'Name', 'URL', 'Auto-Discovery URL', 'Authentication Type'] as const;

export interface ListedSystem {
  readonly id: string;
  readonly name: string;
  readonly website: string;
  readonly discovery: string;
}

/** The systems list, without the few that need a key. */
export const parseSystems = (csv: string): ReadonlyArray<ListedSystem> | IngestError => {
  const table = readCsv(csv, COLUMNS, 'GBFS systems');
  if (table instanceof IngestError) return table;
  const { rows, column } = table;
  const seen = new Set<string>();
  const out: ListedSystem[] = [];
  for (const row of rows) {
    const field = (name: (typeof COLUMNS)[number]) => (row[column[name]] ?? '').trim();
    const id = field('System ID');
    const discovery = field('Auto-Discovery URL');
    if (!id || seen.has(id) || !/^https?:\/\//.test(discovery) || field('Authentication Type') !== '')
      continue;
    seen.add(id);
    out.push({ id, name: field('Name'), website: field('URL'), discovery });
  }
  return out;
};

/** What checking a system found. */
export interface Located {
  readonly stations: number;
  readonly bounds: { west: number; south: number; east: number; north: number } | undefined;
  readonly information: string;
  readonly status: string;
  readonly vehicleTypes: string;
}

/** The extent of a system's stations, ignoring ones at 0,0 (a common placeholder). */
export const boundsOf = (information: StationInformation): Located['bounds'] => {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const { lat, lon } of information.data.stations) {
    if ((lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    west = Math.min(west, lon);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    north = Math.max(north, lat);
  }
  if (!Number.isFinite(west)) return undefined;
  return { west: round(west, 4), south: round(south, 4), east: round(east, 4), north: round(north, 4) };
};

type Entry = { -readonly [K in keyof Located]: Located[K] } & ListedSystem & { checkedAt: number };

const entriesOf = (data: BikeSystemData | undefined): Map<string, Entry> => {
  const out = new Map<string, Entry>();
  if (!data) return out;
  for (let i = 0; i < data.id.length; i++) {
    const west = data.west[i];
    const south = data.south[i];
    const east = data.east[i];
    const north = data.north[i];
    out.set(data.id[i] as string, {
      id: data.id[i] as string,
      name: data.name[i] ?? '',
      website: data.website[i] ?? '',
      discovery: data.discovery[i] ?? '',
      checkedAt: data.checkedAt[i] ?? 0,
      stations: data.stations[i] ?? 0,
      bounds:
        west != null && south != null && east != null && north != null
          ? { west, south, east, north }
          : undefined,
      information: data.information[i] ?? '',
      status: data.status[i] ?? '',
      vehicleTypes: data.vehicleTypes[i] ?? '',
    });
  }
  return out;
};

/**
 * The next catalog: the listed systems, each with what's known of it (a
 * changed discovery URL starts it over), updated with this round's checks.
 * Systems no longer listed are dropped. A failed check keeps what an earlier
 * one found, but still counts as a visit so the walk moves on.
 */
export const mergeSystems = (
  previous: BikeSystemData | undefined,
  listed: ReadonlyArray<ListedSystem>,
  checks: ReadonlyMap<string, Located | 'failed'>,
  now: number,
): BikeSystemData => {
  const known = entriesOf(previous);
  const out: Columns<BikeSystemData> = {
    id: [],
    name: [],
    website: [],
    discovery: [],
    checkedAt: [],
    stations: [],
    west: [],
    south: [],
    east: [],
    north: [],
    information: [],
    status: [],
    vehicleTypes: [],
  };
  for (const system of listed) {
    const before = known.get(system.id);
    const base: Entry =
      before && before.discovery === system.discovery
        ? { ...before, ...system }
        : {
            ...system,
            checkedAt: 0,
            stations: 0,
            bounds: undefined,
            information: '',
            status: '',
            vehicleTypes: '',
          };
    const check = checks.get(system.id);
    const entry: Entry =
      check === undefined
        ? base
        : check === 'failed'
          ? { ...base, checkedAt: now }
          : { ...base, ...check, checkedAt: now };
    out.id.push(entry.id);
    out.name.push(entry.name);
    out.website.push(entry.website);
    out.discovery.push(entry.discovery);
    out.checkedAt.push(entry.checkedAt);
    out.stations.push(entry.stations);
    out.west.push(entry.bounds?.west ?? null);
    out.south.push(entry.bounds?.south ?? null);
    out.east.push(entry.bounds?.east ?? null);
    out.north.push(entry.bounds?.north ?? null);
    out.information.push(entry.information);
    out.status.push(entry.status);
    out.vehicleTypes.push(entry.vehicleTypes);
  }
  return out;
};

/** The systems to check this round: never-checked ones first, then the longest unchecked. */
export const nextBatch = (
  previous: BikeSystemData | undefined,
  listed: ReadonlyArray<ListedSystem>,
  size: number,
): ReadonlyArray<ListedSystem> => {
  const known = entriesOf(previous);
  const checkedAt = (s: ListedSystem) => {
    const entry = known.get(s.id);
    return entry && entry.discovery === s.discovery ? entry.checkedAt : 0;
  };
  return listed.toSorted((a, b) => checkedAt(a) - checkedAt(b)).slice(0, size);
};

export const makeBikeSystemSource = (): Source<'bikeSystems'> => {
  // Many systems share a platform host (nextbike, Donkey Republic, Lyft): take turns per host.
  const gate = makeHostGate();
  const fetchJson = <S extends Schema.Top>(url: string, schema: S) =>
    gate(url, get(url).pipe(Effect.flatMap(okText), Effect.timeout(REQUEST_TIMEOUT))).pipe(
      Effect.flatMap(decodeJson(schema)),
      Effect.mapError((e) => new IngestError({ message: e.message })),
    );

  const check = Effect.fnUntraced(function* (system: ListedSystem) {
    const urls = feedUrls(yield* fetchJson(system.discovery, Discovery));
    const information = urls.get('station_information') ?? '';
    const status = urls.get('station_status') ?? '';
    // Free-floating fleets have no stations to show.
    if (!information || !status)
      return {
        stations: 0,
        bounds: undefined,
        information: '',
        status: '',
        vehicleTypes: '',
      } satisfies Located;
    const stations = yield* fetchJson(information, StationInformation);
    return {
      stations: stations.data.stations.length,
      bounds: boundsOf(stations),
      information,
      status,
      vehicleTypes: urls.get('vehicle_types') ?? '',
    } satisfies Located;
  });

  return {
    interval: Effect.succeed(feeds.bikeSystems.intervalSeconds),
    read: (_validators, previous) =>
      Effect.gen(function* () {
        const listed = parseSystems(yield* get(SYSTEMS_URL).pipe(Effect.flatMap(okText)));
        if (listed instanceof IngestError) return yield* listed;
        const prior = Option.getOrUndefined(yield* previous);
        const started = yield* Clock.currentTimeMillis;
        const deadline = started + Duration.toMillis(BUDGET);
        const checks = new Map<string, Located | 'failed'>();
        let failures = 0;
        yield* Effect.forEach(
          nextBatch(prior, listed, BATCH),
          (system) =>
            Effect.gen(function* () {
              if ((yield* Clock.currentTimeMillis) > deadline) return;
              const result = yield* Effect.result(check(system));
              if (result._tag === 'Success') checks.set(system.id, result.success);
              else {
                failures++;
                checks.set(system.id, 'failed');
                yield* Effect.logDebug('bike-share system check failed').pipe(
                  Effect.annotateLogs({ system: system.id, error: result.failure.message }),
                );
              }
            }),
          { concurrency: CONCURRENCY, discard: true },
        );
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const data = mergeSystems(prior, listed, checks, now);
        const located = data.stations.filter((n) => n > 0).length;
        yield* Effect.logInfo('bike-share systems checked').pipe(
          Effect.annotateLogs({ checked: checks.size, failures, located, listed: listed.length }),
        );
        return updated<'bikeSystems'>(data, located);
      }),
  };
};
