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
  aircraft: {
    title: 'Aircraft',
    source: {
      name: 'OpenSky Network',
      url: 'https://opensky-network.org',
      license: 'OpenSky Network terms of use (non-commercial)',
    },
    // With API client credentials; see `openSkyInterval` for the anonymous quota.
    intervalSeconds: 90,
  },
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
};

/**
 * OpenSky charges 4 credits per global request. Anonymous clients get 400
 * credits a day (one request every ~15 minutes); API clients get 4,000.
 */
export const openSkyInterval = (authenticated: boolean): number =>
  authenticated ? feeds.aircraft.intervalSeconds : 15 * 60;

/** OpenSky emitter categories (state vector field 17). */
export const aircraftCategories: Readonly<Record<number, string>> = {
  2: 'Light',
  3: 'Small',
  4: 'Large',
  5: 'High vortex large',
  6: 'Heavy',
  7: 'High performance',
  8: 'Rotorcraft',
  9: 'Glider',
  10: 'Lighter than air',
  11: 'Parachutist',
  12: 'Ultralight',
  14: 'Unmanned',
  15: 'Space vehicle',
  16: 'Emergency vehicle',
  17: 'Service vehicle',
  18: 'Obstacle',
  19: 'Cluster obstacle',
  20: 'Line obstacle',
};
