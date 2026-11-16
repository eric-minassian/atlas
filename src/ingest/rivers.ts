import { DateTime, Effect, Option, Schema } from 'effect';
import type { FloodWarning, GaugeCountry, GaugeData, GaugeStatus, RiverData } from '../domain.ts';
import { type Columns, decodeJson, get, IngestError, okText, round, type Source, updated } from './source.ts';

/** Readings older than this are left out: the gauge has stopped reporting. */
const MAX_AGE_MS = 3 * 86_400_000;

interface Gauge {
  readonly id: string;
  readonly name: string;
  readonly river: string;
  readonly lon: number;
  readonly lat: number;
  readonly time: number;
  readonly value: number;
  readonly unit: string;
  readonly status: GaugeStatus;
  readonly threshold: number | null;
}

/** Packs one country's gauges into columns. */
export const toColumns = (gauges: ReadonlyArray<Gauge>): GaugeData => {
  const since = gauges.reduce((min, g) => Math.min(min, g.time), Number.POSITIVE_INFINITY);
  const out: Columns<Omit<GaugeData, 'since'>> = {
    id: [],
    name: [],
    river: [],
    lon: [],
    lat: [],
    observed: [],
    value: [],
    unit: [],
    status: [],
    threshold: [],
  };
  for (const g of gauges) {
    out.id.push(g.id);
    out.name.push(g.name);
    out.river.push(g.river);
    out.lon.push(round(g.lon, 4));
    out.lat.push(round(g.lat, 4));
    out.observed.push(Math.round((g.time - since) / 60_000));
    out.value.push(round(g.value, 3));
    out.unit.push(g.unit);
    out.status.push(g.status);
    out.threshold.push(g.threshold === null ? null : round(g.threshold, 3));
  }
  return { since: Number.isFinite(since) ? since : 0, ...out };
};

const finite = (value: unknown): number | null => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
/** EA fields are sometimes a list (a station with two labels): the first is used. */
const one = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);
const text = (value: unknown): string => {
  const v = one(value);
  return typeof v === 'string' ? v.trim() : '';
};

// ---------------------------------------------------------------------------
// United States: NWS river gauges (NWPS observed stages)
// ---------------------------------------------------------------------------

/**
 * NWPS's own `/nwps/v1/gauges` times out (504 after 60 s) when asked for the
 * whole country, so this reads the same observations from NWS's map service,
 * which pages 10,000 gauges at a time in about a second.
 */
const US_LAYER =
  'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0';
const US_PAGE = 10_000;
const usUrl = (offset: number) =>
  `${US_LAYER}/query?${new URLSearchParams({
    where: "status NOT IN ('out_of_service','obs_not_current')",
    outFields: 'gaugelid,status,location,waterbody,obstime,units,flood,observed,latitude,longitude',
    returnGeometry: 'false',
    orderByFields: 'objectid',
    resultOffset: String(offset),
    resultRecordCount: String(US_PAGE),
    f: 'json',
  }).toString()}`;

const S = Schema.NullOr(Schema.String);
const UsGauges = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      attributes: Schema.Struct({
        gaugelid: Schema.String,
        status: Schema.String,
        location: S,
        waterbody: S,
        /** UTC, `YYYY-MM-DD HH:MM:SS`. */
        obstime: S,
        units: S,
        /** Numbers as strings, empty when not defined. */
        flood: S,
        observed: S,
        latitude: Schema.NullOr(Schema.Finite),
        longitude: Schema.NullOr(Schema.Finite),
      }),
    }),
  ),
  exceededTransferLimit: Schema.optionalKey(Schema.Boolean),
});
type UsGauges = typeof UsGauges.Type;

const usStatus: Readonly<Record<string, GaugeStatus>> = {
  major: 'major',
  moderate: 'moderate',
  minor: 'minor',
  action: 'action',
  no_flooding: 'normal',
  low_threshold: 'low',
  not_defined: 'unknown',
};

export const parseUsGauges = (pages: ReadonlyArray<UsGauges>, now: number): Gauge[] => {
  const gauges: Gauge[] = [];
  for (const page of pages)
    for (const { attributes: a } of page.features) {
      const status = usStatus[a.status];
      const value = finite(a.observed);
      const time = a.obstime ? Date.parse(`${a.obstime.replace(' ', 'T')}Z`) : Number.NaN;
      // -999 and below mark a missing value.
      if (!status || value === null || value <= -900 || a.latitude === null || a.longitude === null) continue;
      if (!Number.isFinite(time) || now - time > MAX_AGE_MS) continue;
      const location = (a.location ?? '').trim();
      const river = (a.waterbody ?? '').trim();
      gauges.push({
        id: a.gaugelid,
        name: location || river || a.gaugelid,
        river: location ? river : '',
        lon: a.longitude,
        lat: a.latitude,
        time,
        value,
        unit: (a.units ?? '').trim() || 'ft',
        status,
        threshold: finite(a.flood),
      });
    }
  return gauges;
};

const readUs = Effect.gen(function* () {
  const pages: UsGauges[] = [];
  for (let page = 0; page < 3; page++) {
    const body = yield* decodeJson(UsGauges)(yield* okText(yield* get(usUrl(page * US_PAGE))));
    pages.push(body);
    if (!body.exceededTransferLimit) break;
  }
  return pages;
});

// ---------------------------------------------------------------------------
// England: Environment Agency flood monitoring
// ---------------------------------------------------------------------------

const EA = 'https://environment.data.gov.uk/flood-monitoring';
/** The full view includes each station's typical range (`stageScale`). */
const UK_STATIONS_URL = `${EA}/id/stations?parameter=level&_view=full&_limit=10000`;
const UK_READINGS_URL = `${EA}/data/readings?latest&parameter=level`;
const UK_FLOODS_URL = `${EA}/id/floods`;
const ukAreaUrl = (id: string) => `${EA}/id/floodAreas/${encodeURIComponent(id)}`;
/** Flood area lookups per refresh (each warning's position; areas don't move, so they're reused after). */
const MAX_AREA_LOOKUPS = 40;

/** EA's linked-data JSON: loosely typed (a field is a value, a list or a link), so fields are read defensively. */
const UkStations = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      notation: Schema.String,
      RLOIid: Schema.optionalKey(Schema.Unknown),
      label: Schema.optionalKey(Schema.Unknown),
      lat: Schema.optionalKey(Schema.Unknown),
      long: Schema.optionalKey(Schema.Unknown),
      riverName: Schema.optionalKey(Schema.Unknown),
      measures: Schema.optionalKey(Schema.Unknown),
      stageScale: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
type UkStations = typeof UkStations.Type;
const UkReadings = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ measure: Schema.String, dateTime: Schema.String, value: Schema.Unknown }),
  ),
});
type UkReadings = typeof UkReadings.Type;
const UkFloods = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      floodAreaID: Schema.String,
      severityLevel: Schema.Int,
      description: Schema.optionalKey(Schema.Unknown),
      message: Schema.optionalKey(Schema.Unknown),
      timeMessageChanged: Schema.optionalKey(Schema.Unknown),
      floodArea: Schema.optionalKey(Schema.Struct({ county: Schema.optionalKey(Schema.Unknown) })),
    }),
  ),
});
type UkFloods = typeof UkFloods.Type;
const UkArea = Schema.Struct({ items: Schema.Struct({ lat: Schema.Finite, long: Schema.Finite }) });

/** The measure shown for a station, by qualifier: river stage first, then tidal level. Groundwater isn't a river. */
const QUALIFIERS = ['Stage', 'Tidal Level', 'Downstream Stage', 'Height', 'Water'];

const levelMeasures = (measures: unknown): Array<{ readonly id: string; readonly qualifier: string }> =>
  (Array.isArray(measures) ? measures : [measures]).flatMap((m: unknown) => {
    if (typeof m !== 'object' || m === null) return [];
    const r = m as Record<string, unknown>;
    const id = r['@id'];
    const unit = typeof r.unitName === 'string' ? r.unitName : '';
    const qualifier = typeof r.qualifier === 'string' ? r.qualifier : '';
    // Levels are in meters (mASD: above the gauge's datum; mAOD: above sea level).
    if (typeof id !== 'string' || r.parameter !== 'level' || !/^m(ASD|AOD|BDAT)?$/.test(unit)) return [];
    if (!QUALIFIERS.includes(qualifier)) return [];
    return [{ id, qualifier }];
  });

export const parseUkGauges = (stations: UkStations, readings: UkReadings, now: number): Gauge[] => {
  const latest = new Map<string, { readonly value: number; readonly time: number }>();
  for (const r of readings.items) {
    const value = finite(one(r.value));
    const time = Date.parse(r.dateTime);
    if (value !== null && Number.isFinite(time)) latest.set(r.measure, { value, time });
  }
  const gauges: Gauge[] = [];
  for (const s of stations.items) {
    const lat = finite(one(s.lat));
    const lon = finite(one(s.long));
    if (lat === null || lon === null) continue;
    const measures = levelMeasures(s.measures).toSorted(
      (a, b) => QUALIFIERS.indexOf(a.qualifier) - QUALIFIERS.indexOf(b.qualifier),
    );
    const measure = measures.find((m) => latest.has(m.id));
    const reading = measure ? latest.get(measure.id) : undefined;
    if (!measure || !reading || now - reading.time > MAX_AGE_MS) continue;
    // The typical range is for the station's stage; it doesn't describe a tidal or downstream level.
    const scale =
      measure.qualifier === 'Stage' && typeof s.stageScale === 'object' ? s.stageScale : undefined;
    const high = finite((scale as Record<string, unknown> | undefined)?.typicalRangeHigh);
    const low = finite((scale as Record<string, unknown> | undefined)?.typicalRangeLow);
    const status: GaugeStatus =
      high === null || low === null
        ? 'unknown'
        : reading.value > high
          ? 'high'
          : reading.value < low
            ? 'low'
            : 'normal';
    const rloi = text(s.RLOIid);
    gauges.push({
      id: rloi || s.notation,
      name: text(s.label) || s.notation,
      river: text(s.riverName),
      lon,
      lat,
      time: reading.time,
      value: reading.value,
      unit: 'm',
      status,
      threshold: high,
    });
  }
  return gauges;
};

/** Warnings in force (levels 1-3), placed with `positions` (by flood area); ones without a position are left out. */
export const parseUkWarnings = (
  floods: UkFloods,
  positions: ReadonlyMap<string, readonly [number, number]>,
): FloodWarning[] =>
  floods.items.flatMap((f): FloodWarning[] => {
    const position = positions.get(f.floodAreaID);
    const changed = Date.parse(text(f.timeMessageChanged));
    if (f.severityLevel < 1 || f.severityLevel > 3 || !position) return [];
    return [
      {
        id: f.floodAreaID,
        level: f.severityLevel,
        area: text(f.description),
        county: text(f.floodArea?.county),
        message: text(f.message),
        changed: Number.isFinite(changed) ? changed : 0,
        lon: round(position[0], 4),
        lat: round(position[1], 4),
      },
    ];
  });

const readUk = Effect.gen(function* () {
  const [stations, readings] = yield* Effect.all(
    [
      get(UK_STATIONS_URL).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(UkStations))),
      get(UK_READINGS_URL).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(UkReadings))),
    ],
    { concurrency: 2 },
  );
  return { stations, readings };
});

/** England's warnings, with positions from `known` (the last snapshot) or looked up. */
const readUkWarnings = (known: ReadonlyMap<string, readonly [number, number]>) =>
  Effect.gen(function* () {
    const floods = yield* get(UK_FLOODS_URL).pipe(
      Effect.flatMap(okText),
      Effect.flatMap(decodeJson(UkFloods)),
    );
    const positions = new Map(known);
    const missing = [...new Set(floods.items.map((f) => f.floodAreaID))].filter((id) => !positions.has(id));
    yield* Effect.forEach(
      missing.slice(0, MAX_AREA_LOOKUPS),
      (id) =>
        get(ukAreaUrl(id)).pipe(
          Effect.flatMap(okText),
          Effect.flatMap(decodeJson(UkArea)),
          Effect.map(({ items }) => positions.set(id, [items.long, items.lat])),
          Effect.catch((error: IngestError) =>
            Effect.logWarning('flood area unavailable').pipe(
              Effect.annotateLogs({ area: id, error: error.message }),
            ),
          ),
        ),
      { concurrency: 6, discard: true },
    );
    return parseUkWarnings(floods, positions);
  });

// ---------------------------------------------------------------------------
// Germany: WSV Pegelonline (federal waterways)
// ---------------------------------------------------------------------------

const DE_URL =
  'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?timeseries=W&includeTimeseries=true&includeCurrentMeasurement=true';

const DeStations = Schema.Array(
  Schema.Struct({
    number: Schema.String,
    longname: Schema.String,
    latitude: Schema.optionalKey(Schema.Finite),
    longitude: Schema.optionalKey(Schema.Finite),
    water: Schema.optionalKey(Schema.Struct({ longname: Schema.String })),
    timeseries: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          shortname: Schema.String,
          unit: Schema.String,
          currentMeasurement: Schema.optionalKey(
            Schema.Struct({
              timestamp: Schema.String,
              value: Schema.Finite,
              stateMnwMhw: Schema.optionalKey(Schema.String),
              stateNswHsw: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    ),
  }),
);
type DeStations = typeof DeStations.Type;

/** Pegelonline names are upper case ("KÖLN", "RHEIN"). */
const titleCase = (value: string) =>
  value
    .toLowerCase()
    .replace(/(^|[\s(/-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());

/**
 * Above the highest navigable level (HSW) shipping stops: the river is near
 * flooding, so it reads as US "action" stage. Above mean high water (MHW) is
 * high but not unusual.
 */
const deStatus = (mnwMhw: string | undefined, nswHsw: string | undefined): GaugeStatus | undefined => {
  if (mnwMhw === 'out-dated' || nswHsw === 'out-dated') return undefined;
  if (nswHsw === 'high') return 'action';
  if (mnwMhw === 'high') return 'high';
  if (mnwMhw === 'normal') return 'normal';
  if (mnwMhw === 'low') return 'low';
  return 'unknown';
};

export const parseDeGauges = (stations: DeStations, now: number): Gauge[] =>
  stations.flatMap((s): Gauge[] => {
    const level = s.timeseries?.find((t) => t.shortname === 'W');
    const m = level?.currentMeasurement;
    const time = m ? Date.parse(m.timestamp) : Number.NaN;
    const status = m ? deStatus(m.stateMnwMhw, m.stateNswHsw) : undefined;
    if (!level || !m || !status || s.latitude === undefined || s.longitude === undefined) return [];
    if (!Number.isFinite(time) || now - time > MAX_AGE_MS) return [];
    return [
      {
        id: s.number,
        name: titleCase(s.longname),
        river: s.water ? titleCase(s.water.longname) : '',
        lon: s.longitude,
        lat: s.latitude,
        time,
        value: m.value,
        unit: level.unit,
        status,
        threshold: null,
      },
    ];
  });

const readDe = get(DE_URL).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(DeStations)));

// ---------------------------------------------------------------------------

/**
 * Each country is read on its own: one failing keeps that country's data
 * from the last snapshot, and the refresh fails only when all of them do.
 */
export const makeRiverSource = (): Source<'rivers'> => ({
  read: (_validators, previous) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const last = Option.getOrUndefined(yield* previous);
      const knownAreas = new Map((last?.warnings ?? []).map((w) => [w.id, [w.lon, w.lat] as const]));
      const [us, uk, de, warnings] = yield* Effect.all(
        [
          Effect.result(Effect.map(readUs, (pages) => parseUsGauges(pages, now))),
          Effect.result(
            Effect.map(readUk, ({ stations, readings }) => parseUkGauges(stations, readings, now)),
          ),
          Effect.result(Effect.map(readDe, (stations) => parseDeGauges(stations, now))),
          Effect.result(readUkWarnings(knownAreas)),
        ],
        { concurrency: 4 },
      );

      const results: ReadonlyArray<readonly [GaugeCountry, typeof us]> = [
        ['US', us],
        ['GB', uk],
        ['DE', de],
      ];
      const countries: Array<RiverData['countries'][number]> = [];
      const errors: string[] = [];
      for (const [country, result] of results) {
        if (result._tag === 'Success' && result.success.length > 0) {
          countries.push({ country, read: now, gauges: toColumns(result.success) });
          continue;
        }
        const error = result._tag === 'Failure' ? result.failure.message : 'no gauges reported';
        errors.push(`${country}: ${error}`);
        yield* Effect.logWarning('river gauges unavailable; keeping the last ones').pipe(
          Effect.annotateLogs({ country, error }),
        );
        const kept = last?.countries.find((c) => c.country === country);
        if (kept) countries.push(kept);
      }
      if (errors.length === results.length) return yield* new IngestError({ message: errors.join('; ') });
      if (warnings._tag === 'Failure')
        yield* Effect.logWarning('flood warnings unavailable; keeping the last ones').pipe(
          Effect.annotateLogs({ error: warnings.failure.message }),
        );
      const data: RiverData = {
        countries,
        warnings: warnings._tag === 'Success' ? warnings.success : (last?.warnings ?? []),
      };
      const count = countries.reduce((n, c) => n + c.gauges.id.length, 0) + data.warnings.length;
      return updated<'rivers'>(data, count);
    }),
});
