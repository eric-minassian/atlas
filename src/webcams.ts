import { Secrets } from '@ericminassian/platform';
import { Cache, Clock, Context, Duration, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { isTile, tileBounds } from './area.ts';
import { webcamSource } from './catalog.ts';
import {
  SourceNotConfigured,
  TileOutOfRange,
  UpstreamUnavailable,
  type Webcam,
  type WebcamArea,
} from './domain.ts';
import { makeGate } from './gate.ts';
import { decodeJson, get, okText, round } from './ingest/source.ts';

const API = 'https://api.windy.com/webcams/api/v3/webcams';
/** The most Windy lists per request. */
const LIMIT = 50;
/**
 * How long an answer is reused. Windy's free tier signs image URLs for 10
 * minutes; with the edge (2 min) and browser (3 min) caching on top, a frame
 * URL is at most ~7 minutes old when a browser shows it.
 */
const FRESH = Duration.minutes(2);
/** Windy allows 300 requests a minute per key. */
const SPACING = Duration.millis(250);

const WindyWebcam = Schema.Struct({
  webcamId: Schema.Finite,
  title: Schema.String,
  /** `active` or `inactive`. */
  status: Schema.String,
  viewCount: Schema.optionalKey(Schema.Finite),
  lastUpdatedOn: Schema.optionalKey(Schema.NullOr(Schema.String)),
  images: Schema.optionalKey(
    Schema.Struct({
      current: Schema.Struct({ preview: Schema.optionalKey(Schema.String) }),
      sizes: Schema.Struct({ preview: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }) }),
    }),
  ),
  location: Schema.optionalKey(
    Schema.Struct({
      city: Schema.optionalKey(Schema.NullOr(Schema.String)),
      country: Schema.optionalKey(Schema.NullOr(Schema.String)),
      latitude: Schema.Finite,
      longitude: Schema.Finite,
    }),
  ),
  player: Schema.optionalKey(Schema.Struct({ day: Schema.optionalKey(Schema.String) })),
  urls: Schema.optionalKey(Schema.Struct({ detail: Schema.String })),
});

export const WindyResponse = Schema.Struct({ total: Schema.Finite, webcams: Schema.Array(WindyWebcam) });
type WindyResponse = typeof WindyResponse.Type;

/** Active webcams with a frame, a position and a Windy page (every image must link to it). */
export const parseWindy = (response: WindyResponse, fetchedAt: number): WebcamArea => ({
  fetchedAt,
  total: Math.round(response.total),
  webcams: response.webcams.flatMap((w): Webcam[] => {
    const preview = w.images?.current.preview;
    const size = w.images?.sizes.preview;
    if (w.status !== 'active' || !preview || !size || !w.location || !w.urls) return [];
    const updatedAt = w.lastUpdatedOn ? Date.parse(w.lastUpdatedOn) : Number.NaN;
    return [
      {
        id: String(w.webcamId),
        title: w.title,
        lon: round(w.location.longitude, 5),
        lat: round(w.location.latitude, 5),
        city: w.location.city ?? null,
        country: w.location.country ?? null,
        preview: { url: preview, width: Math.round(size.width), height: Math.round(size.height) },
        page: w.urls.detail,
        timelapse: w.player?.day ?? null,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
        views: Math.round(w.viewCount ?? 0),
      },
    ];
  }),
});

/** Webcams by map tile from Windy, cached briefly per tile and spaced to Windy's rate limit. */
export class WebcamLookup extends Context.Service<
  WebcamLookup,
  {
    area(
      z: number,
      x: number,
      y: number,
    ): Effect.Effect<WebcamArea, UpstreamUnavailable | TileOutOfRange | SourceNotConfigured>;
  }
>()('atlas/WebcamLookup') {
  static readonly layer = Layer.effect(
    WebcamLookup,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const secrets = yield* Secrets;
      const gate = yield* makeGate(SPACING, '8 seconds');
      const zoom = webcamSource.zoom;

      const fetchTile = Effect.fnUntraced(function* (tile: string) {
        const [x = 0, y = 0] = tile.split('/').map(Number);
        const key = yield* secrets.getOptional('WINDY_WEBCAMS_KEY');
        if (Option.isNone(key)) return yield* new SourceNotConfigured({ source: 'Windy' });
        const b = tileBounds(zoom, x, y);
        const url =
          `${API}?bbox=${b.north},${b.east},${b.south},${b.west}&limit=${LIMIT}` +
          '&sortKey=popularity&sortDirection=desc&include=images,location,player,urls';
        const response = yield* gate(
          get(url, { headers: { 'x-windy-api-key': Redacted.value(key.value) } }).pipe(
            Effect.flatMap(okText),
            Effect.flatMap(decodeJson(WindyResponse)),
          ),
        ).pipe(Effect.provideService(HttpClient.HttpClient, client));
        return parseWindy(response, yield* Clock.currentTimeMillis);
      });

      const cache = yield* Cache.makeWith(fetchTile, {
        capacity: 4000,
        // A failure is retried soon; Windy being briefly busy shouldn't blank a tile for minutes.
        timeToLive: (exit) => (Exit.isSuccess(exit) ? FRESH : Duration.seconds(15)),
      });

      const area = Effect.fn('WebcamLookup.area')(function* (z: number, x: number, y: number) {
        if (z !== zoom || !isTile(z, x, y)) return yield* new TileOutOfRange({ z, x, y });
        yield* Effect.annotateCurrentSpan({ tile: `${z}/${x}/${y}` });
        return yield* Cache.get(cache, `${x}/${y}`).pipe(
          Effect.catchTags({
            IngestError: (error) =>
              Effect.andThen(
                Effect.logWarning('Windy lookup failed').pipe(Effect.annotateLogs({ error: error.message })),
                Effect.fail(new UpstreamUnavailable({ source: 'Windy' })),
              ),
            GateBusy: () => Effect.fail(new UpstreamUnavailable({ source: 'Windy' })),
          }),
        );
      });
      return WebcamLookup.of({ area });
    }),
  );
}
