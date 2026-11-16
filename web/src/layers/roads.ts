import type { VectorTileFeature } from '@mapbox/vector-tile';
import {
  Credit,
  ImageryLayer,
  type Request,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from 'cesium';
import { MAX_VECTOR_ZOOM, openStreetMapCredit, vectorTile } from '../data/vectortiles.ts';
import type { LayerDef, LayerHandle } from './types.ts';

/** Roads first appear at this tile level (~150 m per pixel), where they stop being noise. */
const MIN_LEVEL = 9;
const MAX_LEVEL = 19;
/** Tiles are drawn at up to twice their size, so lines stay crisp on high-density screens. */
const SCALE = Math.min(2, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)));
const SIZE = 256 * SCALE;

interface Stroke {
  readonly color: string;
  /** Line width in CSS pixels at tile levels 12 and 18; interpolated between, clamped outside. */
  readonly width: readonly [number, number];
  /** First tile level the class is drawn at. */
  readonly from: number;
  readonly casing?: boolean;
  readonly dash?: readonly number[];
}

// Pale lines read on both dense city imagery and dark water; the big roads get a warm tint and a
// dark casing so they stand out from the imagery's own roads.
const strokes: Readonly<Record<string, Stroke>> = {
  motorway: { color: 'rgba(250, 210, 110, 0.9)', width: [1.6, 7], from: 9, casing: true },
  trunk: { color: 'rgba(250, 225, 150, 0.85)', width: [1.4, 6], from: 9, casing: true },
  primary: { color: 'rgba(255, 255, 255, 0.8)', width: [1.1, 5.5], from: 10, casing: true },
  secondary: { color: 'rgba(255, 255, 255, 0.7)', width: [0.9, 5], from: 11, casing: true },
  tertiary: { color: 'rgba(255, 255, 255, 0.6)', width: [0.7, 4.5], from: 12 },
  minor: { color: 'rgba(255, 255, 255, 0.5)', width: [0.5, 3.5], from: 13 },
  service: { color: 'rgba(255, 255, 255, 0.35)', width: [0.4, 2], from: 15 },
  track: { color: 'rgba(240, 230, 210, 0.4)', width: [0.4, 1.6], from: 14, dash: [4, 3] },
  path: { color: 'rgba(240, 230, 210, 0.45)', width: [0.4, 1.4], from: 15, dash: [2, 2] },
  rail: { color: 'rgba(225, 225, 230, 0.6)', width: [0.6, 2], from: 11, dash: [6, 3] },
  transit: { color: 'rgba(225, 225, 230, 0.5)', width: [0.6, 1.8], from: 13, dash: [6, 3] },
};
/** Draw order: small roads under big ones. */
const order = [
  'path',
  'track',
  'service',
  'rail',
  'transit',
  'minor',
  'tertiary',
  'secondary',
  'primary',
  'trunk',
  'motorway',
];

const BORDERS: Readonly<Record<number, Stroke>> = {
  2: { color: 'rgba(255, 255, 255, 0.75)', width: [1.4, 2.5], from: MIN_LEVEL, dash: [6, 3] },
  4: { color: 'rgba(255, 255, 255, 0.45)', width: [0.9, 1.6], from: MIN_LEVEL, dash: [4, 3] },
};

const widthAt = (stroke: Stroke, level: number) => {
  const t = Math.min(1, Math.max(0, (level - 12) / 6));
  return (stroke.width[0] + (stroke.width[1] - stroke.width[0]) * t) * SCALE;
};

/**
 * Roads, railways and borders drawn from OpenStreetMap vector tiles into
 * imagery tiles, so they drape over terrain like the satellite imagery under
 * them. Past zoom 14, tiles are cut from their zoom-14 ancestor.
 */
class RoadsImageryProvider extends UrlTemplateImageryProvider {
  constructor() {
    super({
      // Never fetched: `requestImage` draws every tile from vector data.
      url: 'data:,',
      tilingScheme: new WebMercatorTilingScheme(),
      minimumLevel: 0,
      maximumLevel: MAX_LEVEL,
      tileWidth: 256,
      tileHeight: 256,
      hasAlphaChannel: true,
      credit: new Credit(openStreetMapCredit),
    });
  }

  override requestImage(x: number, y: number, level: number, _request?: Request) {
    return draw(x, y, level);
  }
}

const blank = (() => {
  let canvas: HTMLCanvasElement | undefined;
  return () => {
    canvas ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    return canvas;
  };
})();

const draw = async (x: number, y: number, level: number): Promise<HTMLCanvasElement> => {
  if (level < MIN_LEVEL) return blank();
  const sourceLevel = Math.min(level, MAX_VECTOR_ZOOM);
  const shift = level - sourceLevel;
  const k = 2 ** shift;
  const sx = x >> shift;
  const sy = y >> shift;
  const tile = await vectorTile(sourceLevel, sx, sy);
  if (!tile) return blank();
  const canvas = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const ox = x - sx * k;
  const oy = y - sy * k;

  const path = (feature: VectorTileFeature, extent: number) => {
    const scale = (SIZE * k) / extent;
    ctx.beginPath();
    for (const ring of feature.loadGeometry()) {
      ring.forEach((p, i) => {
        const px = p.x * scale - ox * SIZE;
        const py = p.y * scale - oy * SIZE;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
    }
  };

  const roads = tile.layers.transportation;
  if (roads) {
    const byClass = new Map<string, VectorTileFeature[]>();
    for (let i = 0; i < roads.length; i++) {
      const feature = roads.feature(i);
      // Tunnels are underground: drawing them over the imagery would mislead.
      if (feature.properties.brunnel === 'tunnel') continue;
      const cls = String(feature.properties.class ?? '');
      const stroke = strokes[cls];
      if (!stroke || level < stroke.from) continue;
      const list = byClass.get(cls) ?? [];
      list.push(feature);
      byClass.set(cls, list);
    }
    // Casings in one pass under every road, so junctions don't show seams.
    for (const cls of order) {
      const stroke = strokes[cls];
      if (!stroke?.casing) continue;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.lineWidth = widthAt(stroke, level) + 1.5 * SCALE;
      ctx.setLineDash([]);
      for (const feature of byClass.get(cls) ?? []) {
        path(feature, roads.extent);
        ctx.stroke();
      }
    }
    for (const cls of order) {
      const stroke = strokes[cls];
      if (!stroke) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = widthAt(stroke, level);
      ctx.setLineDash(stroke.dash ? stroke.dash.map((d) => d * SCALE) : []);
      for (const feature of byClass.get(cls) ?? []) {
        path(feature, roads.extent);
        ctx.stroke();
      }
    }
  }

  const boundaries = tile.layers.boundary;
  if (boundaries) {
    for (let i = 0; i < boundaries.length; i++) {
      const feature = boundaries.feature(i);
      // Maritime borders cross open water; only land borders help orientation here.
      if (feature.properties.maritime === 1) continue;
      const stroke = BORDERS[Number(feature.properties.admin_level)];
      if (!stroke) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = widthAt(stroke, level);
      ctx.setLineDash(stroke.dash ? stroke.dash.map((d) => d * SCALE) : []);
      path(feature, boundaries.extent);
      ctx.stroke();
    }
  }
  return canvas;
};

export const roadsLayer: LayerDef = {
  id: 'roads',
  title: 'Roads',
  category: 'base',
  description: 'Roads, railways and borders from OpenStreetMap, drawn over the imagery as you zoom in.',
  source: { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
  defaultVisible: true,
  range: { max: 400_000 },
  basemaps: ['satellite'],
  opacity: 0.9,
  create(globe): LayerHandle {
    let layer: ImageryLayer | undefined;
    let opacity = 0.9;
    return {
      setVisible(visible) {
        if (visible && !layer) {
          layer = new ImageryLayer(new RoadsImageryProvider(), { alpha: opacity });
          globe.addImagery(layer);
        }
        if (!visible && layer) {
          globe.removeImagery(layer);
          layer = undefined;
        }
      },
      setOpacity(value) {
        opacity = value;
        if (layer) layer.alpha = value;
      },
      destroy() {
        if (layer) globe.removeImagery(layer);
      },
    };
  },
};
