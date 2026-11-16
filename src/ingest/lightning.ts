import { Clock, Effect, Option, Predicate, Result } from 'effect';
import type { LightningData } from '../domain.ts';
import { type Columns, get, IngestError, okText, round, type Source, updated } from './source.ts';

/**
 * Lightning from the Geostationary Lightning Mappers on GOES-East and
 * GOES-West: NOAA publishes a Level 2 file of flashes every 20 seconds per
 * satellite to public S3 buckets (netCDF-4, which is HDF5). Each refresh
 * reads the files that appeared since the last one and keeps the past
 * quarter hour.
 */
export const SATELLITES = [
  /** GOES-East, 75.2° W. */
  { id: 'G19', bucket: 'noaa-goes19' },
  /** GOES-West, 137.2° W. */
  { id: 'G18', bucket: 'noaa-goes18' },
] as const;
type SatelliteId = (typeof SATELLITES)[number]['id'];

/**
 * The two fields of view overlap over the eastern Pacific and western North
 * America. Each flash is kept from the satellite nearer overhead, split
 * halfway between the two sub-satellite points, so it isn't counted twice.
 */
const SPLIT_LON = -106.2;
const keeps = (satellite: SatelliteId, lon: number) =>
  satellite === 'G19' ? lon >= SPLIT_LON && lon < 90 : lon < SPLIT_LON || lon >= 90;

export const WINDOW_MS = 15 * 60_000;
const PRODUCT = 'GLM-L2-LCFA';
/** Seconds between the Unix epoch and the J2000 epoch netCDF times here count from (2000-01-01 12:00 UTC). */
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const FETCH_CONCURRENCY = 8;

/** `OR_GLM-L2-LCFA_G19_s20263200059200_e…` → `s20263200059200` (year, day of year, hh mm ss, tenths). */
export const startOf = (key: string): string | undefined => /_(s\d{14})_/.exec(key)?.[1];

/** A file name's start time, epoch ms. */
export const startTime = (start: string): number => {
  const year = Number(start.slice(1, 5));
  const day = Number(start.slice(5, 8));
  const [h, m, s, tenths] = [
    start.slice(8, 10),
    start.slice(10, 12),
    start.slice(12, 14),
    start.slice(14, 15),
  ].map(Number) as [number, number, number, number];
  return Date.UTC(year, 0, day, h, m, s, tenths * 100);
};

/** The hourly prefixes that can hold files from `from` to `to` (epoch ms). */
export const prefixesFor = (from: number, to: number): string[] => {
  const prefixes: string[] = [];
  for (let t = Math.floor(from / 3_600_000) * 3_600_000; t <= to; t += 3_600_000) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    const day = Math.floor((t - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
    prefixes.push(
      `${PRODUCT}/${year}/${String(day).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`,
    );
  }
  return prefixes;
};

/**
 * The object keys in an S3 ListObjectsV2 answer. It's XML; keys are the only
 * part read, and GLM's are plain ASCII (no entities to unescape). An hour
 * holds 180 files per satellite, well under the 1,000 a page returns.
 */
export const parseListing = (xml: string): string[] | IngestError => {
  if (!xml.includes('<ListBucketResult')) return new IngestError({ message: 'unexpected S3 listing' });
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1] as string);
};

/** Flashes from one file. */
export interface Flashes {
  readonly lon: ReadonlyArray<number>;
  readonly lat: ReadonlyArray<number>;
  /** Epoch ms. */
  readonly time: ReadonlyArray<number>;
  /** Joules. */
  readonly energy: ReadonlyArray<number>;
  /** Square meters. */
  readonly area: ReadonlyArray<number>;
}

type H5 = typeof import('h5wasm');
type H5File = InstanceType<H5['File']>;

/** The first element of an attribute's value (netCDF stores scalars as one-element arrays). */
const scalar = (value: unknown): unknown =>
  ArrayBuffer.isView(value) || Array.isArray(value) ? (value as ArrayLike<unknown>)[0] : value;

/**
 * A variable's values, unpacked per the netCDF conventions GLM follows:
 * integers stored as signed 16-bit with `_Unsigned = "true"`, scaled by
 * `scale_factor` and shifted by `add_offset`; `_FillValue` marks missing
 * values (NaN here).
 */
export const readVariable = (file: H5File, name: string): Float64Array | IngestError => {
  const dataset = file.get(name);
  if (!dataset || !('value' in dataset) || !('attrs' in dataset))
    return new IngestError({ message: `GLM file has no ${name}` });
  const raw: unknown = dataset.value;
  // Scalars (product_time) come back as plain numbers, arrays as typed arrays.
  const values: ArrayLike<number> | undefined = Predicate.isNumber(raw)
    ? [raw]
    : ArrayBuffer.isView(raw) &&
        !(raw instanceof DataView) &&
        !(raw instanceof BigInt64Array) &&
        !(raw instanceof BigUint64Array)
      ? (raw as unknown as ArrayLike<number>)
      : undefined;
  if (!values) return new IngestError({ message: `GLM ${name} isn't numeric` });
  const attr = (key: string) => scalar(dataset.attrs[key]?.value);
  const unsigned = attr('_Unsigned') === 'true';
  const scale = attr('scale_factor');
  const offset = attr('add_offset');
  const fill = attr('_FillValue');
  const bits = 8 * ((raw as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 8);
  const wrap = (v: number) => (unsigned && v < 0 ? v + 2 ** bits : v);
  const fillValue = Predicate.isNumber(fill) ? wrap(fill) : undefined;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = wrap(values[i] as number);
    out[i] =
      v === fillValue
        ? Number.NaN
        : v * (Predicate.isNumber(scale) ? scale : 1) + (Predicate.isNumber(offset) ? offset : 0);
  }
  return out;
};

/** `seconds since 2026-11-16 00:59:20.000` → epoch ms of the reference time. */
const referenceOf = (units: unknown): number | undefined => {
  const match = Predicate.isString(units)
    ? /^seconds since (\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(\.\d+)?)/.exec(units)
    : null;
  const ms = match ? Date.parse(`${match[1]}T${match[2]}Z`) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

let opened = 0;

/** Reads the flashes in one GLM L2 file (bytes as downloaded). */
export const parseGlm = (h5: H5, bytes: Uint8Array, satellite: SatelliteId): Flashes | IngestError => {
  const FS = h5.FS as unknown as {
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  } | null;
  if (!FS) return new IngestError({ message: 'h5wasm is not ready' });
  // h5wasm reads from its in-memory file system.
  const path = `/glm-${++opened}.nc`;
  FS.writeFile(path, bytes);
  let file: H5File | undefined;
  try {
    file = new h5.File(path, 'r');
    const lat = readVariable(file, 'flash_lat');
    const lon = readVariable(file, 'flash_lon');
    const energy = readVariable(file, 'flash_energy');
    const area = readVariable(file, 'flash_area');
    const offset = readVariable(file, 'flash_time_offset_of_first_event');
    for (const v of [lat, lon, energy, area, offset]) if (v instanceof IngestError) return v;
    const productTime = readVariable(file, 'product_time');
    if (productTime instanceof IngestError) return productTime;
    const offsetUnits = file.get('flash_time_offset_of_first_event');
    const reference =
      referenceOf(
        offsetUnits && 'attrs' in offsetUnits ? scalar(offsetUnits.attrs.units?.value) : undefined,
      ) ?? J2000_MS + (productTime[0] ?? Number.NaN) * 1000;
    if (!Number.isFinite(reference)) return new IngestError({ message: 'GLM file has no time reference' });

    const out = {
      lon: [] as number[],
      lat: [] as number[],
      time: [] as number[],
      energy: [] as number[],
      area: [] as number[],
    };
    const n = (lat as Float64Array).length;
    for (let i = 0; i < n; i++) {
      const la = (lat as Float64Array)[i] as number;
      const lo = (lon as Float64Array)[i] as number;
      if (!Number.isFinite(la) || !Number.isFinite(lo) || !keeps(satellite, lo)) continue;
      out.lat.push(la);
      out.lon.push(lo);
      out.time.push(reference + ((offset as Float64Array)[i] as number) * 1000);
      out.energy.push((energy as Float64Array)[i] as number);
      out.area.push((area as Float64Array)[i] as number);
    }
    return out;
  } catch (cause) {
    return new IngestError({
      message: `GLM file unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  } finally {
    file?.close();
    FS.unlink(path);
  }
};

let loading: Promise<H5> | undefined;
/**
 * h5wasm, loaded on first use: its WebAssembly (embedded in the module, so the
 * worker bundle is self-contained) compiles at import, which the API server,
 * bundling every source for intervals, never needs to pay for.
 */
const loadH5 = Effect.tryPromise({
  try: () => {
    loading ??= import('h5wasm').then(async (h5) => {
      await h5.ready;
      return h5;
    });
    return loading;
  },
  catch: (cause) => new IngestError({ message: `h5wasm failed to load: ${String(cause)}` }),
});

/**
 * Adds new flashes to the previous ones and drops those older than the
 * window (`now` epoch ms). Energy is kept in femtojoules and area in km².
 */
export const mergeFlashes = (
  previous: LightningData | undefined,
  batches: ReadonlyArray<{ readonly satellite: string; readonly flashes: Flashes }>,
  latest: Readonly<Record<string, string>>,
  now: number,
): LightningData => {
  const since = Math.floor((now - WINDOW_MS) / 1000) * 1000;
  const out: Columns<Omit<LightningData, 'since' | 'latest'>> = {
    lon: [],
    lat: [],
    time: [],
    energy: [],
    area: [],
    satellite: [],
  };
  const push = (
    lon: number,
    lat: number,
    time: number,
    energyFj: number,
    areaKm2: number,
    satellite: string,
  ) => {
    if (time < since) return;
    out.lon.push(round(lon, 3));
    out.lat.push(round(lat, 3));
    out.time.push(round((time - since) / 1000, 1));
    out.energy.push(Number.isFinite(energyFj) ? round(energyFj, 0) : 0);
    out.area.push(Number.isFinite(areaKm2) ? round(areaKm2, 0) : 0);
    out.satellite.push(satellite);
  };
  if (previous)
    for (let i = 0; i < previous.lon.length; i++)
      push(
        previous.lon[i] as number,
        previous.lat[i] as number,
        previous.since + (previous.time[i] as number) * 1000,
        previous.energy[i] as number,
        previous.area[i] as number,
        previous.satellite[i] as string,
      );
  for (const { satellite, flashes: f } of batches)
    for (let i = 0; i < f.lon.length; i++)
      push(
        f.lon[i] as number,
        f.lat[i] as number,
        f.time[i] as number,
        (f.energy[i] as number) * 1e15,
        (f.area[i] as number) / 1e6,
        satellite,
      );
  return { since, latest, ...out };
};

export const makeLightningSource = (): Source<'lightning'> => ({
  read: (_validators, previous) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const prior = Option.getOrUndefined(yield* previous);
      const latest: Record<string, string> = { ...prior?.latest };
      const from = now - WINDOW_MS;

      // The files each satellite published since the newest one already read (or in the window).
      const pending = yield* Effect.forEach(
        SATELLITES,
        (satellite) =>
          Effect.gen(function* () {
            const keys: string[] = [];
            for (const prefix of prefixesFor(from, now)) {
              const xml = yield* get(
                `https://${satellite.bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`,
              ).pipe(Effect.flatMap(okText));
              const listed = parseListing(xml);
              if (listed instanceof IngestError) return yield* listed;
              keys.push(...listed);
            }
            const after = latest[satellite.id];
            return keys.flatMap((key) => {
              const start = startOf(key);
              if (!start || startTime(start) < from || (after !== undefined && start <= after)) return [];
              return [{ satellite, key, start }];
            });
          }),
        { concurrency: SATELLITES.length },
      );

      const files = pending.flat();
      const h5 = yield* loadH5;
      const results = yield* Effect.forEach(
        files,
        ({ satellite, key, start }) =>
          Effect.gen(function* () {
            const response = yield* get(`https://${satellite.bucket}.s3.amazonaws.com/${key}`);
            if (response.status !== 200)
              return yield* new IngestError({ message: `GET ${key}: HTTP ${response.status}` });
            const bytes = yield* response.arrayBuffer.pipe(
              Effect.mapError((cause) => new IngestError({ message: `reading ${key}: ${String(cause)}` })),
            );
            const flashes = parseGlm(h5, new Uint8Array(bytes), satellite.id);
            if (flashes instanceof IngestError) return yield* flashes;
            return { satellite: satellite.id, start, flashes };
          }).pipe(Effect.result),
        { concurrency: FETCH_CONCURRENCY },
      );
      const batches = results.flatMap((r) => (Result.isSuccess(r) ? [r.success] : []));
      const failed = results.flatMap((r) => (Result.isFailure(r) ? [r.failure.message] : []));
      if (files.length > 0 && batches.length === 0)
        return yield* new IngestError({ message: `no GLM file could be read: ${failed[0]}` });
      // A file that failed is skipped rather than retried: the window moves on within minutes.
      if (failed.length > 0)
        yield* Effect.logWarning('skipped unreadable GLM files').pipe(
          Effect.annotateLogs({ failed: failed.length, first: failed[0] }),
        );
      for (const batch of batches)
        if ((latest[batch.satellite] ?? '') < batch.start) latest[batch.satellite] = batch.start;

      const data = mergeFlashes(prior, batches, latest, now);
      return updated<'lightning'>(data, data.lon.length);
    }),
});
