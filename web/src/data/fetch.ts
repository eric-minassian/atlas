import { Schema } from 'effect';

/** GETs JSON from a third-party API and decodes it with `schema`. */
export const fetchJson = async <S extends Schema.Top & { readonly DecodingServices: never }>(
  url: string,
  schema: S,
  init: { readonly signal?: AbortSignal; readonly headers?: Record<string, string> } = {},
): Promise<S['Type']> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return Schema.decodeUnknownPromise(schema)(await response.json());
};

/**
 * Wikimedia asks every client to identify itself. Browsers can't set
 * `User-Agent`, so its APIs accept `Api-User-Agent` (allowed by their CORS).
 */
export const wikimediaHeaders = (): Record<string, string> => ({
  'Api-User-Agent': `Atlas (${window.location.origin})`,
});
