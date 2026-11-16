import type { Secrets } from '@ericminassian/platform';
/**
 * The contract every source implements, and the HTTP plumbing they share.
 *
 * A source reads one upstream dataset and normalizes it into its feed's
 * payload (`FeedData` in src/domain.ts). Sources are pure with respect to
 * storage: `Refresher` (src/refresh.ts) decides when they run and what happens
 * to their output.
 */
import { Effect, type Option, Schema } from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http';
import type { FeedData, FeedId } from '../domain.ts';

/** HTTP cache validators from the previous successful read. */
export interface Validators {
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
}

export type IngestResult<F extends FeedId> =
  | {
      readonly _tag: 'Updated';
      readonly data: FeedData[F];
      readonly count: number;
      readonly validators: Validators;
    }
  | { readonly _tag: 'NotModified' };

export class IngestError extends Schema.TaggedError<IngestError, { readonly brand: unique symbol }>()(
  'IngestError',
  {
    message: Schema.String,
  },
) {}

export interface Source<F extends FeedId> {
  /** Seconds between refreshes; may depend on configuration (credentials). */
  readonly interval: Effect.Effect<number, never, Secrets>;
  /**
   * Reads the source. `previous` loads the payload currently published, for
   * sources that build on it (a stream sampled for a minute only sees part of
   * the world); it costs a storage read and a decode, so only those run it.
   */
  readonly read: (
    validators: Validators,
    previous: Effect.Effect<Option.Option<FeedData[F]>>,
  ) => Effect.Effect<IngestResult<F>, IngestError, HttpClient.HttpClient | Secrets>;
}

export const updated = <F extends FeedId>(
  data: FeedData[F],
  count: number,
  response?: HttpClientResponse.HttpClientResponse,
): IngestResult<F> => ({
  _tag: 'Updated',
  data,
  count,
  validators: response
    ? { etag: response.headers.etag, lastModified: response.headers['last-modified'] }
    : {},
});

export const notModified = { _tag: 'NotModified' } as const;

const USER_AGENT = 'atlas/0.1 (world model aggregator)';

/**
 * GETs `url` with the previous validators, so unchanged sources answer 304.
 * Non-2xx answers other than 304 are left to the caller (some sources use 403
 * or 429 to say something specific).
 */
export const get = Effect.fnUntraced(function* (
  url: string,
  options: { readonly validators?: Validators; readonly headers?: Record<string, string> } = {},
) {
  const client = yield* HttpClient.HttpClient;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...options.headers };
  if (options.validators?.etag) headers['if-none-match'] = options.validators.etag;
  if (options.validators?.lastModified) headers['if-modified-since'] = options.validators.lastModified;
  return yield* client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers))).pipe(
    Effect.timeout('60 seconds'),
    Effect.mapError((cause) => new IngestError({ message: `GET ${hostOf(url)}: ${describe(cause)}` })),
  );
});

/** Reads a 2xx body as text, failing with the status and a snippet of the body otherwise. */
export const okText = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  const text = yield* response.text.pipe(
    Effect.mapError((cause) => new IngestError({ message: `reading the response: ${describe(cause)}` })),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new IngestError({ message: `HTTP ${response.status}: ${text.slice(0, 200).trim()}` });
  }
  return text;
});

/** Decodes a JSON body with `schema`, reporting where it didn't match. */
export const decodeJson = <S extends Schema.Top>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (text: string) =>
    decode(text).pipe(
      Effect.mapError((error) => new IngestError({ message: `unexpected response: ${error.message}` })),
    );
};

const hostOf = (url: string) => new URL(url).host;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String(cause);

/** A columnar payload under construction: its arrays writable. */
export type Columns<T> = {
  -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K];
};

/** Rounds to `digits` decimals, to keep snapshots small. */
export const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
