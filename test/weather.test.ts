import { assert, describe, it } from '@effect/vitest';
import { Platform, Storage } from '@ericminassian/platform';
import { Effect, Layer, Option } from 'effect';
import { makeAirQualitySource, parseAirQuality, Readings } from '../src/ingest/airquality.ts';
import { HEIGHT, makeAuroraSource, parseOvation, WIDTH } from '../src/ingest/aurora.ts';
import { makeBuoySource, parseBuoys, parseStationNames } from '../src/ingest/buoys.ts';
import { makeMetarSource, parseMetars, splitCsv } from '../src/ingest/metars.ts';
import { IngestError } from '../src/ingest/source.ts';
import { makeWeatherAlertSource, MAX_NEW_ZONES, ZONE_CACHE_KEY } from '../src/ingest/weatheralerts.ts';
import { fakeHttp, fixture, ovation, readSource, recorded, type Upstream, updatedData } from './support.ts';

describe('weather stations (METAR)', () => {
  it('splits quoted CSV fields', () => {
    assert.deepStrictEqual(splitCsv('"METAR KSFO 160013Z, A3002",KSFO,,1.5,'), [
      'METAR KSFO 160013Z, A3002',
      'KSFO',
      '',
      '1.5',
      '',
    ]);
    assert.deepStrictEqual(splitCsv('"say ""hi""",x'), ['say "hi"', 'x']);
  });

  it('parses observations, keeping each station once and its latest report', () => {
    const parsed = parseMetars(fixture('metars.csv'));
    if (parsed instanceof IngestError) throw parsed;
    const { data, skipped } = parsed;
    assert.strictEqual(skipped, 1); // NCPL reports no position
    assert.strictEqual(data.station.length, 7);
    assert.strictEqual(data.station.filter((s) => s === 'KSFO').length, 1);
    const at = (station: string) => data.station.indexOf(station);
    const sfo = at('KSFO');
    assert.strictEqual(data.temperature[sfo], 12.8);
    assert.strictEqual(data.weather[sfo], '+RA BR');
    assert.strictEqual(data.flightCategory[sfo], 'IFR');
    assert.strictEqual(
      data.since + (data.observed[sfo] as number) * 60_000,
      Date.parse('2026-11-16T00:13:00Z'),
    );
    assert.include(data.raw[sfo], 'SPECI KSFO 160013Z');
    // Calm, and variable (VRB, written as 0°): no direction.
    assert.deepStrictEqual([data.windSpeed[at('KP69')], data.windDirection[at('KP69')]], [0, null]);
    assert.deepStrictEqual([data.windSpeed[at('KATT')], data.windDirection[at('KATT')]], [5, null]);
    assert.strictEqual(data.flightCategory[at('KP69')], null);
    assert.strictEqual(data.visibility[at('KUNV')], '10+');
    assert.strictEqual(data.altimeter[at('EGLL')], 29.53);
  });

  it('rejects a file without the expected columns', () => {
    assert.instanceOf(parseMetars('station_id,latitude\nKSFO,1\n'), IngestError);
  });

  it.effect('gunzips the cache file and keeps its ETag', () =>
    Effect.gen(function* () {
      const { result } = yield* readSource(makeMetarSource());
      assert.strictEqual(updatedData(result).station.length, 7);
      assert.strictEqual(result._tag === 'Updated' && result.validators.etag, '"metars-1"');
    }),
  );

  it.effect('reads a body that arrives already decompressed', () =>
    Effect.gen(function* () {
      const { result } = yield* readSource(makeMetarSource(), () => new Response(fixture('metars.csv')));
      assert.strictEqual(updatedData(result).station.length, 7);
    }),
  );
});

describe('ocean buoys (NDBC)', () => {
  it('parses the fixed-width file and joins station names', () => {
    const names = parseStationNames(fixture('ndbc-stations.txt'));
    const parsed = parseBuoys(fixture('ndbc.txt'), names);
    if (parsed instanceof IngestError) throw parsed;
    const { data } = parsed;
    assert.deepStrictEqual(data.station, ['22101', '32ST0', '46026', 'BURL1']);
    const sf = data.station.indexOf('46026');
    assert.strictEqual(data.name[sf], 'SAN FRANCISCO - 18NM West of San Francisco, CA');
    assert.deepStrictEqual(
      [data.waveHeight[sf], data.wavePeriod[sf], data.waveDirection[sf], data.windDirection[sf]],
      [3.9, 15, 271, 360],
    );
    assert.strictEqual(data.waterTemperature[sf], 18.5);
    assert.strictEqual(data.pressure[sf], 1016.4);
    assert.strictEqual(data.airTemperature[sf], null);
    assert.strictEqual(data.name[data.station.indexOf('32ST0')], '');
    assert.strictEqual(data.waveHeight[data.station.indexOf('BURL1')], null);
    assert.strictEqual(data.since, Date.parse('2026-11-15T23:30:00Z'));
    assert.deepStrictEqual(data.observed, [30, 0, 50, 30]);
  });

  it.effect('keeps the published names when the station table is unavailable', () =>
    Effect.gen(function* () {
      const previous = parseBuoys(fixture('ndbc.txt'), parseStationNames(fixture('ndbc-stations.txt')));
      if (previous instanceof IngestError) throw previous;
      const { result } = yield* readSource(
        makeBuoySource(),
        (call) =>
          call.url.pathname.endsWith('station_table.txt')
            ? new Response('busy', { status: 503 })
            : recorded(call),
        Effect.succeedSome(previous.data),
      );
      const data = updatedData(result);
      assert.strictEqual(
        data.name[data.station.indexOf('46026')],
        'SAN FRANCISCO - 18NM West of San Francisco, CA',
      );
    }),
  );
});

describe('air quality sensors (Sensor.Community)', () => {
  it('keeps plausible outdoor readings, one per location', () => {
    const { data, dropped } = parseAirQuality(
      JSON.parse(fixture('sensor-community.json')) as typeof Readings.Type,
    );
    // Saturated (999.9), negative, and PM2.5 well above PM10.
    assert.strictEqual(dropped, 3);
    assert.sameMembers([...data.sensor], [151, 249, 261, 1140, 417]);
    assert.notInclude([...data.sensor], 11586); // indoor
    // Two sensors at one spot: the newer reading wins.
    assert.notInclude([...data.sensor], 107);
    const i = data.sensor.indexOf(1140);
    assert.deepStrictEqual([data.pm25[i], data.pm10[i], data.model[i]], [70.9, 75.2, 'SDS011']);
    assert.strictEqual(data.since, Date.parse('2026-11-16T00:53:34Z'));
  });

  it.effect('reads the file again when the connection drops partway through', () => {
    let calls = 0;
    const dropsOnce: Upstream = (call) => {
      calls++;
      if (calls > 1) return recorded(call);
      const body = new ReadableStream({
        start: (controller) => controller.error(new Error('connection reset')),
      });
      return new Response(body);
    };
    return Effect.gen(function* () {
      const { result } = yield* readSource(makeAirQualitySource(), dropsOnce);
      assert.strictEqual(updatedData(result).sensor.length, 5);
      assert.strictEqual(calls, 2);
    });
  });

  it.effect('reads the dust-sensor file', () =>
    Effect.gen(function* () {
      const { result, calls } = yield* readSource(makeAirQualitySource());
      assert.strictEqual(updatedData(result).sensor.length, 5);
      assert.strictEqual(calls[0]?.url.pathname, '/static/v2/data.dust.min.json');
    }),
  );
});

describe('aurora (SWPC OVATION)', () => {
  const grid = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  it('packs the grid into one byte per cell', () => {
    const data = parseOvation(JSON.parse(ovation()) as Parameters<typeof parseOvation>[0]);
    if (data instanceof IngestError) throw data;
    assert.strictEqual(data.observed, Date.parse('2026-11-16T00:53:00Z'));
    assert.strictEqual(data.forecast, Date.parse('2026-11-16T02:10:00Z'));
    const cells = grid(data.grid);
    assert.strictEqual(cells.length, WIDTH * HEIGHT);
    // 78° S on the meridian, and the same latitude halfway round.
    assert.strictEqual(cells[(90 - 78) * WIDTH], 14);
    assert.strictEqual(cells[(90 - 78) * WIDTH + 180], 14);
    assert.strictEqual(cells[(90 + 30) * WIDTH], 0);
  });

  it('rejects a partial grid', () => {
    const partial = { ...JSON.parse(ovation()), coordinates: [[0, 0, 5]] } as Parameters<
      typeof parseOvation
    >[0];
    assert.instanceOf(parseOvation(partial), IngestError);
  });

  it.effect('counts the cells where aurora is likely', () =>
    Effect.gen(function* () {
      const { result } = yield* readSource(makeAuroraSource());
      if (result._tag !== 'Updated') throw new Error('expected an update');
      const meridian = (JSON.parse(fixture('ovation-meridian.json')) as { coordinates: number[][] })
        .coordinates;
      assert.strictEqual(result.count, 360 * meridian.filter(([, , p]) => (p as number) >= 10).length);
      assert.strictEqual(result.validators.etag, '"ovation-1"');
    }),
  );
});

describe('US weather alerts (NWS)', () => {
  const zoneCalls = (calls: ReadonlyArray<{ readonly url: URL }>) =>
    calls.filter((c) => c.url.pathname.startsWith('/zones/')).length;

  it.effect('draws alerts with their own outline or their zones’, fetching each zone once', () => {
    const platform = Platform.layerMemory();
    const http = fakeHttp();
    return Effect.gen(function* () {
      const store = (yield* Storage).store('snapshots');
      const source = makeWeatherAlertSource(store);
      const first = updatedData(yield* source.read({}, Effect.succeedNone));
      assert.strictEqual(first.alerts.length, 4);
      assert.strictEqual(first.alerts[0]?.severity, 'Severe');
      const marine = first.alerts.find((a) => a.event === 'Special Marine Warning');
      assert.strictEqual(marine?.polygons.length, 1);
      // Eleven zones; NWS has no outline for one of them.
      assert.strictEqual(zoneCalls(http.calls), 11);
      assert.strictEqual(Object.keys(first.zones).length, 10);
      assert.isUndefined(first.zones['forecast/PKZ672']);
      assert.strictEqual(first.pendingZones, 0);
      assert.isTrue(Option.isSome(yield* store.getText(ZONE_CACHE_KEY)));

      // The same worker remembers them, and a new one reads them from the store.
      yield* source.read({}, Effect.succeedNone);
      yield* makeWeatherAlertSource(store).read({}, Effect.succeedNone);
      assert.strictEqual(zoneCalls(http.calls), 11);
      // Tests and exercises are left out.
      assert.strictEqual(http.calls[0]?.url.searchParams.get('status'), 'actual');
    }).pipe(Effect.provide(Layer.merge(platform, http.layer)));
  });

  it.effect('fetches a bounded number of new zones per refresh, the rest on later ones', () => {
    const recordedAlerts = JSON.parse(fixture('nws-alerts.json')) as {
      features: Array<{ geometry: unknown; properties: { affectedZones: string[] } }>;
    };
    const first = recordedAlerts.features.find((f) => f.geometry === null);
    if (!first) throw new Error('fixture has no zone-based alert');
    const zones = Array.from(
      { length: MAX_NEW_ZONES + 10 },
      (_, i) => `https://api.weather.gov/zones/forecast/TXZ${100 + i}`,
    );
    const many = {
      ...recordedAlerts,
      features: [{ ...first, properties: { ...first.properties, affectedZones: zones } }],
    };
    const upstream: Upstream = (call) =>
      call.url.pathname === '/alerts/active' ? Response.json(many) : recorded(call);
    const http = fakeHttp(upstream);
    return Effect.gen(function* () {
      const source = makeWeatherAlertSource((yield* Storage).store('snapshots'));
      const before = updatedData(yield* source.read({}, Effect.succeedNone));
      assert.strictEqual(zoneCalls(http.calls), MAX_NEW_ZONES);
      assert.strictEqual(before.pendingZones, 10);
      const after = updatedData(yield* source.read({}, Effect.succeedNone));
      assert.strictEqual(zoneCalls(http.calls), MAX_NEW_ZONES + 10);
      assert.strictEqual(after.pendingZones, 0);
    }).pipe(Effect.provide(Layer.merge(Platform.layerMemory(), http.layer)));
  });

  it.effect('fails when the alert list is unavailable', () => {
    const http = fakeHttp(() => new Response('down', { status: 503 }));
    return Effect.gen(function* () {
      const source = makeWeatherAlertSource((yield* Storage).store('snapshots'));
      const error = yield* Effect.flip(source.read({}, Effect.succeedNone));
      assert.include(error.message, 'HTTP 503');
    }).pipe(Effect.provide(Layer.merge(Platform.layerMemory(), http.layer)));
  });
});
