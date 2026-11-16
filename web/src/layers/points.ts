import {
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  type Label,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  type PointPrimitive,
  PointPrimitiveCollection,
  VerticalOrigin,
} from 'cesium';
import { type Bounds, contains } from '../../../src/area.ts';
import type { FeedId } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { Globe, PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import type { Details, LayerHandle, SearchHit } from './types.ts';

/** A snapshot's points, by index. */
export interface Rows {
  readonly size: number;
  lon(i: number): number;
  lat(i: number): number;
}

export interface PointStyle {
  readonly color: Color;
  /** Pixels at mid distance. */
  readonly size: number;
}

export interface PointLayerOptions<F extends FeedId, R extends Rows> {
  readonly layer: string;
  readonly feed: F;
  readonly rows: (snapshot: Snapshot<F>) => R;
  /** Stable across snapshots (a station id), so a selection survives an update. */
  readonly key: (rows: R, i: number) => string;
  readonly style: (rows: R, i: number) => PointStyle;
  /** Draw order: higher draws later (on top). */
  readonly rank?: (rows: R, i: number) => number;
  readonly describe: (rows: R, i: number) => Details;
  /** A short label drawn beside the point when the camera is close (a temperature). */
  readonly label?: (rows: R, i: number) => string | undefined;
  /** Matches the (trimmed, lower-cased) query against row i. */
  readonly search?: (rows: R, i: number, query: string) => SearchHit | undefined;
  /** The filter id row i belongs to, for layers with filters. */
  readonly filter?: (rows: R, i: number) => string;
  readonly scale?: NearFarScalar;
  /** Called with each snapshot drawn, and with undefined when the layer hides. */
  readonly onRows?: (rows: R | undefined) => void;
}

const OUTLINE = Color.BLACK.withAlpha(0.55);
/** Labels appear within this camera distance: regional scale and closer. */
const LABEL_RANGE = new DistanceDisplayCondition(0, 700_000);
const LABEL_FONT = '500 11px Inter, system-ui, sans-serif';

/**
 * A layer of points from a columnar feed: drawn while visible (and seated on
 * the ground up close), dropped when hidden, with details, search, highlight,
 * filters and in-view counts wired up.
 */
export const feedPoints = <F extends FeedId, R extends Rows>(
  globe: Globe,
  options: PointLayerOptions<F, R>,
): LayerHandle & { readonly rows: () => R | undefined } => {
  const points = globe.scene.primitives.add(new PointPrimitiveCollection());
  const labels: LabelCollection | undefined = options.label
    ? globe.scene.primitives.add(new LabelCollection())
    : undefined;
  const scale = options.scale ?? new NearFarScalar(3e5, 1.5, 2e7, 0.6);
  let rows: R | undefined;
  /** Row index → its primitives; row order, not draw order. */
  let drawn: Array<{ readonly point: PointPrimitive; readonly label: Label | undefined }> = [];
  let byKey = new Map<string, number>();
  let shown: ReadonlySet<string> | undefined;
  let selected: string | undefined;
  let unsubscribe: (() => void) | undefined;
  const offset = new Cartesian2(7, -3);

  const ground = trackGround(globe, () =>
    rows && drawn.length === rows.size
      ? {
          size: rows.size,
          lon: (i) => rows?.lon(i) ?? 0,
          lat: (i) => rows?.lat(i) ?? 0,
          place: (i, position) => {
            const entry = drawn[i];
            if (!entry) return;
            entry.point.position = position;
            if (entry.label) entry.label.position = position;
          },
        }
      : undefined,
  );

  const visibleRow = (i: number) => !shown || !options.filter || !rows || shown.has(options.filter(rows, i));

  const restyle = (i: number) => {
    const entry = drawn[i];
    if (!entry || !rows) return;
    const style = options.style(rows, i);
    const on = options.key(rows, i) === selected;
    entry.point.color = style.color;
    entry.point.pixelSize = on ? style.size + 4 : style.size;
    entry.point.outlineColor = on ? Color.WHITE : OUTLINE;
    entry.point.outlineWidth = on ? 2 : 1;
  };

  const clear = () => {
    points.removeAll();
    labels?.removeAll();
    rows = undefined;
    drawn = [];
    byKey = new Map();
    options.onRows?.(undefined);
  };

  const render = (snapshot: Snapshot<F>) => {
    const next = options.rows(snapshot);
    points.removeAll();
    labels?.removeAll();
    rows = next;
    byKey = new Map();
    const order = Array.from({ length: next.size }, (_, i) => i);
    if (options.rank) {
      const ranks = order.map((i) => options.rank?.(next, i) ?? 0);
      order.sort((a, b) => (ranks[a] as number) - (ranks[b] as number));
    }
    // Filled by row index while drawing in rank order.
    const entries: typeof drawn = [];
    for (const i of order) {
      const key = options.key(next, i);
      byKey.set(key, i);
      const style = options.style(next, i);
      const position = Cartesian3.fromDegrees(next.lon(i), next.lat(i), 0);
      const show = visibleRow(i);
      const point = points.add({
        position,
        pixelSize: style.size,
        color: style.color,
        outlineColor: OUTLINE,
        outlineWidth: 1,
        scaleByDistance: scale,
        show,
        id: { layer: options.layer, key } satisfies PickId,
      });
      const text = options.label?.(next, i);
      const label =
        labels && text
          ? labels.add({
              position,
              text,
              font: LABEL_FONT,
              fillColor: Color.WHITE.withAlpha(0.92),
              outlineColor: Color.BLACK.withAlpha(0.8),
              outlineWidth: 3,
              style: LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: VerticalOrigin.CENTER,
              pixelOffset: offset,
              distanceDisplayCondition: LABEL_RANGE,
              show,
              id: { layer: options.layer, key } satisfies PickId,
            })
          : undefined;
      entries[i] = { point, label };
    }
    drawn = entries;
    if (selected !== undefined) {
      const i = byKey.get(selected);
      if (i !== undefined) restyle(i);
    }
    options.onRows?.(next);
    ground.refresh();
  };

  const applyFilter = () => {
    for (let i = 0; i < drawn.length; i++) {
      const entry = drawn[i];
      if (!entry) continue;
      const show = visibleRow(i);
      entry.point.show = show;
      if (entry.label) entry.label.show = show;
    }
  };

  return {
    rows: () => rows,
    setVisible(visible) {
      points.show = visible;
      if (labels) labels.show = visible;
      if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe(options.feed, render);
      if (!visible && unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
        clear();
      }
    },
    setFilter(visible) {
      shown = visible;
      applyFilter();
    },
    details(key) {
      const i = byKey.get(key);
      return i === undefined || !rows ? undefined : options.describe(rows, i);
    },
    highlight(key) {
      selected = key;
      const i = byKey.get(key);
      if (i !== undefined) restyle(i);
      return () => {
        if (selected !== key) return;
        selected = undefined;
        const j = byKey.get(key);
        if (j !== undefined) restyle(j);
      };
    },
    search(query, limit) {
      const match = options.search;
      if (!rows || !match) return [];
      const q = query.trim().toLowerCase();
      const hits: SearchHit[] = [];
      for (let i = 0; i < rows.size && hits.length < limit; i++) {
        if (!visibleRow(i)) continue;
        const hit = match(rows, i, q);
        if (hit) hits.push(hit);
      }
      return hits;
    },
    countIn(bounds: Bounds) {
      if (!rows) return 0;
      let n = 0;
      for (let i = 0; i < rows.size; i++)
        if (visibleRow(i) && contains(bounds, rows.lon(i), rows.lat(i))) n++;
      return n;
    },
    destroy() {
      ground.stop();
      unsubscribe?.();
      globe.scene.primitives.remove(points);
      if (labels) globe.scene.primitives.remove(labels);
    },
  };
};
