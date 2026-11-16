import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FeedId, FeedStatus } from '../../src/domain.ts';
import { feedPoller, type FeedView } from './data/feeds.ts';
import { layerStatus, type LayerStatus } from './data/status.ts';
import type { LayerState, World } from './world.ts';

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

export function useLayerStatus(layer: string): LayerStatus {
  return useSyncExternalStore(
    (listener) => layerStatus.subscribe(listener),
    () => layerStatus.get(layer),
  );
}

const OFF: LayerState = { kind: 'off' };

/** A layer's state on the globe: shown (with its in-view count), off, or why it isn't drawing. */
export function useLayerState(world: World | undefined, layer: string): LayerState {
  return useSyncExternalStore(
    (listener) => world?.statesChanged.add(listener) ?? (() => {}),
    () => world?.state(layer) ?? OFF,
  );
}

/** Re-renders whenever any layer's state changes; returns the world for reading them. */
export function useLayerStates(world: World | undefined): number {
  return useSyncExternalStore(
    (listener) => world?.statesChanged.add(listener) ?? (() => {}),
    () => world?.statesVersion ?? 0,
  );
}

/** Each feed's server-side status (freshness, errors), refreshed at least every minute. */
export function useCatalog(): ReadonlyMap<FeedId, FeedStatus> {
  return useSyncExternalStore(
    (listener) => feedPoller.onStatuses(listener),
    () => feedPoller.statuses,
  );
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
