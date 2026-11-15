import { readFileSync } from 'node:fs';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

/** Answers for upstream requests; return undefined to answer 404. */
export type Upstream = (call: Call) => Response | undefined;

const json = (body: string, init: { readonly headers?: Record<string, string> } = {}) =>
  new Response(body, { headers: { 'content-type': 'application/json', ...init.headers } });

/** Every source answered from the recorded fixtures. */
export const recorded: Upstream = ({ url }) => {
  switch (url.host) {
    case 'opensky-network.org':
      return json(fixture('opensky.json'));
    case 'celestrak.org':
      return json(fixture('celestrak.json'), {
        headers: { 'last-modified': 'Sun, 15 Nov 2026 22:00:00 GMT' },
      });
    case 'earthquake.usgs.gov':
      return json(fixture('usgs.geojson'), { headers: { 'last-modified': 'Sun, 15 Nov 2026 22:18:37 GMT' } });
    case 'firms.modaps.eosdis.nasa.gov':
      return new Response(fixture('firms.csv'), { headers: { etag: '"firms-1"' } });
    case 'eonet.gsfc.nasa.gov':
      return json(fixture('eonet.json'));
    case 'api.rainviewer.com':
      return json(fixture('rainviewer.json'));
    default:
      return undefined;
  }
};

/** An `HttpClient` that answers from `upstream` and records each call. */
export const fakeHttp = (upstream: Upstream = recorded) => {
  const calls: Call[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const call: Call = { method: request.method, url, headers: request.headers };
      calls.push(call);
      return HttpClientResponse.fromWeb(
        request,
        upstream(call) ?? new Response('not found', { status: 404 }),
      );
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient)(client), calls };
};
