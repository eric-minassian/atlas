import { Cache, Clock, Context, Duration, Effect, Exit, Layer, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { isTile, tileBounds } from './area.ts';
import { wildlifeSource } from './catalog.ts';
import { type Sighting, type SightingArea, TileOutOfRange, UpstreamUnavailable } from './domain.ts';
import { makeGate } from './gate.ts';
import { decodeJson, get, okText, round } from './ingest/source.ts';

/**
 * API v2, which returns only the fields asked for: v1 answers the same query
 * with ~40x the bytes (every taxon's ancestry and every photo's metadata).
 */
const API = 'https://api.inaturalist.org/v2/observations';
const FIELDS = [
  'id',
  'uri',
  'observed_on',
  'time_observed_at',
  'quality_grade',
  'location',
  'obscured',
  'place_guess',
  'user.login',
  'user.name',
  'taxon.name',
  'taxon.rank',
  'taxon.preferred_common_name',
  'taxon.iconic_taxon_name',
  'photos.url',
  'photos.attribution',
].join(',');
const PER_PAGE = 200;
/** Sightings accrue over hours; a tile is reused for half an hour. */
const FRESH = Duration.minutes(30);
/** iNaturalist asks API clients to stay around one request a second. */
const SPACING = Duration.seconds(1);

const S = Schema.optionalKey(Schema.NullOr(Schema.String));

const Observation = Schema.Struct({
  id: Schema.Finite,
  uri: Schema.String,
  observed_on: S,
  time_observed_at: S,
  quality_grade: Schema.String,
  /** `"lat,lon"`. */
  location: S,
  obscured: Schema.optionalKey(Schema.Boolean),
  place_guess: S,
  user: Schema.Struct({ login: Schema.String, name: S }),
  taxon: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        name: S,
        rank: S,
        preferred_common_name: S,
        iconic_taxon_name: S,
      }),
    ),
  ),
  photos: Schema.Array(Schema.Struct({ url: S, attribution: S })),
});

export const ObservationsResponse = Schema.Struct({
  total_results: Schema.Finite,
  results: Schema.Array(Observation),
});
type ObservationsResponse = typeof ObservationsResponse.Type;

/** Observations with a position and a photo, newest first as iNaturalist ordered them. */
export const parseObservations = (response: ObservationsResponse, fetchedAt: number): SightingArea => ({
  fetchedAt,
  total: Math.round(response.total_results),
  sightings: response.results.flatMap((o): Sighting[] => {
    const [lat, lon] = (o.location ?? '').split(',').map(Number);
    const photo = o.photos.find((p) => p.url);
    if (
      lat === undefined ||
      lon === undefined ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !photo?.url
    )
      return [];
    const observedAt = o.time_observed_at ? Date.parse(o.time_observed_at) : Number.NaN;
    return [
      {
        id: Math.round(o.id),
        lon: round(lon, 5),
        lat: round(lat, 5),
        obscured: o.obscured ?? false,
        scientificName: o.taxon?.name ?? null,
        commonName: o.taxon?.preferred_common_name ?? null,
        rank: o.taxon?.rank ?? null,
        group: o.taxon?.iconic_taxon_name ?? null,
        quality: o.quality_grade,
        observedAt: Number.isFinite(observedAt) ? observedAt : null,
        observedOn: o.observed_on ?? null,
        place: o.place_guess ?? null,
        observer: o.user.name || o.user.login,
        // The list gives 75 px squares; `medium` is the same photo at 500 px.
        photo: { url: photo.url.replace('/square.', '/medium.'), attribution: photo.attribution ?? '' },
        url: o.uri,
      },
    ];
  }),
});

/** Recent wildlife sightings by map tile from iNaturalist, cached per tile and spaced to its rate limit. */
export class WildlifeLookup extends Context.Service<
  WildlifeLookup,
  { area(z: number, x: number, y: number): Effect.Effect<SightingArea, UpstreamUnavailable | TileOutOfRange> }
>()('atlas/WildlifeLookup') {
  static readonly layer = Layer.effect(
    WildlifeLookup,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const gate = yield* makeGate(SPACING, '10 seconds');
      const zoom = wildlifeSource.zoom;

      const fetchTile = Effect.fnUntraced(function* (tile: string) {
        const [x = 0, y = 0] = tile.split('/').map(Number);
        const b = tileBounds(zoom, x, y);
        // Photos under a Creative Commons license only: Atlas shows them, credited, beside the map.
        const url =
          `${API}?swlat=${b.south}&swlng=${b.west}&nelat=${b.north}&nelng=${b.east}` +
          `&photos=true&photo_licensed=true&verifiable=true&order_by=observed_on&order=desc` +
          `&per_page=${PER_PAGE}&fields=${FIELDS}`;
        const response = yield* gate(
          get(url).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(ObservationsResponse))),
        ).pipe(Effect.provideService(HttpClient.HttpClient, client));
        return parseObservations(response, yield* Clock.currentTimeMillis);
      });

      const cache = yield* Cache.makeWith(fetchTile, {
        capacity: 4000,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? FRESH : Duration.seconds(15)),
      });

      const area = Effect.fn('WildlifeLookup.area')(function* (z: number, x: number, y: number) {
        if (z !== zoom || !isTile(z, x, y)) return yield* new TileOutOfRange({ z, x, y });
        yield* Effect.annotateCurrentSpan({ tile: `${z}/${x}/${y}` });
        return yield* Cache.get(cache, `${x}/${y}`).pipe(
          Effect.catchTags({
            IngestError: (error) =>
              Effect.andThen(
                Effect.logWarning('iNaturalist lookup failed').pipe(
                  Effect.annotateLogs({ error: error.message }),
                ),
                Effect.fail(new UpstreamUnavailable({ source: 'iNaturalist' })),
              ),
            GateBusy: () => Effect.fail(new UpstreamUnavailable({ source: 'iNaturalist' })),
          }),
        );
      });
      return WildlifeLookup.of({ area });
    }),
  );
}
