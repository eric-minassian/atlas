import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import type { FeedId } from '../src/domain.ts';
import { makeAirportSource, parseAirports } from '../src/ingest/airports.ts';
import { makeBikeSystemSource, mergeSystems, nextBatch, parseSystems } from '../src/ingest/bike-systems.ts';
import { makeEarthquakeSource } from '../src/ingest/earthquakes.ts';
import { makeEventSource } from '../src/ingest/events.ts';
import { makeFireSource, parseFires } from '../src/ingest/fires.ts';
import { makeRadarSource } from '../src/ingest/radar.ts';
import { groupOf, makeSatelliteSource } from '../src/ingest/satellites.ts';
import { IngestError, type IngestResult, type Source } from '../src/ingest/source.ts';
import { parseTransitFeeds } from '../src/ingest/transit-feeds.ts';
import { fakeHttp, fixture, recorded, type Upstream } from './support.ts';

/** Runs a source's read against `upstream`, with optional secrets. */
const read = <F extends FeedId>(
  source: Source<F>,
  upstream?: Upstream,
  secrets: Record<string, string> = {},
) => {
  const http = fakeHttp(upstream);
  return source.read({}, Effect.succeedNone).pipe(
    Effect.provide(Layer.merge(http.layer, Platform.layerMemory({ secrets }))),
    Effect.map((result) => ({ result, calls: http.calls })),
  );
};

const updatedData = <F extends FeedId>(result: IngestResult<F>) => {
  if (result._tag !== 'Updated') throw new Error(`expected an update, got ${result._tag}`);
  return result;
};

describe('satellites (CelesTrak)', () => {
  it.effect('reads elements and sorts satellites into groups', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeSatelliteSource());
      const { data, validators } = updatedData(result);
      assert.deepStrictEqual(data.group, ['station', 'starlink', 'gnss', 'gnss', 'weather', 'other']);
      assert.strictEqual(data.noradId[0], 25544);
      assert.strictEqual(validators.lastModified, 'Sun, 15 Nov 2026 22:00:00 GMT');
    }),
  );

  it.effect('treats a repeat download within the update cycle as unchanged', () =>
    Effect.gen(function* () {
      const { result } = yield* read(
        makeSatelliteSource(),
        () =>
          new Response(
            'GP data has not updated since your last successful download of GROUP=active at 2026-11-15 22:19:06 UTC.',
            { status: 403 },
          ),
      );
      assert.strictEqual(result._tag, 'NotModified');
    }),
  );

  it.effect('fails on other refusals', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.map(
          read(makeSatelliteSource(), () => new Response('blocked', { status: 403 })),
          (r) => r.result,
        ),
      );
      assert.include(error.message, 'HTTP 403');
    }),
  );

  it('classifies GLONASS by its navigation orbit', () => {
    assert.strictEqual(
      groupOf({ OBJECT_NAME: 'COSMOS 2433 (720)', MEAN_MOTION: 2.131, INCLINATION: 64.8 }),
      'gnss',
    );
    assert.strictEqual(
      groupOf({ OBJECT_NAME: 'COSMOS 2558', MEAN_MOTION: 15.2, INCLINATION: 97.6 }),
      'other',
    );
  });
});

describe('earthquakes (USGS)', () => {
  it.effect('normalizes features and sends validators on the next read', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeEarthquakeSource());
      const { data, validators } = updatedData(result);
      assert.strictEqual(data.events.length, 3);
      const [first] = data.events;
      assert.isString(first?.id);
      assert.isTrue(Number.isFinite(first?.depth));
      assert.strictEqual(validators.lastModified, 'Sun, 15 Nov 2026 22:18:37 GMT');

      const http = fakeHttp(({ headers }) =>
        headers['if-modified-since'] ? new Response(null, { status: 304 }) : undefined,
      );
      const again = yield* makeEarthquakeSource()
        .read(validators, Effect.succeedNone)
        .pipe(Effect.provide(Layer.merge(http.layer, Platform.layerMemory())));
      assert.strictEqual(again._tag, 'NotModified');
    }),
  );
});

describe('fires (FIRMS)', () => {
  it('parses detections, skipping malformed rows', () => {
    const parsed = parseFires(fixture('firms.csv'));
    if (parsed instanceof IngestError) throw parsed;
    const { data, skipped } = parsed;
    assert.strictEqual(skipped, 2);
    assert.strictEqual(data.lat.length, 5);
    assert.strictEqual(data.since, Date.parse('2026-11-14T00:41:00Z'));
    assert.deepStrictEqual(data.acquired, [6, 0, 6, 0, 744]);
    assert.deepStrictEqual(data.confidence, [1, 1, 1, 1, 2]);
    assert.deepStrictEqual(data.day, [0, 0, 0, 0, 1]);
  });

  it('rejects a file without the expected columns', () => {
    assert.instanceOf(parseFires('lat,lon\n1,2\n'), IngestError);
  });

  it.effect('keeps the ETag for a conditional read', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeFireSource());
      assert.strictEqual(updatedData(result).validators.etag, '"firms-1"');
    }),
  );
});

describe('natural events (EONET)', () => {
  it.effect('places events at their latest observation and keeps earlier ones as a track', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeEventSource());
      const { data } = updatedData(result);
      const storm = data.events.find((e) => e.category === 'severeStorms');
      assert.isDefined(storm);
      assert.isAbove(storm?.track.length ?? 0, 1);
      const volcano = data.events.find((e) => e.id === 'EONET_TEST_POLY');
      assert.deepStrictEqual([volcano?.lon, volcano?.lat], [11, 21]);
      assert.deepStrictEqual(volcano?.track, []);
    }),
  );
});

describe('radar (RainViewer)', () => {
  it.effect('lists frames oldest first', () =>
    Effect.gen(function* () {
      const { result } = yield* read(makeRadarSource());
      const { data } = updatedData(result);
      assert.strictEqual(data.host, 'https://tilecache.rainviewer.com');
      const times = data.frames.map((f) => f.time);
      assert.deepStrictEqual(
        times,
        times.toSorted((a, b) => a - b),
      );
    }),
  );
});

describe('airports (OurAirports)', () => {
  it('keeps open airports and their open runways', () => {
    const parsed = parseAirports(fixture('ourairports-airports.csv'), fixture('ourairports-runways.csv'));
    if (parsed instanceof IngestError) throw parsed;
    const { airports, runways } = parsed.data;
    assert.strictEqual(parsed.skipped, 0);
    // The closed heliport is gone, with its runway.
    assert.notInclude([...airports.ident], '3MA8');
    assert.deepStrictEqual([...airports.type].toSorted(), [
      'balloonport',
      'heliport',
      'large',
      'large',
      'medium',
      'seaplane',
      'small',
      'small',
      'small',
    ]);
    const bos = airports.ident.indexOf('KBOS');
    assert.deepStrictEqual(
      [
        airports.name[bos],
        airports.iata[bos],
        airports.icao[bos],
        airports.municipality[bos],
        airports.elevation[bos],
      ],
      ['Boston Logan International Airport', 'BOS', 'KBOS', 'Boston', 20],
    );
    assert.isTrue(airports.scheduled[bos]);
    assert.strictEqual(airports.wikipedia[bos], 'https://en.wikipedia.org/wiki/Logan_International_Airport');
    // Quoted names keep their commas.
    assert.include([...airports.name], 'Airnautique, Inc. Airport');

    const bosRunways = runways.airport.flatMap((a, r) => (a === bos ? [r] : []));
    assert.strictEqual(bosRunways.length, 6);
    const r = runways.low.indexOf('04R');
    assert.deepStrictEqual(
      [runways.high[r], runways.length[r], runways.width[r], runways.surface[r], runways.lighted[r]],
      ['22L', 10006, 150, 'ASP', true],
    );
    assert.isNotNull(runways.lowLat[r]);
    // 13NC's 09/27 is closed.
    const oakGrove = airports.ident.indexOf('13NC');
    assert.deepStrictEqual(
      runways.airport.flatMap((a, k) => (a === oakGrove ? [runways.low[k]] : [])),
      ['01', '05'],
    );
  });

  it('rejects a file without the expected columns', () => {
    assert.instanceOf(parseAirports('id,name\n1,x\n', fixture('ourairports-runways.csv')), IngestError);
  });

  it.effect('reads both files, and treats an unchanged airports file as no change', () =>
    Effect.gen(function* () {
      const { result, calls } = yield* read(makeAirportSource());
      const { count, validators } = updatedData(result);
      assert.strictEqual(count, 9);
      assert.strictEqual(validators.etag, '"airports-1"');
      assert.deepStrictEqual(
        calls.map((c) => c.url.pathname),
        ['/ourairports-data/airports.csv', '/ourairports-data/runways.csv'],
      );
      const http = fakeHttp(({ headers }) =>
        headers['if-none-match'] === '"airports-1"' ? new Response(null, { status: 304 }) : undefined,
      );
      const again = yield* makeAirportSource()
        .read(validators, Effect.succeedNone)
        .pipe(Effect.provide(Layer.merge(http.layer, Platform.layerMemory())));
      assert.strictEqual(again._tag, 'NotModified');
      assert.strictEqual(http.calls.length, 1);
    }),
  );
});

describe('transit feeds (Mobility Database)', () => {
  it('lists active keyless vehicle-position feeds with the area each covers', () => {
    const parsed = parseTransitFeeds(fixture('mobilitydatabase.csv'));
    if (parsed instanceof IngestError) throw parsed;
    const { data, unplaced } = parsed;
    // Not the keyed Miami feed, the deprecated Vy duplicate, trip updates, or static feeds.
    assert.deepStrictEqual(data.id, ['mdb-1602', 'mdb-3229', 'mdb-1801', 'tdg-84015']);
    const mbta = data.id.indexOf('mdb-1602');
    assert.strictEqual(data.url[mbta], 'https://cdn.mbta.com/realtime/VehiclePositions.pb');
    assert.deepStrictEqual(
      [data.west[mbta], data.south[mbta], data.east[mbta], data.north[mbta]],
      [-71.848488, 41.581095, -70.276583, 42.797837],
    );
    assert.deepStrictEqual(data.schedules[mbta], ['https://files.mobilitydatabase.org/mdb-437/latest.zip']);
    // tdg-84015 has no area of its own; its static feed does.
    assert.isAbove(data.north[data.id.indexOf('tdg-84015')] ?? 0, 0);
    // motionbuscard has neither.
    assert.strictEqual(unplaced, 1);
  });
});

describe('bike-share systems (GBFS)', () => {
  it('lists systems that need no key', () => {
    const listed = parseSystems(fixture('gbfs/systems.csv'));
    if (listed instanceof IngestError) throw listed;
    assert.deepStrictEqual(
      listed.map((s) => s.id),
      ['lime_antwerp', 'Paris', 'lyft_nyc', 'dott-abu-dhabi'],
    );
  });

  it.effect('locates a batch of systems from their station feeds', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_794_792_000_000);
      const { result } = yield* read(makeBikeSystemSource());
      const { data, count } = updatedData(result);
      assert.strictEqual(count, 2);
      const nyc = data.id.indexOf('lyft_nyc');
      assert.strictEqual(data.stations[nyc], 8);
      assert.strictEqual(data.status[nyc], 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json');
      assert.strictEqual(data.vehicleTypes[nyc], 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/vehicle_types.json');
      assert.isTrue((data.west[nyc] ?? 0) < -73.9 && (data.north[nyc] ?? 0) > 40.7);
      const paris = data.id.indexOf('Paris');
      assert.strictEqual(data.stations[paris], 8);
      assert.strictEqual(data.vehicleTypes[paris], '');
      // Lime Antwerp's feed is gone, Dott's stations didn't answer: checked, nothing found.
      for (const id of ['lime_antwerp', 'dott-abu-dhabi']) {
        const i = data.id.indexOf(id);
        assert.deepStrictEqual([data.checkedAt[i], data.stations[i], data.west[i]], [1_794_792_000, 0, null]);
      }
    }),
  );

  it.effect('leaves out car sharing and free-floating fleets', () =>
    Effect.gen(function* () {
      const velibInformation = JSON.parse(fixture('gbfs/velib-station_information.json')) as {
        data: { stations: Array<Record<string, unknown>> };
      };
      for (const station of velibInformation.data.stations) station.is_virtual_station = true;
      const { result } = yield* read(makeBikeSystemSource(), (call) => {
        // Dott with stations but a fleet of cars; Vélib's stations as if they were parking areas.
        if (call.url.pathname.endsWith('/abu-dhabi/vehicle_types.json'))
          return Response.json({ data: { vehicle_types: [{ vehicle_type_id: 'car', form_factor: 'car' }] } });
        if (call.url.pathname.endsWith('/abu-dhabi/station_information.json'))
          return new Response(fixture('gbfs/nyc-station_information.json'));
        if (call.url.pathname.endsWith('/Velib_Metropole/station_information.json'))
          return Response.json(velibInformation);
        return recorded(call);
      });
      const { data } = updatedData(result);
      for (const id of ['dott-abu-dhabi', 'Paris'])
        assert.strictEqual(data.stations[data.id.indexOf(id)], 0, id);
      assert.strictEqual(data.stations[data.id.indexOf('lyft_nyc')], 8);
    }),
  );

  it('checks never-checked systems first, then the longest unchecked', () => {
    const listed = [
      { id: 'a', name: 'A', website: '', discovery: 'https://a/gbfs.json' },
      { id: 'b', name: 'B', website: '', discovery: 'https://b/gbfs.json' },
      { id: 'c', name: 'C', website: '', discovery: 'https://c/gbfs.json' },
    ];
    const located = {
      stations: 3,
      bounds: { west: 1, south: 2, east: 3, north: 4 },
      information: 'i',
      status: 's',
      vehicleTypes: '',
    };
    const first = mergeSystems(undefined, listed, new Map([['b', located]]), 100);
    const second = mergeSystems(first, listed, new Map([['a', located]]), 200);
    assert.deepStrictEqual(
      nextBatch(second, listed, 2).map((s) => s.id),
      ['c', 'b'],
    );
    // A failed check keeps what an earlier one found, and counts as a visit.
    const failed = mergeSystems(second, listed, new Map([['a', 'failed']]), 250);
    assert.deepStrictEqual([failed.stations[0], failed.west[0], failed.checkedAt[0]], [3, 1, 250]);
    // A new discovery URL starts the system over.
    const moved = [
      { ...listed[0], discovery: 'https://a2/gbfs.json' } as (typeof listed)[number],
      ...listed.slice(1),
    ];
    const third = mergeSystems(failed, moved, new Map(), 300);
    assert.deepStrictEqual([third.stations[0], third.checkedAt[0]], [0, 0]);
    // Systems no longer listed are dropped.
    assert.deepStrictEqual(mergeSystems(third, listed.slice(1), new Map(), 300).id, ['b', 'c']);
  });
});
