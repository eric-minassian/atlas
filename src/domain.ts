/**
 * Atlas's data, as Effect schemas: the feeds, their snapshots, and the API's
 * other payloads. Shared by the server, the worker and the web app (through
 * `src/api.ts`), so keep it free of server-only imports.
 *
 * Large payloads (aircraft, satellites, fires) are columnar: one array per field,
 * all the same length. That keeps snapshots small on the wire and lets the
 * globe read them without building an object per entity.
 */
import { Schema } from 'effect';

export const feedIds = [
  'satellites',
  'earthquakes',
  'fires',
  'events',
  'radar',
  'ships',
  'airports',
  'transitFeeds',
  'bikeSystems',
  'lightning',
] as const;
export const FeedId = Schema.Literals(feedIds);
export type FeedId = typeof FeedId.Type;

/** Body of the `refresh` queue (`queue<RefreshJob>()` in plat.config.ts). */
export const RefreshJob = Schema.Struct({ feed: FeedId });
export type RefreshJob = typeof RefreshJob.Type;

const Column = <S extends Schema.Top>(item: S) => Schema.Array(item);
const Numbers = Column(Schema.Finite);
const NullableNumbers = Column(Schema.NullOr(Schema.Finite));
const Strings = Column(Schema.String);
const Ints = Column(Schema.Int);
const NullableInts = Column(Schema.NullOr(Schema.Int));

// ---------------------------------------------------------------------------
// Feed payloads
// ---------------------------------------------------------------------------

/** Aircraft positions from ADS-B receiver networks (readsb's JSON, normalized), columnar. */
export const AircraftData = Schema.Struct({
  /** ICAO 24-bit transponder address, hex; `~`-prefixed for addresses that aren't ICAO. */
  icao: Column(Schema.String),
  /** Empty when the aircraft doesn't broadcast one. */
  callsign: Column(Schema.String),
  /** Empty when unknown. */
  registration: Column(Schema.String),
  /** ICAO type designator (`B738`), empty when unknown. */
  type: Column(Schema.String),
  /** ADS-B emitter category (`A3`), empty when unknown. */
  category: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  /** Meters: geometric where reported, else barometric. Null when unknown. */
  altitude: NullableNumbers,
  onGround: Column(Schema.Boolean),
  /** Ground speed, m/s. */
  speed: NullableNumbers,
  /** Degrees clockwise from true north. */
  track: NullableNumbers,
  /** m/s, positive when climbing. */
  verticalRate: NullableNumbers,
  squawk: Column(Schema.NullOr(Schema.String)),
  /** Epoch seconds of the last position fix, for dead reckoning. */
  positionTime: Numbers,
});
export type AircraftData = typeof AircraftData.Type;

/** Aircraft within `radiusNm` of a point, as one receiver network reported them. */
export const AircraftNearby = Schema.Struct({
  lat: Schema.Finite,
  lon: Schema.Finite,
  radiusNm: Schema.Finite,
  /** Epoch ms the network produced the answer. */
  time: Schema.Finite,
  source: Schema.String,
  data: AircraftData,
});
export type AircraftNearby = typeof AircraftNearby.Type;

export const SatelliteGroup = Schema.Literals([
  'station',
  'starlink',
  'oneweb',
  'kuiper',
  'gnss',
  'weather',
  'earth',
  'other',
]);
export type SatelliteGroup = typeof SatelliteGroup.Type;

/**
 * Mean orbital elements (CelesTrak GP data, CCSDS OMM field meanings), columnar.
 * Browsers propagate them with SGP4.
 */
export const SatelliteData = Schema.Struct({
  name: Column(Schema.String),
  noradId: Column(Schema.Int),
  /** International designator, e.g. `1998-067A`. */
  objectId: Column(Schema.String),
  group: Column(SatelliteGroup),
  /** ISO 8601 UTC without a zone suffix, as in OMM. */
  epoch: Column(Schema.String),
  /** Revolutions per day. */
  meanMotion: Numbers,
  eccentricity: Numbers,
  /** Degrees. */
  inclination: Numbers,
  raan: Numbers,
  argOfPericenter: Numbers,
  meanAnomaly: Numbers,
  bstar: Numbers,
  meanMotionDot: Numbers,
  meanMotionDdot: Numbers,
  elementSetNo: Column(Schema.Int),
  revAtEpoch: Column(Schema.Int),
});
export type SatelliteData = typeof SatelliteData.Type;

export const AlertLevel = Schema.Literals(['green', 'yellow', 'orange', 'red']);

export const Earthquake = Schema.Struct({
  id: Schema.String,
  /** Epoch ms. */
  time: Schema.Finite,
  lon: Schema.Finite,
  lat: Schema.Finite,
  /** Kilometers. */
  depth: Schema.Finite,
  magnitude: Schema.NullOr(Schema.Finite),
  magnitudeType: Schema.NullOr(Schema.String),
  place: Schema.NullOr(Schema.String),
  url: Schema.String,
  tsunami: Schema.Boolean,
  /** USGS PAGER alert level. */
  alert: Schema.NullOr(AlertLevel),
  /** "Did you feel it?" reports. */
  felt: Schema.NullOr(Schema.Int),
});
export type Earthquake = typeof Earthquake.Type;

export const EarthquakeData = Schema.Struct({ events: Schema.Array(Earthquake) });
export type EarthquakeData = typeof EarthquakeData.Type;

/** Active fire detections (NASA FIRMS, VIIRS 375 m), columnar. */
export const FireData = Schema.Struct({
  /** Epoch ms that `acquired` counts from. */
  since: Schema.Finite,
  lon: Numbers,
  lat: Numbers,
  /** Minutes after `since` the pixel was observed. */
  acquired: Column(Schema.Int),
  /** Fire radiative power, MW. */
  frp: Numbers,
  /** 0 low, 1 nominal, 2 high. */
  confidence: Column(Schema.Int),
  /** 1 when observed in daylight. */
  day: Column(Schema.Int),
});
export type FireData = typeof FireData.Type;

export const NaturalEvent = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** EONET category id, e.g. `wildfires`, `severeStorms`, `volcanoes`. */
  category: Schema.String,
  /** Epoch ms of the latest observation. */
  time: Schema.Finite,
  lon: Schema.Finite,
  lat: Schema.Finite,
  magnitude: Schema.NullOr(Schema.Struct({ value: Schema.Finite, unit: Schema.String })),
  source: Schema.NullOr(Schema.String),
  /** Earlier positions, oldest first (storm tracks); empty for a single observation. */
  track: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
});
export type NaturalEvent = typeof NaturalEvent.Type;

export const EventData = Schema.Struct({ events: Schema.Array(NaturalEvent) });
export type EventData = typeof EventData.Type;

/** Weather radar composites (RainViewer): tile frames, oldest first. */
export const RadarData = Schema.Struct({
  host: Schema.String,
  frames: Schema.Array(Schema.Struct({ time: Schema.Finite, path: Schema.String })),
});
export type RadarData = typeof RadarData.Type;

/**
 * Vessels from AIS, columnar: each one's latest position report and the static
 * data (name, type, size) it last broadcast. Strings are empty and numbers 0
 * where the vessel hasn't said.
 */
export const ShipData = Schema.Struct({
  /** Epoch seconds that `time` counts from. */
  since: Schema.Finite,
  mmsi: Ints,
  name: Strings,
  callsign: Strings,
  /** IMO number; most small craft have none. */
  imo: Ints,
  /** AIS ship and cargo type, 1–99. */
  shipType: Ints,
  lon: Numbers,
  lat: Numbers,
  /** Speed over ground, knots. */
  speed: NullableNumbers,
  /** Course over ground, degrees clockwise from true north. */
  course: NullableNumbers,
  /** Where the bow points, degrees clockwise from true north. */
  heading: NullableNumbers,
  /** AIS navigational status, 0–15 (15: not defined). */
  status: Ints,
  destination: Strings,
  /** Meters, bow to stern. */
  length: Ints,
  /** Meters, beam. */
  width: Ints,
  /** Seconds after `since` of the latest position report. */
  time: Ints,
});
export type ShipData = typeof ShipData.Type;

export const AirportType = Schema.Literals([
  'large',
  'medium',
  'small',
  'heliport',
  'seaplane',
  'balloonport',
]);
export type AirportType = typeof AirportType.Type;

/** Open airports and their runways (OurAirports), columnar. Codes and links are empty when unknown. */
export const AirportData = Schema.Struct({
  airports: Schema.Struct({
    /** OurAirports identifier: the ICAO code where there is one (`KJFK`), else a local one (`00A`). */
    ident: Strings,
    type: Column(AirportType),
    name: Strings,
    lon: Numbers,
    lat: Numbers,
    /** Feet. */
    elevation: NullableInts,
    /** ISO 3166-1 alpha-2. */
    country: Strings,
    municipality: Strings,
    icao: Strings,
    iata: Strings,
    /** The code national authorities use (FAA LID in the US). */
    local: Strings,
    /** Has scheduled airline service. */
    scheduled: Column(Schema.Boolean),
    website: Strings,
    wikipedia: Strings,
  }),
  runways: Schema.Struct({
    /** Index into `airports`. */
    airport: Ints,
    /** Designators of the two ends (`09L`, `27R`). */
    low: Strings,
    high: Strings,
    /** Feet. */
    length: NullableInts,
    width: NullableInts,
    /** As the source records it (`ASP`, `CON`, `TURF`, …). */
    surface: Strings,
    lighted: Column(Schema.Boolean),
    /** Threshold coordinates; null where they haven't been surveyed. */
    lowLon: NullableNumbers,
    lowLat: NullableNumbers,
    highLon: NullableNumbers,
    highLat: NullableNumbers,
  }),
});
export type AirportData = typeof AirportData.Type;

/**
 * GTFS-realtime vehicle-position feeds that need no key, from the Mobility
 * Database catalog, with the area each serves. Columnar.
 */
export const TransitFeedData = Schema.Struct({
  /** Mobility Database id (`mdb-1602`). */
  id: Strings,
  provider: Strings,
  /** The vehicle positions feed. */
  url: Strings,
  west: Numbers,
  south: Numbers,
  east: Numbers,
  north: Numbers,
  /** The Mobility Database's copies of the provider's static GTFS, for route names and modes. */
  schedules: Column(Schema.Array(Schema.String)),
});
export type TransitFeedData = typeof TransitFeedData.Type;

/**
 * Bike-share systems from the GBFS systems list, located by walking each one's
 * feeds a batch at a time. Columnar; the station fields are empty for systems
 * without stations (free-floating fleets) and ones not reached yet.
 */
export const BikeSystemData = Schema.Struct({
  /** GBFS system id. */
  id: Strings,
  name: Strings,
  /** The operator's site. */
  website: Strings,
  /** Auto-discovery (`gbfs.json`) URL. */
  discovery: Strings,
  /** Epoch seconds of the last check; 0 before the first. */
  checkedAt: Ints,
  /** Stations at the last successful check. */
  stations: Ints,
  /** Bounds of the stations. */
  west: NullableNumbers,
  south: NullableNumbers,
  east: NullableNumbers,
  north: NullableNumbers,
  /** `station_information`, `station_status` and `vehicle_types` feeds; empty when absent. */
  information: Strings,
  status: Strings,
  vehicleTypes: Strings,
});
export type BikeSystemData = typeof BikeSystemData.Type;

/** Lightning flashes seen by the GOES Geostationary Lightning Mappers, columnar. */
export const LightningData = Schema.Struct({
  /** Epoch ms that `time` counts from. */
  since: Schema.Finite,
  /**
   * Per satellite (`G19`), the start of the newest file read, as in its name
   * (`s20263200059200`); the next refresh reads only files after it.
   */
  latest: Schema.Record(Schema.String, Schema.String),
  lon: Numbers,
  lat: Numbers,
  /** Seconds after `since` of the flash's first optical event. */
  time: Numbers,
  /** Total optical energy, femtojoules. */
  energy: Numbers,
  /** Square kilometers lit. */
  area: Numbers,
  /** Which satellite saw it, as named in `latest`. */
  satellite: Strings,
});
export type LightningData = typeof LightningData.Type;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const snapshot = <F extends FeedId, D extends Schema.Top>(feed: F, data: D) =>
  Schema.Struct({
    feed: Schema.Literal(feed),
    version: Schema.String,
    /** Epoch ms the source was read. */
    fetchedAt: Schema.Finite,
    count: Schema.Int,
    data,
  });

export const SatelliteSnapshot = snapshot('satellites', SatelliteData);
export type SatelliteSnapshot = typeof SatelliteSnapshot.Type;
export const EarthquakeSnapshot = snapshot('earthquakes', EarthquakeData);
export type EarthquakeSnapshot = typeof EarthquakeSnapshot.Type;
export const FireSnapshot = snapshot('fires', FireData);
export type FireSnapshot = typeof FireSnapshot.Type;
export const EventSnapshot = snapshot('events', EventData);
export type EventSnapshot = typeof EventSnapshot.Type;
export const RadarSnapshot = snapshot('radar', RadarData);
export type RadarSnapshot = typeof RadarSnapshot.Type;
export const ShipSnapshot = snapshot('ships', ShipData);
export type ShipSnapshot = typeof ShipSnapshot.Type;
export const AirportSnapshot = snapshot('airports', AirportData);
export type AirportSnapshot = typeof AirportSnapshot.Type;
export const TransitFeedSnapshot = snapshot('transitFeeds', TransitFeedData);
export type TransitFeedSnapshot = typeof TransitFeedSnapshot.Type;
export const BikeSystemSnapshot = snapshot('bikeSystems', BikeSystemData);
export type BikeSystemSnapshot = typeof BikeSystemSnapshot.Type;
export const LightningSnapshot = snapshot('lightning', LightningData);
export type LightningSnapshot = typeof LightningSnapshot.Type;

/** Each feed's snapshot schema. */
export const Snapshots = {
  satellites: SatelliteSnapshot,
  earthquakes: EarthquakeSnapshot,
  fires: FireSnapshot,
  events: EventSnapshot,
  radar: RadarSnapshot,
  ships: ShipSnapshot,
  airports: AirportSnapshot,
  transitFeeds: TransitFeedSnapshot,
  bikeSystems: BikeSystemSnapshot,
  lightning: LightningSnapshot,
} satisfies { [F in FeedId]: Schema.Top };

/** Each feed's payload type. */
export interface FeedData {
  satellites: SatelliteData;
  earthquakes: EarthquakeData;
  fires: FireData;
  events: EventData;
  radar: RadarData;
  ships: ShipData;
  airports: AirportData;
  transitFeeds: TransitFeedData;
  bikeSystems: BikeSystemData;
  lightning: LightningData;
}

// ---------------------------------------------------------------------------
// Catalog and point queries
// ---------------------------------------------------------------------------

export const FeedStatus = Schema.Struct({
  id: FeedId,
  /** Current snapshot, or null before the first successful refresh. */
  version: Schema.NullOr(Schema.String),
  fetchedAt: Schema.NullOr(Schema.Finite),
  /** Last time the source was reached, including checks that found nothing new. */
  checkedAt: Schema.NullOr(Schema.Finite),
  count: Schema.NullOr(Schema.Int),
  /** The last attempt's error; null once a refresh succeeds. */
  error: Schema.NullOr(Schema.String),
  intervalSeconds: Schema.Int,
});
export type FeedStatus = typeof FeedStatus.Type;

export const Catalog = Schema.Struct({ feeds: Schema.Array(FeedStatus) });
export type Catalog = typeof Catalog.Type;

export const Latitude = Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 }));
export const Longitude = Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 }));

export const CurrentWeather = Schema.Struct({
  /** Local time of the observation, ISO 8601 without zone. */
  time: Schema.String,
  /** °C */
  temperature: Schema.Finite,
  apparentTemperature: Schema.Finite,
  /** % */
  humidity: Schema.Finite,
  /** mm in the preceding hour */
  precipitation: Schema.Finite,
  /** WMO weather interpretation code. */
  weatherCode: Schema.Int,
  /** % */
  cloudCover: Schema.Finite,
  /** km/h */
  windSpeed: Schema.Finite,
  /** Degrees the wind comes from. */
  windDirection: Schema.Finite,
  windGusts: Schema.Finite,
  /** hPa at sea level */
  pressure: Schema.Finite,
  isDay: Schema.Boolean,
});
export type CurrentWeather = typeof CurrentWeather.Type;

/** Conditions at a point on Earth. */
export const Here = Schema.Struct({
  lat: Schema.Finite,
  lon: Schema.Finite,
  /** Meters above sea level. */
  elevation: Schema.NullOr(Schema.Finite),
  timezone: Schema.NullOr(Schema.String),
  utcOffsetSeconds: Schema.NullOr(Schema.Int),
  weather: Schema.NullOr(CurrentWeather),
});
export type Here = typeof Here.Type;

/** The airports in one map tile, with their runways and every detail the snapshot has. */
export const AirportsInTile = Schema.Struct({
  /** The airports snapshot they were cut from. */
  version: Schema.String,
  data: AirportData,
});
export type AirportsInTile = typeof AirportsInTile.Type;

export const TransitMode = Schema.Literals(['bus', 'tram', 'metro', 'rail', 'ferry', 'cable', 'other']);
export type TransitMode = typeof TransitMode.Type;

/** Transit vehicles in one map tile, from every keyless GTFS-realtime feed covering it. */
export const TransitVehicles = Schema.Struct({
  /** Epoch ms the answer was put together. */
  time: Schema.Finite,
  /** The feeds covering the tile; `feed` indexes into this. `ok` is false for one that didn't answer. */
  feeds: Schema.Array(Schema.Struct({ id: Schema.String, provider: Schema.String, ok: Schema.Boolean })),
  data: Schema.Struct({
    feed: Ints,
    /** The vehicle's id in its feed, or its trip's when the feed gives none. */
    id: Strings,
    /** What the vehicle shows riders (a fleet number, a headsign); empty when not given. */
    label: Strings,
    route: Strings,
    /** The route's public name (`39`, `Red Line`) from the provider's schedule; empty when unknown. */
    routeName: Strings,
    trip: Strings,
    /** From the route's type in the provider's schedule; null when unknown. */
    mode: Column(Schema.NullOr(TransitMode)),
    lon: Numbers,
    lat: Numbers,
    /** Degrees clockwise from true north. */
    bearing: NullableNumbers,
    /** m/s. */
    speed: NullableNumbers,
    /** Epoch seconds of the position. */
    timestamp: NullableNumbers,
  }),
});
export type TransitVehicles = typeof TransitVehicles.Type;

/** Bike-share stations in one map tile, with what they have now. */
export const BikeStations = Schema.Struct({
  /** Epoch ms the answer was put together. */
  time: Schema.Finite,
  /** The systems covering the tile; `system` indexes into this. `ok` is false for one that didn't answer. */
  systems: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, website: Schema.String, ok: Schema.Boolean }),
  ),
  data: Schema.Struct({
    system: Ints,
    id: Strings,
    name: Strings,
    lon: Numbers,
    lat: Numbers,
    /** Bikes ready to rent, electric ones included. */
    bikes: Ints,
    /** Electric bikes among `bikes`; null when the system doesn't break them out. */
    ebikes: NullableInts,
    /** Free docks; null at stations without them. */
    docks: NullableInts,
    capacity: NullableInts,
    /** Whether the station is renting bikes out and taking them back. */
    renting: Column(Schema.Boolean),
    returning: Column(Schema.Boolean),
    /** Epoch seconds of the station's last report. */
    reported: NullableNumbers,
  }),
});
export type BikeStations = typeof BikeStations.Type;

/**
 * What the browser needs to know about this deployment: the keys of services
 * it calls directly (each restricted to Atlas's domains at the provider), and
 * which keyed server-side sources are configured. Null or false means not set
 * up, and the layers that need it stay out of the panel.
 */
export const ClientConfig = Schema.Struct({
  keys: Schema.Struct({
    /** Cesium ion: terrain, OSM buildings, Google Photorealistic 3D Tiles. */
    cesiumIon: Schema.NullOr(Schema.String),
    /** ArcGIS Location Platform: high-resolution imagery. */
    arcgis: Schema.NullOr(Schema.String),
    /** Mapillary client token: street-level imagery. */
    mapillary: Schema.NullOr(Schema.String),
  }),
  sources: Schema.Struct({
    /** aisstream.io: ships worldwide (without it, only the Baltic). */
    aisstream: Schema.Boolean,
    /** Windy: webcams worldwide. */
    windy: Schema.Boolean,
  }),
});
export type ClientConfig = typeof ClientConfig.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The feed has no snapshot yet: its first refresh hasn't succeeded. A 404, not
 * a 503: it's expected right after a stage is created, and the platform
 * records every 5xx as an error.
 */
export class FeedNotReady extends Schema.TaggedError<FeedNotReady, { readonly brand: unique symbol }>()(
  'FeedNotReady',
  { feed: FeedId },
  { httpApiStatus: 404 },
) {}

/** A source the request depends on didn't answer. */
export class UpstreamUnavailable extends Schema.TaggedError<
  UpstreamUnavailable,
  { readonly brand: unique symbol }
>()('UpstreamUnavailable', { source: Schema.String }, { httpApiStatus: 502 }) {}

/** A map tile outside its tiling scheme. */
export class TileOutOfRange extends Schema.TaggedError<TileOutOfRange, { readonly brand: unique symbol }>()(
  'TileOutOfRange',
  { z: Schema.Int, x: Schema.Int, y: Schema.Int },
  { httpApiStatus: 404 },
) {}
