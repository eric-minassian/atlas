import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FeedId, FeedStatus } from '../../src/domain.ts';
import { callApi } from './client.ts';
import { feedPoller, type FeedView } from './data/feeds.ts';

/** The current time, re-rendering every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useFeedView(feed: FeedId | undefined): FeedView | undefined {
  return useSyncExternalStore(
    (listener) => feedPoller.onViews(listener),
    () => (feed ? feedPoller.view(feed) : undefined),
  );
}

/** Each feed's server-side status (freshness, errors), refreshed every minute. */
export function useCatalog(): ReadonlyMap<FeedId, FeedStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<FeedId, FeedStatus>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const catalog = await callApi((api) => api.catalog());
        if (cancelled) return;
        feedPoller.adoptStatuses(catalog.feeds);
        setStatuses(new Map(catalog.feeds.map((f) => [f.id, f])));
      } catch {
        // Offline for a moment: keep the statuses we have and try again next minute.
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return statuses;
}

/** State remembered in this browser; falls back to `initial` when storage is unavailable. */
export function usePersistentState<T extends object>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : { ...initial, ...(JSON.parse(stored) as T) };
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Private mode or blocked storage: the setting just isn't remembered.
    }
  };
  return [value, set];
}
