import { Effect } from 'effect';
import { feeds } from '../catalog.ts';
import type { AirportData, AirportType } from '../domain.ts';
import { numberField, readCsv } from './csv.ts';
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

const BASE_URL = 'https://davidmegginson.github.io/ourairports-data';

const TYPES: Readonly<Record<string, AirportType>> = {
  large_airport: 'large',
  medium_airport: 'medium',
  small_airport: 'small',
  heliport: 'heliport',
  seaplane_base: 'seaplane',
  balloonport: 'balloonport',
};

const AIRPORT_COLUMNS = [
  'id',
  'ident',
  'type',
  'name',
  'latitude_deg',
  'longitude_deg',
  'elevation_ft',
  'iso_country',
  'municipality',
  'scheduled_service',
  'icao_code',
  'iata_code',
  'local_code',
  'home_link',
  'wikipedia_link',
] as const;

const RUNWAY_COLUMNS = [
  'airport_ref',
  'length_ft',
  'width_ft',
  'surface',
  'lighted',
  'closed',
  'le_ident',
  'le_latitude_deg',
  'le_longitude_deg',
  'he_ident',
  'he_latitude_deg',
  'he_longitude_deg',
] as const;

const int = (value: string | undefined): number | null => {
  const n = numberField(value);
  return n === undefined ? null : Math.round(n);
};
const coordinate = (value: string | undefined): number | null => {
  const n = numberField(value);
  return n === undefined ? null : round(n, 5);
};

/**
 * Parses OurAirports' airports and runways, keeping open airports and their
 * open runways. Rows that don't parse are skipped and counted.
 */
export const parseAirports = (
  airportsCsv: string,
  runwaysCsv: string,
): { data: AirportData; skipped: number } | IngestError => {
  const airports = readCsv(airportsCsv, AIRPORT_COLUMNS, 'OurAirports airports');
  if (airports instanceof IngestError) return airports;
  const runways = readCsv(runwaysCsv, RUNWAY_COLUMNS, 'OurAirports runways');
  if (runways instanceof IngestError) return runways;

  const a: Columns<AirportData['airports']> = {
    ident: [],
    type: [],
    name: [],
    lon: [],
    lat: [],
    elevation: [],
    country: [],
    municipality: [],
    icao: [],
    iata: [],
    local: [],
    scheduled: [],
    website: [],
    wikipedia: [],
  };
  const indexById = new Map<string, number>();
  let skipped = 0;
  const c = airports.column;
  for (const row of airports.rows) {
    const field = (name: (typeof AIRPORT_COLUMNS)[number]) => (row[c[name]] ?? '').trim();
    const rawType = field('type');
    if (rawType === 'closed') continue;
    const type = TYPES[rawType];
    const lat = numberField(field('latitude_deg'));
    const lon = numberField(field('longitude_deg'));
    if (!type || lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      skipped++;
      continue;
    }
    indexById.set(field('id'), a.ident.length);
    a.ident.push(field('ident'));
    a.type.push(type);
    a.name.push(field('name'));
    a.lon.push(round(lon, 5));
    a.lat.push(round(lat, 5));
    a.elevation.push(int(field('elevation_ft')));
    a.country.push(field('iso_country'));
    a.municipality.push(field('municipality'));
    a.icao.push(field('icao_code'));
    a.iata.push(field('iata_code'));
    a.local.push(field('local_code'));
    a.scheduled.push(field('scheduled_service') === 'yes');
    a.website.push(field('home_link'));
    a.wikipedia.push(field('wikipedia_link'));
  }

  const r: Columns<AirportData['runways']> = {
    airport: [],
    low: [],
    high: [],
    length: [],
    width: [],
    surface: [],
    lighted: [],
    lowLon: [],
    lowLat: [],
    highLon: [],
    highLat: [],
  };
  const rc = runways.column;
  for (const row of runways.rows) {
    const field = (name: (typeof RUNWAY_COLUMNS)[number]) => (row[rc[name]] ?? '').trim();
    if (field('closed') === '1') continue;
    // Runways of closed airports (and of rows skipped above) have nowhere to go.
    const airport = indexById.get(field('airport_ref'));
    if (airport === undefined) continue;
    r.airport.push(airport);
    r.low.push(field('le_ident'));
    r.high.push(field('he_ident'));
    r.length.push(int(field('length_ft')));
    r.width.push(int(field('width_ft')));
    r.surface.push(field('surface'));
    r.lighted.push(field('lighted') === '1');
    r.lowLon.push(coordinate(field('le_longitude_deg')));
    r.lowLat.push(coordinate(field('le_latitude_deg')));
    r.highLon.push(coordinate(field('he_longitude_deg')));
    r.highLat.push(coordinate(field('he_latitude_deg')));
  }
  return { data: { airports: a, runways: r }, skipped };
};

/**
 * Every open airport, heliport and seaplane base, refreshed daily. OurAirports
 * regenerates both files together each night, so an unchanged airports file
 * (304) stands for both.
 */
export const makeAirportSource = (): Source<'airports'> => ({
  interval: Effect.succeed(feeds.airports.intervalSeconds),
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(`${BASE_URL}/airports.csv`, { validators });
      if (response.status === 304) return notModified;
      const airports = yield* okText(response);
      const runways = yield* get(`${BASE_URL}/runways.csv`).pipe(Effect.flatMap(okText));
      const parsed = parseAirports(airports, runways);
      if (parsed instanceof IngestError) return yield* parsed;
      if (parsed.skipped > 0)
        yield* Effect.logWarning('skipped malformed airport rows').pipe(
          Effect.annotateLogs({ skipped: parsed.skipped }),
        );
      return updated<'airports'>(parsed.data, parsed.data.airports.ident.length, response);
    }),
});
