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
  'metars',
  'buoys',
  'airQuality',
  'disasters',
  'tsunamis',
  'weatherAlerts',
  'firePerimeters',
  'volcanoes',
  'aurora',
  'rivers',
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

/** A polygon ring as flat `[lon, lat, lon, lat, …]`, not repeating the first vertex. */
export const Ring = Schema.Array(Schema.Finite);
/** The outer ring first, then any holes. */
export const Polygon = Schema.Array(Ring);
export type Polygon = typeof Polygon.Type;

export const FlightCategory = Schema.Literals(['VFR', 'MVFR', 'IFR', 'LIFR']);
export type FlightCategory = typeof FlightCategory.Type;

/** Surface weather observations from airports (METAR, via the Aviation Weather Center), columnar. */
export const MetarData = Schema.Struct({
  /** Epoch ms that `observed` counts from. */
  since: Schema.Finite,
  /** ICAO station id, e.g. `KSFO`. */
  station: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  /** Minutes after `since` the observation was made. */
  observed: Column(Schema.Int),
  /** °C */
  temperature: NullableNumbers,
  dewpoint: NullableNumbers,
  /** Degrees the wind blows from; null when calm or variable. */
  windDirection: NullableNumbers,
  /** Knots. */
  windSpeed: NullableNumbers,
  windGust: NullableNumbers,
  /** Statute miles as reported: `10+` means 10 or more; empty when not reported. */
  visibility: Column(Schema.String),
  /** Inches of mercury. */
  altimeter: NullableNumbers,
  flightCategory: Column(Schema.NullOr(FlightCategory)),
  /** Present weather, e.g. `-SHSN BR`; empty when none. */
  weather: Column(Schema.String),
  raw: Column(Schema.String),
});
export type MetarData = typeof MetarData.Type;

/** Latest observations from moored buoys and coastal stations (NOAA NDBC), columnar. */
export const BuoyData = Schema.Struct({
  /** Epoch ms that `observed` counts from. */
  since: Schema.Finite,
  station: Column(Schema.String),
  /** The station's name and location, empty when NDBC doesn't list one. */
  name: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  observed: Column(Schema.Int),
  /** Degrees the wind blows from. */
  windDirection: NullableNumbers,
  /** m/s */
  windSpeed: NullableNumbers,
  windGust: NullableNumbers,
  /** Significant wave height, meters. */
  waveHeight: NullableNumbers,
  /** Dominant wave period, seconds. */
  wavePeriod: NullableNumbers,
  /** Degrees the dominant waves come from. */
  waveDirection: NullableNumbers,
  /** Sea-level pressure, hPa. */
  pressure: NullableNumbers,
  /** °C */
  airTemperature: NullableNumbers,
  waterTemperature: NullableNumbers,
});
export type BuoyData = typeof BuoyData.Type;

/** Particulate matter from outdoor low-cost sensors (Sensor.Community), one per location, columnar. */
export const AirQualityData = Schema.Struct({
  /** Epoch ms that `observed` counts from. */
  since: Schema.Finite,
  /** Sensor.Community sensor id. */
  sensor: Column(Schema.Int),
  /** Sensor model, e.g. `SDS011`. */
  model: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  /** Minutes after `since` of the reading (a 5-minute average). */
  observed: Column(Schema.Int),
  /** µg/m³ */
  pm25: Numbers,
  pm10: Numbers,
});
export type AirQualityData = typeof AirQualityData.Type;

/** GDACS event types: earthquake, tropical cyclone, flood, volcano, drought, wildfire. */
export const DisasterType = Schema.Literals(['EQ', 'TC', 'FL', 'VO', 'DR', 'WF']);
export type DisasterType = typeof DisasterType.Type;
export const DisasterAlert = Schema.Literals(['green', 'orange', 'red']);
export type DisasterAlert = typeof DisasterAlert.Type;

export const Disaster = Schema.Struct({
  /** Type and GDACS event id, e.g. `TC1001350`. */
  id: Schema.String,
  type: DisasterType,
  eventId: Schema.Int,
  episodeId: Schema.Int,
  name: Schema.String,
  /** GDACS alert level: the estimated humanitarian impact. */
  alert: DisasterAlert,
  country: Schema.String,
  /** Epoch ms. */
  from: Schema.Finite,
  to: Schema.Finite,
  lon: Schema.Finite,
  lat: Schema.Finite,
  /** GDACS's summary of severity, e.g. "Magnitude 4.8M, Depth:10km". */
  severity: Schema.String,
  /** The GDACS report page. */
  url: Schema.String,
  /** Cyclone track, observed and forecast, as lines of flat `[lon, lat, …]`; empty for other types. */
  track: Schema.Array(Schema.Array(Schema.Finite)),
  /** Cyclone forecast cone, or the affected area of a drought or flood; empty when not fetched. */
  areas: Schema.Array(Polygon),
});
export type Disaster = typeof Disaster.Type;

export const DisasterData = Schema.Struct({ events: Schema.Array(Disaster) });
export type DisasterData = typeof DisasterData.Type;

export const TsunamiBulletin = Schema.Struct({
  id: Schema.String,
  /** The warning center: National (Palmer, Alaska) or Pacific (Honolulu). */
  center: Schema.Literals(['NTWC', 'PTWC']),
  /** Warning, Advisory, Watch, Threat, Information or Cancellation. */
  category: Schema.String,
  /** Where the earthquake was, e.g. "65 miles NE of Kodiak City, Alaska". */
  region: Schema.String,
  /** Epoch ms. */
  issued: Schema.Finite,
  lon: Schema.Finite,
  lat: Schema.Finite,
  /** Preliminary magnitude as reported, e.g. `4.2(Mwp)`. */
  magnitude: Schema.NullOr(Schema.String),
  note: Schema.String,
  /** The bulletin's text. */
  url: Schema.String,
});
export type TsunamiBulletin = typeof TsunamiBulletin.Type;

export const TsunamiData = Schema.Struct({ bulletins: Schema.Array(TsunamiBulletin) });
export type TsunamiData = typeof TsunamiData.Type;

export const AlertSeverity = Schema.Literals(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']);
export type AlertSeverity = typeof AlertSeverity.Type;

/**
 * A National Weather Service alert. The description and instructions aren't
 * stored (they'd make up most of the snapshot); clients fetch them from the
 * alert's NWS URL when it's selected.
 */
export const WeatherAlert = Schema.Struct({
  /** NWS alert id (a URN); `https://api.weather.gov/alerts/<id>` has the full text. */
  id: Schema.String,
  event: Schema.String,
  headline: Schema.NullOr(Schema.String),
  severity: AlertSeverity,
  /** The affected places, as NWS words them. */
  area: Schema.String,
  sender: Schema.String,
  /** Epoch ms. */
  sent: Schema.Finite,
  onset: Schema.NullOr(Schema.Finite),
  expires: Schema.NullOr(Schema.Finite),
  ends: Schema.NullOr(Schema.Finite),
  /** The alert's own outline (storm-based warnings); empty when it covers whole zones. */
  polygons: Schema.Array(Polygon),
  /** Affected zones (keys of `zones`), drawn when the alert has no outline of its own. */
  zones: Schema.Array(Schema.String),
});
export type WeatherAlert = typeof WeatherAlert.Type;

export const WeatherAlertData = Schema.Struct({
  alerts: Schema.Array(WeatherAlert),
  /** Simplified zone outlines by zone id (`forecast/CAZ073`), shared by the alerts that cover them. */
  zones: Schema.Record(Schema.String, Schema.Array(Polygon)),
  /** Zones some alert covers whose outline hasn't been fetched yet; later refreshes fetch them. */
  pendingZones: Schema.Int,
});
export type WeatherAlertData = typeof WeatherAlertData.Type;

/** A US wildland fire's current perimeter (NIFC WFIGS), simplified. */
export const FirePerimeter = Schema.Struct({
  /** IRWIN incident id. */
  id: Schema.String,
  name: Schema.String,
  /** `WF` wildfire, `RX` prescribed fire, `CX` complex. */
  kind: Schema.String,
  /** NWCG unique fire identifier, e.g. `2026-CABDF-000123`. */
  fireId: Schema.String,
  acres: Schema.NullOr(Schema.Finite),
  /** Percent contained. */
  contained: Schema.NullOr(Schema.Finite),
  /** Epoch ms. */
  discovered: Schema.NullOr(Schema.Finite),
  /** When the perimeter was mapped, epoch ms. */
  mapped: Schema.NullOr(Schema.Finite),
  /** E.g. `CA`, empty when unknown. */
  state: Schema.String,
  county: Schema.String,
  cause: Schema.NullOr(Schema.String),
  personnel: Schema.NullOr(Schema.Int),
  /** A point inside or near it, for labels and the camera. */
  lon: Schema.Finite,
  lat: Schema.Finite,
  polygons: Schema.Array(Polygon),
});
export type FirePerimeter = typeof FirePerimeter.Type;

export const FirePerimeterData = Schema.Struct({ fires: Schema.Array(FirePerimeter) });
export type FirePerimeterData = typeof FirePerimeterData.Type;

/** Holocene volcanoes (Smithsonian Global Volcanism Program), columnar. */
export const VolcanoData = Schema.Struct({
  /** GVP volcano number, e.g. `211010`. */
  number: Column(Schema.Int),
  name: Column(Schema.String),
  /** Primary volcano type, e.g. `Stratovolcano`. */
  type: Column(Schema.String),
  country: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  /** Meters above sea level. */
  elevation: NullableNumbers,
  /** Year of the latest known eruption (negative: BCE); null when unknown. */
  lastEruption: Column(Schema.NullOr(Schema.Int)),
  /** Start of an eruption GVP lists as continuing, `YYYY-MM-DD` (day or month may be `00`); empty otherwise. */
  erupting: Column(Schema.String),
  /** GVP gallery photo id, e.g. `GVP-01511`; empty when there's none. */
  photo: Column(Schema.String),
  photoCredit: Column(Schema.String),
});
export type VolcanoData = typeof VolcanoData.Type;

/** NOAA SWPC's OVATION aurora nowcast. */
export const AuroraData = Schema.Struct({
  /** Epoch ms of the solar wind observation it's based on. */
  observed: Schema.Finite,
  /** Epoch ms the forecast is for. */
  forecast: Schema.Finite,
  /**
   * Probability of visible aurora, %, one byte per cell, base64: 360
   * longitudes (0° to 359° E) by 181 latitudes (90° S to 90° N), longitude
   * varying fastest.
   */
  grid: Schema.String,
});
export type AuroraData = typeof AuroraData.Type;

/**
 * How a river gauge reads, most severe first: US flood categories, then
 * `high` (above the usual range: UK typical range, German mean high water),
 * `normal`, `low`, and `unknown` (no thresholds to compare with).
 */
export const GaugeStatus = Schema.Literals([
  'major',
  'moderate',
  'minor',
  'action',
  'high',
  'normal',
  'low',
  'unknown',
]);
export type GaugeStatus = typeof GaugeStatus.Type;
export const GaugeCountry = Schema.Literals(['US', 'GB', 'DE']);
export type GaugeCountry = typeof GaugeCountry.Type;

/** One country's river gauges' latest levels, columnar. */
export const GaugeData = Schema.Struct({
  /** Epoch ms that `observed` counts from. */
  since: Schema.Finite,
  /** The agency's gauge id: NWS location id, EA station (its public page's number when it has one), WSV number. */
  id: Column(Schema.String),
  name: Column(Schema.String),
  river: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  observed: Column(Schema.Int),
  value: Numbers,
  /** `ft` or `kcfs` (US), `m` (UK), `cm` (DE). */
  unit: Column(Schema.String),
  status: Column(GaugeStatus),
  /** Flood stage (US) or top of the typical range (UK), in `unit`; null when there's none. */
  threshold: NullableNumbers,
});
export type GaugeData = typeof GaugeData.Type;

/** A flood warning in force in England (Environment Agency), placed at its area's center. */
export const FloodWarning = Schema.Struct({
  /** Flood area code, e.g. `031WAF213`. */
  id: Schema.String,
  /** 1 severe flood warning, 2 flood warning, 3 flood alert. */
  level: Schema.Int,
  area: Schema.String,
  county: Schema.String,
  message: Schema.String,
  /** Epoch ms the message last changed. */
  changed: Schema.Finite,
  lon: Schema.Finite,
  lat: Schema.Finite,
});
export type FloodWarning = typeof FloodWarning.Type;

/** River gauges by country (US NWPS, UK Environment Agency, German WSV), and England's flood warnings. */
export const RiverData = Schema.Struct({
  /** A country whose source failed keeps its earlier data (and read time). */
  countries: Schema.Array(
    Schema.Struct({
      country: GaugeCountry,
      /** Epoch ms the country's source was read. */
      read: Schema.Finite,
      gauges: GaugeData,
    }),
  ),
  warnings: Schema.Array(FloodWarning),
});
export type RiverData = typeof RiverData.Type;
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
export const MetarSnapshot = snapshot('metars', MetarData);
export type MetarSnapshot = typeof MetarSnapshot.Type;
export const BuoySnapshot = snapshot('buoys', BuoyData);
export type BuoySnapshot = typeof BuoySnapshot.Type;
export const AirQualitySnapshot = snapshot('airQuality', AirQualityData);
export type AirQualitySnapshot = typeof AirQualitySnapshot.Type;
export const DisasterSnapshot = snapshot('disasters', DisasterData);
export type DisasterSnapshot = typeof DisasterSnapshot.Type;
export const TsunamiSnapshot = snapshot('tsunamis', TsunamiData);
export type TsunamiSnapshot = typeof TsunamiSnapshot.Type;
export const WeatherAlertSnapshot = snapshot('weatherAlerts', WeatherAlertData);
export type WeatherAlertSnapshot = typeof WeatherAlertSnapshot.Type;
export const FirePerimeterSnapshot = snapshot('firePerimeters', FirePerimeterData);
export type FirePerimeterSnapshot = typeof FirePerimeterSnapshot.Type;
export const VolcanoSnapshot = snapshot('volcanoes', VolcanoData);
export type VolcanoSnapshot = typeof VolcanoSnapshot.Type;
export const AuroraSnapshot = snapshot('aurora', AuroraData);
export type AuroraSnapshot = typeof AuroraSnapshot.Type;
export const RiverSnapshot = snapshot('rivers', RiverData);
export type RiverSnapshot = typeof RiverSnapshot.Type;
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
  metars: MetarSnapshot,
  buoys: BuoySnapshot,
  airQuality: AirQualitySnapshot,
  disasters: DisasterSnapshot,
  tsunamis: TsunamiSnapshot,
  weatherAlerts: WeatherAlertSnapshot,
  firePerimeters: FirePerimeterSnapshot,
  volcanoes: VolcanoSnapshot,
  aurora: AuroraSnapshot,
  rivers: RiverSnapshot,
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
  metars: MetarData;
  buoys: BuoyData;
  airQuality: AirQualityData;
  disasters: DisasterData;
  tsunamis: TsunamiData;
  weatherAlerts: WeatherAlertData;
  firePerimeters: FirePerimeterData;
  volcanoes: VolcanoData;
  aurora: AuroraData;
  rivers: RiverData;
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

/** Modeled air quality (CAMS, via Open-Meteo). Pollutants in µg/m³; null when not modeled there. */
export const CurrentAirQuality = Schema.Struct({
  /** Local time, ISO 8601 without zone. */
  time: Schema.String,
  /** US EPA Air Quality Index. */
  usAqi: Schema.NullOr(Schema.Finite),
  pm25: Schema.NullOr(Schema.Finite),
  pm10: Schema.NullOr(Schema.Finite),
  ozone: Schema.NullOr(Schema.Finite),
  nitrogenDioxide: Schema.NullOr(Schema.Finite),
});
export type CurrentAirQuality = typeof CurrentAirQuality.Type;

/** Conditions at a point on Earth. */
export const Here = Schema.Struct({
  lat: Schema.Finite,
  lon: Schema.Finite,
  /** Meters above sea level. */
  elevation: Schema.NullOr(Schema.Finite),
  timezone: Schema.NullOr(Schema.String),
  utcOffsetSeconds: Schema.NullOr(Schema.Int),
  weather: Schema.NullOr(CurrentWeather),
  /** Null when the air quality service didn't answer: the rest still stands. */
  airQuality: Schema.NullOr(CurrentAirQuality),
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
