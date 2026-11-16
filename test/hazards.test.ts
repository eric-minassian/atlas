import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { RiverData } from '../src/domain.ts';
import { chain, makeDisasterSource } from '../src/ingest/disasters.ts';
import { FeatureCollection, parsePerimeters } from '../src/ingest/perimeters.ts';
import { makeRiverSource } from '../src/ingest/rivers.ts';
import { makeTsunamiSource, parseTsunamiFeed } from '../src/ingest/tsunamis.ts';
import { Eruptions, parseVolcanoes, Volcanoes } from '../src/ingest/volcanoes.ts';
import { fixture, readSource, recorded, type Upstream, updatedData } from './support.ts';

const perimeters = () => JSON.parse(fixture('wfigs.geojson')) as typeof FeatureCollection.Type;
const volcanoes = () => JSON.parse(fixture('gvp-volcanoes.json')) as typeof Volcanoes.Type;
const eruptions = () => JSON.parse(fixture('gvp-eruptions.json')) as typeof Eruptions.Type;

describe('disaster alerts (GDACS)', () => {
  const geometryCalls = (calls: ReadonlyArray<{ readonly url: URL }>) =>
    calls
      .filter((c) => c.url.pathname.endsWith('/getgeometry'))
      .map((c) => c.url.searchParams.get('eventtype'));

  it('joins track segments listed out of order', () => {
    assert.deepStrictEqual(
      chain([
        [3, 3, 4, 4],
        [1, 1, 2, 2],
        [2, 2, 3, 3],
        [9, 9, 8, 8],
      ]),
      [
        [1, 1, 2, 2, 3, 3, 4, 4],
        [9, 9, 8, 8],
      ],
    );
  });

  it.effect('merges current and significant events, with outlines for cyclones and droughts', () =>
    Effect.gen(function* () {
      const { result, calls } = yield* readSource(makeDisasterSource());
      const { events } = updatedData(result);
      // Five current from the app list, the current drought from the search; the past cyclone is left out.
      assert.strictEqual(events.length, 6);
      assert.sameMembers(
        events.map((e) => e.type),
        ['TC', 'EQ', 'FL', 'WF', 'WF', 'DR'],
      );
      assert.deepStrictEqual(
        events.map((e) => e.to),
        events.map((e) => e.to).toSorted((a, b) => b - a),
      );
      const cyclone = events.find((e) => e.type === 'TC');
      assert.strictEqual(cyclone?.id, 'TC1001350');
      assert.strictEqual(cyclone?.alert, 'green');
      assert.strictEqual(cyclone?.areas.length, 1); // the cone, not the wind buffers
      assert.deepStrictEqual(cyclone?.track, [
        [-158.9, -8.4, -160.1, -8.1, -161.2, -8.4, -162.5, -8.7, -163.4, -9],
      ]);
      const drought = events.find((e) => e.type === 'DR');
      assert.strictEqual(drought?.alert, 'orange');
      assert.notInclude(drought?.country, ', ,');
      assert.isAbove(drought?.areas.length ?? 0, 0);
      // The flood's geometry didn't load: it's still listed, as a point.
      assert.deepStrictEqual(events.find((e) => e.type === 'FL')?.areas, []);
      assert.sameMembers(geometryCalls(calls), ['TC', 'DR', 'FL']);
    }),
  );

  it.effect('reuses the outlines it published for an unchanged episode', () =>
    Effect.gen(function* () {
      const first = updatedData((yield* readSource(makeDisasterSource())).result);
      const { result, calls } = yield* readSource(makeDisasterSource(), recorded, Effect.succeedSome(first));
      assert.deepStrictEqual(geometryCalls(calls), ['FL']);
      assert.strictEqual(updatedData(result).events.find((e) => e.type === 'TC')?.areas.length, 1);
    }),
  );
});

describe('tsunami bulletins (NOAA)', () => {
  const issued = Date.parse('2026-11-13T23:30:02Z');

  it('parses a center’s Atom feed', () => {
    const [bulletin, ...rest] = parseTsunamiFeed(fixture('tsunami-ntwc.xml'), 'NTWC', issued + 60_000);
    assert.strictEqual(rest.length, 0);
    assert.deepStrictEqual(
      { ...bulletin, id: undefined },
      {
        id: undefined,
        center: 'NTWC',
        category: 'Information',
        region: '65 miles NE of Kodiak City, Alaska',
        issued,
        lon: -151,
        lat: 58.4,
        magnitude: '4.2(Mwp)',
        note: 'There is NO tsunami danger from this earthquake.',
        url: 'https://www.tsunami.gov/events/PAAQ/2026/11/13/togrrv/1/WEAK53/WEAK53.txt',
      },
    );
    const [pacific] = parseTsunamiFeed(fixture('tsunami-ptwc.xml'), 'PTWC', issued);
    assert.strictEqual(pacific?.region, 'About 84 Miles Northwest of Isla Mona');
  });

  it('drops bulletins older than a day', () => {
    assert.deepStrictEqual(
      parseTsunamiFeed(fixture('tsunami-ntwc.xml'), 'NTWC', issued + 2 * 86_400_000),
      [],
    );
  });

  it.effect('keeps a center’s last bulletins when its feed fails, and fails only if both do', () =>
    Effect.gen(function* () {
      const both = updatedData((yield* readSource(makeTsunamiSource())).result);
      assert.sameMembers(
        both.bulletins.map((b) => b.center),
        ['NTWC', 'PTWC'],
      );
      const pacificDown: Upstream = (call) =>
        call.url.pathname.endsWith('PHEBAtom.xml') ? new Response('down', { status: 503 }) : undefined;
      // The national center now has nothing current; the Pacific center's feed is down.
      const { result } = yield* readSource(
        makeTsunamiSource(),
        (call) => pacificDown(call) ?? new Response('<feed></feed>'),
        Effect.succeedSome(both),
      );
      assert.deepStrictEqual(
        updatedData(result).bulletins.map((b) => b.center),
        ['PTWC'],
      );
      const error = yield* Effect.flip(
        Effect.map(
          readSource(makeTsunamiSource(), () => new Response('down', { status: 503 })),
          (r) => r.result,
        ),
      );
      assert.include(error.message, 'HTTP 503');
    }),
  );

  it.effect('reports no change when the bulletins are the ones published', () =>
    Effect.gen(function* () {
      const published = updatedData((yield* readSource(makeTsunamiSource())).result);
      const { result } = yield* readSource(makeTsunamiSource(), recorded, Effect.succeedSome(published));
      assert.strictEqual(result._tag, 'NotModified');
    }),
  );
});

describe('wildfire perimeters (WFIGS)', () => {
  it('normalizes perimeters, largest first', () => {
    const { fires } = parsePerimeters(perimeters().features);
    assert.strictEqual(fires.length, 3);
    assert.deepStrictEqual(
      fires.map((f) => f.acres),
      fires.map((f) => f.acres).toSorted((a, b) => (b ?? 0) - (a ?? 0)),
    );
    const prescribed = fires.find((f) => f.kind === 'RX');
    assert.strictEqual(prescribed?.id, 'cd72cda6-e2ea-47f1-94aa-513bac026c46');
    assert.strictEqual(prescribed?.state, 'OK');
    const contained = fires.find((f) => f.name === 'Timber');
    assert.strictEqual(contained?.contained, 100);
    for (const fire of fires) {
      assert.isAbove(fire.polygons.length, 0);
      const ring = fire.polygons[0]?.[0] ?? [];
      const lons = ring.filter((_, i) => i % 2 === 0);
      const lats = ring.filter((_, i) => i % 2 === 1);
      assert.isTrue(fire.lon >= Math.min(...lons) - 1 && fire.lon <= Math.max(...lons) + 1);
      assert.isTrue(fire.lat >= Math.min(...lats) - 1 && fire.lat <= Math.max(...lats) + 1);
    }
  });
});

describe('volcanoes (Smithsonian GVP)', () => {
  it('marks continuing eruptions and keeps photo ids', () => {
    const data = parseVolcanoes(volcanoes(), eruptions());
    assert.strictEqual(data.number.length, 4);
    const at = (name: string) => data.name.indexOf(name);
    assert.strictEqual(data.erupting[at('Kilauea')], '2024-12-23');
    assert.strictEqual(data.photo[at('Kilauea')], 'GVP-03420');
    assert.deepStrictEqual(
      [data.erupting[at('Campi Flegrei')], data.lastEruption[at('Campi Flegrei')]],
      ['', 1538],
    );
    assert.strictEqual(data.lastEruption[at('West Eifel Volcanic Field')], -8300);
    assert.deepStrictEqual([data.photo[at('Rumble IV')], data.photoCredit[at('Rumble IV')]], ['', '']);
  });
});

describe('river gauges (NWPS, Environment Agency, Pegelonline)', () => {
  const country = (data: RiverData, code: string) => data.countries.find((c) => c.country === code)?.gauges;

  it.effect('reads each country and maps its levels to flood status', () =>
    Effect.gen(function* () {
      const data = updatedData((yield* readSource(makeRiverSource())).result);
      const us = country(data, 'US');
      assert.deepStrictEqual(us?.status, [
        'major',
        'moderate',
        'minor',
        'action',
        'normal',
        'unknown',
        'low',
      ]);
      assert.strictEqual(us?.threshold[0], 16);
      assert.strictEqual(us?.threshold[3], null);
      // A gauge NWS names only by its river.
      assert.deepStrictEqual([us?.name[4], us?.river[4]], ['Cheyenne River', '']);

      const uk = country(data, 'GB');
      // Groundwater isn't a river level; a tidal level has no typical range.
      assert.deepStrictEqual(uk?.id, ['2032', '7041', '6282', '3359']);
      assert.strictEqual(uk?.status[0], 'high');
      assert.strictEqual(uk?.status[2], 'unknown');
      assert.strictEqual(uk?.name[3], 'Ilfracombe Lambda');

      const de = country(data, 'DE');
      // An outdated reading and a station without a position are left out.
      assert.deepStrictEqual(de?.name, ['Celle', 'Eitze', 'Waltrop']);
      assert.deepStrictEqual(de?.status, ['normal', 'low', 'unknown']);
      assert.strictEqual(de?.river[0], 'Aller');

      // The warning whose area couldn't be looked up has no position, so it's left out.
      assert.deepStrictEqual(
        data.warnings.map((w) => [w.id, w.level, w.lat]),
        [['031WAF213', 3, 51.9776]],
      );
      assert.closeTo(data.warnings[0]?.lon ?? 0, -2.3965, 1e-3);
    }),
  );

  it.effect('keeps a failing country’s last data, and fails only when every country does', () =>
    Effect.gen(function* () {
      const before = updatedData((yield* readSource(makeRiverSource())).result);
      const germanyDown: Upstream = (call) =>
        call.url.host === 'www.pegelonline.wsv.de' ? new Response('down', { status: 503 }) : recorded(call);
      const stale: RiverData = {
        warnings: before.warnings,
        countries: before.countries.map((c) => Object.assign({}, c, { read: 1 })),
      };
      const after = updatedData(
        (yield* readSource(makeRiverSource(), germanyDown, Effect.succeedSome(stale))).result,
      );
      assert.strictEqual(after.countries.find((c) => c.country === 'DE')?.read, 1);
      assert.strictEqual(country(after, 'DE')?.id.length, 3);

      const error = yield* Effect.flip(
        Effect.map(
          readSource(makeRiverSource(), () => new Response('down', { status: 503 })),
          (r) => r.result,
        ),
      );
      assert.include(error.message, 'US:');
    }),
  );
});
