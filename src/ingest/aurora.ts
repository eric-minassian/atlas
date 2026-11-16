import { Effect, Schema } from 'effect';
import type { AuroraData } from '../domain.ts';
import { decodeJson, get, IngestError, notModified, okText, type Source, updated } from './source.ts';

/** OVATION's 30-90 minute aurora forecast on a 1° grid, every 5 minutes. */
const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
/** The snapshot's count: cells where aurora is likely enough to look for (SWPC's maps start their scale here). */
const LIKELY = 10;

export const WIDTH = 360;
export const HEIGHT = 181;

export const Ovation = Schema.Struct({
  'Observation Time': Schema.String,
  'Forecast Time': Schema.String,
  coordinates: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])),
});
type Ovation = typeof Ovation.Type;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  // In chunks: spreading 65,000 arguments at once overflows the call stack.
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

/**
 * Packs the `[lon, lat, probability]` triples into one byte per cell (see
 * `AuroraData.grid`): ~90 KB of base64 instead of ~900 KB of JSON, and mostly
 * zeros, which compress to almost nothing on the wire.
 */
export const parseOvation = (ovation: Ovation): AuroraData | IngestError => {
  const observed = Date.parse(ovation['Observation Time']);
  const forecast = Date.parse(ovation['Forecast Time']);
  if (!Number.isFinite(observed) || !Number.isFinite(forecast))
    return new IngestError({ message: 'OVATION times did not parse' });
  const grid = new Uint8Array(WIDTH * HEIGHT);
  let cells = 0;
  for (const [lon, lat, probability] of ovation.coordinates) {
    const x = Math.round(lon);
    const y = Math.round(lat) + 90;
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
    grid[y * WIDTH + x] = Math.max(0, Math.min(100, Math.round(probability)));
    cells++;
  }
  if (cells < WIDTH * HEIGHT * 0.9)
    return new IngestError({ message: `OVATION grid has ${cells} of ${WIDTH * HEIGHT} cells` });
  return { observed, forecast, grid: toBase64(grid) };
};

const likelyCells = (grid: string): number => {
  const binary = atob(grid);
  let n = 0;
  for (let i = 0; i < binary.length; i++) if (binary.charCodeAt(i) >= LIKELY) n++;
  return n;
};

export const makeAuroraSource = (): Source<'aurora'> => ({
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(OVATION_URL, { validators });
      if (response.status === 304) return notModified;
      const data = parseOvation(yield* decodeJson(Ovation)(yield* okText(response)));
      if (data instanceof IngestError) return yield* data;
      return updated<'aurora'>(data, likelyCells(data.grid), response);
    }),
});
