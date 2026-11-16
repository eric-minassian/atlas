import { type Effect, Semaphore } from 'effect';

/** Runs `request` when its host's turn comes. */
export type HostGate = <A, E, R>(url: string, request: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/**
 * A polite client for hosts that serve many feeds (a transit data portal, a
 * bike-share platform): one request at a time per host, so a view covering
 * twenty of its feeds sends them one after another rather than all at once.
 * Requests to different hosts don't wait on each other.
 */
export const makeHostGate = (): HostGate => {
  const hosts = new Map<string, Semaphore.Semaphore>();
  return (url, request) => {
    const host = new URL(url).host;
    let semaphore = hosts.get(host);
    if (!semaphore) {
      semaphore = Semaphore.makeUnsafe(1);
      hosts.set(host, semaphore);
    }
    return semaphore.withPermit(request);
  };
};
