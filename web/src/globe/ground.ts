import { Cartesian3 } from 'cesium';
import { contains } from '../../../src/area.ts';
import type { Globe } from './globe.ts';

/** Above this, heights don't visibly matter and the ellipsoid stands in for the ground. */
const NEAR = 400_000;
/**
 * Items re-seated per pass, nearest the view's center first. Each lookup is a
 * ray cast against a terrain tile (or a render of the 3D tiles on the
 * Photorealistic base map), so the budget keeps a pass to a few milliseconds.
 */
const BUDGET = { satellite: 1500, photoreal: 120 } as const;
/** Waits this long after the last trigger: while the camera flies or terrain streams, nothing runs. */
const DEBOUNCE_MS = 300;

/**
 * Things a layer draws on the ground, by index. Point primitives can't clamp
 * themselves to terrain (billboards and labels can: give those
 * `heightReference: CLAMP_TO_GROUND` instead), so layers with many points hand
 * them to `trackGround`, which seats the ones in view on the ground whenever the
 * camera settles nearby or terrain finishes loading.
 */
export interface GroundSet {
  readonly size: number;
  lon(i: number): number;
  lat(i: number): number;
  /** Meters above the ground to draw item i (default 0). */
  lift?(i: number): number;
  /** Moves item i to `position`. */
  place(i: number, position: Cartesian3): void;
}

export interface GroundTracker {
  /** Re-seats soon: call after replacing the items (a new snapshot). */
  refresh(): void;
  stop(): void;
}

/** Keeps `set` on the ground as the view and terrain change. */
export const trackGround = (globe: Globe, set: () => GroundSet | undefined): GroundTracker => {
  const scratch = new Cartesian3();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const seat = async () => {
    timer = undefined;
    const items = set();
    const { bounds, height, center } = globe.view;
    if (!items || !bounds || height > NEAR) return;
    const pass = ++generation;
    let indices: number[] = [];
    for (let i = 0; i < items.size; i++) if (contains(bounds, items.lon(i), items.lat(i))) indices.push(i);
    const budget = BUDGET[globe.basemap];
    if (indices.length > budget && center) {
      const d = (i: number) => (items.lon(i) - center.lon) ** 2 + (items.lat(i) - center.lat) ** 2;
      indices = indices.toSorted((a, b) => d(a) - d(b)).slice(0, budget);
    }
    const heights = await globe.groundHeights(indices.map((i) => ({ lon: items.lon(i), lat: items.lat(i) })));
    // A newer pass (or a new snapshot) superseded this one while heights were sampled.
    if (pass !== generation || set() !== items) return;
    indices.forEach((i, k) => {
      const ground = heights[k];
      if (ground === undefined) return;
      items.place(
        i,
        Cartesian3.fromDegrees(
          items.lon(i),
          items.lat(i),
          ground + (items.lift?.(i) ?? 0),
          undefined,
          scratch,
        ),
      );
    });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void seat(), DEBOUNCE_MS);
  };

  const stops = [
    globe.viewSettled.add(schedule),
    globe.basemapChanged.add(schedule),
    // Fires as terrain tiles stream in; zero means everything in view has loaded.
    globe.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
      if (queued === 0 && globe.view.height <= NEAR) schedule();
    }),
  ];
  schedule();
  return {
    refresh: schedule,
    stop() {
      clearTimeout(timer);
      generation++;
      for (const stop of stops) stop();
    },
  };
};
