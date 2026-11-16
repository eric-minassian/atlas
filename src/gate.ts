import { Clock, Data, Duration, Effect } from 'effect';

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
