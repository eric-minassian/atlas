import { Effect, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { Api } from '../../src/api.ts';

/**
 * The API client, generated from `src/api.ts`: paths, payloads, responses and
 * errors are checked against the server's definition, and responses are
 * decoded with the same schemas the server encodes with.
 */
export const runtime = ManagedRuntime.make(FetchHttpClient.layer);

const client = HttpApiClient.make(Api, { baseUrl: window.location.origin });

export type ApiClient = Effect.Success<typeof client>;

/** Runs `f` with the client; aborting `signal` cancels the request. */
export const callApi = <A, E>(
  f: (api: ApiClient) => Effect.Effect<A, E>,
  options?: { readonly signal?: AbortSignal },
): Promise<A> => runtime.runPromise(Effect.flatMap(client, f), options);
