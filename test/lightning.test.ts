import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import type { LightningData } from '../src/domain.ts';
import {
  makeLightningSource,
  parseGlm,
  parseListing,
  prefixesFor,
  startOf,
  startTime,
} from '../src/ingest/lightning.ts';
import { IngestError } from '../src/ingest/source.ts';
import { fakeHttp, fixture, fixtureBytes } from './support.ts';

const h5 = await import('h5wasm');
await h5.ready;

/** The fixture is a GOES-19 file cut down to 8 flashes, with its variables' types and packing intact. */
const PRODUCT_TIME = Date.parse('2026-11-16T00:59:20Z');

const read = (previous?: LightningData) => {
  const http = fakeHttp();
  return makeLightningSource()
    .read({}, Effect.succeed(Option.fromUndefinedOr(previous)))
    .pipe(
      Effect.provide(Layer.merge(http.layer, Platform.layerMemory())),
      Effect.map((result) => {
        if (result._tag !== 'Updated') throw new Error('expected an update');
        return { data: result.data, calls: http.calls };
      }),
    );
};

describe('lightning (GOES GLM)', () => {
  it('unpacks flashes: unsigned 16-bit values, scale and offset, times from the file reference', () => {
    const flashes = parseGlm(h5, fixtureBytes('glm-g19.nc'), 'G19');
    if (flashes instanceof IngestError) throw flashes;
    assert.strictEqual(flashes.lat.length, 8);
    assert.closeTo(flashes.lat[0] as number, -12.4072, 1e-4);
    assert.closeTo(flashes.lon[0] as number, -48.5636, 1e-4);
    // 36 × 9.99996e-16 + 2.8515e-16 J
    assert.closeTo((flashes.energy[0] as number) * 1e15, 36.28, 0.01);
    // 2236 × 152601.86 m²
    assert.closeTo((flashes.area[0] as number) / 1e6, 341.2, 0.1);
    // Raw 11323 → 11323 × 0.00038148 − 5 s.
    assert.closeTo(
      (flashes.time[0] as number) - PRODUCT_TIME,
      (11323 * 0.00038147560553625226 - 5) * 1000,
      1,
    );
    // Raw −27965 is 37571 unsigned → 9.33 s.
    assert.closeTo((flashes.time[4] as number) - PRODUCT_TIME, 9332, 1);
  });

  it('keeps each flash from the satellite nearer overhead', () => {
    // Every flash in the fixture is east of 106.2° W: GOES-West leaves them to GOES-East.
    const west = parseGlm(h5, fixtureBytes('glm-g19.nc'), 'G18');
    if (west instanceof IngestError) throw west;
    assert.strictEqual(west.lat.length, 0);
  });

  it('rejects a file that is not HDF5', () => {
    assert.instanceOf(parseGlm(h5, new TextEncoder().encode('not hdf5'), 'G19'), IngestError);
  });

  it('reads file names, hourly prefixes and S3 listings', () => {
    const key =
      'GLM-L2-LCFA/2026/320/00/OR_GLM-L2-LCFA_G19_s20263200059200_e20263200059400_c20263200059420.nc';
    assert.strictEqual(startOf(key), 's20263200059200');
    assert.strictEqual(startTime('s20263200059200'), Date.parse('2026-11-16T00:59:20Z'));
    assert.deepStrictEqual(
      prefixesFor(Date.parse('2026-11-16T00:50:00Z'), Date.parse('2026-11-16T01:05:00Z')),
      ['GLM-L2-LCFA/2026/320/00/', 'GLM-L2-LCFA/2026/320/01/'],
    );
    const keys = parseListing(fixture('glm-listing.xml'));
    if (keys instanceof IngestError) throw keys;
    assert.strictEqual(keys.length, 4);
    assert.instanceOf(parseListing('<Error/>'), IngestError);
  });

  it.effect('reads the files of the past quarter hour, then only newer ones, and lets old flashes go', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-11-16T00:59:50Z'));
      const first = yield* read();
      // The listing's 00:00 file is outside the window; the three from 00:58:40 on are read.
      const files = first.calls.filter((c) => c.url.pathname.endsWith('.nc'));
      assert.strictEqual(files.length, 3);
      assert.strictEqual(first.data.lon.length, 24);
      assert.deepStrictEqual(first.data.latest, { G19: 's20263200059200' });
      assert.strictEqual(first.data.satellite[0], 'G19');

      const second = yield* read(first.data);
      assert.isFalse(second.calls.some((c) => c.url.pathname.endsWith('.nc')));
      assert.strictEqual(second.data.lon.length, 24);

      yield* TestClock.adjust('16 minutes');
      const third = yield* read(second.data);
      assert.strictEqual(third.data.lon.length, 0);
      assert.deepStrictEqual(third.data.latest, { G19: 's20263200059200' });
    }),
  );
});
