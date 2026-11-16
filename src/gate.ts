/**
 * Keeping upstream services happy: lookups by area can fan out to many
 * requests for one view, and some upstreams limit how fast or how many at once.
 */
import { Clock, Data, Duration, Effect, Semaphore } from 'effect';

/** The upstream already has requests booked further ahead than the caller is willing to wait. */
export class GateBusy extends Data.TaggedError('GateBusy') {}

/**
 * Spaces the requests one server instance makes to an upstream with a rate
 * limit: each starts at least `spacing` after the previous one. A request
 * that would have to wait longer than `maxWait` fails at once instead, so a
 * burst of lookups answers "try again" rather than piling up behind the limit.
 */
export const makeGate = (spacing: Duration.Input, maxWait: Duration.Input) =>
  Effect.sync(() => {
    const step = Duration.toMillis(spacing);
    const patience = Duration.toMillis(maxWait);
    let next = Number.NEGATIVE_INFINITY;
    return <A, E, R>(request: Effect.Effect<A, E, R>): Effect.Effect<A, E | GateBusy, R> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const slot = Math.max(now, next);
        if (slot - now > patience) return yield* new GateBusy();
        // Booked before the first yield below, so concurrent callers each get their own slot.
        next = slot + step;
        if (slot > now) yield* Effect.sleep(Duration.millis(slot - now));
        return yield* request;
      });
  });

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
