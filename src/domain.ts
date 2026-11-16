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

export const feedIds = ['satellites', 'earthquakes', 'fires', 'events', 'radar', 'cameras'] as const;
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

/** Who runs a set of traffic cameras: credited with each, and linked for their own camera map. */
export const CameraOperator = Schema.Struct({
  name: Schema.String,
  /** The operator's traffic or camera map. */
  url: Schema.String,
  /** Shown with each frame: the operator's required attribution, or where the list came from. */
  credit: Schema.String,
});
export type CameraOperator = typeof CameraOperator.Type;

/** Traffic cameras that publish a still frame, columnar. */
export const CameraData = Schema.Struct({
  operators: Schema.Array(CameraOperator),
  /** `<operator>-<its id>`, stable across refreshes; the image relay is keyed by it. */
  id: Column(Schema.String),
  name: Column(Schema.String),
  lon: Numbers,
  lat: Numbers,
  /** Index into `operators`. */
  operator: Column(Schema.Int),
  /** Which way the camera looks ("West", "S"), empty when unknown. */
  view: Column(Schema.String),
  /** Where the operator publishes the latest frame (JPEG or PNG). */
  image: Column(Schema.String),
  /** The frame is only served over plain HTTP: browsers load it through the API's camera relay. */
  relayed: Column(Schema.Boolean),
});
export type CameraData = typeof CameraData.Type;

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
export const CameraSnapshot = snapshot('cameras', CameraData);
export type CameraSnapshot = typeof CameraSnapshot.Type;

/** Each feed's snapshot schema. */
export const Snapshots = {
  satellites: SatelliteSnapshot,
  earthquakes: EarthquakeSnapshot,
  fires: FireSnapshot,
  events: EventSnapshot,
  radar: RadarSnapshot,
  cameras: CameraSnapshot,
} satisfies { [F in FeedId]: Schema.Top };

/** Each feed's payload type. */
export interface FeedData {
  satellites: SatelliteData;
  earthquakes: EarthquakeData;
  fires: FireData;
  events: EventData;
  radar: RadarData;
  cameras: CameraData;
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
// Area lookups: webcams and wildlife
// ---------------------------------------------------------------------------

/** A public webcam listed by Windy. */
export const Webcam = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  lon: Schema.Finite,
  lat: Schema.Finite,
  city: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  /** The latest frame. Windy signs these URLs and they expire (10 minutes on the free tier). */
  preview: Schema.Struct({ url: Schema.String, width: Schema.Int, height: Schema.Int }),
  /** Windy's page for the webcam: Windy's terms require every image to link to it. */
  page: Schema.String,
  /** Today's timelapse on Windy. */
  timelapse: Schema.NullOr(Schema.String),
  /** Epoch ms of the latest frame. */
  updatedAt: Schema.NullOr(Schema.Finite),
  views: Schema.Int,
});
export type Webcam = typeof Webcam.Type;

/** The most viewed webcams in one map tile. */
export const WebcamArea = Schema.Struct({
  /** Epoch ms Windy was asked. */
  fetchedAt: Schema.Finite,
  /** How many Windy lists in the tile; `webcams` holds the most viewed of them. */
  total: Schema.Int,
  webcams: Schema.Array(Webcam),
});
export type WebcamArea = typeof WebcamArea.Type;

/** A wildlife observation with a photo, from iNaturalist. */
export const Sighting = Schema.Struct({
  id: Schema.Int,
  lon: Schema.Finite,
  lat: Schema.Finite,
  /** The observer hid the exact spot, or the species is sensitive: the point is somewhere within ~20 km. */
  obscured: Schema.Boolean,
  /** Null until someone identifies it. */
  scientificName: Schema.NullOr(Schema.String),
  commonName: Schema.NullOr(Schema.String),
  /** `species`, `genus`, … */
  rank: Schema.NullOr(Schema.String),
  /** iNaturalist's iconic taxon (`Aves`, `Plantae`, …); null when unidentified. */
  group: Schema.NullOr(Schema.String),
  /** `research` (community-verified), `needs_id` or `casual`. */
  quality: Schema.String,
  /** Epoch ms when the time was recorded, else null. */
  observedAt: Schema.NullOr(Schema.Finite),
  /** `YYYY-MM-DD`, local to the observer. */
  observedOn: Schema.NullOr(Schema.String),
  place: Schema.NullOr(Schema.String),
  observer: Schema.String,
  photo: Schema.Struct({
    url: Schema.String,
    /** iNaturalist's attribution line: "(c) Name, some rights reserved (CC BY)". */
    attribution: Schema.String,
  }),
  url: Schema.String,
});
export type Sighting = typeof Sighting.Type;

/** The latest sightings in one map tile, newest first. */
export const SightingArea = Schema.Struct({
  fetchedAt: Schema.Finite,
  /** How many iNaturalist has in the tile; `sightings` holds the latest of them. */
  total: Schema.Int,
  sightings: Schema.Array(Sighting),
});
export type SightingArea = typeof SightingArea.Type;

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

/** A keyed source this deployment has no key for. */
export class SourceNotConfigured extends Schema.TaggedError<
  SourceNotConfigured,
  { readonly brand: unique symbol }
>()('SourceNotConfigured', { source: Schema.String }, { httpApiStatus: 404 }) {}

/** No camera with this id is relayed (the relay serves only cameras in the current snapshot that need it). */
export class UnknownCamera extends Schema.TaggedError<UnknownCamera, { readonly brand: unique symbol }>()(
  'UnknownCamera',
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}
