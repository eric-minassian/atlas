import type { Store } from '@ericminassian/platform';
import { Clock, Effect, Option, Schema } from 'effect';
import { AlertSeverity, Polygon, type WeatherAlert, type WeatherAlertData } from '../domain.ts';
import { GeoJsonArea, toPolygons } from './geometry.ts';
import { decodeJson, get, IngestError, okText, type Source, updated } from './source.ts';

/** Alerts in effect now, excluding tests and exercises. NWS asks API clients to send a User-Agent (`get` does). */
const ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual';
const zoneUrl = (id: string) => `https://api.weather.gov/zones/${id}`;

/**
 * Zone outlines, kept in the `snapshots` store: they're static (NWS revises
 * zones a few times a year), so each is fetched once and every later refresh
 * reuses it. One object, read once per worker and rewritten when zones are added.
 */
// Versioned: outlines are stored simplified, so a change to the simplification needs a new key.
export const ZONE_CACHE_KEY = 'cache/nws-zones-v1.json';
/**
 * New zones fetched per refresh, at most; the rest come on later refreshes (a
 * cold cache needs four or five). About 10 s of requests; `ZONE_BUDGET_MS` is
 * the guard when NWS is slow.
 */
export const MAX_NEW_ZONES = 120;
/** Stop starting new zone requests this long into a refresh, so it ends well inside the worker's 120 s. */
const ZONE_BUDGET_MS = 40_000;
/**
 * Degrees. Zones are drawn at regional scale, where 0.02° (~2 km) still
 * follows coasts and county lines; it halves the outlines' size against 0.01°.
 * Rounding to 0.01° loses less than the simplification does.
 */
const ZONE_TOLERANCE = 0.02;
const ZONE_DIGITS = 2;
/** Vertices per zone: enough for a county; Alaska's island-chain zones are coarsened to it. */
const ZONE_MAX_VERTICES = 120;
/** Storm-based warnings are small (a few counties) and drawn closer. */
const ALERT_TOLERANCE = 0.002;

const Properties = Schema.Struct({
  id: Schema.String,
  areaDesc: Schema.String,
  affectedZones: Schema.Array(Schema.String),
  sent: Schema.String,
  onset: Schema.NullOr(Schema.String),
  expires: Schema.NullOr(Schema.String),
  ends: Schema.NullOr(Schema.String),
  severity: Schema.String,
  event: Schema.String,
  senderName: Schema.String,
  headline: Schema.NullOr(Schema.String),
});
const AlertFeature = Schema.Struct({ geometry: Schema.NullOr(GeoJsonArea), properties: Properties });
export const AlertCollection = Schema.Struct({ features: Schema.Array(AlertFeature) });
type AlertCollection = typeof AlertCollection.Type;

/** A zone: its geometry is checked separately, so a zone with an unusual one is recorded as having none. */
const Zone = Schema.Struct({ geometry: Schema.NullOr(Schema.Unknown) });
const ZoneOutlines = Schema.Record(Schema.String, Schema.Array(Polygon));
const decodeArea = Schema.decodeUnknownOption(GeoJsonArea);

/** `https://api.weather.gov/zones/forecast/CAZ073` → `forecast/CAZ073`. */
export const zoneId = (url: string): string | undefined => /\/zones\/([a-z]+\/[A-Z0-9]+)$/.exec(url)?.[1];

const isSeverity = Schema.is(AlertSeverity);
const rank: Readonly<Record<WeatherAlert['severity'], number>> = {
  Extreme: 0,
  Severe: 1,
  Moderate: 2,
  Minor: 3,
  Unknown: 4,
};
const time = (value: string | null): number | null => {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

/** The zones `collection`'s alerts are drawn with (alerts with an outline of their own need none), most severe first. */
export const zonesNeeded = (collection: AlertCollection): ReadonlyArray<string> => {
  const best = new Map<string, number>();
  for (const { geometry, properties: p } of collection.features) {
    if (geometry) continue;
    const r = rank[isSeverity(p.severity) ? p.severity : 'Unknown'];
    for (const url of p.affectedZones) {
      const id = zoneId(url);
      if (id && (best.get(id) ?? 5) > r) best.set(id, r);
    }
  }
  return [...best.entries()].toSorted((a, b) => a[1] - b[1]).map(([id]) => id);
};

/**
 * Normalizes the alerts and attaches the outlines of the zones they cover,
 * from `outlines` (zones not there yet are counted as pending). Most severe
 * first, then newest.
 */
export const parseAlerts = (
  collection: AlertCollection,
  outlines: ReadonlyMap<string, ReadonlyArray<Polygon>>,
): WeatherAlertData => {
  const zones: Record<string, ReadonlyArray<Polygon>> = {};
  const pending = new Set<string>();
  const alerts: WeatherAlert[] = [];
  for (const { geometry, properties: p } of collection.features) {
    const sent = time(p.sent);
    if (sent === null) continue;
    const polygons = geometry ? toPolygons(geometry, ALERT_TOLERANCE, 4) : [];
    const ids = p.affectedZones.flatMap((url) => zoneId(url) ?? []);
    if (polygons.length === 0)
      for (const id of ids) {
        const outline = outlines.get(id);
        if (!outline) pending.add(id);
        else if (outline.length > 0) zones[id] = outline;
      }
    alerts.push({
      id: p.id,
      event: p.event,
      headline: p.headline,
      severity: isSeverity(p.severity) ? p.severity : 'Unknown',
      area: p.areaDesc,
      sender: p.senderName,
      sent,
      onset: time(p.onset),
      expires: time(p.expires),
      ends: time(p.ends),
      polygons,
      zones: ids,
    });
  }
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || b.sent - a.sent);
  return { alerts, zones, pendingZones: pending.size };
};

/** Fetches one zone's outline; none for a zone NWS has no geometry for (or no longer has). */
const fetchZone = (id: string) =>
  Effect.gen(function* () {
    const response = yield* get(zoneUrl(id));
    if (response.status === 404) return [];
    const zone = yield* decodeJson(Zone)(yield* okText(response));
    return Option.match(decodeArea(zone.geometry), {
      onNone: () => [],
      onSome: (area) => toPolygons(area, ZONE_TOLERANCE, ZONE_DIGITS, ZONE_MAX_VERTICES),
    });
  }).pipe(
    Effect.timeout('15 seconds'),
    Effect.mapError((error) =>
      error instanceof IngestError ? error : new IngestError({ message: `zone ${id} timed out` }),
    ),
  );

/** Active NWS alerts, drawn with their own outline or their zones' (cached in `store`). */
export const makeWeatherAlertSource = (store: Store): Source<'weatherAlerts'> => {
  // The worker keeps this between invocations; a cold one loads it from the store.
  let cached: Map<string, ReadonlyArray<Polygon>> | undefined;
  const readStored = Effect.gen(function* () {
    const body = yield* store.getText(ZONE_CACHE_KEY);
    if (Option.isNone(body)) return new Map<string, ReadonlyArray<Polygon>>();
    // An unreadable cache (a format change) is just started over.
    const decoded = Schema.decodeOption(Schema.fromJsonString(ZoneOutlines))(body.value);
    return new Map(Option.match(decoded, { onNone: () => [], onSome: (z) => Object.entries(z) }));
  });

  return {
    // No conditional request: zones still pending need the alerts even when they haven't changed.
    read: () =>
      Effect.gen(function* () {
        const response = yield* get(ALERTS_URL, { headers: { accept: 'application/geo+json' } });
        const collection = yield* decodeJson(AlertCollection)(yield* okText(response));

        cached ??= yield* readStored;
        const outlines = cached;
        const missing = zonesNeeded(collection).filter((id) => !outlines.has(id));
        const deadline = (yield* Clock.currentTimeMillis) + ZONE_BUDGET_MS;
        const added = new Map<string, ReadonlyArray<Polygon>>();
        let failed = 0;
        yield* Effect.forEach(
          missing.slice(0, MAX_NEW_ZONES),
          (id) =>
            Effect.gen(function* () {
              if ((yield* Clock.currentTimeMillis) > deadline) return;
              const result = yield* Effect.result(fetchZone(id));
              if (result._tag === 'Success') added.set(id, result.success);
              else failed++;
            }),
          { concurrency: 6, discard: true },
        );
        if (added.size > 0) {
          // Another worker may have added zones since this one loaded the cache: merge, don't overwrite.
          const stored = yield* readStored;
          for (const [id, polygons] of added) stored.set(id, polygons);
          yield* store.put(ZONE_CACHE_KEY, JSON.stringify(Object.fromEntries(stored)), {
            contentType: 'application/json',
          });
          for (const [id, polygons] of stored) outlines.set(id, polygons);
        }
        const data = parseAlerts(collection, outlines);
        if (missing.length > 0)
          yield* Effect.logInfo('fetched NWS zone outlines').pipe(
            Effect.annotateLogs({ added: added.size, failed, pending: data.pendingZones }),
          );
        return updated<'weatherAlerts'>(data, data.alerts.length);
      }),
  };
};
