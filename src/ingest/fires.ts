import { Effect } from 'effect';
import { feeds } from '../catalog.ts';
import type { FireData } from '../domain.ts';
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

/** VIIRS (NOAA-20) active fire detections, worldwide, past 24 hours. No key needed for this file. */
const CSV_URL =
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv';

const REQUIRED = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp', 'daynight'] as const;
const CONFIDENCE: Readonly<Record<string, number>> = { l: 0, low: 0, n: 1, nominal: 1, h: 2, high: 2 };

/**
 * Parses FIRMS' CSV (unquoted, one detection per line). This is the hot path
 * of the largest feed (~90k rows), so it validates each field directly rather
 * than decoding row objects; rows that don't parse are skipped and counted.
 */
export const parseFires = (csv: string): { data: FireData; skipped: number } | IngestError => {
  const lines = csv.split('\n');
  const header = (lines[0] ?? '').trim().split(',');
  const index = Object.fromEntries(REQUIRED.map((name) => [name, header.indexOf(name)])) as Record<
    (typeof REQUIRED)[number],
    number
  >;
  const missing = REQUIRED.filter((name) => index[name] < 0);
  if (missing.length > 0) return new IngestError({ message: `FIRMS CSV is missing ${missing.join(', ')}` });

  const times: number[] = [];
  const out: Columns<Omit<FireData, 'since'>> = {
    lon: [],
    lat: [],
    acquired: [],
    frp: [],
    confidence: [],
    day: [],
  };
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const f = line.split(',');
    const lat = Number(f[index.latitude]);
    const lon = Number(f[index.longitude]);
    const frp = Number(f[index.frp]);
    const time = Date.parse(`${f[index.acq_date]}T${hhmm(f[index.acq_time])}:00Z`);
    const confidence = CONFIDENCE[f[index.confidence] ?? ''];
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(frp) ||
      !Number.isFinite(time) ||
      confidence === undefined
    ) {
      skipped++;
      continue;
    }
    times.push(time);
    out.lat.push(round(lat, 4));
    out.lon.push(round(lon, 4));
    out.frp.push(round(frp, 1));
    out.confidence.push(confidence);
    out.day.push(f[index.daynight] === 'D' ? 1 : 0);
  }
  const since = times.reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY);
  out.acquired = times.map((t) => Math.round((t - since) / 60_000));
  return { data: { since: Number.isFinite(since) ? since : 0, ...out }, skipped };
};

/** `47` → `00:47`, `1305` → `13:05`. */
const hhmm = (value: string | undefined): string => {
  const v = (value ?? '').padStart(4, '0');
  return `${v.slice(0, 2)}:${v.slice(2, 4)}`;
};

export const makeFireSource = (): Source<'fires'> => ({
  interval: Effect.succeed(feeds.fires.intervalSeconds),
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(CSV_URL, { validators });
      if (response.status === 304) return notModified;
      const parsed = parseFires(yield* okText(response));
      if (parsed instanceof IngestError) return yield* parsed;
      if (parsed.skipped > 0)
        yield* Effect.logWarning('skipped malformed fire rows').pipe(
          Effect.annotateLogs({ skipped: parsed.skipped }),
        );
      return updated<'fires'>(parsed.data, parsed.data.lat.length, response);
    }),
});
