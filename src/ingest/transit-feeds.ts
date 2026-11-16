import { Effect } from 'effect';
import { feeds } from '../catalog.ts';
import type { TransitFeedData } from '../domain.ts';
import { numberField, readCsv } from './csv.ts';
import { type Columns, get, IngestError, notModified, okText, type Source, updated } from './source.ts';

const CATALOG_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';

const COLUMNS = [
  'id',
  'data_type',
  'entity_type',
  'provider',
  'static_reference',
  'urls.direct_download',
  'urls.authentication_type',
  'urls.latest',
  'location.bounding_box.minimum_latitude',
  'location.bounding_box.maximum_latitude',
  'location.bounding_box.minimum_longitude',
  'location.bounding_box.maximum_longitude',
  'status',
] as const;
type ColumnName = (typeof COLUMNS)[number];

/**
 * Picks the catalog's active GTFS-realtime vehicle-position feeds that need
 * no key, with the area each covers: its own bounding box, or else the one
 * of the static feed it references (the realtime and static feeds of one
 * provider cover the same area). Feeds with neither can't be placed and are
 * left out. Each keeps the Mobility Database's copies of its static feeds,
 * where route names and modes come from.
 */
export const parseTransitFeeds = (csv: string): { data: TransitFeedData; unplaced: number } | IngestError => {
  const table = readCsv(csv, COLUMNS, 'Mobility Database');
  if (table instanceof IngestError) return table;
  const { rows, column } = table;
  const field = (row: ReadonlyArray<string>, name: ColumnName) => (row[column[name]] ?? '').trim();

  const byId = new Map(rows.map((row) => [field(row, 'id'), row]));
  const boundsOf = (row: ReadonlyArray<string>) => {
    const south = numberField(field(row, 'location.bounding_box.minimum_latitude'));
    const north = numberField(field(row, 'location.bounding_box.maximum_latitude'));
    const west = numberField(field(row, 'location.bounding_box.minimum_longitude'));
    const east = numberField(field(row, 'location.bounding_box.maximum_longitude'));
    if (south === undefined || north === undefined || west === undefined || east === undefined)
      return undefined;
    if (south > north || west > east || Math.abs(south) > 90 || Math.abs(north) > 90) return undefined;
    return { west, south, east, north };
  };

  const out: Columns<TransitFeedData> = {
    id: [],
    provider: [],
    url: [],
    west: [],
    south: [],
    east: [],
    north: [],
    schedules: [],
  };
  let unplaced = 0;
  for (const row of rows) {
    if (
      field(row, 'data_type') !== 'gtfs_rt' ||
      !field(row, 'entity_type').split('|').includes('vp') ||
      field(row, 'urls.authentication_type') !== '0' ||
      field(row, 'status') !== 'active' ||
      !/^https?:\/\//.test(field(row, 'urls.direct_download'))
    )
      continue;
    const references = field(row, 'static_reference')
      .split('|')
      .flatMap((id) => {
        const referenced = byId.get(id.trim());
        return referenced ? [referenced] : [];
      });
    const bounds = boundsOf(row) ?? references.map(boundsOf).find((b) => b !== undefined);
    if (!bounds) {
      unplaced++;
      continue;
    }
    out.id.push(field(row, 'id'));
    out.provider.push(field(row, 'provider'));
    out.url.push(field(row, 'urls.direct_download'));
    out.west.push(bounds.west);
    out.south.push(bounds.south);
    out.east.push(bounds.east);
    out.north.push(bounds.north);
    out.schedules.push(
      references.map((r) => field(r, 'urls.latest')).filter((url) => url.startsWith('https://')),
    );
  }
  return { data: out, unplaced };
};

/** The catalog of keyless vehicle-position feeds that `/api/live/transit` draws from, refreshed daily. */
export const makeTransitFeedSource = (): Source<'transitFeeds'> => ({
  interval: Effect.succeed(feeds.transitFeeds.intervalSeconds),
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(CATALOG_URL, { validators });
      if (response.status === 304) return notModified;
      const parsed = parseTransitFeeds(yield* okText(response));
      if (parsed instanceof IngestError) return yield* parsed;
      if (parsed.unplaced > 0)
        yield* Effect.logInfo('transit feeds without an area left out').pipe(
          Effect.annotateLogs({ unplaced: parsed.unplaced }),
        );
      return updated<'transitFeeds'>(parsed.data, parsed.data.id.length, response);
    }),
});
