import { assert, describe, it } from '@effect/vitest';
import { Platform } from '@ericminassian/platform';
import { captureTelemetry } from '@ericminassian/platform/testing';
import { Effect, Exit, Fiber, Layer, Option, Scope } from 'effect';
import { Socket } from 'effect/socket';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach } from 'vitest';
import type { ShipData } from '../src/domain.ts';
import { FeedStore } from '../src/feeds.ts';
import {
  AisCollector,
  cleanText,
  mergeShips,
  parseAisTime,
  type Position,
  readDigitraffic,
  streamAisstream,
} from '../src/ingest/ships.ts';
import { listen, ShipsLayer, ShipTracker } from '../src/ships.ts';
import { fakeHttp, fixture } from './support.ts';

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

const NOW_MS = 1794790561538;
const BALTIC = [255806247, 255806258, 259859000];

describe('ships: aisstream.io connection', () => {
  const connect = (socket: ReturnType<typeof scriptedSocket>, heard: AisCollector[]) =>
    streamAisstream('test-key', (batch) => Effect.sync(() => void heard.push(batch))).pipe(
      Effect.provideService(Socket.WebSocketConstructor, socket.make),
    );

  it.effect('hands each batch to the tracker until the connection ends, and says why', () =>
    Effect.gen(function* () {
      const socket = scriptedSocket(recordedMessages, { code: 1006, reason: '' });
      const heard: AisCollector[] = [];
      const { messages, ended } = yield* connect(socket, heard);
      const subscription = JSON.parse(socket.sent[0] ?? '{}') as {
        APIKey: string;
        FilterMessageTypes: string[];
      };
      assert.strictEqual(subscription.APIKey, 'test-key');
      assert.include(subscription.FilterMessageTypes, 'ShipStaticData');
      assert.strictEqual(messages, recordedMessages.length - 1);
      assert.include(ended, '1006');
      const mmsis = heard.flatMap((batch) => Array.from(batch.positions.keys()));
      assert.includeMembers(mmsis, [431011136, 211518790, 338534526, 314322000]);
    }),
  );

  it.effect('ends a connection that goes quiet', () =>
    Effect.gen(function* () {
      const heard: AisCollector[] = [];
      const listening = yield* Effect.forkChild(connect(scriptedSocket(recordedMessages), heard));
      // The scripted socket delivers on the event loop; then nothing more comes.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      yield* TestClock.adjust('2 minutes');
      const { ended } = yield* Fiber.join(listening);
      assert.include(ended, 'nothing heard');
      assert.isAbove(heard.length, 0);
    }),
  );

  it.effect('fails when the key is refused', () =>
    Effect.gen(function* () {
      const socket = scriptedSocket(['{"error":"Api Key Is Not Valid"}'], { code: 1000, reason: '' });
      const error = yield* Effect.flip(connect(socket, []));
      assert.strictEqual(error._tag, 'IngestError');
      assert.include(error.message, 'Api Key Is Not Valid');
    }),
  );

  it.effect('fails when the connection ends before sending anything', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(connect(scriptedSocket([], { code: 1011, reason: 'overloaded' }), []));
      assert.include(error.message, 'aisstream.io');
    }),
  );
});

describe('ships: Digitraffic', () => {
  it.effect(
    'reaches back as long as vessels are kept on the first poll, and to the previous poll after',
    () =>
      Effect.gen(function* () {
        const http = fakeHttp();
        const first = yield* readDigitraffic(NOW_MS).pipe(Effect.provide(http.layer));
        assert.isTrue(http.calls.every((c) => c.headers['digitraffic-user'] === 'atlas'));
        const [locations, vessels] = http.calls;
        assert.strictEqual(locations?.url.searchParams.get('from'), String(NOW_MS - 3 * 60 * 60 * 1000));
        assert.isNull(vessels?.url.searchParams.get('from'));
        assert.includeMembers(
          first.positions.map((p) => p.mmsi),
          BALTIC,
        );
        assert.deepStrictEqual(
          first.statics.find((v) => v.mmsi === 255806247),
          {
            mmsi: 255806247,
            name: 'SILVA',
            callsign: 'CQAQ5',
            imo: 9237010,
            shipType: 70,
            destination: 'FIHMN',
            length: 100,
            width: 17,
          },
        );

        yield* readDigitraffic(NOW_MS + 60_000, NOW_MS - 30_000).pipe(Effect.provide(http.layer));
        for (const call of http.calls.slice(2))
          assert.strictEqual(call.url.searchParams.get('from'), String(NOW_MS - 30_000));
      }),
  );
});

/** The tracker on `platform`, with the feed store it publishes to. */
const trackerOn = (platform: Layer.Layer<Platform.Services>) =>
  ShipTracker.layer.pipe(Layer.provideMerge(FeedStore.layer), Layer.provideMerge(platform));

const published = Effect.gen(function* () {
  const store = yield* FeedStore;
  return Option.getOrThrow(yield* store.payload('ships'));
});

describe('ships: tracker', () => {
  it.effect("publishes what it heard, and fills in static data heard before a vessel's position", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const tracker = yield* ShipTracker;
      const now = NOW_MS / 1000;
      yield* tracker.hear([position(1, now - 10, 12)], [{ mmsi: 2, name: 'EARLY BIRD', length: 90 }]);
      const first = yield* tracker.publish;
      assert.deepStrictEqual([...first.mmsi], [1]);

      yield* TestClock.adjust('1 minute');
      yield* tracker.hear([position(2, now + 50, 0, 5)], []);
      const second = yield* published;
      assert.deepStrictEqual([...second.mmsi], [1]);
      yield* tracker.publish;
      const third = yield* published;
      assert.deepStrictEqual(
        [...third.mmsi].toSorted((a, b) => a - b),
        [1, 2],
      );
      assert.deepStrictEqual([row(third, 2)?.name, row(third, 2)?.length], ['EARLY BIRD', 90]);
      const status = (yield* (yield* FeedStore).states).get('ships');
      assert.strictEqual(status?.count, 2);
      assert.strictEqual(status?.intervalSeconds, 60);
    }).pipe(Effect.provide(trackerOn(Platform.layerMemory()))),
  );

  it.effect('starts from the last published snapshot, so a restart keeps the map', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const platform = yield* Layer.build(Platform.layerMemory());
      const shared = Layer.succeedContext(platform);
      yield* Effect.gen(function* () {
        const tracker = yield* ShipTracker;
        yield* tracker.hear([position(7, NOW_MS / 1000, 0, 5)], [{ mmsi: 7, name: 'STAYS' }]);
        yield* tracker.publish;
      }).pipe(Effect.provide(trackerOn(shared)));
      yield* TestClock.adjust('1 minute');
      const restarted = yield* Effect.flatMap(ShipTracker, (t) => t.publish).pipe(
        Effect.provide(trackerOn(shared)),
      );
      assert.deepStrictEqual([row(restarted, 7)?.name], ['STAYS']);
    }),
  );
});

describe('ships: service', () => {
  let telemetry: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    telemetry = captureTelemetry();
  });
  afterEach(() => telemetry.stop());
  /** The service's units of work, as the console counts them. */
  const jobs = () =>
    telemetry.events.flatMap((e) => (e.t === 'job' && e.kind === 'service' ? [`${e.name} ${e.status}`] : []));

  it.effect('polls Digitraffic at once, publishes every minute, and once more when it stops', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const platform = yield* Layer.build(Platform.layerMemory());
      const http = fakeHttp();
      const versions = Effect.map(
        Effect.flatMap(FeedStore, (store) => store.states),
        (states) => states.get('ships')?.version,
      ).pipe(Effect.provide(FeedStore.layer.pipe(Layer.provide(Layer.succeedContext(platform)))));

      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        ShipsLayer.pipe(Layer.provide([Layer.succeedContext(platform), http.layer])),
        scope,
      );
      yield* TestClock.adjust('1 second');
      assert.isAbove(http.calls.length, 0);
      assert.isUndefined(yield* versions);

      yield* TestClock.adjust('1 minute');
      const first = yield* versions;
      assert.isDefined(first);
      const data = yield* published.pipe(
        Effect.provide(FeedStore.layer.pipe(Layer.provide(Layer.succeedContext(platform)))),
      );
      assert.includeMembers([...data.mmsi], [255806247]);

      yield* Scope.close(scope, Exit.void);
      const last = yield* versions;
      assert.notStrictEqual(last, first);
      // A poll at once and another a minute later, a publish each minute, and the last on the way out.
      assert.deepStrictEqual(jobs().toSorted(), [
        'digitraffic ok',
        'digitraffic ok',
        'publish ok',
        'publish ok',
      ]);
    }),
  );

  it.effect('holds an aisstream.io connection per run, heard into the tracker', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-11-16T01:22:05Z'));
      const socket = scriptedSocket(recordedMessages, { code: 1006, reason: '' });
      yield* listen.pipe(Effect.provideService(Socket.WebSocketConstructor, socket.make));
      const data = yield* (yield* ShipTracker).publish;
      assert.includeMembers([...data.mmsi], [431011136, 211518790, 338534526, 314322000]);
      assert.strictEqual(row(data, 431011136)?.name, 'YAMABISHIMARU NO.18');
    }).pipe(Effect.provide(trackerOn(Platform.layerMemory({ secrets: { AISSTREAM_KEY: 'test-key' } })))),
  );
});
