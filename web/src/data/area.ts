import { type Bounds, tileAt, unwrap } from '../../../src/area.ts';
import type { Globe, View } from '../globe/globe.ts';

export interface Tile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

const keyOf = (t: Tile) => `${t.z}/${t.x}/${t.y}`;

/**
 * The tiles at zoom `z` covering `bounds`, nearest `center` first, at most
 * `limit` of them. A tilted view reaches the horizon, so the far tiles are
 * the ones dropped.
 */
export const tilesFor = (
  bounds: Bounds,
  z: number,
  center: { readonly lat: number; readonly lon: number } | undefined,
  limit: number,
): Tile[] => {
  const tiles: Tile[] = [];
  for (const part of unwrap(bounds)) {
    const nw = tileAt(z, part.west, part.north);
    const se = tileAt(z, part.east, part.south);
    // Cap the scan itself: a horizon view at a high zoom can span thousands of tiles.
    if ((se.x - nw.x + 1) * (se.y - nw.y + 1) > limit * 50) {
      if (!center) continue;
      const c = tileAt(z, center.lon, center.lat);
      const r = Math.ceil(Math.sqrt(limit));
      for (let x = Math.max(nw.x, c.x - r); x <= Math.min(se.x, c.x + r); x++)
        for (let y = Math.max(nw.y, c.y - r); y <= Math.min(se.y, c.y + r); y++) tiles.push({ z, x, y });
      continue;
    }
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) tiles.push({ z, x, y });
  }
  if (center && tiles.length > limit) {
    const c = tileAt(z, center.lon, center.lat);
    tiles.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
  }
  return tiles.slice(0, limit);
};

export interface AreaOptions<T> {
  /** The zoom the source is served at (each tile is one request). */
  readonly zoom: number;
  /** Tiles loaded for one view, at most. */
  readonly maxTiles: number;
  /** How long a tile's data stays fresh; it reloads while in view after this. */
  readonly ttlMs: number;
  readonly load: (tile: Tile, signal: AbortSignal) => Promise<T>;
  /** Called with every loaded tile still in view whenever that set changes. */
  readonly onChange: (tiles: ReadonlyArray<{ readonly tile: Tile; readonly data: T }>) => void;
  /** Called when a load fails (the tile is retried on the next settle). */
  readonly onError?: (error: unknown) => void;
}

/** In-flight requests per layer, so a fast pan doesn't queue dozens behind each other. */
const CONCURRENCY = 4;

/**
 * Loads a source by tile for whatever is in view: on each settle, the tiles
 * covering the view are fetched (cached ones reused while fresh), tiles that
 * left the view are dropped, and `onChange` gets the current set. Inactive (the
 * layer hidden), it loads nothing and holds nothing.
 */
export class AreaTiles<T> {
  private readonly cache = new Map<string, { readonly tile: Tile; data: T; loadedAt: number }>();
  private wanted: Tile[] = [];
  private readonly inFlight = new Map<string, AbortController>();
  private active = false;
  private emitted = '';
  private readonly stops: Array<() => void>;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly globe: Globe,
    private readonly options: AreaOptions<T>,
  ) {
    this.stops = [globe.viewSettled.add((view) => this.update(view))];
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.update(this.globe.view);
      this.timer = setInterval(() => this.update(this.globe.view), Math.max(5000, this.options.ttlMs / 2));
    } else {
      clearInterval(this.timer);
      for (const controller of this.inFlight.values()) controller.abort();
      this.inFlight.clear();
      this.cache.clear();
      this.wanted = [];
      this.emitted = '';
    }
  }

  /** Drops cached data and reloads what's in view (after a filter change on the server side). */
  reload(): void {
    this.cache.clear();
    if (this.active) this.update(this.globe.view);
  }

  private update(view: View): void {
    if (!this.active || !view.bounds) return;
    this.wanted = tilesFor(view.bounds, this.options.zoom, view.center, this.options.maxTiles);
    const wantedKeys = new Set(this.wanted.map(keyOf));
    for (const [key, controller] of this.inFlight)
      if (!wantedKeys.has(key)) {
        controller.abort();
        this.inFlight.delete(key);
      }
    // Keep a few tiles beyond the view, so panning back and forth doesn't refetch.
    const keep = this.options.maxTiles * 2;
    if (this.cache.size > keep) {
      for (const key of this.cache.keys()) {
        if (this.cache.size <= keep) break;
        if (!wantedKeys.has(key)) this.cache.delete(key);
      }
    }
    this.emit();
    this.pump();
  }

  private pump(): void {
    const now = Date.now();
    for (const tile of this.wanted) {
      if (this.inFlight.size >= CONCURRENCY) return;
      const key = keyOf(tile);
      const cached = this.cache.get(key);
      if (this.inFlight.has(key) || (cached && now - cached.loadedAt < this.options.ttlMs)) continue;
      const controller = new AbortController();
      this.inFlight.set(key, controller);
      void this.fetch(tile, key, controller);
    }
  }

  private async fetch(tile: Tile, key: string, controller: AbortController): Promise<void> {
    try {
      const data = await this.options.load(tile, controller.signal);
      if (!controller.signal.aborted && this.active) {
        this.cache.set(key, { tile, data, loadedAt: Date.now() });
        this.emit();
      }
    } catch (error) {
      if (!controller.signal.aborted) this.options.onError?.(error);
    } finally {
      if (this.inFlight.get(key) === controller) this.inFlight.delete(key);
      if (this.active) this.pump();
    }
  }

  /** Hands the loaded tiles in view to the layer, unless that's the same set it already has. */
  private emit(): void {
    const tiles = [];
    let signature = '';
    for (const tile of this.wanted) {
      const cached = this.cache.get(keyOf(tile));
      if (!cached) continue;
      tiles.push({ tile, data: cached.data });
      signature += `${keyOf(tile)}@${cached.loadedAt};`;
    }
    if (signature === this.emitted) return;
    this.emitted = signature;
    this.options.onChange(tiles);
  }

  destroy(): void {
    this.setActive(false);
    for (const stop of this.stops) stop();
  }
}
