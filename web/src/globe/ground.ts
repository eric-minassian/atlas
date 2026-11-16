import { Cartesian3 } from 'cesium';
import { contains } from '../../../src/area.ts';
import type { Globe } from './globe.ts';

/** Above this, heights don't visibly matter and the ellipsoid stands in for the ground. */
const NEAR = 400_000;
/** At most this many items are re-seated per settle, nearest the view first, to keep it cheap. */
const BUDGET = 4000;

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
  /** Re-seats now: call after replacing the items (a new snapshot). */
  refresh(): void;
  stop(): void;
}

/** Keeps `set` on the ground as the view and terrain change. */
export const trackGround = (globe: Globe, set: () => GroundSet | undefined): GroundTracker => {
  const scratch = new Cartesian3();
  let pending = false;

  const seat = () => {
    pending = false;
    const items = set();
    const { bounds, height } = globe.view;
    if (!items || !bounds || height > NEAR) return;
    let done = 0;
    for (let i = 0; i < items.size && done < BUDGET; i++) {
      const lon = items.lon(i);
      const lat = items.lat(i);
      if (!contains(bounds, lon, lat)) continue;
      const ground = globe.heightAt(lon, lat);
      if (ground === undefined) continue;
      items.place(i, Cartesian3.fromDegrees(lon, lat, ground + (items.lift?.(i) ?? 0), undefined, scratch));
      done++;
    }
  };
  // Coalesce bursts (a settle and a terrain load together) into one pass on the next frame.
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(seat);
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
      for (const stop of stops) stop();
    },
  };
};
