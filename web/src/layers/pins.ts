import {
  type Billboard,
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  HeightReference,
  type Label,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  VerticalOrigin,
} from 'cesium';
import { type Bounds, contains } from '../../../src/area.ts';
import type { Globe, PickId } from '../globe/globe.ts';
import { Listeners } from '../lib/listeners.ts';

/** A white disc with a dark rim; billboards tint it. */
export const dotIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="5.5" fill="#fff" stroke="rgba(0,0,0,0.7)" stroke-width="2"/></svg>',
)}`;

/** A camera body and lens on a dark disc, white so billboards can tint it. */
export const cameraIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<circle cx="12" cy="12" r="11" fill="rgba(10,14,20,0.78)"/>' +
    '<rect x="5" y="8.5" width="10" height="7" rx="1.6" fill="#fff"/>' +
    '<path d="M15.5 11.2 19 9v6l-3.5-2.2Z" fill="#fff"/></svg>',
)}`;

/** Labels that rank lower show only nearer the camera: `[rank below, meters]`, most significant first. */
export type Tiers = ReadonlyArray<readonly [rank: number, meters: number]>;

const conditions = new Map<number, DistanceDisplayCondition>();
/** The display distance for an item of `rank`, or undefined when it never shows. */
export const reachOf = (tiers: Tiers, rank: number): DistanceDisplayCondition | undefined => {
  const meters = tiers.find(([below]) => rank < below)?.[1];
  if (meters === undefined) return undefined;
  let condition = conditions.get(meters);
  if (!condition) {
    condition = new DistanceDisplayCondition(0, meters);
    conditions.set(meters, condition);
  }
  return condition;
};

export interface PinStyle {
  readonly lon: number;
  readonly lat: number;
  readonly color: Color;
  readonly image?: string;
  /** Pixel size of the icon at `scale` 1. */
  readonly size?: number;
  readonly reach?: DistanceDisplayCondition | undefined;
  readonly label?: { readonly text: string; readonly reach: DistanceDisplayCondition | undefined };
}

interface Entry<T> {
  item: T;
  readonly billboard: Billboard;
  readonly label: Label | undefined;
}

const SELECTED = Color.WHITE;
/** Shown at any distance: what a marker without a `reach`, or the selected one, gets. */
const ANYWHERE = new DistanceDisplayCondition(0, Number.MAX_VALUE);

/**
 * A layer's markers on the ground (terrain or 3D tiles), keyed so a new set
 * of items keeps the markers that stayed and only adds and removes the
 * difference: area layers replace their items on every settle, and rebuilding
 * thousands of billboards each time would flicker.
 */
export class GroundPins<T> {
  /** Fires (once per burst, after the current task) when the items or the filter change. */
  readonly changed = new Listeners<void>();
  private changePending = false;
  private readonly billboards: BillboardCollection;
  private readonly labels: LabelCollection;
  private readonly entries = new Map<string, Entry<T>>();
  private selected: string | undefined;

  constructor(
    private readonly globe: Globe,
    private readonly layer: string,
    private readonly style: (item: T) => PinStyle,
  ) {
    this.billboards = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    this.labels = globe.scene.primitives.add(new LabelCollection({ scene: globe.scene }));
  }

  /** Replaces the items, keeping the markers of keys that stay. */
  replace(items: ReadonlyMap<string, T>): void {
    for (const [key, entry] of this.entries)
      if (!items.has(key)) {
        this.billboards.remove(entry.billboard);
        if (entry.label) this.labels.remove(entry.label);
        this.entries.delete(key);
      }
    for (const [key, item] of items) {
      const entry = this.entries.get(key);
      if (entry) entry.item = item;
      else this.entries.set(key, this.add(key, item));
    }
    this.notify();
  }

  // Deferred, so a listener never runs in the middle of whatever replaced the items.
  private notify(): void {
    if (this.changePending) return;
    this.changePending = true;
    queueMicrotask(() => {
      this.changePending = false;
      this.changed.emit();
    });
  }

  private add(key: string, item: T): Entry<T> {
    const s = this.style(item);
    const position = Cartesian3.fromDegrees(s.lon, s.lat);
    const id = { layer: this.layer, key } satisfies PickId;
    const selected = key === this.selected;
    const billboard = this.billboards.add({
      position,
      image: s.image ?? dotIcon,
      width: s.size ?? 12,
      height: s.size ?? 12,
      color: selected ? SELECTED : s.color,
      scale: selected ? 1.5 : 1,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      scaleByDistance: new NearFarScalar(1_000, 1.15, 200_000, 0.6),
      distanceDisplayCondition: selected ? ANYWHERE : (s.reach ?? ANYWHERE),
      id,
    });
    const label = s.label
      ? this.labels.add({
          position,
          text: s.label.text,
          font: '500 12px Inter, system-ui, sans-serif',
          fillColor: Color.WHITE.withAlpha(0.92),
          outlineColor: Color.BLACK.withAlpha(0.8),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -((s.size ?? 12) / 2 + 3)),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: s.label.reach,
          show: s.label.reach !== undefined,
          id,
        })
      : undefined;
    return { item, billboard, label };
  }

  get(key: string): T | undefined {
    return this.entries.get(key)?.item;
  }

  get size(): number {
    return this.entries.size;
  }

  *items(): IterableIterator<[string, T]> {
    for (const [key, entry] of this.entries) yield [key, entry.item];
  }

  /** Shows only the items `visible` accepts (a layer's filter). */
  filter(visible: (item: T) => boolean): void {
    for (const entry of this.entries.values()) {
      const show = visible(entry.item);
      entry.billboard.show = show;
      if (entry.label) entry.label.show = show && entry.label.distanceDisplayCondition !== undefined;
    }
    this.notify();
  }

  isShown(key: string): boolean {
    return this.entries.get(key)?.billboard.show ?? false;
  }

  countIn(bounds: Bounds): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (!entry.billboard.show) continue;
      const s = this.style(entry.item);
      if (contains(bounds, s.lon, s.lat)) n++;
    }
    return n;
  }

  setShow(visible: boolean): void {
    this.billboards.show = visible;
    this.labels.show = visible;
  }

  /** Emphasizes `key` (and shows it at any distance); returns the cleanup. */
  highlight(key: string): () => void {
    this.selected = key;
    const restyle = (on: boolean) => {
      const entry = this.entries.get(key);
      if (!entry) return;
      const s = this.style(entry.item);
      entry.billboard.color = on ? SELECTED : s.color;
      entry.billboard.scale = on ? 1.5 : 1;
      entry.billboard.distanceDisplayCondition = on ? ANYWHERE : (s.reach ?? ANYWHERE);
    };
    restyle(true);
    return () => {
      if (this.selected === key) this.selected = undefined;
      restyle(false);
    };
  }

  clear(): void {
    this.billboards.removeAll();
    this.labels.removeAll();
    this.entries.clear();
  }

  destroy(): void {
    this.globe.scene.primitives.remove(this.billboards);
    this.globe.scene.primitives.remove(this.labels);
  }
}

/** A box about `meters` across around a point: where to fly to see one marker up close. */
export const around = (lon: number, lat: number, meters = 1_200): Bounds => {
  const dLat = meters / 2 / 111_320;
  const dLon = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
};

/** Case-insensitive substring matches over `items`, at most `limit`. */
export const matching = <T>(
  items: Iterable<T>,
  query: string,
  limit: number,
  text: (item: T) => string,
): T[] => {
  const q = query.trim().toLowerCase();
  const out: T[] = [];
  if (!q) return out;
  for (const item of items) {
    if (out.length >= limit) break;
    if (text(item).toLowerCase().includes(q)) out.push(item);
  }
  return out;
};
