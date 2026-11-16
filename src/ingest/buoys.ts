import { Effect, Option } from 'effect';
import { feeds } from '../catalog.ts';
import type { BuoyData } from '../domain.ts';
import {
  type Columns,
  get,
  IngestError,
  notModified,
  okText,
  round,
  type Source,
  updated,
} from './source.ts';

/** The latest observation from each NDBC station that reported in the past few hours, fixed-width text. */
const OBS_URL = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
/** Station metadata, `|`-separated; only the names are used. */
const STATIONS_URL = 'https://www.ndbc.noaa.gov/data/stations/station_table.txt';

const REQUIRED = [
  'STN',
  'LAT',
  'LON',
  'YYYY',
  'MM',
  'DD',
  'hh',
  'mm',
  'WDIR',
  'WSPD',
  'GST',
  'WVHT',
  'DPD',
  'MWD',
  'PRES',
  'ATMP',
  'WTMP',
] as const;

/** NDBC writes `MM` for a missing value. */
const value = (field: string | undefined): number | null => {
  if (field === undefined || field === 'MM') return null;
  const n = Number(field);
  return Number.isFinite(n) ? n : null;
};

const entities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (text: string) =>
  text.replace(/&(#\d+|[a-z]+);/g, (whole, name: string) =>
    name.startsWith('#') ? String.fromCharCode(Number(name.slice(1))) : (entities[name] ?? whole),
  );

/** Station names by id from NDBC's station table. */
export const parseStationNames = (text: string): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const [id, , , , name] = line.split('|');
    const trimmed = decodeEntities(name?.trim() ?? '');
    if (id && trimmed) names.set(id.trim().toUpperCase(), trimmed);
  }
  return names;
};

/**
 * Parses `latest_obs.txt`: two header lines (names, units), then one
 * whitespace-separated row per station. Rows that don't parse are skipped.
 */
export const parseBuoys = (
  text: string,
  names: ReadonlyMap<string, string>,
): { data: BuoyData; skipped: number } | IngestError => {
  const lines = text.split('\n');
  const header = (lines[0] ?? '').replace(/^#/, '').trim().split(/\s+/);
  const index = Object.fromEntries(REQUIRED.map((name) => [name, header.indexOf(name)])) as Record<
    (typeof REQUIRED)[number],
    number
  >;
  const missing = REQUIRED.filter((name) => index[name] < 0);
  if (missing.length > 0) return new IngestError({ message: `NDBC file is missing ${missing.join(', ')}` });

  const rows: Array<{ readonly time: number; readonly f: string[] }> = [];
  let skipped = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split(/\s+/);
    const time = Date.UTC(
      Number(f[index.YYYY]),
      Number(f[index.MM]) - 1,
      Number(f[index.DD]),
      Number(f[index.hh]),
      Number(f[index.mm]),
    );
    if (
      f.length < header.length ||
      value(f[index.LAT]) === null ||
      value(f[index.LON]) === null ||
      !Number.isFinite(time)
    ) {
      skipped++;
      continue;
    }
    rows.push({ time, f });
  }

  const since = rows.reduce((min, r) => Math.min(min, r.time), Number.POSITIVE_INFINITY);
  const out: Columns<Omit<BuoyData, 'since'>> = {
    station: [],
    name: [],
    lon: [],
    lat: [],
    observed: [],
    windDirection: [],
    windSpeed: [],
    windGust: [],
    waveHeight: [],
    wavePeriod: [],
    waveDirection: [],
    pressure: [],
    airTemperature: [],
    waterTemperature: [],
  };
  for (const { time, f } of rows) {
    const station = (f[index.STN] ?? '').toUpperCase();
    out.station.push(station);
    out.name.push(names.get(station) ?? '');
    out.lat.push(round(value(f[index.LAT]) ?? 0, 4));
    out.lon.push(round(value(f[index.LON]) ?? 0, 4));
    out.observed.push(Math.round((time - since) / 60_000));
    out.windDirection.push(value(f[index.WDIR]));
    out.windSpeed.push(value(f[index.WSPD]));
    out.windGust.push(value(f[index.GST]));
    out.waveHeight.push(value(f[index.WVHT]));
    out.wavePeriod.push(value(f[index.DPD]));
    out.waveDirection.push(value(f[index.MWD]));
    out.pressure.push(value(f[index.PRES]));
    out.airTemperature.push(value(f[index.ATMP]));
    out.waterTemperature.push(value(f[index.WTMP]));
  }
  return { data: { since: Number.isFinite(since) ? since : 0, ...out }, skipped };
};

export const makeBuoySource = (): Source<'buoys'> => ({
  interval: Effect.succeed(feeds.buoys.intervalSeconds),
  read: (validators, previous) =>
    Effect.gen(function* () {
      const response = yield* get(OBS_URL, { validators });
      if (response.status === 304) return notModified;
      const text = yield* okText(response);
      // Names are a nicety: if the table is unavailable, keep the ones published last time.
      const table = yield* get(STATIONS_URL).pipe(Effect.flatMap(okText), Effect.result);
      let names: ReadonlyMap<string, string>;
      if (table._tag === 'Success') names = parseStationNames(table.success);
      else {
        yield* Effect.logWarning('NDBC station table unavailable').pipe(
          Effect.annotateLogs({ error: table.failure.message }),
        );
        const last = yield* previous;
        names = Option.match(last, {
          onNone: () => new Map(),
          onSome: (data) => new Map(data.station.map((id, i) => [id, data.name[i] ?? ''])),
        });
      }
      const parsed = parseBuoys(text, names);
      if (parsed instanceof IngestError) return yield* parsed;
      if (parsed.skipped > 0)
        yield* Effect.logWarning('skipped malformed NDBC rows').pipe(
          Effect.annotateLogs({ skipped: parsed.skipped }),
        );
      return updated<'buoys'>(parsed.data, parsed.data.station.length, response);
    }),
});
