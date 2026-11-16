import { Effect } from 'effect';
import type { HttpClientResponse } from 'effect/http';
import { feeds } from '../catalog.ts';
import { FlightCategory, type MetarData } from '../domain.ts';
import { type Columns, get, IngestError, notModified, round, type Source, updated } from './source.ts';

/** The latest METAR from every reporting station (~5,000), regenerated every minute. Gzipped CSV. */
const CSV_URL = 'https://aviationweather.gov/data/cache/metars.cache.csv.gz';

const REQUIRED = [
  'raw_text',
  'station_id',
  'observation_time',
  'latitude',
  'longitude',
  'temp_c',
  'dewpoint_c',
  'wind_dir_degrees',
  'wind_speed_kt',
  'wind_gust_kt',
  'visibility_statute_mi',
  'altim_in_hg',
  'wx_string',
  'flight_category',
] as const;

const isFlightCategory = (value: string): value is FlightCategory =>
  (FlightCategory.literals as ReadonlyArray<string>).includes(value);

/** Splits a CSV line. Fields may be quoted (the raw reports are), with `""` for a quote inside. */
export const splitCsv = (line: string): string[] => {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else value += line[i++];
      }
      fields.push(value);
      i++; // the comma
    } else {
      const comma = line.indexOf(',', i);
      const end = comma < 0 ? line.length : comma;
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
};

/** A number, or null for an empty field (the CSV leaves unreported values empty). */
const numberOrNull = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parses the AWC's METAR cache CSV. Rows without a position or observation
 * time are skipped and counted; a station reported twice keeps its latest.
 */
export const parseMetars = (csv: string): { data: MetarData; skipped: number } | IngestError => {
  const lines = csv.split('\n');
  const header = splitCsv((lines[0] ?? '').trim());
  // Some names repeat (four sky-cover layers); the first of each is the one wanted.
  const index = Object.fromEntries(REQUIRED.map((name) => [name, header.indexOf(name)])) as Record<
    (typeof REQUIRED)[number],
    number
  >;
  const missing = REQUIRED.filter((name) => index[name] < 0);
  if (missing.length > 0) return new IngestError({ message: `METAR CSV is missing ${missing.join(', ')}` });

  const rows: Array<{ readonly time: number; readonly f: string[] }> = [];
  const byStation = new Map<string, number>();
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const f = splitCsv(line);
    const station = f[index.station_id] ?? '';
    const lat = numberOrNull(f[index.latitude]);
    const lon = numberOrNull(f[index.longitude]);
    const time = Date.parse(f[index.observation_time] ?? '');
    if (!station || lat === null || lon === null || !Number.isFinite(time)) {
      skipped++;
      continue;
    }
    const seen = byStation.get(station);
    if (seen !== undefined) {
      if ((rows[seen] as (typeof rows)[number]).time >= time) continue;
      rows[seen] = { time, f };
    } else {
      byStation.set(station, rows.length);
      rows.push({ time, f });
    }
  }

  const since = rows.reduce((min, r) => Math.min(min, r.time), Number.POSITIVE_INFINITY);
  const out: Columns<Omit<MetarData, 'since'>> = {
    station: [],
    lon: [],
    lat: [],
    observed: [],
    temperature: [],
    dewpoint: [],
    windDirection: [],
    windSpeed: [],
    windGust: [],
    visibility: [],
    altimeter: [],
    flightCategory: [],
    weather: [],
    raw: [],
  };
  for (const { time, f } of rows) {
    const speed = numberOrNull(f[index.wind_speed_kt]);
    // METARs give north as 360°, so 0 means no direction: calm, or variable (`VRB`, which the CSV writes as 0).
    const reported = numberOrNull(f[index.wind_dir_degrees]);
    const direction = speed === 0 || reported === 0 ? null : reported;
    const temperature = numberOrNull(f[index.temp_c]);
    const dewpoint = numberOrNull(f[index.dewpoint_c]);
    const altimeter = numberOrNull(f[index.altim_in_hg]);
    const category = f[index.flight_category] ?? '';
    out.station.push(f[index.station_id] ?? '');
    out.lat.push(round(numberOrNull(f[index.latitude]) ?? 0, 4));
    out.lon.push(round(numberOrNull(f[index.longitude]) ?? 0, 4));
    out.observed.push(Math.round((time - since) / 60_000));
    out.temperature.push(temperature === null ? null : round(temperature, 1));
    out.dewpoint.push(dewpoint === null ? null : round(dewpoint, 1));
    out.windDirection.push(direction);
    out.windSpeed.push(speed);
    out.windGust.push(numberOrNull(f[index.wind_gust_kt]));
    out.visibility.push((f[index.visibility_statute_mi] ?? '').trim());
    out.altimeter.push(altimeter === null ? null : round(altimeter, 2));
    out.flightCategory.push(isFlightCategory(category) ? category : null);
    out.weather.push((f[index.wx_string] ?? '').trim());
    out.raw.push((f[index.raw_text] ?? '').trim());
  }
  return { data: { since: Number.isFinite(since) ? since : 0, ...out }, skipped };
};

/**
 * The body as text. AWC serves the `.gz` file as is (no `Content-Encoding`),
 * so it's gunzipped here; a body that isn't gzip is read as plain text.
 */
const gunzipText = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => new IngestError({ message: `reading the response: ${cause.message}` })),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* new IngestError({ message: `HTTP ${response.status}` });
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
    return yield* Effect.tryPromise({
      try: () => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text(),
      catch: (cause) => new IngestError({ message: `gunzipping the METAR file: ${String(cause)}` }),
    });
  });

export const makeMetarSource = (): Source<'metars'> => ({
  interval: Effect.succeed(feeds.metars.intervalSeconds),
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(CSV_URL, { validators });
      if (response.status === 304) return notModified;
      const parsed = parseMetars(yield* gunzipText(response));
      if (parsed instanceof IngestError) return yield* parsed;
      if (parsed.skipped > 0)
        yield* Effect.logWarning('skipped METAR rows without a position or time').pipe(
          Effect.annotateLogs({ skipped: parsed.skipped }),
        );
      return updated<'metars'>(parsed.data, parsed.data.station.length, response);
    }),
});
