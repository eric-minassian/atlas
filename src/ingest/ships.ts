import { Secrets } from '@ericminassian/platform';
import { Clock, Effect, Option, Predicate, Redacted, Result, Schema } from 'effect';
import { Socket } from 'effect/socket';
import { feeds } from '../catalog.ts';
import type { ShipData } from '../domain.ts';
import { type Columns, decodeJson, get, IngestError, okText, round, type Source, updated } from './source.ts';

/**
 * Ships from AIS. aisstream.io relays a worldwide network of volunteer
 * receivers over a WebSocket; the worker can't hold one open between runs, so
 * each refresh listens for a while and merges what it heard into the previous
 * snapshot. Fintraffic's Digitraffic (the Baltic, no key) is read every time,
 * so the layer works without an aisstream key too.
 */
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const DIGITRAFFIC_URL = 'https://meri.digitraffic.fi/api/ais/v1';
/** Well inside the worker's 120 s, leaving time for the merge and publishing. */
const LISTEN_SECONDS = 45;
/** A vessel under way that goes unheard this long has left coverage. */
const MOVING_TTL_S = 30 * 60;
/** Moored and anchored vessels report every few minutes and move little, so they're kept longer. */
const STATIONARY_TTL_S = 3 * 60 * 60;
const MOVING_KNOTS = 0.5;
/** At anchor, moored, aground. */
const STATIONARY_STATUS = new Set([1, 5, 6]);

/** A position report, normalized. */
export interface Position {
  readonly mmsi: number;
  readonly lon: number;
  readonly lat: number;
  readonly speed: number | null;
  readonly course: number | null;
  readonly heading: number | null;
  /** Null for class B transponders, which don't report one. */
  readonly status: number | null;
  /** Epoch seconds. */
  readonly time: number;
}

/** Static and voyage data; absent fields weren't in the message. */
export interface Static {
  readonly mmsi: number;
  readonly name?: string;
  readonly callsign?: string;
  readonly imo?: number;
  readonly shipType?: number;
  readonly destination?: string;
  readonly length?: number;
  readonly width?: number;
}

type Vessel = { -readonly [K in keyof Position]: Position[K] } & {
  status: number;
  name: string;
  callsign: string;
  imo: number;
  shipType: number;
  destination: string;
  length: number;
  width: number;
};

/** AIS 6-bit text pads with `@`; whatever follows the first one is filler. */
export const cleanText = (value: string): string => (value.split('@')[0] ?? '').replace(/\s+/g, ' ').trim();

const validPosition = (lon: number, lat: number) =>
  Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
/** 102.3 knots means "not available". */
const speedOf = (sog: number) => (sog >= 102.2 || sog < 0 ? null : round(sog, 1));
/** 360 means "not available". */
const courseOf = (cog: number) => (cog >= 360 || cog < 0 ? null : Math.round(cog) % 360);
/** 511 means "not available". */
const headingOf = (heading: number) => (heading > 359 || heading < 0 ? null : Math.round(heading));
const shipTypeOf = (type: number) => (type > 0 && type < 100 ? type : 0);
const imoOf = (imo: number) => (imo >= 1_000_000 && imo <= 9_999_999 ? imo : 0);
/** Distances from the GPS antenna to bow, stern, port and starboard. */
const sizeOf = (d: { readonly A: number; readonly B: number; readonly C: number; readonly D: number }) => ({
  length: d.A + d.B,
  width: d.C + d.D,
});

const isMoving = (v: Pick<Vessel, 'speed' | 'status'>) =>
  v.speed !== null && v.speed >= MOVING_KNOTS && !STATIONARY_STATUS.has(v.status);

/**
 * Builds the next snapshot: the previous vessels, moved to newer positions
 * where there are any, with static data filled in where messages carried it,
 * less those unheard for too long (`now` in epoch seconds). Static data comes
 * every six minutes or so, so a vessel keeps its name and size between
 * snapshots even when only positions were heard this time.
 */
export const mergeShips = (
  previous: ShipData | undefined,
  positions: Iterable<Position>,
  statics: Iterable<Static>,
  now: number,
): ShipData => {
  const vessels = new Map<number, Vessel>();
  if (previous) {
    for (let i = 0; i < previous.mmsi.length; i++) {
      const mmsi = previous.mmsi[i] as number;
      vessels.set(mmsi, {
        mmsi,
        lon: previous.lon[i] as number,
        lat: previous.lat[i] as number,
        speed: previous.speed[i] ?? null,
        course: previous.course[i] ?? null,
        heading: previous.heading[i] ?? null,
        status: previous.status[i] as number,
        time: previous.since + (previous.time[i] as number),
        name: previous.name[i] ?? '',
        callsign: previous.callsign[i] ?? '',
        imo: previous.imo[i] ?? 0,
        shipType: previous.shipType[i] ?? 0,
        destination: previous.destination[i] ?? '',
        length: previous.length[i] ?? 0,
        width: previous.width[i] ?? 0,
      });
    }
  }
  for (const p of positions) {
    const known = vessels.get(p.mmsi);
    if (known && known.time >= p.time) continue;
    vessels.set(p.mmsi, {
      name: '',
      callsign: '',
      imo: 0,
      shipType: 0,
      destination: '',
      length: 0,
      width: 0,
      ...known,
      ...p,
      status: p.status ?? known?.status ?? 15,
    });
  }
  for (const s of statics) {
    const v = vessels.get(s.mmsi);
    if (!v) continue; // no position to put it at
    if (s.name) v.name = s.name;
    if (s.callsign) v.callsign = s.callsign;
    if (s.imo) v.imo = s.imo;
    if (s.shipType) v.shipType = s.shipType;
    if (s.destination) v.destination = s.destination;
    if (s.length) v.length = s.length;
    if (s.width) v.width = s.width;
  }

  const kept = [...vessels.values()].filter(
    (v) => now - v.time <= (isMoving(v) ? MOVING_TTL_S : STATIONARY_TTL_S),
  );
  const since = kept.reduce((min, v) => Math.min(min, v.time), now);
  const out: Columns<Omit<ShipData, 'since'>> = {
    mmsi: [],
    name: [],
    callsign: [],
    imo: [],
    shipType: [],
    lon: [],
    lat: [],
    speed: [],
    course: [],
    heading: [],
    status: [],
    destination: [],
    length: [],
    width: [],
    time: [],
  };
  for (const v of kept) {
    out.mmsi.push(v.mmsi);
    out.name.push(v.name);
    out.callsign.push(v.callsign);
    out.imo.push(v.imo);
    out.shipType.push(v.shipType);
    out.lon.push(v.lon);
    out.lat.push(v.lat);
    out.speed.push(v.speed);
    out.course.push(v.course);
    out.heading.push(v.heading);
    out.status.push(v.status);
    out.destination.push(v.destination);
    out.length.push(v.length);
    out.width.push(v.width);
    out.time.push(Math.round(v.time - since));
  }
  return { since: Math.floor(since), ...out };
};

// ---------------------------------------------------------------------------
// aisstream.io
// ---------------------------------------------------------------------------

const Dimension = Schema.Struct({ A: Schema.Int, B: Schema.Int, C: Schema.Int, D: Schema.Int });
const MetaData = Schema.Struct({
  MMSI: Schema.Int,
  /** aisstream's last known name for the vessel, sent with every message. */
  ShipName: Schema.optionalKey(Schema.String),
  time_utc: Schema.String,
});
const Located = {
  Latitude: Schema.Finite,
  Longitude: Schema.Finite,
  Sog: Schema.Finite,
  Cog: Schema.Finite,
  TrueHeading: Schema.Finite,
  Valid: Schema.Boolean,
};
const message = <T extends string, S extends Schema.Top>(type: T, body: S) =>
  Schema.Struct({
    MessageType: Schema.Literal(type),
    MetaData,
    Message: Schema.Struct({ [type]: body } as { [K in T]: S }),
  });

/** The aisstream.io messages Atlas subscribes to (https://aisstream.io/documentation). Extra keys are ignored. */
const AisMessage = Schema.Union([
  message('PositionReport', Schema.Struct({ ...Located, NavigationalStatus: Schema.Int })),
  message('StandardClassBPositionReport', Schema.Struct(Located)),
  message(
    'ExtendedClassBPositionReport',
    Schema.Struct({ ...Located, Name: Schema.String, Type: Schema.Int, Dimension }),
  ),
  message(
    'ShipStaticData',
    Schema.Struct({
      Name: Schema.String,
      CallSign: Schema.String,
      Destination: Schema.String,
      Type: Schema.Int,
      ImoNumber: Schema.Int,
      Dimension,
      Valid: Schema.Boolean,
    }),
  ),
  message(
    'StaticDataReport',
    Schema.Struct({
      PartNumber: Schema.Boolean,
      ReportA: Schema.Struct({ Name: Schema.String, Valid: Schema.Boolean }),
      ReportB: Schema.Struct({
        CallSign: Schema.String,
        ShipType: Schema.Int,
        Dimension,
        Valid: Schema.Boolean,
      }),
    }),
  ),
]);
type AisMessage = typeof AisMessage.Type;
export const aisMessageTypes = AisMessage.members.map((m) => m.fields.MessageType.literal);

const decodeAisMessage = Schema.decodeUnknownOption(AisMessage);

/** `2026-11-16 00:56:47.297760842 +0000 UTC` → epoch seconds. */
export const parseAisTime = (value: string): number | undefined => {
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(value);
  const ms = match ? Date.parse(`${match[1]}T${match[2]}Z`) : Number.NaN;
  return Number.isFinite(ms) ? ms / 1000 : undefined;
};

/** What a listen heard: the latest position per vessel and every static report, merged per vessel. */
export class AisCollector {
  readonly positions = new Map<number, Position>();
  readonly statics = new Map<number, Static>();
  messages = 0;
  skipped = 0;
  /** aisstream answers a bad subscription with `{"error": …}` before closing. */
  error: string | undefined;

  /** Takes one message as sent (JSON text). */
  add(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.skipped++;
      return;
    }
    if (Predicate.hasProperty(json, 'error') && Predicate.isString(json.error)) {
      this.error = json.error;
      return;
    }
    const decoded = decodeAisMessage(json);
    if (Option.isNone(decoded)) {
      // Subscription confirmations and message types we didn't ask for.
      this.skipped++;
      return;
    }
    this.messages++;
    this.take(decoded.value);
  }

  private take(m: AisMessage): void {
    const mmsi = m.MetaData.MMSI;
    const time = parseAisTime(m.MetaData.time_utc);
    if (m.MetaData.ShipName) this.static({ mmsi, name: cleanText(m.MetaData.ShipName) });
    switch (m.MessageType) {
      case 'PositionReport': {
        const r = m.Message.PositionReport;
        if (r.Valid && time !== undefined) this.position(mmsi, r, r.NavigationalStatus, time);
        return;
      }
      case 'StandardClassBPositionReport': {
        const r = m.Message.StandardClassBPositionReport;
        if (r.Valid && time !== undefined) this.position(mmsi, r, null, time);
        return;
      }
      case 'ExtendedClassBPositionReport': {
        const r = m.Message.ExtendedClassBPositionReport;
        if (!r.Valid) return;
        if (time !== undefined) this.position(mmsi, r, null, time);
        this.static({
          mmsi,
          name: cleanText(r.Name),
          shipType: shipTypeOf(r.Type),
          ...sizeOf(r.Dimension),
        });
        return;
      }
      case 'ShipStaticData': {
        const r = m.Message.ShipStaticData;
        if (!r.Valid) return;
        this.static({
          mmsi,
          name: cleanText(r.Name),
          callsign: cleanText(r.CallSign),
          destination: cleanText(r.Destination),
          shipType: shipTypeOf(r.Type),
          imo: imoOf(r.ImoNumber),
          ...sizeOf(r.Dimension),
        });
        return;
      }
      case 'StaticDataReport': {
        const r = m.Message.StaticDataReport;
        // Class B static data comes in two parts: A has the name, B the rest.
        if (!r.PartNumber && r.ReportA.Valid) this.static({ mmsi, name: cleanText(r.ReportA.Name) });
        if (r.PartNumber && r.ReportB.Valid)
          this.static({
            mmsi,
            callsign: cleanText(r.ReportB.CallSign),
            shipType: shipTypeOf(r.ReportB.ShipType),
            ...sizeOf(r.ReportB.Dimension),
          });
        return;
      }
    }
  }

  private position(
    mmsi: number,
    r: { Latitude: number; Longitude: number; Sog: number; Cog: number; TrueHeading: number },
    status: number | null,
    time: number,
  ): void {
    if (!validPosition(r.Longitude, r.Latitude)) return;
    const known = this.positions.get(mmsi);
    if (known && known.time > time) return;
    this.positions.set(mmsi, {
      mmsi,
      lon: round(r.Longitude, 4),
      lat: round(r.Latitude, 4),
      speed: speedOf(r.Sog),
      course: courseOf(r.Cog),
      heading: headingOf(r.TrueHeading),
      status,
      time,
    });
  }

  private static(s: Static): void {
    const known = this.statics.get(s.mmsi);
    const defined = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== '' && v !== 0));
    this.statics.set(s.mmsi, { ...known, ...defined, mmsi: s.mmsi });
  }
}

const textDecoder = new TextDecoder();

/**
 * Listens to aisstream.io for `seconds`. The subscription must be sent within
 * 3 s of connecting, and the service drops messages for slow readers, so each
 * frame is folded into the collector as it arrives. aisstream caps the
 * bandwidth of uncompressed connections; Node's WebSocket (Node 22+, as on
 * Lambda) negotiates permessage-deflate. The account allows 3 connections at
 * once, shared by every stage using the key.
 */
const listen = Effect.fnUntraced(function* (key: string, seconds: number) {
  const collector = new AisCollector();
  const socket = yield* Socket.makeWebSocket(AISSTREAM_URL, { openTimeout: '10 seconds' });
  const ended = yield* Effect.gen(function* () {
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    yield* writer.write(
      JSON.stringify({
        APIKey: key,
        BoundingBoxes: [
          [
            [-90, -180],
            [90, 180],
          ],
        ],
        FilterMessageTypes: aisMessageTypes,
      }),
    );
    const deadline = (yield* Clock.currentTimeMillis) + seconds * 1000;
    while (true) {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return undefined;
      const frames = yield* Effect.timeoutOption(reader.pull, remaining);
      if (Option.isNone(frames)) return undefined;
      for (const frame of frames.value)
        collector.add(typeof frame === 'string' ? frame : textDecoder.decode(frame));
    }
  }).pipe(
    Effect.scoped,
    // A connection closed early still leaves what it delivered.
    Effect.catchTag('SocketError', (error) => Effect.succeed(error)),
  );
  if (collector.error !== undefined)
    return yield* new IngestError({ message: `aisstream.io: ${collector.error}` });
  if (ended && collector.messages === 0)
    return yield* new IngestError({ message: `aisstream.io: ${ended.message}` });
  if (ended)
    yield* Effect.logWarning('aisstream.io closed the connection early').pipe(
      Effect.annotateLogs({ error: ended.message, messages: collector.messages }),
    );
  return collector;
});

// ---------------------------------------------------------------------------
// Fintraffic Digitraffic
// ---------------------------------------------------------------------------

/** https://meri.digitraffic.fi/swagger/ — `locations`. Extra keys are ignored. */
const DigitrafficLocations = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      mmsi: Schema.Int,
      geometry: Schema.Struct({ coordinates: Schema.Tuple([Schema.Finite, Schema.Finite]) }),
      properties: Schema.Struct({
        sog: Schema.Finite,
        cog: Schema.Finite,
        navStat: Schema.Int,
        heading: Schema.Finite,
        /** Epoch ms the position was received. */
        timestampExternal: Schema.Finite,
      }),
    }),
  ),
});
type DigitrafficLocations = typeof DigitrafficLocations.Type;

/** `vessels`: each vessel's latest static and voyage data. */
const DigitrafficVessels = Schema.Array(
  Schema.Struct({
    mmsi: Schema.Int,
    name: Schema.String,
    callSign: Schema.String,
    imo: Schema.Int,
    shipType: Schema.Int,
    destination: Schema.String,
    referencePointA: Schema.Int,
    referencePointB: Schema.Int,
    referencePointC: Schema.Int,
    referencePointD: Schema.Int,
  }),
);
type DigitrafficVessels = typeof DigitrafficVessels.Type;

export const parseDigitraffic = (
  locations: DigitrafficLocations,
  vessels: DigitrafficVessels,
): { positions: Position[]; statics: Static[] } => ({
  positions: locations.features.flatMap(({ mmsi, geometry, properties: p }) => {
    const [lon, lat] = geometry.coordinates;
    if (!validPosition(lon, lat)) return [];
    return [
      {
        mmsi,
        lon: round(lon, 4),
        lat: round(lat, 4),
        speed: speedOf(p.sog),
        course: courseOf(p.cog),
        heading: headingOf(p.heading),
        status: p.navStat,
        time: p.timestampExternal / 1000,
      },
    ];
  }),
  statics: vessels.map((v) => ({
    mmsi: v.mmsi,
    name: cleanText(v.name),
    callsign: cleanText(v.callSign),
    imo: imoOf(v.imo),
    shipType: shipTypeOf(v.shipType),
    destination: cleanText(v.destination),
    ...sizeOf({ A: v.referencePointA, B: v.referencePointB, C: v.referencePointC, D: v.referencePointD }),
  })),
});

const readDigitraffic = Effect.fnUntraced(function* (now: number) {
  // Digitraffic asks clients to name themselves.
  const headers = { 'digitraffic-user': 'atlas' };
  const [locations, vessels] = yield* Effect.all(
    [
      // Nothing older than the longest a vessel is kept.
      get(`${DIGITRAFFIC_URL}/locations?from=${Math.floor((now - STATIONARY_TTL_S) * 1000)}`, {
        headers,
      }).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(DigitrafficLocations))),
      get(`${DIGITRAFFIC_URL}/vessels`, { headers }).pipe(
        Effect.flatMap(okText),
        Effect.flatMap(decodeJson(DigitrafficVessels)),
      ),
    ],
    { concurrency: 2 },
  );
  return parseDigitraffic(locations, vessels);
});

export interface ShipSourceOptions {
  /** Opens the aisstream.io connection; tests stand in a scripted socket. */
  readonly webSocket?: Socket.WebSocketConstructor['Service'];
}

export const makeShipSource = (options: ShipSourceOptions = {}): Source<'ships'> => ({
  interval: Effect.succeed(feeds.ships.intervalSeconds),
  read: (_validators, previous) =>
    Effect.gen(function* () {
      const key = yield* (yield* Secrets).getOptional('AISSTREAM_KEY');
      const now = (yield* Clock.currentTimeMillis) / 1000;
      const stream = Option.match(key, {
        onNone: () => Effect.undefined,
        onSome: (k) =>
          listen(Redacted.value(k), LISTEN_SECONDS).pipe(
            options.webSocket
              ? Effect.provideService(Socket.WebSocketConstructor, options.webSocket)
              : Effect.provide(Socket.layerWebSocketConstructorGlobal),
          ),
      });
      const [heard, baltic] = yield* Effect.all(
        [Effect.result(stream), Effect.result(readDigitraffic(now))],
        {
          concurrency: 2,
        },
      );
      if (Result.isFailure(heard) && Result.isFailure(baltic))
        return yield* new IngestError({
          message: `${heard.failure.message}; Digitraffic: ${baltic.failure.message}`,
        });
      // One source is better than none: keep publishing, and say which one failed.
      const failed = (source: string, error: IngestError) =>
        Effect.logWarning('ship source failed').pipe(Effect.annotateLogs({ source, error: error.message }));
      if (Result.isFailure(heard)) yield* failed('aisstream.io', heard.failure);
      if (Result.isFailure(baltic)) yield* failed('Digitraffic', baltic.failure);
      const positions: Position[] = [];
      const statics: Static[] = [];
      if (Result.isSuccess(baltic)) {
        positions.push(...baltic.success.positions);
        statics.push(...baltic.success.statics);
      }
      if (Result.isSuccess(heard) && heard.success) {
        positions.push(...heard.success.positions.values());
        statics.push(...heard.success.statics.values());
        yield* Effect.logInfo('heard aisstream.io').pipe(
          Effect.annotateLogs({
            messages: heard.success.messages,
            vessels: heard.success.positions.size,
            skipped: heard.success.skipped,
          }),
        );
      }
      const data = mergeShips(Option.getOrUndefined(yield* previous), positions, statics, now);
      return updated<'ships'>(data, data.mmsi.length);
    }),
});
