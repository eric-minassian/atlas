import { storageUrl } from '@ericminassian/platform/client';
import { Schema } from 'effect';
import { feeds, snapshotKey } from '../../../src/catalog.ts';
import { type FeedId, type FeedStatus, Snapshots } from '../../../src/domain.ts';
import { callApi } from '../client.ts';

export type Snapshot<F extends FeedId> = (typeof Snapshots)[F]['Type'];

export interface FeedView {
  /** No snapshot yet, or the last request failed and no snapshot is held. */
  readonly state: 'idle' | 'loading' | 'ready' | 'pending' | 'error';
  readonly version?: string;
  readonly fetchedAt?: number;
  readonly count?: number;
}

/** One shared object, so `useSyncExternalStore` sees a stable snapshot. */
const IDLE: FeedView = { state: 'idle' };
const NO_STATUSES: ReadonlyMap<FeedId, FeedStatus> = new Map();

/** The catalog is read at least this often, for the panel's freshness and errors. */
const MAX_POLL_MS = 60_000;
/** The catalog is edge-cached for 10 s: reading it more often finds nothing new. */
const MIN_POLL_MS = 10_000;

type Listener<F extends FeedId> = (snapshot: Snapshot<F>) => void;

/**
 * Keeps the feeds layers listen to current. The catalog says each feed's
 * current version; a snapshot is fetched from the public `feeds` store only
 * when its version changes, and since a version's file never changes, the
 * edge and the browser keep it for good. The catalog is read every minute, or
 * a third of the shortest refresh interval among the feeds listened to.
 */
class FeedPoller {
  private readonly listeners = new Map<FeedId, Set<Listener<FeedId>>>();
  private readonly latest = new Map<FeedId, Snapshot<FeedId>>();
  /** Feeds with a snapshot download in flight, by the version it's for. */
  private readonly fetching = new Map<FeedId, string>();
  private readonly views = new Map<FeedId, FeedView>();
  private readonly viewListeners = new Set<() => void>();
  private statusMap = NO_STATUSES;
  private readonly statusListeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private failures = 0;

  subscribe<F extends FeedId>(feed: F, listener: Listener<F>): () => void {
    let set = this.listeners.get(feed);
    if (!set) {
      set = new Set();
      this.listeners.set(feed, set);
    }
    set.add(listener as Listener<FeedId>);
    const held = this.latest.get(feed);
    if (held) listener(held);
    // The next catalog read is spaced for this feed too.
    if (this.statusMap.size > 0) this.sync(feed);
    else this.start();
    return () => set.delete(listener as Listener<FeedId>);
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

  /** Each feed's server-side status (freshness, errors), from the latest catalog. */
  get statuses(): ReadonlyMap<FeedId, FeedStatus> {
    return this.statusMap;
  }

  onStatuses(listener: () => void): () => void {
    this.statusListeners.add(listener);
    this.start();
    return () => this.statusListeners.delete(listener);
  }

  /** Starts reading the catalog, unless it's already being read. */
  private start() {
    if (this.polling || this.timer !== undefined) return;
    void this.poll();
  }

  private pollDelay(): number {
    if (this.failures > 0) return Math.min(MAX_POLL_MS, MIN_POLL_MS * 2 ** (this.failures - 1));
    let delay = MAX_POLL_MS;
    for (const [feed, set] of this.listeners) {
      if (set.size === 0) continue;
      const interval = (this.statusMap.get(feed)?.intervalSeconds ?? feeds[feed].intervalSeconds) * 1000;
      delay = Math.min(delay, interval / 3);
    }
    return Math.max(MIN_POLL_MS, delay);
  }

  private async poll(): Promise<void> {
    this.polling = true;
    try {
      const catalog = await callApi((api) => api.catalog());
      this.failures = 0;
      this.statusMap = new Map(catalog.feeds.map((f) => [f.id, f]));
      for (const l of this.statusListeners) l();
      for (const [feed, set] of this.listeners) if (set.size > 0) this.sync(feed);
    } catch {
      // Offline for a moment: keep what's held and try again soon.
      this.failures++;
      for (const [feed, set] of this.listeners)
        if (set.size > 0 && !this.latest.has(feed)) this.setView(feed, { state: 'error' });
    } finally {
      this.polling = false;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.poll();
      }, this.pollDelay());
    }
  }

  /** Brings `feed` to the catalog's version: fetches the snapshot if it's new. */
  private sync(feed: FeedId) {
    const status = this.statusMap.get(feed);
    const held = this.latest.get(feed);
    if (!status?.version) {
      if (!held) this.setView(feed, { state: 'pending' });
      return;
    }
    if (status.version === held?.version) {
      this.setView(feed, {
        state: 'ready',
        version: held.version,
        fetchedAt: held.fetchedAt,
        count: held.count,
      });
      return;
    }
    if (this.fetching.get(feed) === status.version) return;
    void this.fetchSnapshot(feed, status.version);
  }

  private async fetchSnapshot(feed: FeedId, version: string): Promise<void> {
    this.fetching.set(feed, version);
    if (!this.latest.has(feed)) this.setView(feed, { state: 'loading' });
    try {
      const response = await fetch(storageUrl('feeds', snapshotKey(feed, version, feeds[feed].browserView)));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decode = Schema.decodeUnknownPromise(Snapshots[feed]);
      const snapshot = await decode(await response.json());
      // A newer version may have arrived while this one downloaded; keep whichever is newer.
      if (this.fetching.get(feed) !== version) return;
      this.latest.set(feed, snapshot);
      for (const l of this.listeners.get(feed) ?? []) l(snapshot);
      this.setView(feed, {
        state: 'ready',
        version: snapshot.version,
        fetchedAt: snapshot.fetchedAt,
        count: snapshot.count,
      });
    } catch {
      // The next catalog read tries again.
      if (!this.latest.has(feed)) this.setView(feed, { state: 'error' });
    } finally {
      if (this.fetching.get(feed) === version) this.fetching.delete(feed);
    }
  }

  private setView(feed: FeedId, view: FeedView) {
    const previous = this.views.get(feed);
    if (
      previous?.state === view.state &&
      previous.version === view.version &&
      previous.fetchedAt === view.fetchedAt &&
      previous.count === view.count
    )
      return;
    this.views.set(feed, view);
    for (const l of this.viewListeners) l();
  }
}

export const feedPoller = new FeedPoller();
