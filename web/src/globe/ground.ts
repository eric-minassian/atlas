import {
  type Billboard,
  type BillboardCollection,
  Cartesian3,
  Cartographic,
  HeightReference,
  type Label,
  type LabelCollection,
  Math as CesiumMath,
} from 'cesium';
import { contains } from '../../../src/area.ts';
import type { Globe } from './globe.ts';

/** Above this, heights don't visibly matter and the ellipsoid stands in for the ground. */
const NEAR = 400_000;
/**
 * Items farther than this many camera heights from the view's center aren't
 * seated: they're beyond the detail terrain has loaded for, and a tilted view
 * reaches the horizon.
 */
const REACH = 20;
const MIN_REACH = 30_000;
const METERS_PER_DEGREE = 111_320;

/** Whether a point is near enough to the view's center to be worth a ground height. */
const nearCenter = (view: Globe['view'], lon: number, lat: number): boolean => {
  const { center, height } = view;
  if (!center) return false;
  const x = (lon - center.lon) * Math.cos((center.lat * Math.PI) / 180);
  return Math.hypot(x, lat - center.lat) * METERS_PER_DEGREE <= Math.max(MIN_REACH, height * REACH);
};
/**
 * Items re-seated per pass, nearest the view's center first. Each lookup is a
 * ray cast against a loaded terrain tile (or, under Photorealistic 3D, a
 * terrain sample), so the budget keeps a pass short.
 */
const BUDGET = 1500;
/** Waits this long after the last trigger: while the camera flies or terrain streams, nothing runs. */
const DEBOUNCE_MS = 300;

/**
 * Things a layer draws on the ground, by index. Point primitives can't clamp
 * themselves to terrain (billboards and labels can: give those
 * `heightReference: CLAMP_TO_GROUND` and hand their collection to
 * `followGround`), so layers with many points hand them to `trackGround`, which
 * seats the ones in view on the ground whenever the camera settles nearby or
 * terrain loads.
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

/** Runs `pass` a moment after the view settles, the base map changes or terrain finishes loading. */
const onGroundChanges = (globe: Globe, pass: () => Promise<void>): GroundTracker => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void pass(), DEBOUNCE_MS);
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
      for (const stop of stops) stop();
    },
  };
};

/** Keeps `set` on the ground as the view and terrain change. */
export const trackGround = (globe: Globe, set: () => GroundSet | undefined): GroundTracker => {
  const scratch = new Cartesian3();
  let generation = 0;
  return onGroundChanges(globe, async () => {
    const items = set();
    const { bounds, height, center } = globe.view;
    if (!items || !bounds || height > NEAR) return;
    const pass = ++generation;
    let indices: number[] = [];
    for (let i = 0; i < items.size; i++) {
      const lon = items.lon(i);
      const lat = items.lat(i);
      if (contains(bounds, lon, lat) && nearCenter(globe.view, lon, lat)) indices.push(i);
    }
    if (indices.length > BUDGET && center) {
      const d = (i: number) => (items.lon(i) - center.lon) ** 2 + (items.lat(i) - center.lat) ** 2;
      indices = indices.toSorted((a, b) => d(a) - d(b)).slice(0, BUDGET);
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
  });
};

export interface GroundFollower extends GroundTracker {
  /** The ground height an item was last seated at under Photorealistic 3D (0 otherwise), for items a layer moves. */
  heightOf(item: Billboard | Label): number;
}

/**
 * Keeps billboards and labels that clamp to the ground on it when there's no
 * globe to clamp to. Under Photorealistic 3D the globe is hidden and Google's
 * tiles don't take part in clamping (ray-casting them reads their geometry
 * back from the GPU), so items set to `CLAMP_TO_GROUND` get explicit heights
 * from terrain samples instead, and clamp again when the satellite base map
 * returns.
 */
export const followGround = (
  globe: Globe,
  collections: ReadonlyArray<BillboardCollection | LabelCollection>,
): GroundFollower => {
  /** The ground each switched item was seated at. */
  const seated = new WeakMap<Billboard | Label, number>();
  /** Items switched from clamping to explicit heights (weak: layers remove items freely). */
  const converted = new WeakSet<Billboard | Label>();
  const carto = new Cartographic();
  let generation = 0;

  const each = (visit: (item: Billboard | Label) => void) => {
    for (const collection of collections)
      for (let i = 0; i < collection.length; i++) visit(collection.get(i));
  };

  const tracker = onGroundChanges(globe, async () => {
    const pass = ++generation;
    if (globe.basemap === 'satellite') {
      each((item) => {
        if (!converted.has(item)) return;
        item.heightReference = HeightReference.CLAMP_TO_GROUND;
        converted.delete(item);
      });
      return;
    }
    const { bounds, height } = globe.view;
    if (!bounds || height > NEAR) return;
    const wanted: Array<{ item: Billboard | Label; lon: number; lat: number }> = [];
    each((item) => {
      if (item.heightReference === HeightReference.CLAMP_TO_GROUND) {
        item.heightReference = HeightReference.NONE;
        converted.add(item);
      }
      if (!converted.has(item) || wanted.length >= BUDGET) return;
      Cartographic.fromCartesian(item.position, undefined, carto);
      const lon = CesiumMath.toDegrees(carto.longitude);
      const lat = CesiumMath.toDegrees(carto.latitude);
      if (contains(bounds, lon, lat) && nearCenter(globe.view, lon, lat)) wanted.push({ item, lon, lat });
    });
    const heights = await globe.groundHeights(wanted);
    if (pass !== generation || globe.basemap !== 'photoreal') return;
    wanted.forEach(({ item, lon, lat }, k) => {
      const ground = heights[k];
      if (ground === undefined) return;
      seated.set(item, ground);
      item.position = Cartesian3.fromDegrees(lon, lat, ground);
    });
  });
  return { ...tracker, heightOf: (item) => seated.get(item) ?? 0 };
};
