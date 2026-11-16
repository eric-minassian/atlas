import { DateTime, Effect, Option, Schema } from 'effect';
import { feeds } from '../catalog.ts';
import { type Disaster, type DisasterData, DisasterType, type Polygon } from '../domain.ts';
import { GeoJsonArea, toPolygons } from './geometry.ts';
import { decodeJson, get, IngestError, okText, round, type Source, updated } from './source.ts';

const API = 'https://www.gdacs.org/gdacsapi/api';
/** GDACS's current events for its app: the latest 100, which green wildfires and quakes can fill. */
const CURRENT_URL = `${API}/events/geteventlist/EVENTS4APP`;
/**
 * Orange and red events of the past year, so long-running ones (droughts,
 * slow floods) aren't crowded out of the list above. Pages hold 100 events.
 */
const significantUrl = (now: number, page: number) => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `${API}/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=Orange;Red&fromDate=${day(now - 365 * 86_400_000)}&toDate=${day(now)}&pagenumber=${page}`;
};
const MAX_PAGES = 3;
const geometryUrl = (d: Pick<Disaster, 'type' | 'eventId' | 'episodeId'>) =>
  `${API}/polygons/getgeometry?eventtype=${d.type}&eventid=${d.eventId}&episodeid=${d.episodeId}`;
/**
 * Outlines worth drawing: a cyclone's forecast cone and track, a drought's or
 * flood's affected area. Quakes, volcanoes and wildfires read fine as points.
 */
const WITH_AREAS: ReadonlySet<DisasterType> = new Set(['TC', 'DR', 'FL']);
/** Geometry requests per refresh; the rest reuse what was fetched before, or wait for the next refresh. */
const MAX_GEOMETRY = 12;
/** Degrees: these areas span hundreds of kilometers. */
const TOLERANCE = 0.02;
/** A drought's area can be a continent's worth of patches. */
const MAX_AREA_VERTICES = 600;

const Alert = Schema.Literals(['Green', 'Orange', 'Red']);
const EventFeature = Schema.Struct({
  geometry: Schema.Struct({ coordinates: Schema.Array(Schema.Finite) }),
  properties: Schema.Struct({
    eventtype: Schema.String,
    eventid: Schema.Int,
    episodeid: Schema.Int,
    name: Schema.String,
    alertlevel: Alert,
    country: Schema.NullOr(Schema.String),
    fromdate: Schema.String,
    todate: Schema.String,
    iscurrent: Schema.String,
    url: Schema.Struct({ report: Schema.String }),
    severitydata: Schema.optionalKey(Schema.Struct({ severitytext: Schema.String })),
  }),
});
type EventFeature = typeof EventFeature.Type;
export const EventList = Schema.Struct({ features: Schema.Array(EventFeature) });

const GeometryFeature = Schema.Struct({
  geometry: Schema.Union([
    GeoJsonArea,
    Schema.Struct({
      type: Schema.Literal('LineString'),
      coordinates: Schema.Array(Schema.Array(Schema.Finite)),
    }),
    Schema.Struct({ type: Schema.Literal('Point'), coordinates: Schema.Array(Schema.Finite) }),
  ]),
  properties: Schema.Struct({ Class: Schema.optionalKey(Schema.String) }),
});
export const EventGeometry = Schema.Struct({ features: Schema.Array(GeometryFeature) });
type EventGeometry = typeof EventGeometry.Type;

const isType = Schema.is(DisasterType);
/** GDACS dates are UTC without a zone. */
const parseTime = (value: string) => Date.parse(value.endsWith('Z') ? value : `${value}Z`);

/** Current events from any of the lists, each once (the first list's copy wins), newest first. */
export const parseEvents = (lists: ReadonlyArray<ReadonlyArray<EventFeature>>): DisasterData => {
  const events = new Map<string, Disaster>();
  for (const list of lists)
    for (const { geometry, properties: p } of list) {
      const id = `${p.eventtype}${p.eventid}`;
      const [lon, lat] = geometry.coordinates;
      const from = parseTime(p.fromdate);
      const to = parseTime(p.todate);
      if (events.has(id) || p.iscurrent !== 'true' || !isType(p.eventtype)) continue;
      if (lon === undefined || lat === undefined || !Number.isFinite(from) || !Number.isFinite(to)) continue;
      events.set(id, {
        id,
        type: p.eventtype,
        eventId: p.eventid,
        episodeId: p.episodeid,
        name: p.name,
        alert: p.alertlevel.toLowerCase() as Disaster['alert'],
        // GDACS lists several countries with empty entries between them ("Aruba, , Brazil").
        country: (p.country ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
          .join(', '),
        from,
        to,
        lon: round(lon, 4),
        lat: round(lat, 4),
        severity: (p.severitydata?.severitytext ?? '').trim(),
        url: p.url.report,
        track: [],
        areas: [],
      });
    }
  return { events: [...events.values()].toSorted((a, b) => b.to - a.to) };
};

const key = (x: number | undefined, y: number | undefined) => `${x},${y}`;

/**
 * Joins line segments that share endpoints into lines. GDACS draws a cyclone's
 * track as one two-point segment per step, grouped by storm category rather
 * than in order.
 */
export const chain = (segments: ReadonlyArray<ReadonlyArray<number>>): number[][] => {
  const starting = new Map<string, number>();
  const ends = new Set<string>();
  segments.forEach((s, i) => {
    starting.set(key(s[0], s[1]), i);
    ends.add(key(s.at(-2), s.at(-1)));
  });
  const used = new Set<number>();
  const lines: number[][] = [];
  const follow = (first: number) => {
    const line = [...(segments[first] as ReadonlyArray<number>)];
    used.add(first);
    for (;;) {
      const next = starting.get(key(line.at(-2), line.at(-1)));
      if (next === undefined || used.has(next)) break;
      used.add(next);
      line.push(...(segments[next] as ReadonlyArray<number>).slice(2));
    }
    lines.push(line);
  };
  segments.forEach((s, i) => {
    if (!used.has(i) && !ends.has(key(s[0], s[1]))) follow(i);
  });
  segments.forEach((_, i) => {
    if (!used.has(i)) follow(i);
  });
  return lines;
};

/** The parts of an event's geometry worth drawing: the cone or affected area, and a cyclone's track. */
export const parseGeometry = (
  type: DisasterType,
  geometry: EventGeometry,
): { readonly track: number[][]; readonly areas: Polygon[] } => {
  const segments: number[][] = [];
  const areas: Polygon[] = [];
  for (const { geometry: g, properties } of geometry.features) {
    const cls = properties.Class ?? '';
    if (g.type === 'LineString' && type === 'TC' && cls.startsWith('Line_'))
      segments.push(g.coordinates.flatMap(([lon = 0, lat = 0]) => [round(lon, 3), round(lat, 3)]));
    else if (
      (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
      ((type === 'TC' && cls === 'Poly_Cones') ||
        (type === 'DR' && cls === 'Poly_area') ||
        (type === 'FL' && cls === 'Poly_Affected'))
    )
      areas.push(...toPolygons(g, TOLERANCE, 3, MAX_AREA_VERTICES));
  }
  return { track: chain(segments), areas };
};

const readList = (url: string) =>
  Effect.gen(function* () {
    const response = yield* get(url);
    // The search answers 204 when nothing matches.
    if (response.status === 204) return [];
    return (yield* decodeJson(EventList)(yield* okText(response))).features;
  });

/** Current GDACS events, with outlines for cyclones, droughts and floods. */
export const makeDisasterSource = (): Source<'disasters'> => ({
  interval: Effect.succeed(feeds.disasters.intervalSeconds),
  read: (_validators, previous) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const current = yield* readList(CURRENT_URL);
      const significant: EventFeature[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const features = yield* readList(significantUrl(now, page));
        significant.push(...features);
        if (features.length < 100) break;
      }
      const { events } = parseEvents([current, significant]);

      // Outlines change with each episode (a new advisory); otherwise reuse what's published. An
      // event published without any (its request failed) is asked for again.
      const before = new Map(
        Option.match(yield* previous, { onNone: () => [], onSome: (data) => data.events })
          .filter((e) => e.areas.length > 0 || e.track.length > 0)
          .map((e) => [`${e.id}/${e.episodeId}`, e]),
      );
      const missing = events.filter((e) => WITH_AREAS.has(e.type) && !before.has(`${e.id}/${e.episodeId}`));
      const fetched = new Map<string, { readonly track: number[][]; readonly areas: Polygon[] }>();
      yield* Effect.forEach(
        missing.slice(0, MAX_GEOMETRY),
        (e) =>
          get(geometryUrl(e)).pipe(
            Effect.flatMap(okText),
            Effect.flatMap(decodeJson(EventGeometry)),
            Effect.map((geometry) => fetched.set(e.id, parseGeometry(e.type, geometry))),
            Effect.catch((error: IngestError) =>
              Effect.logWarning('GDACS geometry unavailable').pipe(
                Effect.annotateLogs({ event: e.id, error: error.message }),
              ),
            ),
          ),
        { concurrency: 4, discard: true },
      );
      // The events are this read's own objects: attach the outlines in place.
      for (const e of events) {
        const shapes = fetched.get(e.id) ?? before.get(`${e.id}/${e.episodeId}`);
        if (shapes) Object.assign(e, { track: shapes.track, areas: shapes.areas });
      }
      const data: DisasterData = { events };
      if (data.events.length === 0 && current.length > 0)
        return yield* new IngestError({ message: 'GDACS listed events, but none current and recognized' });
      return updated<'disasters'>(data, data.events.length);
    }),
});
