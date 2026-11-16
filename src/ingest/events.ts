import { Effect, Schema } from 'effect';
import type { EventData, NaturalEvent } from '../domain.ts';
import { decodeJson, get, notModified, okText, round, type Source, updated } from './source.ts';

/** Open natural events (wildfires, storms, volcanoes, ice, …) with an observation in the last 60 days. */
const EVENTS_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=60';

const Position = Schema.Tuple([Schema.Finite, Schema.Finite]);

const Geometry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('Point'),
    date: Schema.String,
    magnitudeValue: Schema.NullOr(Schema.Finite),
    magnitudeUnit: Schema.NullOr(Schema.String),
    coordinates: Position,
  }),
  Schema.Struct({
    type: Schema.Literal('Polygon'),
    date: Schema.String,
    magnitudeValue: Schema.NullOr(Schema.Finite),
    magnitudeUnit: Schema.NullOr(Schema.String),
    coordinates: Schema.Array(Schema.Array(Position)),
  }),
]);
type Geometry = typeof Geometry.Type;

const Event = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  categories: Schema.Array(Schema.Struct({ id: Schema.String })),
  sources: Schema.Array(Schema.Struct({ url: Schema.String })),
  geometry: Schema.Array(Geometry),
});

const Events = Schema.Struct({ events: Schema.Array(Event) });
type Events = typeof Events.Type;

/**
 * A polygon's position: the mean of its outer ring's distinct vertices (fine
 * for the small areas EONET reports). GeoJSON rings repeat the first vertex last.
 */
const positionOf = (g: Geometry): readonly [number, number] | undefined => {
  if (g.type === 'Point') return g.coordinates;
  const closed = g.coordinates[0] ?? [];
  const [first, last] = [closed[0], closed.at(-1)];
  const ring = first && last && first[0] === last[0] && first[1] === last[1] ? closed.slice(0, -1) : closed;
  if (ring.length === 0) return undefined;
  const [lon, lat] = ring.reduce(([a, b], [x, y]) => [a + x, b + y], [0, 0]);
  return [lon / ring.length, lat / ring.length];
};

export const parseEvents = (body: Events): EventData => {
  const events: NaturalEvent[] = [];
  for (const e of body.events) {
    const observations = e.geometry
      .flatMap((g) => {
        const position = positionOf(g);
        const time = Date.parse(g.date);
        return position && Number.isFinite(time) ? [{ g, time, position }] : [];
      })
      .toSorted((a, b) => a.time - b.time);
    const latest = observations.at(-1);
    if (!latest) continue;
    const { g } = latest;
    events.push({
      id: e.id,
      title: e.title,
      category: e.categories[0]?.id ?? 'other',
      time: latest.time,
      lon: round(latest.position[0], 4),
      lat: round(latest.position[1], 4),
      magnitude:
        g.magnitudeValue !== null && g.magnitudeUnit !== null
          ? { value: g.magnitudeValue, unit: g.magnitudeUnit }
          : null,
      source: e.sources[0]?.url ?? null,
      track:
        observations.length > 1
          ? observations
              .slice(0, -1)
              .map(({ position: [lon, lat] }) => [round(lon, 3), round(lat, 3)] as const)
          : [],
    });
  }
  return { events };
};

export const makeEventSource = (): Source<'events'> => ({
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(EVENTS_URL, { validators });
      if (response.status === 304) return notModified;
      const data = parseEvents(yield* decodeJson(Events)(yield* okText(response)));
      return updated<'events'>(data, data.events.length, response);
    }),
});
