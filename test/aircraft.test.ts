import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { AircraftNearbyLookup, parseReadsb } from '../src/aircraft.ts';
import { fakeHttp, fixture, recorded, type Upstream } from './support.ts';

const lookup = (upstream: Upstream = recorded) => {
  const http = fakeHttp(upstream);
  return { calls: http.calls, layer: AircraftNearbyLookup.layer.pipe(Layer.provide(http.layer)) };
};

describe('nearby aircraft', () => {
  it('normalizes readsb to SI units and drops aircraft without a position', () => {
    const { time, data } = parseReadsb(
      JSON.parse(fixture('adsbfi.json')) as Parameters<typeof parseReadsb>[0],
    );
    assert.strictEqual(data.icao.length, 4);
    assert.strictEqual(data.callsign[0], 'RYR4EF');
    assert.strictEqual(data.registration[0], '9H-QDQ');
    assert.strictEqual(data.type[0], 'B738');
    assert.strictEqual(data.category[0], 'A3');
    assert.strictEqual(data.altitude[0], Math.round(37175 * 0.3048)); // geometric, not barometric
    assert.strictEqual(data.speed[0], Math.round(407.3 * 0.514444 * 10) / 10);
    assert.deepStrictEqual([data.onGround[3], data.altitude[3]], [true, 0]);
    assert.strictEqual(time, 1794784474001);
    assert.strictEqual(data.positionTime[0], Math.round((1794784474.001 - 0.127) * 10) / 10);
  });

  it.effect('snaps to whole degrees and shares an answer for a few seconds', () => {
    const { calls, layer } = lookup();
    return Effect.gen(function* () {
      const aircraft = yield* AircraftNearbyLookup;
      const first = yield* aircraft.near(51.2, -0.4);
      assert.deepStrictEqual([first.lat, first.lon, first.source], [51, 0, 'adsb.fi']);
      assert.strictEqual(first.data.icao.length, 4);
      yield* aircraft.near(50.9, 0.3);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.url.pathname, '/api/v2/lat/51/lon/0/dist/250');
      yield* TestClock.adjust('10 seconds');
      yield* aircraft.near(51, 0);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('falls back to the next network when one fails', () => {
    const { calls, layer } = lookup((call) =>
      call.url.host === 'api.adsb.lol'
        ? new Response(
            fixture('adsbfi.json').replace('"aircraft"', '"ac"').replace('1794784474.001', '1794784474001'),
          )
        : new Response('busy', { status: 503 }),
    );
    return Effect.gen(function* () {
      const nearby = yield* (yield* AircraftNearbyLookup).near(40, -74);
      assert.strictEqual(nearby.source, 'adsb.lol');
      assert.strictEqual(nearby.time, 1794784474001);
      assert.deepStrictEqual(
        calls.map((c) => c.url.host),
        ['opendata.adsb.fi', 'api.adsb.lol'],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect('reports every network failing as unavailable', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* AircraftNearbyLookup).near(0, 0));
      assert.strictEqual(error._tag, 'UpstreamUnavailable');
    }).pipe(Effect.provide(lookup(() => new Response('down', { status: 500 })).layer)),
  );
});
