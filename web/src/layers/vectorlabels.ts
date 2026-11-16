import type { VectorTile } from '@mapbox/vector-tile';
import {
  Cartesian2,
  Cartesian3,
  Color,
  HorizontalOrigin,
  type Label,
  LabelCollection,
  LabelStyle,
  type PointPrimitive,
  PointPrimitiveCollection,
  VerticalOrigin,
} from 'cesium';
import { contains } from '../../../src/area.ts';
import { tilesFor } from '../data/area.ts';
import { MAX_VECTOR_ZOOM, vectorTile } from '../data/vectortiles.ts';
import type { Globe, PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';

/** One thing to label, read from a vector tile. */
export interface Candidate {
  /** Unique across tiles (an OSM id, or kind + name + rounded position), so tile overlaps don't double it. */
  readonly key: string;
  readonly text: string;
  readonly lon: number;
  readonly lat: number;
  /** Lower draws first and wins collisions. */
  readonly priority: number;
  readonly size: number;
  readonly color: string;
  readonly weight?: 400 | 500 | 600;
  /** A dot under the label (points of interest), in this color. */
  readonly dot?: string;
  /**
   * Street-scale detail (street names, house numbers, shops): shown only near
   * the camera, or a tilted view piles them up along the horizon.
   */
  readonly near?: boolean;
  /** Kept for the inspector: the feature's properties. */
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** Reads the candidates worth labeling from one tile at a view zoom. */
export type Extract = (
  tile: VectorTile,
  at: { readonly z: number; readonly x: number; readonly y: number; readonly height: number },
) => Candidate[];

/** Where a tile-local point (0..extent) lands in degrees. */
export const toLonLat = (z: number, x: number, y: number, extent: number, px: number, py: number) => {
  const n = 2 ** z;
  const lon = ((x + px / extent) / n) * 360 - 180;
  const my = Math.PI * (1 - (2 * (y + py / extent)) / n);
  return { lon, lat: (Math.atan(Math.sinh(my)) * 180) / Math.PI };
};

/** The vector zoom whose tiles match the detail on screen at a camera height. */
export const zoomFor = (height: number): number =>
  Math.max(4, Math.min(MAX_VECTOR_ZOOM, Math.floor(Math.log2(40_075_000 / Math.max(1, height * 1.5)))));

const MAX_TILES = 12;
/** Labels placed on screen at most; the rest wait for the camera to come closer. */
const MAX_SHOWN = 220;
const PADDING = 3;

const measure = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map<string, number>();
  return (font: string, text: string): number => {
    const key = `${font}|${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      if (ctx) ctx.font = font;
      width = ctx ? ctx.measureText(text).width : text.length * 7;
      if (cache.size > 5000) cache.clear();
      cache.set(key, width);
    }
    return width;
  };
})();

interface Placed {
  readonly candidate: Candidate;
  readonly label: Label;
  readonly dot: PointPrimitive | undefined;
  readonly font: string;
  /** On the ground, kept current as terrain loads. */
  position: Cartesian3;
}

/**
 * Screen-space labels from vector tiles, kept legible: they face the camera
 * (so tilting doesn't smear them, as text baked into imagery would), sit on the
 * terrain, and are thinned by priority so they never overlap. Used for place
 * and street names, and for points of interest.
 */
export class VectorLabels {
  private readonly labels: LabelCollection;
  private readonly dots: PointPrimitiveCollection;
  private placed: Placed[] = [];
  private readonly byKey = new Map<string, Placed>();
  private readonly extracted = new Map<string, Candidate[]>();
  private active = false;
  private generation = 0;
  private declutterQueued = false;
  private readonly stops: Array<() => void>;
  private readonly ground;

  constructor(
    private readonly globe: Globe,
    private readonly options: {
      readonly layer: string;
      readonly extract: Extract;
      /** Points carry a pick id and a dot when the candidates have `dot`. */
      readonly pickable: boolean;
      /** Above this camera height it draws nothing (for owners that span all heights). */
      readonly maxHeight?: number;
    },
  ) {
    this.labels = globe.scene.primitives.add(new LabelCollection({ scene: globe.scene }));
    this.dots = globe.scene.primitives.add(new PointPrimitiveCollection());
    this.ground = trackGround(globe, () => ({
      size: this.placed.length,
      lon: (i) => this.placed[i]?.candidate.lon ?? 0,
      lat: (i) => this.placed[i]?.candidate.lat ?? 0,
      place: (i, position) => {
        const p = this.placed[i];
        if (!p) return;
        p.position = Cartesian3.clone(position, p.position);
        p.label.position = position;
        if (p.dot) p.dot.position = position;
        this.queueDeclutter();
      },
    }));
    this.stops = [
      globe.viewSettled.add(() => void this.load()),
      globe.viewChanged.add(() => this.queueDeclutter()),
    ];
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.labels.show = active;
    this.dots.show = active;
    if (active) void this.load();
    else {
      this.generation++;
      this.clear();
    }
  }

  candidate(key: string): Candidate | undefined {
    return this.byKey.get(key)?.candidate;
  }

  /** Everything loaded for the view, most important first. */
  candidates(): ReadonlyArray<Candidate> {
    return this.placed.map((p) => p.candidate);
  }

  /** The labels currently placed within `bounds`. */
  countIn(bounds: { west: number; south: number; east: number; north: number }): number {
    let n = 0;
    for (const p of this.placed) if (p.label.show && contains(bounds, p.candidate.lon, p.candidate.lat)) n++;
    return n;
  }

  private clear() {
    this.labels.removeAll();
    this.dots.removeAll();
    this.placed = [];
    this.byKey.clear();
  }

  /** Loads the tiles for the view and rebuilds the label set from them. */
  private async load(): Promise<void> {
    if (!this.active) return;
    const view = this.globe.view;
    if (!view.bounds) return;
    const generation = ++this.generation;
    if (view.height > (this.options.maxHeight ?? Number.POSITIVE_INFINITY)) {
      this.clear();
      return;
    }
    const z = zoomFor(view.height);
    const tiles = tilesFor(view.bounds, z, view.center, MAX_TILES);
    const results = await Promise.all(
      tiles.map(async (t) => {
        const key = `${t.z}/${t.x}/${t.y}@${bandOf(view.height)}`;
        const cached = this.extracted.get(key);
        if (cached) return cached;
        const tile = await vectorTile(t.z, t.x, t.y).catch(() => undefined);
        const candidates = tile ? this.options.extract(tile, { ...t, height: view.height }) : [];
        this.extracted.set(key, candidates);
        if (this.extracted.size > 200) this.extracted.delete(this.extracted.keys().next().value as string);
        return candidates;
      }),
    );
    if (generation !== this.generation || !this.active) return;
    const next = new Map<string, Candidate>();
    for (const list of results) for (const c of list) if (!next.has(c.key)) next.set(c.key, c);
    this.rebuild([...next.values()].toSorted((a, b) => a.priority - b.priority));
  }

  private rebuild(candidates: Candidate[]) {
    // Keep labels that are still wanted (no flicker on a small pan); add the new; drop the gone.
    const keep = new Set(candidates.map((c) => c.key));
    for (const p of this.placed)
      if (!keep.has(p.candidate.key)) {
        this.labels.remove(p.label);
        if (p.dot) this.dots.remove(p.dot);
        this.byKey.delete(p.candidate.key);
      }
    const placed: Placed[] = [];
    for (const c of candidates) {
      const existing = this.byKey.get(c.key);
      if (existing) {
        placed.push(existing);
        continue;
      }
      const ground = this.globe.heightAt(c.lon, c.lat) ?? 0;
      const position = Cartesian3.fromDegrees(c.lon, c.lat, ground);
      const font = `${c.weight ?? 500} ${c.size}px Inter, ui-sans-serif, system-ui, sans-serif`;
      const id = this.options.pickable
        ? ({ layer: this.options.layer, key: c.key } satisfies PickId)
        : undefined;
      const label = this.labels.add({
        position,
        text: c.text,
        font,
        fillColor: Color.fromCssColorString(c.color),
        outlineColor: Color.BLACK.withAlpha(0.75),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: c.dot ? HorizontalOrigin.LEFT : HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.CENTER,
        pixelOffset: c.dot ? new Cartesian2(7, 0) : Cartesian2.ZERO,
        // Labels are placed by screen space, not depth: a rooftop or a ridge shouldn't hide them.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: false,
        ...(id ? { id } : {}),
      });
      const dot = c.dot
        ? this.dots.add({
            position,
            pixelSize: 7,
            color: Color.fromCssColorString(c.dot),
            outlineColor: Color.BLACK.withAlpha(0.6),
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            show: false,
            ...(id ? { id } : {}),
          })
        : undefined;
      const entry: Placed = { candidate: c, label, dot, font, position };
      this.byKey.set(c.key, entry);
      placed.push(entry);
    }
    this.placed = placed;
    this.ground.refresh();
    this.declutter();
  }

  private queueDeclutter() {
    if (this.declutterQueued || !this.active) return;
    this.declutterQueued = true;
    requestAnimationFrame(() => {
      this.declutterQueued = false;
      this.declutter();
    });
  }

  /** Shows labels in priority order, skipping any that would overlap one already shown. */
  private declutter() {
    const scene = this.globe.scene;
    const canvas = scene.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const boxes: Array<readonly [number, number, number, number]> = [];
    const screen = new Cartesian2();
    const camera = scene.camera.positionWC;
    const horizon = Cartesian3.magnitude(camera);
    const nearby = Math.max(1500, this.globe.view.height * 10);
    let shown = 0;
    for (const p of this.placed) {
      let visible = false;
      // Past the horizon: Cesium would still project it onto the screen.
      const beyond =
        Cartesian3.distance(camera, p.position) >
        Math.sqrt(Math.max(0, horizon ** 2 - 6_356_000 ** 2)) + 2000;
      const tooFar = p.candidate.near === true && Cartesian3.distance(camera, p.position) > nearby;
      const at = beyond || tooFar ? undefined : scene.cartesianToCanvasCoordinates(p.position, screen);
      if (shown < MAX_SHOWN && at && at.x > -50 && at.y > -20 && at.x < width + 50 && at.y < height + 20) {
        const w = measure(p.font, p.candidate.text) + (p.dot ? 10 : 0);
        const h = p.candidate.size + 2;
        const left = p.dot ? at.x - 4 : at.x - w / 2;
        const box = [
          left - PADDING,
          at.y - h / 2 - PADDING,
          left + w + PADDING,
          at.y + h / 2 + PADDING,
        ] as const;
        visible = !boxes.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]);
        if (visible) {
          boxes.push(box);
          shown++;
        }
      }
      p.label.show = visible;
      if (p.dot) p.dot.show = visible;
    }
  }

  destroy(): void {
    for (const stop of this.stops) stop();
    this.ground.stop();
    this.globe.scene.primitives.remove(this.labels);
    this.globe.scene.primitives.remove(this.dots);
  }
}

/** Extraction depends on how close the camera is (what's worth naming); cache per band, not per meter. */
const bandOf = (height: number) => Math.round(Math.log2(Math.max(1, height)) * 2);
