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
  metars: {
    title: 'Weather stations',
    source: {
      name: 'NOAA Aviation Weather Center',
      url: 'https://aviationweather.gov',
      license: 'Public domain',
    },
    intervalSeconds: 5 * 60,
  },
  buoys: {
    title: 'Ocean buoys',
    source: { name: 'NOAA NDBC', url: 'https://www.ndbc.noaa.gov', license: 'Public domain' },
    intervalSeconds: 10 * 60,
  },
  airQuality: {
    title: 'Air quality sensors',
    source: {
      name: 'Sensor.Community',
      url: 'https://sensor.community',
      license: 'Database Contents License (DbCL) 1.0 under ODbL',
    },
    intervalSeconds: 5 * 60,
  },
  disasters: {
    title: 'Disaster alerts',
    source: {
      name: 'GDACS',
      url: 'https://www.gdacs.org',
      license: 'GDACS terms of use (EC JRC and UN OCHA), attribution required',
    },
    intervalSeconds: 10 * 60,
  },
  tsunamis: {
    title: 'Tsunami bulletins',
    source: {
      name: 'NOAA Tsunami Warning Centers',
      url: 'https://www.tsunami.gov',
      license: 'Public domain',
    },
    intervalSeconds: 2 * 60,
  },
  weatherAlerts: {
    title: 'US weather alerts',
    source: { name: 'National Weather Service', url: 'https://www.weather.gov', license: 'Public domain' },
    intervalSeconds: 2 * 60,
  },
  firePerimeters: {
    title: 'Wildfire perimeters',
    source: {
      name: 'NIFC WFIGS',
      url: 'https://data-nifc.opendata.arcgis.com',
      license: 'Public domain',
    },
    intervalSeconds: 15 * 60,
  },
  volcanoes: {
    title: 'Volcanoes',
    source: {
      name: 'Smithsonian Global Volcanism Program',
      url: 'https://volcano.si.edu',
      license: 'Smithsonian terms of use, attribution required',
    },
    intervalSeconds: 24 * 60 * 60,
  },
  aurora: {
    title: 'Aurora forecast',
    source: {
      name: 'NOAA Space Weather Prediction Center',
      url: 'https://www.swpc.noaa.gov',
      license: 'Public domain',
    },
    intervalSeconds: 5 * 60,
  },
  rivers: {
    title: 'River gauges',
    source: {
      name: 'NOAA NWPS, Environment Agency, WSV Pegelonline',
      url: 'https://water.noaa.gov',
      license: 'Public domain (US), Open Government Licence (UK), DL-DE Zero 2.0 (DE)',
    },
    intervalSeconds: 15 * 60,
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
  cameras: {
    title: 'Traffic cameras',
    source: {
      name: 'Transport agencies',
      url: 'https://github.com/AidanWelch/OpenTrafficCamMap',
      license: "Each operator's open data terms; OpenTrafficCamMap (MIT)",
    },
    // Camera lists change over weeks; the frames themselves are loaded live from each operator.
    intervalSeconds: 60 * 60,
  },
};

/**
 * The Web Mercator zoom each area lookup is served at (`/api/live/<source>/:z/:x/:y`):
 * about 150 km tiles for airports, 40 km for transit, 20 km for bike-share stations.
 */
export const areaZooms = { airports: 8, transit: 10, bikes: 11 } as const;

/** Where live transit vehicles come from; each feed's provider is credited with the vehicles. */
export const transitSource: Source = {
  name: 'GTFS-realtime feeds via the Mobility Database',
  url: 'https://mobilitydatabase.org',
  license: 'Each provider’s license',
};

/** NIFC's current wildfire perimeters (ArcGIS feature layer); records link to their page on it. */
export const wfigsPerimeters =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0';

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

/** A source looked up by area (`/api/live/<source>/:z/:x/:y`), served at one tile zoom. */
export interface AreaSource {
  readonly source: Source;
  readonly zoom: number;
}

/** Webcams worldwide from Windy, when this deployment has a key. */
export const webcamSource: AreaSource = {
  source: { name: 'Windy', url: 'https://www.windy.com/webcams', license: 'Windy Webcams API terms' },
  // Tiles ~150 km across (less toward the poles): a city and its surroundings in one request.
  zoom: 8,
};

/** Recent wildlife observations with photos from iNaturalist. */
export const wildlifeSource: AreaSource = {
  source: {
    name: 'iNaturalist',
    url: 'https://www.inaturalist.org',
    license: 'Photos under their observers’ Creative Commons licenses',
  },
  // Tiles ~20 km across: a dense city still gets a useful sample of its latest sightings.
  zoom: 11,
};
