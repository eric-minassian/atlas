/**
 * What each feed is and where it comes from. Shared by the worker (refresh
 * intervals) and the web app (layer names and attribution).
 */
import type { FeedId } from './domain.ts';

export interface Source {
  readonly name: string;
  readonly url: string;
  readonly license: string;
}

export interface FeedInfo {
  readonly title: string;
  readonly source: Source;
  /** How often the worker refreshes it. */
  readonly intervalSeconds: number;
}

export const feeds: { readonly [F in FeedId]: FeedInfo } = {
  satellites: {
    title: 'Satellites',
    source: { name: 'CelesTrak', url: 'https://celestrak.org', license: 'Public GP data' },
    // CelesTrak publishes new elements every two hours and refuses more frequent downloads.
    intervalSeconds: 2 * 60 * 60,
  },
  earthquakes: {
    title: 'Earthquakes',
    source: { name: 'USGS', url: 'https://earthquake.usgs.gov', license: 'Public domain' },
    intervalSeconds: 60,
  },
  fires: {
    title: 'Fire detections',
    source: {
      name: 'NASA FIRMS (VIIRS NOAA-20)',
      url: 'https://firms.modaps.eosdis.nasa.gov',
      license: 'NASA open data',
    },
    intervalSeconds: 30 * 60,
  },
  events: {
    title: 'Natural events',
    source: { name: 'NASA EONET', url: 'https://eonet.gsfc.nasa.gov', license: 'NASA open data' },
    intervalSeconds: 15 * 60,
  },
  radar: {
    title: 'Weather radar',
    source: { name: 'RainViewer', url: 'https://www.rainviewer.com', license: 'RainViewer API terms' },
    intervalSeconds: 5 * 60,
  },
  ships: {
    title: 'Ships',
    source: {
      name: 'aisstream.io and Fintraffic',
      url: 'https://aisstream.io',
      license: 'aisstream.io terms; Fintraffic / digitraffic.fi, CC BY 4.0',
    },
    intervalSeconds: 5 * 60,
  },
  airports: {
    title: 'Airports',
    source: { name: 'OurAirports', url: 'https://ourairports.com', license: 'Public domain' },
    intervalSeconds: 24 * 60 * 60,
  },
  transitFeeds: {
    title: 'Transit feed catalog',
    source: {
      name: 'Mobility Database',
      url: 'https://mobilitydatabase.org',
      license: 'Catalog: CC0; each feed under its provider’s license',
    },
    intervalSeconds: 24 * 60 * 60,
  },
  bikeSystems: {
    title: 'Bike-share systems',
    source: {
      name: 'GBFS (MobilityData systems list)',
      url: 'https://github.com/MobilityData/gbfs',
      license: 'Each system’s GBFS license',
    },
    // Each refresh checks a batch of systems (src/ingest/bike-systems.ts); every one is revisited within hours.
    intervalSeconds: 15 * 60,
  },
  lightning: {
    title: 'Lightning',
    source: {
      name: 'NOAA GOES GLM',
      url: 'https://registry.opendata.aws/noaa-goes/',
      license: 'NOAA open data',
    },
    intervalSeconds: 60,
  },
};

/** Where live transit vehicles come from; each feed's provider is credited with the vehicles. */
export const transitSource: Source = {
  name: 'GTFS-realtime feeds via the Mobility Database',
  url: 'https://mobilitydatabase.org',
  license: 'Each provider’s license',
};

/** Where nearby-aircraft queries go, in order: the next is tried when one fails. */
export const aircraftSources: ReadonlyArray<Source> = [
  { name: 'adsb.fi', url: 'https://adsb.fi', license: 'adsb.fi open data terms (non-commercial)' },
  { name: 'adsb.lol', url: 'https://adsb.lol', license: 'ODbL 1.0' },
];

/** ADS-B emitter categories (DO-260B). */
export const aircraftCategories: Readonly<Record<string, string>> = {
  A1: 'Light',
  A2: 'Small',
  A3: 'Large',
  A4: 'High vortex large',
  A5: 'Heavy',
  A6: 'High performance',
  A7: 'Rotorcraft',
  B1: 'Glider',
  B2: 'Lighter than air',
  B3: 'Parachutist',
  B4: 'Ultralight',
  B6: 'Unmanned',
  B7: 'Space vehicle',
  C1: 'Emergency vehicle',
  C2: 'Service vehicle',
  C3: 'Obstacle',
};
