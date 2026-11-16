import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { Effect, Fiber, Layer } from 'effect';
import type { Socket } from 'effect/socket';
import { TestClock } from 'effect/testing';
import type { ShipData } from '../src/domain.ts';
import {
  AisCollector,
  cleanText,
  makeShipSource,
  mergeShips,
  parseAisTime,
  type Position,
  type ShipSourceOptions,
} from '../src/ingest/ships.ts';
import { fakeHttp, fixture, recorded, type Upstream } from './support.ts';

const NOW = Date.parse('2026-11-16T01:22:10Z') / 1000;
const recordedMessages = fixture('aisstream.jsonl').trim().split('\n');

const position = (mmsi: number, time: number, speed: number | null, status: number | null = 0): Position => ({
  mmsi,
  lon: 10,
  lat: 54,
  speed,
  course: speed ? 90 : null,
  heading: null,
  status,
  time,
});

const row = (data: ShipData, mmsi: number) => {
  const i = data.mmsi.indexOf(mmsi);
  if (i < 0) return undefined;
  return {
    name: data.name[i],
    callsign: data.callsign[i],
    imo: data.imo[i],
    shipType: data.shipType[i],
    destination: data.destination[i],
    length: data.length[i],
    width: data.width[i],
    status: data.status[i],
    lon: data.lon[i],
    time: data.since + (data.time[i] as number),
  };
};

/**
 * A WebSocket that answers the subscription with `frames` (as binary, like
 * aisstream.io), then closes with `closeWith` if given.
 */
const scriptedSocket = (
  frames: ReadonlyArray<string>,
  closeWith?: { code: number; reason: string },
): { make: Socket.WebSocketConstructor['Service']; sent: string[] } => {
  const sent: string[] = [];
  const make: Socket.WebSocketConstructor['Service'] = () => {
    const listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
    const emit = (type: string, event: Socket.WebSocketEvent) => {
      for (const l of listeners.get(type) ?? []) l(event);
    };
    const socket = {
      readyState: 0,
      binaryType: 'blob',
      addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
        let set = listeners.get(type);
        if (!set) listeners.set(type, (set = new Set()));
        set.add(listener);
      },
      removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
        listeners.get(type)?.delete(listener);
      },
      send(data: string | Uint8Array<ArrayBuffer>) {
        sent.push(String(data));
        setTimeout(() => {
          for (const frame of frames) emit('message', { data: new TextEncoder().encode(frame).buffer });
          if (closeWith) {
            socket.readyState = 3;
            emit('close', closeWith);
          }
        }, 0);
      },
      close() {
        socket.readyState = 3;
      },
    };
    setTimeout(() => {
      socket.readyState = 1;
      emit('open', {});
    }, 0);
    return socket;
  };
  return { make, sent };
};

const read = (options: ShipSourceOptions, secrets: Record<string, string>, upstream: Upstream = recorded) => {
  const http = fakeHttp(upstream);
  return makeShipSource(options)
    .read({}, Effect.succeedNone)
    .pipe(
      Effect.provide(Layer.merge(http.layer, Platform.layerMemory({ secrets }))),
      Effect.map((result) => {
        if (result._tag !== 'Updated') throw new Error('expected an update');
        return { data: result.data, calls: http.calls };
      }),
    );
};

describe('ships: merging reports into the previous snapshot', () => {
  it('keeps the latest position per vessel', () => {
    const data = mergeShips(
      undefined,
      [
        position(1, NOW - 60, 5),
        { ...position(1, NOW - 10, 5), lon: 11 },
        { ...position(1, NOW - 30, 5), lon: 12 },
      ],
      [],
      NOW,
    );
    assert.deepStrictEqual(data.mmsi, [1]);
    assert.strictEqual(row(data, 1)?.lon, 11);
    assert.strictEqual(row(data, 1)?.time, NOW - 10);
  });

  it('drops vessels under way unheard for half an hour, moored ones after three hours', () => {
    const data = mergeShips(
      undefined,
      [
        position(1, NOW - 29 * 60, 8),
        position(2, NOW - 31 * 60, 8),
        position(3, NOW - 2 * 3600, 0),
        // Moored, though the GPS jitters: the status says it isn't going anywhere.
        position(4, NOW - 2 * 3600, 0.8, 5),
        position(5, NOW - 3.1 * 3600, 0),
      ],
      [],
      NOW,
    );
    assert.deepStrictEqual(
      data.mmsi.toSorted((a, b) => a - b),
      [1, 3, 4],
    );
  });

  it('carries static data forward from the previous snapshot while only positions arrive', () => {
    const first = mergeShips(
      undefined,
      [position(7, NOW - 400, 10)],
      [
        {
          mmsi: 7,
          name: 'ARK GERMANIA',
          callsign: 'OZHJ2',
          imo: 9609952,
          shipType: 79,
          length: 196,
          width: 30,
        },
      ],
      NOW - 300,
    );
    const second = mergeShips(
      first,
      [position(7, NOW - 5, 10, null)],
      [{ mmsi: 7, destination: 'DKKOG' }],
      NOW,
    );
    assert.deepStrictEqual(row(second, 7), {
      name: 'ARK GERMANIA',
      callsign: 'OZHJ2',
      imo: 9609952,
      shipType: 79,
      destination: 'DKKOG',
      length: 196,
      width: 30,
      // Class B reports have no status; the earlier one stands.
      status: 0,
      lon: 10,
      time: NOW - 5,
    });
  });

  it('ignores static data for vessels it has no position for', () => {
    const data = mergeShips(undefined, [], [{ mmsi: 9, name: 'NOWHERE' }], NOW);
    assert.deepStrictEqual(data.mmsi, []);
  });

  it('counts report times from the oldest kept vessel', () => {
    const data = mergeShips(undefined, [position(1, NOW - 100, 0), position(2, NOW - 40, 0)], [], NOW);
    assert.strictEqual(data.since, NOW - 100);
    assert.deepStrictEqual(data.time, [0, 60]);
  });
});

describe('ships: aisstream.io messages', () => {
  it('reads every subscribed message type from the recorded stream', () => {
    const collector = new AisCollector();
    for (const message of recordedMessages) collector.add(message);
    assert.strictEqual(collector.skipped, 1); // the subscription confirmation
    assert.strictEqual(collector.messages, recordedMessages.length - 1);

    // Two class A reports: the later one wins.
    const yamabishi = collector.positions.get(431011136);
    assert.deepStrictEqual(
      [yamabishi?.lon, yamabishi?.speed, yamabishi?.course, yamabishi?.heading, yamabishi?.status],
      [136.2028, 10.8, 220, 220, 0],
    );
    assert.strictEqual(yamabishi?.time, parseAisTime('2026-11-16 01:21:54.339041524 +0000 UTC'));
    assert.deepStrictEqual(collector.statics.get(431011136), {
      mmsi: 431011136,
      name: 'YAMABISHIMARU NO.18',
      callsign: 'JD4347',
      destination: '>JP AMX OFF',
      shipType: 80,
      imo: 9831402,
      length: 64,
      width: 10,
    });
    // Not available: course 360, heading 511.
    const barge = collector.positions.get(211518790);
    assert.deepStrictEqual([barge?.speed, barge?.course, barge?.heading], [0, 0, 0]);

    // Class B: position without status; static data in part B.
    assert.strictEqual(collector.positions.get(338534526)?.status, null);
    assert.deepStrictEqual(collector.statics.get(338534526), {
      mmsi: 338534526,
      shipType: 30,
      length: 18,
      width: 7,
    });
    // Names come with every message, from aisstream's own records.
    assert.strictEqual(collector.statics.get(314322000)?.name, 'WARRIOR SPIRIT');
  });

  it('reports a refused subscription', () => {
    const collector = new AisCollector();
    collector.add('{"error":"Api Key Is Not Valid"}');
    assert.strictEqual(collector.error, 'Api Key Is Not Valid');
  });

  it('cleans AIS text', () => {
    assert.strictEqual(cleanText('KIA ORA@@@@@@@'), 'KIA ORA');
    assert.strictEqual(cleanText(' GAS 88  '), 'GAS 88');
    assert.strictEqual(cleanText('@@@@'), '');
  });
});

describe('ships: source', () => {
  it.effect('reads the Baltic from Digitraffic without an aisstream key', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1794790561538);
      const { data, calls } = yield* read({}, {});
      assert.isTrue(calls.every((c) => c.url.host === 'meri.digitraffic.fi'));
      assert.strictEqual(calls[0]?.headers['digitraffic-user'], 'atlas');
      // The vessel under way last heard nine hours ago is gone; the moored one from nine hours ago too.
      assert.deepStrictEqual(
        data.mmsi.toSorted((a, b) => a - b),
        [255806247, 255806258, 259859000],
      );
      const silva = row(data, 255806247);
      assert.deepStrictEqual([silva?.name, silva?.shipType, silva?.callsign], ['SILVA', 70, 'CQAQ5']);
    }),
  );

  it.effect('merges what aisstream.io sent during the listen with Digitraffic', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-11-16T01:22:05Z'));
      const socket = scriptedSocket(recordedMessages);
      const listening = yield* Effect.forkChild(
        read({ webSocket: socket.make }, { AISSTREAM_KEY: 'test-key' }),
      );
      // The scripted socket delivers on the event loop; then the listen runs out its time.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      yield* TestClock.adjust('45 seconds');
      const { data } = yield* Fiber.join(listening);
      const subscription = JSON.parse(socket.sent[0] ?? '{}') as {
        APIKey: string;
        FilterMessageTypes: string[];
      };
      assert.strictEqual(subscription.APIKey, 'test-key');
      assert.include(subscription.FilterMessageTypes, 'ShipStaticData');
      // Heard on the stream, and Digitraffic's moored vessel from half an hour earlier.
      assert.includeMembers([...data.mmsi], [431011136, 211518790, 338534526, 314322000, 259859000]);
      assert.strictEqual(row(data, 431011136)?.name, 'YAMABISHIMARU NO.18');
      // Static data for a vessel with no position has nowhere to go.
      assert.notInclude([...data.mmsi], 219551000);
    }),
  );

  it.effect('still publishes Digitraffic when aisstream.io refuses the key', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1794790561538);
      const socket = scriptedSocket(['{"error":"Api Key Is Not Valid"}'], { code: 1000, reason: '' });
      const { data } = yield* read({ webSocket: socket.make }, { AISSTREAM_KEY: 'bad' });
      assert.deepStrictEqual(
        data.mmsi.toSorted((a, b) => a - b),
        [255806247, 255806258, 259859000],
      );
    }),
  );

  it.effect('fails when neither source answers', () =>
    Effect.gen(function* () {
      const socket = scriptedSocket([], { code: 1011, reason: 'overloaded' });
      const error = yield* Effect.flip(
        read({ webSocket: socket.make }, { AISSTREAM_KEY: 'k' }, () => undefined),
      );
      assert.include(error.message, 'aisstream.io');
      assert.include(error.message, 'Digitraffic');
    }),
  );

  it.effect('keeps vessels from the previous snapshot', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1794790561538);
      const previous = mergeShips(
        undefined,
        [position(42, 1794790561538 / 1000 - 600, 0)],
        [{ mmsi: 42, name: 'OLD' }],
        1794790561538 / 1000,
      );
      const http = fakeHttp();
      const result = yield* makeShipSource()
        .read({}, Effect.succeedSome(previous))
        .pipe(Effect.provide(Layer.merge(http.layer, Platform.layerMemory())));
      assert.strictEqual(result._tag, 'Updated');
      if (result._tag === 'Updated') assert.include([...result.data.mmsi], 42);
    }),
  );
});
