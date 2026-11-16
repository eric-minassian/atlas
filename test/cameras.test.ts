import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Effect, Layer, Option, Schema } from 'effect';
import type { CameraData } from '../src/domain.ts';
import {
  assemble,
  CaltransFile,
  makeCameraSource,
  NycCameras,
  OtcmFile,
  parseCaltrans,
  parseNyc,
  parseOtcm,
  parseTfl,
  TflPlaces,
} from '../src/ingest/cameras.ts';
import { fakeHttp, fixture, recorded, type Upstream } from './support.ts';

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, name: string) =>
  Schema.decodeSync(Schema.fromJsonString(schema))(fixture(name));

const read = (upstream: Upstream = recorded, previous: Option.Option<CameraData> = Option.none()) => {
  const http = fakeHttp(upstream);
  return makeCameraSource()
    .read({}, Effect.succeed(previous))
    .pipe(Effect.provide(Layer.merge(http.layer, Platform.layerMemory())));
};

const camerasOf = (data: CameraData) =>
  data.id.map((id, i) => ({
    id,
    name: data.name[i],
    operator: data.operators[data.operator[i] as number]?.name,
    image: data.image[i],
    relayed: data.relayed[i],
  }));

describe('traffic cameras', () => {
  it('reads TfL JamCams that are available, with the way they face', () => {
    const cameras = parseTfl(decode(TflPlaces, 'tfl-jamcams.json'));
    assert.deepStrictEqual(
      cameras.map((c) => c.id),
      ['tfl-00002.00865', 'tfl-00001.02151'],
    );
    assert.deepStrictEqual(cameras[0], {
      id: 'tfl-00002.00865',
      name: 'A406 Billet Upass E',
      lon: -0.01594,
      lat: 51.60067,
      view: 'West',
      image: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg',
    });
  });

  it('reads NYC DOT cameras that are online', () => {
    const cameras = parseNyc(decode(NycCameras, 'nyctmc-cameras.json'));
    assert.strictEqual(cameras.length, 3);
    assert.strictEqual(cameras[0]?.id, 'nyc-1b3248f9-f26e-4f36-943f-b7a7731595fb');
    assert.strictEqual(
      cameras[0]?.image,
      'https://webcams.nyctmc.org/api/cameras/1b3248f9-f26e-4f36-943f-b7a7731595fb/image',
    );
  });

  it('reads Caltrans cameras in service, keyed by district and image name', () => {
    const cameras = parseCaltrans(decode(CaltransFile, 'caltrans-d07.json'));
    assert.deepStrictEqual(
      cameras.map((c) => [c.id, c.lon, c.lat, c.view]),
      [
        ['caltrans-7-i110196avenue26offramp', -118.2215, 34.0837, 'South'],
        ['caltrans-7-i52slausonave', -118.12791, 33.97857, 'South'],
      ],
    );
  });

  it('keeps OpenTrafficCamMap still images from hosts with live frames, credited by host', () => {
    const cameras = parseOtcm(decode(OtcmFile, 'opentrafficcammap-usa.json'));
    const operators = cameras.map((c) => c.id.slice(0, c.id.indexOf('-')));
    // Alabama's HLS stream, and Alaska's, California's and Colorado's still images are left out.
    assert.deepStrictEqual(operators, [
      'ohio',
      'ohio',
      'trimarc',
      'trimarc',
      'trimarc',
      'trimarc',
      'indiana',
      'arizona',
    ]);
    const images = cameras.map((c) => c.image);
    assert.include(images, 'https://itscameras.dot.state.oh.us/images/toledo/SR2-EB-Approach.jpg');
    assert.include(
      images,
      'https://itscameras.dot.state.oh.us/images/rest_area/I-70%20EB%20at%20MM%20130%20Licking%20County%20PTZ.jpg',
    );
    // The same Kentucky camera, listed under Ohio and Kentucky, gets one id.
    const maysville = cameras.filter((c) => c.name.includes('Maysville'));
    assert.strictEqual(maysville.length, 2);
    assert.strictEqual(maysville[0]?.id, maysville[1]?.id);
  });

  it('drops cameras already seen by id or image', () => {
    const camera = { name: 'A', lon: 1, lat: 2, view: '', image: 'https://example.com/a.jpg' };
    const data = assemble([
      { ...camera, id: 'tfl-1' },
      { ...camera, id: 'tfl-2' },
      { ...camera, id: 'tfl-1', image: 'https://example.com/b.jpg' },
      { ...camera, id: 'nyc-3', image: 'https://example.com/c.jpg' },
      { ...camera, id: 'unknown-4', image: 'https://example.com/d.jpg' },
    ]);
    assert.deepStrictEqual(data.id, ['tfl-1', 'nyc-3']);
    assert.deepStrictEqual(data.operator, [0, 1]);
  });

  it.effect('merges every list into one snapshot and marks HTTP-only frames for the relay', () =>
    Effect.gen(function* () {
      const result = yield* read();
      if (result._tag !== 'Updated') throw new Error('expected an update');
      const cameras = camerasOf(result.data);
      assert.strictEqual(result.count, 14);
      assert.strictEqual(new Set(cameras.map((c) => c.image)).size, 14);
      assert.deepStrictEqual(
        cameras.filter((c) => c.relayed).map((c) => c.image),
        ['http://www.trimarc.org/images/milestone/CCTV_03_RussellvilleRd_and_CampbellLn.jpg'],
      );
      assert.deepStrictEqual(
        Object.entries(Object.groupBy(cameras, (c) => c.operator ?? '')).map(([name, list]) => [
          name,
          list?.length,
        ]),
        [
          ['Transport for London', 2],
          ['NYC DOT', 3],
          ['Caltrans', 2],
          ['Ohio DOT', 2],
          ['TRIMARC (Kentucky)', 3],
          ['Indiana DOT', 1],
          ['Arizona DOT', 1],
        ],
      );
    }),
  );

  it.effect("keeps a failed list's cameras from the previous snapshot", () =>
    Effect.gen(function* () {
      const first = yield* read();
      if (first._tag !== 'Updated') throw new Error('expected an update');
      const withoutTfl: Upstream = (call) =>
        call.url.host === 'api.tfl.gov.uk' ? undefined : recorded(call);

      const kept = yield* read(withoutTfl, Option.some(first.data));
      if (kept._tag !== 'Updated') throw new Error('expected an update');
      assert.strictEqual(kept.count, 14);
      assert.includeMembers([...kept.data.id], ['tfl-00002.00865', 'tfl-00001.02151']);

      const lost = yield* read(withoutTfl);
      assert.strictEqual(lost._tag === 'Updated' ? lost.count : 0, 12);
    }),
  );

  it.effect('fails when every list fails', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(read(() => new Response('down', { status: 503 })));
      assert.include(error.message, 'every camera list failed');
    }),
  );
});
