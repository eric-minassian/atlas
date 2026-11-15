import { Secrets } from '@ericminassian/platform';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { openSkyInterval } from '../catalog.ts';
import type { AircraftData } from '../domain.ts';
import { type Columns, decodeJson, get, IngestError, okText, round, type Source, updated } from './source.ts';

const STATES_URL = 'https://opensky-network.org/api/states/all?extended=1';
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const N = Schema.NullOr(Schema.Finite);

/** One OpenSky state vector (https://openskynetwork.github.io/opensky-api/rest.html). */
const StateVector = Schema.TupleWithRest(
  Schema.Tuple([
    Schema.String, // 0 icao24
    Schema.NullOr(Schema.String), // 1 callsign
    Schema.String, // 2 origin_country
    N, // 3 time_position
    Schema.Finite, // 4 last_contact
    N, // 5 longitude
    N, // 6 latitude
    N, // 7 baro_altitude
    Schema.Boolean, // 8 on_ground
    N, // 9 velocity
    N, // 10 true_track
    N, // 11 vertical_rate
    Schema.Unknown, // 12 sensors
    N, // 13 geo_altitude
    Schema.NullOr(Schema.String), // 14 squawk
    Schema.Boolean, // 15 spi
    Schema.Finite, // 16 position_source
  ]),
  [Schema.Unknown], // 17 category (with extended=1), and whatever OpenSky adds later
);

const StatesResponse = Schema.Struct({
  time: Schema.Finite,
  states: Schema.NullOr(Schema.Array(StateVector)),
});
type StatesResponse = typeof StatesResponse.Type;

const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Finite });

/** Normalizes OpenSky's state vectors, dropping aircraft without a position. */
export const parseStates = (response: StatesResponse): AircraftData => {
  const out: Columns<AircraftData> = {
    time: response.time,
    icao: [],
    callsign: [],
    country: [],
    lon: [],
    lat: [],
    altitude: [],
    onGround: [],
    speed: [],
    track: [],
    verticalRate: [],
    squawk: [],
    positionTime: [],
    category: [],
  };
  for (const s of response.states ?? []) {
    const lon = s[5];
    const lat = s[6];
    if (lon === null || lat === null) continue;
    const altitude = s[13] ?? s[7];
    const category = s[17];
    out.icao.push(s[0]);
    out.callsign.push((s[1] ?? '').trim());
    out.country.push(s[2]);
    out.lon.push(round(lon, 4));
    out.lat.push(round(lat, 4));
    out.altitude.push(altitude === null ? null : Math.round(altitude));
    out.onGround.push(s[8]);
    out.speed.push(s[9] === null ? null : round(s[9], 1));
    out.track.push(s[10] === null ? null : round(s[10], 1));
    out.verticalRate.push(s[11] === null ? null : round(s[11], 1));
    out.squawk.push(s[14]);
    out.positionTime.push(s[3] ?? s[4]);
    out.category.push(typeof category === 'number' && Number.isInteger(category) ? category : 0);
  }
  return out;
};

/**
 * Global aircraft positions from the OpenSky Network. With `OPENSKY_CLIENT_ID`
 * and `OPENSKY_CLIENT_SECRET` set it signs in (OAuth2 client credentials) for
 * the larger quota; tokens are reused until shortly before they expire.
 */
export const makeAircraftSource = (): Source<'aircraft'> => {
  let token: { value: string; expiresAt: number } | undefined;

  const credentials = Effect.gen(function* () {
    const secrets = yield* Secrets;
    const id = yield* secrets.getOptional('OPENSKY_CLIENT_ID');
    const secret = yield* secrets.getOptional('OPENSKY_CLIENT_SECRET');
    return Option.all({ id, secret });
  });

  const bearer = Effect.fnUntraced(function* (id: string, secret: string) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (token && token.expiresAt > now + 60_000) return token.value;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: 'client_credentials',
            client_id: id,
            client_secret: secret,
          }),
        ),
      )
      .pipe(
        Effect.timeout('30 seconds'),
        Effect.mapError((cause) => new IngestError({ message: `OpenSky sign-in: ${String(cause)}` })),
      );
    const body = yield* decodeJson(TokenResponse)(yield* okText(response)).pipe(
      Effect.mapError((e) => new IngestError({ message: `OpenSky sign-in: ${e.message}` })),
    );
    token = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return token.value;
  });

  return {
    interval: Effect.map(credentials, (c) => openSkyInterval(Option.isSome(c))),
    read: () =>
      Effect.gen(function* () {
        const creds = yield* credentials;
        const headers: Record<string, string> = {};
        if (Option.isSome(creds)) {
          const { id, secret } = creds.value;
          headers.authorization = `Bearer ${yield* bearer(Redacted.value(id), Redacted.value(secret))}`;
        }
        const response = yield* get(STATES_URL, { headers });
        if (response.status === 429) {
          const retry = response.headers['x-rate-limit-retry-after-seconds'];
          return yield* new IngestError({
            message: `OpenSky quota exhausted${retry ? `; retry in ${retry}s` : ''}`,
          });
        }
        const states = yield* decodeJson(StatesResponse)(yield* okText(response));
        const data = parseStates(states);
        return updated<'aircraft'>(data, data.icao.length);
      }),
  };
};
