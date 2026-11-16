import { readFileSync } from 'node:fs';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export const fixtureBytes = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

export interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

/** Answers for upstream requests; return undefined to answer 404. */
export type Upstream = (call: Call) => Response | undefined;

const json = (body: string, init: { readonly headers?: Record<string, string> } = {}) =>
  new Response(body, { headers: { 'content-type': 'application/json', ...init.headers } });

/** Serves `bytes` the way object stores do: HEAD for the length, `Range` for parts. */
export const ranged = (bytes: Uint8Array<ArrayBuffer>, call: Call): Response => {
  if (call.method === 'HEAD')
    return new Response(null, { headers: { 'content-length': String(bytes.length) } });
  const range = /^bytes=(\d+)-(\d+)$/.exec(call.headers.range ?? '');
  if (!range) return new Response(bytes);
  const start = Number(range[1]);
  const end = Math.min(bytes.length - 1, Number(range[2]));
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
  });
};

const EMPTY_LISTING =
  '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>';

/** GBFS documents recorded from Citi Bike, Vélib' and Dott, by URL path. */
const gbfs: Readonly<Record<string, string>> = {
  'gbfs.citibikenyc.com/gbfs/2.3/gbfs.json': 'gbfs/citibike-gbfs.json',
  'gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json': 'gbfs/nyc-station_information.json',
  'gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json': 'gbfs/nyc-station_status.json',
  'gbfs.lyft.com/gbfs/2.3/bkn/en/vehicle_types.json': 'gbfs/nyc-vehicle_types.json',
  'velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/gbfs.json': 'gbfs/velib-gbfs.json',
  'velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_information.json':
    'gbfs/velib-station_information.json',
  'velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_status.json':
    'gbfs/velib-station_status.json',
  'gbfs.api.ridedott.com/public/v2/abu-dhabi/gbfs.json': 'gbfs/dott-gbfs.json',
};

/** Every source answered from the recorded fixtures. */
export const recorded: Upstream = (call) => {
  const { url } = call;
  switch (url.host) {
    case 'opendata.adsb.fi':
      return json(fixture('adsbfi.json'));
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
    case 'meri.digitraffic.fi':
      if (url.pathname === '/api/ais/v1/locations') return json(fixture('digitraffic-locations.json'));
      if (url.pathname === '/api/ais/v1/vessels') return json(fixture('digitraffic-vessels.json'));
      return undefined;
    case 'davidmegginson.github.io':
      if (url.pathname === '/ourairports-data/airports.csv')
        return new Response(fixture('ourairports-airports.csv'), { headers: { etag: '"airports-1"' } });
      if (url.pathname === '/ourairports-data/runways.csv')
        return new Response(fixture('ourairports-runways.csv'));
      return undefined;
    case 'files.mobilitydatabase.org':
      if (url.pathname === '/feeds_v2.csv')
        return new Response(fixture('mobilitydatabase.csv'), { headers: { etag: '"mdb-1"' } });
      if (url.pathname === '/mdb-437/latest.zip') return ranged(fixtureBytes('mbta-gtfs.zip'), call);
      return undefined;
    case 'cdn.mbta.com':
      return new Response(fixtureBytes('mbta-vehicles.pb'), {
        headers: { 'content-type': 'application/x-protobuf' },
      });
    case 'raw.githubusercontent.com':
      return url.pathname === '/MobilityData/gbfs/master/systems.csv'
        ? new Response(fixture('gbfs/systems.csv'))
        : undefined;
    case 'noaa-goes19.s3.amazonaws.com':
      if (url.pathname === '/')
        return new Response(
          url.searchParams.get('prefix') === 'GLM-L2-LCFA/2026/320/00/'
            ? fixture('glm-listing.xml')
            : EMPTY_LISTING,
        );
      return new Response(fixtureBytes('glm-g19.nc'));
    case 'noaa-goes18.s3.amazonaws.com':
      return url.pathname === '/' ? new Response(EMPTY_LISTING) : undefined;
    default: {
      const recordedGbfs = gbfs[`${url.host}${url.pathname}`];
      return recordedGbfs ? json(fixture(recordedGbfs)) : undefined;
    }
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
