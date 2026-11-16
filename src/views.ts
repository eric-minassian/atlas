import type { AirportData, FeedData, FeedId } from './domain.ts';
import type { Columns } from './ingest/source.ts';

/** A cut of a snapshot, published beside it for browsers. */
export interface View<D> {
  readonly data: D;
  readonly count: number;
}

const emptyRunways = (): Columns<AirportData['runways']> => ({
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
});

const emptyAirports = (): Columns<AirportData['airports']> => ({
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
});

/** The airports at `indices`, with their runways (re-pointed at the new positions). */
export const sliceAirports = (
  data: AirportData,
  indices: ReadonlyArray<number>,
  withRunways: boolean,
): AirportData => {
  const airports = emptyAirports();
  const runways = emptyRunways();
  const at = new Map<number, number>();
  const keys = Object.keys(airports) as Array<keyof AirportData['airports']>;
  for (const i of indices) {
    at.set(i, airports.ident.length);
    for (const key of keys) (airports[key] as unknown[]).push(data.airports[key][i]);
  }
  if (withRunways) {
    const runwayKeys = Object.keys(runways) as Array<keyof AirportData['runways']>;
    for (let r = 0; r < data.runways.airport.length; r++) {
      const airport = at.get(data.runways.airport[r] as number);
      if (airport === undefined) continue;
      for (const key of runwayKeys)
        (runways[key] as unknown[]).push(key === 'airport' ? airport : data.runways[key][r]);
    }
  }
  return { airports, runways };
};

/**
 * The large and medium airports worldwide (~5,300 of ~73,000) with what drawing
 * and search need, about 190 KB compressed. Runways and links describe one
 * airport, so they come with its tile (`/api/live/airports/8/x/y`).
 */
export const majorAirports = (data: AirportData): View<AirportData> => {
  const major: number[] = [];
  for (let i = 0; i < data.airports.ident.length; i++) {
    const type = data.airports.type[i];
    if (type === 'large' || type === 'medium') major.push(i);
  }
  const sliced = sliceAirports(data, major, false);
  const blank = sliced.airports.ident.map(() => '');
  return {
    data: { ...sliced, airports: { ...sliced.airports, website: blank, wikipedia: blank } },
    count: major.length,
  };
};

/** How each feed with a `browserView` (src/catalog.ts) cuts its snapshot. */
export const views: { readonly [F in FeedId]?: (data: FeedData[F]) => View<FeedData[F]> } = {
  airports: majorAirports,
};
