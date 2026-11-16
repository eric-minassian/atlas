import { Context, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { UnknownCamera, UpstreamUnavailable } from './domain.ts';
import { FeedStore } from './feeds.ts';

/** Frames are a few hundred KB; anything much larger isn't a camera frame. */
const MAX_BYTES = 4 * 1024 * 1024;

export interface Frame {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Fetches the latest frame of a traffic camera whose operator serves it only
 * over plain HTTP, which an HTTPS page can't show. Only cameras the current
 * snapshot marks `relayed` are served, looked up by id: callers can't make it
 * fetch an arbitrary URL.
 */
export class CameraRelay extends Context.Service<
  CameraRelay,
  { frame(id: string): Effect.Effect<Frame, UnknownCamera | UpstreamUnavailable> }
>()('atlas/CameraRelay') {
  static readonly layer = Layer.effect(
    CameraRelay,
    Effect.gen(function* () {
      const store = yield* FeedStore;
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      /** The relayed cameras' image URLs by id, for one snapshot version (decoding the snapshot isn't free). */
      let index: { readonly version: string; readonly urls: ReadonlyMap<string, string> } | undefined;

      const urlOf = Effect.fnUntraced(function* (id: string) {
        const snapshot = yield* store.read('cameras');
        if (Option.isNone(snapshot)) return undefined;
        if (index?.version !== snapshot.value.version) {
          const data = yield* store.payload('cameras');
          const urls = new Map<string, string>();
          if (Option.isSome(data)) {
            const { id: ids, image, relayed } = data.value;
            for (let i = 0; i < ids.length; i++)
              if (relayed[i]) urls.set(ids[i] as string, image[i] as string);
          }
          index = { version: snapshot.value.version, urls };
        }
        return index.urls.get(id);
      });

      const frame = Effect.fn('CameraRelay.frame')(function* (id: string) {
        yield* Effect.annotateCurrentSpan({ camera: id });
        const url = yield* urlOf(id);
        if (url === undefined) return yield* new UnknownCamera({ id });
        const unavailable = new UpstreamUnavailable({ source: new URL(url).host });
        const response = yield* client
          .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader('accept', 'image/*')))
          .pipe(
            Effect.timeout('10 seconds'),
            Effect.mapError(() => unavailable),
          );
        const contentType = response.headers['content-type'] ?? '';
        if (!/^image\/(jpeg|png|gif|webp)\b/.test(contentType)) return yield* unavailable;
        const bytes = new Uint8Array(
          yield* response.arrayBuffer.pipe(
            Effect.timeout('10 seconds'),
            Effect.mapError(() => unavailable),
          ),
        );
        if (bytes.byteLength > MAX_BYTES) return yield* unavailable;
        return { bytes, contentType: contentType.split(';')[0] ?? contentType };
      });

      return CameraRelay.of({ frame });
    }),
  );
}
