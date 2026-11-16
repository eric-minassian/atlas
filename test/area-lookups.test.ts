import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Clock, Effect, Fiber, Layer, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { tileAt, tileBounds } from '../src/area.ts';
import { makeGate } from '../src/gate.ts';
import { parseWindy, WebcamLookup, WindyResponse } from '../src/webcams.ts';
import { ObservationsResponse, parseObservations, WildlifeLookup } from '../src/wildlife.ts';
import { fakeHttp, fixture, recorded, type Upstream } from './support.ts';

const london8 = tileAt(8, -0.1276, 51.5072);
const london11 = tileAt(11, -0.1276, 51.5072);

const webcams = (
  upstream: Upstream = recorded,
  secrets: Record<string, string> = { WINDY_WEBCAMS_KEY: 'k' },
) => {
  const http = fakeHttp(upstream);
  return {
    calls: http.calls,
    layer: WebcamLookup.layer.pipe(Layer.provide([http.layer, Platform.layerMemory({ secrets })])),
  };
};

const wildlife = (upstream: Upstream = recorded) => {
  const http = fakeHttp(upstream);
  return { calls: http.calls, layer: WildlifeLookup.layer.pipe(Layer.provide(http.layer)) };
};

describe('webcams (Windy)', () => {
  it('keeps active webcams with a frame, a position and a Windy page', () => {
    const area = parseWindy(
      Schema.decodeSync(Schema.fromJsonString(WindyResponse))(fixture('windy-webcams.json')),
      1,
    );
    assert.strictEqual(area.total, 849);
    assert.strictEqual(area.webcams.length, 3);
    assert.deepStrictEqual(area.webcams[0], {
      id: '1420893641',
      title: 'London: Trafalgar Square',
      lon: -0.12765,
      lat: 51.5074,
      city: 'London',
      country: 'United Kingdom',
      preview: {
        url: 'https://imgproxy.windy.com/_/preview/plain/current/1420893641/original.jpg?v=2',
        width: 352,
        height: 224,
      },
      page: 'https://windy.com/webcams/1420893641',
      timelapse: 'https://webcams.windy.com/webcams/public/embed/player/1420893641/day',
      updatedAt: Date.parse('2026-11-16T00:53:05.000Z'),
      views: 554620,
    });
  });

  it.effect('asks Windy for the tile with the key, and reuses the answer for two minutes', () => {
    const { calls, layer } = webcams();
    return Effect.gen(function* () {
      const lookup = yield* WebcamLookup;
      const area = yield* lookup.area(8, london8.x, london8.y);
      assert.strictEqual(area.webcams.length, 3);
      yield* lookup.area(8, london8.x, london8.y);
      assert.strictEqual(calls.length, 1);
      const b = tileBounds(8, london8.x, london8.y);
      assert.strictEqual(calls[0]?.url.searchParams.get('bbox'), `${b.north},${b.east},${b.south},${b.west}`);
      assert.strictEqual(calls[0]?.url.searchParams.get('limit'), '50');
      assert.strictEqual(calls[0]?.headers['x-windy-api-key'], 'k');
      yield* TestClock.adjust('3 minutes');
      yield* lookup.area(8, london8.x, london8.y);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('rejects other zooms and tiles outside the scheme', () =>
    Effect.gen(function* () {
      const lookup = yield* WebcamLookup;
      assert.strictEqual((yield* Effect.flip(lookup.area(9, 0, 0)))._tag, 'TileOutOfRange');
      assert.strictEqual((yield* Effect.flip(lookup.area(8, 256, 0)))._tag, 'TileOutOfRange');
    }).pipe(Effect.provide(webcams().layer)),
  );

  it.effect('says so when the deployment has no Windy key', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* WebcamLookup).area(8, london8.x, london8.y));
      assert.strictEqual(error._tag, 'SourceNotConfigured');
    }).pipe(Effect.provide(webcams(recorded, {}).layer)),
  );

  it.effect('reports Windy refusing as unavailable', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* WebcamLookup).area(8, london8.x, london8.y));
      assert.strictEqual(error._tag, 'UpstreamUnavailable');
    }).pipe(Effect.provide(webcams(() => new Response('{"message":"Unauthorized"}', { status: 401 })).layer)),
  );
});

describe('wildlife (iNaturalist)', () => {
  it('keeps observations with a position and a photo, at a size worth showing', () => {
    const area = parseObservations(
      Schema.decodeSync(Schema.fromJsonString(ObservationsResponse))(
        fixture('inaturalist-observations.json'),
      ),
      1,
    );
    assert.strictEqual(area.sightings.length, 5);
    const fox = area.sightings.find((s) => s.commonName === 'Red Fox');
    assert.deepStrictEqual(fox, {
      id: 414961729,
      lon: -0.06374,
      lat: 51.46211,
      obscured: false,
      scientificName: 'Vulpes vulpes',
      commonName: 'Red Fox',
      rank: 'species',
      group: 'Mammalia',
      quality: 'research',
      observedAt: Date.parse('2026-11-15T20:37:48+00:00'),
      observedOn: '2026-11-15',
      place: 'Peckham Rye / Nunhead Lane (Stop EN), London SE15 3UA, UK',
      observer: 'Marco Zaccaria Di Fraia',
      photo: {
        url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/764006516/medium.jpg',
        attribution: '(c) Marco Zaccaria Di Fraia, some rights reserved (CC BY)',
      },
      url: 'https://www.inaturalist.org/observations/414961729',
    });
    const unidentified = area.sightings.find((s) => s.scientificName === null);
    assert.strictEqual(unidentified?.observer, 'meeshe97');
    assert.isTrue(area.sightings.some((s) => s.obscured));
  });

  it.effect('asks for the tile’s latest licensed photos and reuses the answer for half an hour', () => {
    const { calls, layer } = wildlife();
    return Effect.gen(function* () {
      const lookup = yield* WildlifeLookup;
      yield* lookup.area(11, london11.x, london11.y);
      yield* lookup.area(11, london11.x, london11.y);
      assert.strictEqual(calls.length, 1);
      const params = calls[0]?.url.searchParams;
      const b = tileBounds(11, london11.x, london11.y);
      assert.deepStrictEqual(
        ['swlat', 'swlng', 'nelat', 'nelng'].map((k) => Number(params?.get(k))),
        [b.south, b.west, b.north, b.east],
      );
      assert.strictEqual(params?.get('photo_licensed'), 'true');
      assert.strictEqual(params?.get('order_by'), 'observed_on');
      yield* TestClock.adjust('31 minutes');
      yield* lookup.area(11, london11.x, london11.y);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('retries a failed tile soon rather than caching the failure', () => {
    let down = true;
    const { calls, layer } = wildlife((call) =>
      down ? new Response('busy', { status: 503 }) : recorded(call),
    );
    return Effect.gen(function* () {
      const lookup = yield* WildlifeLookup;
      assert.strictEqual((yield* Effect.flip(lookup.area(11, 0, 0)))._tag, 'UpstreamUnavailable');
      down = false;
      yield* TestClock.adjust('20 seconds');
      const area = yield* lookup.area(11, 0, 0);
      assert.strictEqual(area.sightings.length, 5);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('rejects other zooms', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* WildlifeLookup).area(10, 0, 0));
      assert.strictEqual(error._tag, 'TileOutOfRange');
    }).pipe(Effect.provide(wildlife().layer)),
  );
});

describe('rate gate', () => {
  it.effect('spaces requests and turns away those that would wait too long', () =>
    Effect.gen(function* () {
      const gate = yield* makeGate('1 second', '2 seconds');
      const started: number[] = [];
      const request = Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => started.push(now)));
      const fibers = yield* Effect.forEach([0, 1, 2, 3], () =>
        Effect.forkChild(Effect.result(gate(request))),
      );
      yield* TestClock.adjust('5 seconds');
      const results = yield* Effect.forEach(fibers, Fiber.join);
      assert.deepStrictEqual(started, [0, 1000, 2000]);
      assert.deepStrictEqual(
        results.map((r) => (Result.isFailure(r) ? r.failure._tag : 'ok')),
        ['ok', 'ok', 'ok', 'GateBusy'],
      );
    }),
  );
});
