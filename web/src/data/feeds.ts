import { Effect, Result } from 'effect';
import { feeds } from '../../../src/catalog.ts';
import type { FeedId, FeedStatus, Snapshots } from '../../../src/domain.ts';
import { type ApiClient, callApi } from '../client.ts';

export type Snapshot<F extends FeedId> = (typeof Snapshots)[F]['Type'];

type Fetchers = { [F in FeedId]: (api: ApiClient) => Effect.Effect<Snapshot<F>, unknown> };

const fetchers: Fetchers = {
  aircraft: (api) => api.feeds.aircraft(),
  satellites: (api) => api.feeds.satellites(),
  earthquakes: (api) => api.feeds.earthquakes(),
  fires: (api) => api.feeds.fires(),
  events: (api) => api.feeds.events(),
  radar: (api) => api.feeds.radar(),
};

export interface FeedView {
  /** No snapshot yet, or the last request failed and no snapshot is held. */
  readonly state: 'idle' | 'loading' | 'ready' | 'pending' | 'error';
  readonly version?: string;
  readonly fetchedAt?: number;
  readonly count?: number;
}

/** One shared object, so `useSyncExternalStore` sees a stable snapshot. */
const IDLE: FeedView = { state: 'idle' };

type Listener<F extends FeedId> = (snapshot: Snapshot<F>) => void;

/**
 * Polls each feed while at least one layer listens to it. Polls are spaced by
 * a third of the feed's refresh interval (bounded to 10 s - 5 min); responses
 * are edge-cached, and an unchanged version isn't handed to listeners again.
 */
class FeedPoller {
  private readonly listeners = new Map<FeedId, Set<Listener<FeedId>>>();
  /** Feeds with a poll loop running: a request in flight or the next one scheduled. */
  private readonly running = new Set<FeedId>();
  private readonly timers = new Map<FeedId, ReturnType<typeof setTimeout>>();
  private readonly latest = new Map<FeedId, Snapshot<FeedId>>();
  private readonly views = new Map<FeedId, FeedView>();
  private readonly viewListeners = new Set<() => void>();
  private readonly intervals = new Map<FeedId, number>();

  subscribe<F extends FeedId>(feed: F, listener: Listener<F>): () => void {
    let set = this.listeners.get(feed);
    if (!set) {
      set = new Set();
      this.listeners.set(feed, set);
    }
    set.add(listener as Listener<FeedId>);
    const held = this.latest.get(feed);
    if (held) listener(held);
    if (!this.running.has(feed)) {
      this.running.add(feed);
      void this.poll(feed, 0);
    }
    return () => {
      set.delete(listener as Listener<FeedId>);
      if (set.size > 0) return;
      const timer = this.timers.get(feed);
      if (timer === undefined) return; // a request is in flight; the loop stops when it returns
      clearTimeout(timer);
      this.timers.delete(feed);
      this.running.delete(feed);
    };
  }

  /** The current snapshot, if one has arrived. */
  get<F extends FeedId>(feed: F): Snapshot<F> | undefined {
    return this.latest.get(feed);
  }

  view(feed: FeedId): FeedView {
    return this.views.get(feed) ?? IDLE;
  }

  onViews(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  /** Adopts the server's (possibly credential-dependent) refresh intervals from the catalog. */
  adoptStatuses(statuses: ReadonlyArray<FeedStatus>) {
    for (const s of statuses) this.intervals.set(s.id, s.intervalSeconds);
  }

  private pollDelay(feed: FeedId, failures: number): number {
    const interval = (this.intervals.get(feed) ?? feeds[feed].intervalSeconds) * 1000;
    const base = Math.min(300_000, Math.max(10_000, interval / 3));
    return failures > 0 ? Math.min(300_000, base * 2 ** failures) : base;
  }

  private setView(feed: FeedId, view: FeedView) {
    this.views.set(feed, view);
    for (const l of this.viewListeners) l();
  }

  private async poll(feed: FeedId, failures: number): Promise<void> {
    this.timers.delete(feed);
    const previous = this.views.get(feed);
    if (!previous?.version) this.setView(feed, { state: 'loading' });
    let nextFailures = 0;
    const fetcher = fetchers[feed] as (api: ApiClient) => Effect.Effect<Snapshot<FeedId>, unknown>;
    const result = await callApi((api) => Effect.result(fetcher(api))).catch((defect: unknown) =>
      Result.fail(defect),
    );
    if (Result.isSuccess(result)) {
      const snapshot = result.success;
      if (snapshot.version !== this.latest.get(feed)?.version) {
        this.latest.set(feed, snapshot);
        for (const l of this.listeners.get(feed) ?? []) l(snapshot);
      }
      this.setView(feed, {
        state: 'ready',
        version: snapshot.version,
        fetchedAt: snapshot.fetchedAt,
        count: snapshot.count,
      });
    } else {
      nextFailures = failures + 1;
      const notReady = isTagged(result.failure, 'FeedNotReady');
      if (!previous?.version) this.setView(feed, { state: notReady ? 'pending' : 'error' });
    }
    if (!this.listeners.get(feed)?.size) {
      this.running.delete(feed);
      return;
    }
    this.timers.set(
      feed,
      setTimeout(() => void this.poll(feed, nextFailures), this.pollDelay(feed, nextFailures)),
    );
  }
}

const isTagged = (error: unknown, tag: string) =>
  typeof error === 'object' && error !== null && (error as { _tag?: unknown })._tag === tag;

export const feedPoller = new FeedPoller();
