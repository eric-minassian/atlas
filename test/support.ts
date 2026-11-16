import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Platform } from '@ericminassian/platform';
import { Effect, Layer, type Option } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { FeedData, FeedId } from '../src/domain.ts';
import type { IngestResult, Source } from '../src/ingest/source.ts';

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

/**
 * OVATION's grid is 65,160 cells (900 KB); the fixture is its 0° meridian,
 * repeated around the globe so the source sees a whole grid.
 */
export const ovation = (): string => {
  const meridian = JSON.parse(fixture('ovation-meridian.json')) as {
    coordinates: Array<[number, number, number]>;
  };
  const coordinates: Array<[number, number, number]> = [];
  for (let lon = 0; lon < 360; lon++)
    for (const [, lat, p] of meridian.coordinates) coordinates.push([lon, lat, p]);
  return JSON.stringify({ ...meridian, coordinates });
};

/** Upstream answers for the weather and hazard sources, by host and path. */
const hazards = (url: URL): Response | undefined => {
  const path = url.pathname;
  switch (url.host) {
    case 'aviationweather.gov':
      // Served as a gzip file, as AWC does: no Content-Encoding.
      return new Response(gzipSync(fixture('metars.csv')), {
        headers: { 'content-type': 'application/octet-stream', etag: '"metars-1"' },
      });
    case 'www.ndbc.noaa.gov':
      return path.endsWith('latest_obs.txt')
        ? new Response(fixture('ndbc.txt'))
        : path.endsWith('station_table.txt')
          ? new Response(fixture('ndbc-stations.txt'))
          : undefined;
    case 'data.sensor.community':
      return json(fixture('sensor-community.json'));
    case 'www.gdacs.org': {
      if (path.endsWith('/EVENTS4APP')) return json(fixture('gdacs-current.json'));
      if (path.endsWith('/SEARCH'))
        return url.searchParams.get('pagenumber') === '1'
          ? json(fixture('gdacs-significant.json'))
          : new Response(null, { status: 204 });
      const type = url.searchParams.get('eventtype');
      if (path.endsWith('/getgeometry') && type === 'TC') return json(fixture('gdacs-tc-geometry.json'));
      if (path.endsWith('/getgeometry') && type === 'DR') return json(fixture('gdacs-dr-geometry.json'));
      return undefined;
    }
    case 'www.tsunami.gov':
      return path.endsWith('PAAQAtom.xml')
        ? new Response(fixture('tsunami-ntwc.xml'))
        : path.endsWith('PHEBAtom.xml')
          ? new Response(fixture('tsunami-ptwc.xml'))
          : undefined;
    case 'api.weather.gov':
      if (path === '/alerts/active') return json(fixture('nws-alerts.json'));
      // One zone NWS has no outline for; every other zone gets the recorded one.
      if (path === '/zones/forecast/PKZ672') return undefined;
      return path.startsWith('/zones/') ? json(fixture('nws-zone.json')) : undefined;
    case 'services3.arcgis.com':
      return json(fixture('wfigs.geojson'));
    case 'webservices.volcano.si.edu':
      return (url.searchParams.get('typeName') ?? '').endsWith('Holocene_Volcanoes')
        ? json(fixture('gvp-volcanoes.json'))
        : json(fixture('gvp-eruptions.json'));
    case 'services.swpc.noaa.gov':
      return json(ovation(), { headers: { etag: '"ovation-1"' } });
    case 'mapservices.weather.noaa.gov':
      return json(fixture('nws-gauges.json'));
    case 'environment.data.gov.uk':
      if (path.endsWith('/id/stations')) return json(fixture('ea-stations.json'));
      if (path.endsWith('/data/readings')) return json(fixture('ea-readings.json'));
      if (path.endsWith('/id/floods')) return json(fixture('ea-floods.json'));
      return path.endsWith('/id/floodAreas/031WAF213') ? json(fixture('ea-flood-area.json')) : undefined;
    case 'www.pegelonline.wsv.de':
      return json(fixture('pegelonline.json'));
    default:
      return undefined;
  }
};

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
      return recordedGbfs ? json(fixture(recordedGbfs)) : hazards(url);
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

/** Runs a source's read against `upstream` on the in-memory platform, with `previous` as the published payload. */
export const readSource = <F extends FeedId>(
  source: Source<F>,
  upstream?: Upstream,
  previous: Effect.Effect<Option.Option<FeedData[F]>> = Effect.succeedNone,
) => {
  const http = fakeHttp(upstream);
  return source.read({}, previous).pipe(
    Effect.provide(Layer.merge(http.layer, Platform.layerMemory())),
    Effect.map((result) => ({ result, calls: http.calls })),
  );
};

/** The payload of an update; fails the test on anything else. */
export const updatedData = <F extends FeedId>(result: IngestResult<F>): FeedData[F] => {
  if (result._tag !== 'Updated') throw new Error(`expected an update, got ${result._tag}`);
  return result.data;
};
