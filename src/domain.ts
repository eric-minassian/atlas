/**
 * Atlas's data, as Effect schemas: the feeds, their snapshots, and the API's
 * other payloads. Shared by the server, the worker and the web app (through
 * `src/api.ts`), so keep it free of server-only imports.
 *
 * Large feeds (aircraft, satellites, fires) are columnar: one array per field,
 * all the same length. That keeps snapshots small on the wire and lets the
 * globe read them without building an object per entity.
 */
import { Schema } from 'effect';

export const feedIds = ['aircraft', 'satellites', 'earthquakes', 'fires', 'events', 'radar'] as const;
export const FeedId = Schema.Literals(feedIds);
export type FeedId = typeof FeedId.Type;

/** Body of the `refresh` queue (`queue<RefreshJob>()` in plat.config.ts). */
export const RefreshJob = Schema.Struct({ feed: FeedId });
export type RefreshJob = typeof RefreshJob.Type;

const Column = <S extends Schema.Top>(item: S) => Schema.Array(item);
const Numbers = Column(Schema.Finite);
const NullableNumbers = Column(Schema.NullOr(Schema.Finite));

// ---------------------------------------------------------------------------
// Feed payloads
// ---------------------------------------------------------------------------

/** Aircraft state vectors (OpenSky Network), columnar. */
export const AircraftData = Schema.Struct({
  /** Epoch seconds the positions are reported for. */
  time: Schema.Finite,
  /** ICAO 24-bit transponder address, hex. */
  icao: Column(Schema.String),
  /** Empty when the aircraft doesn't broadcast one. */
  callsign: Column(Schema.String),
  /** Country of registration, inferred from the ICAO address. */
  country: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  /** Meters above the WGS84 ellipsoid where reported, else barometric altitude. */
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
  /** OpenSky emitter category, 0 when unknown (see `aircraftCategories` in src/catalog.ts). */
  category: Column(Schema.Int),
});
export type AircraftData = typeof AircraftData.Type;

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

export const AircraftSnapshot = snapshot('aircraft', AircraftData);
export type AircraftSnapshot = typeof AircraftSnapshot.Type;
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

/** Each feed's snapshot schema. */
export const Snapshots = {
  aircraft: AircraftSnapshot,
  satellites: SatelliteSnapshot,
  earthquakes: EarthquakeSnapshot,
  fires: FireSnapshot,
  events: EventSnapshot,
  radar: RadarSnapshot,
} satisfies { [F in FeedId]: Schema.Top };

/** Each feed's payload type. */
export interface FeedData {
  aircraft: AircraftData;
  satellites: SatelliteData;
  earthquakes: EarthquakeData;
  fires: FireData;
  events: EventData;
  radar: RadarData;
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
