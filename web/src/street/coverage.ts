import type { VectorTile, VectorTileLayer } from '@mapbox/vector-tile';
import {
  Credit,
  ImageryLayer,
  type Request,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from 'cesium';
import { vectorSource } from '../data/vectortiles.ts';
import type { Filter, LayerDef, LayerHandle } from '../layers/types.ts';

const SCALE = Math.min(2, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)));
const SIZE = 256 * SCALE;
const COLOR_360 = 'rgba(70, 170, 255, 0.95)';
const COLOR_FLAT = 'rgba(70, 170, 255, 0.4)';

export const coverageFilters: ReadonlyArray<Filter> = [
  { id: 'panoramax', label: 'Panoramax', color: '#46aaff' },
  { id: 'mapillary', label: 'Mapillary', color: '#46aaff' },
];

interface Source {
  readonly id: 'panoramax' | 'mapillary';
  /** Zooms its tiles carry sequences at; deeper views reuse the deepest. */
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly tile: (z: number, x: number, y: number) => Promise<VectorTile | undefined>;
  readonly layer: string;
  readonly is360: (properties: Readonly<Record<string, unknown>>) => boolean;
}

// Panoramax's v2 tiles carry sequences from zoom 15 and stay small (tens of KB); below that
// they're density grids.
const panoramax: Source = {
  id: 'panoramax',
  minZoom: 15,
  maxZoom: 17,
  tile: vectorSource('Panoramax', (z, x, y) => `https://api.panoramax.xyz/api/map/2/${z}/${x}/${y}.mvt`, 64),
  layer: 'sequences',
  is360: (p) => p.type === 'equirectangular',
};

// Mapillary's zoom-13 tiles hold sequences only; zoom 14 adds every image as a point, which runs
// to several MB per tile in a city.
const mapillary = (token: string): Source => ({
  id: 'mapillary',
  minZoom: 13,
  maxZoom: 13,
  tile: vectorSource(
    'Mapillary',
    (z, x, y) => `https://tiles.mapillary.com/maps/vtp/mly1_public/2/${z}/${x}/${y}?access_token=${token}`,
    16,
  ),
  layer: 'sequence',
  is360: (p) => p.is_pano === true,
});

const stroke = (
  ctx: CanvasRenderingContext2D,
  layer: VectorTileLayer,
  shift: number,
  ox: number,
  oy: number,
  is360: Source['is360'],
) => {
  const k = 2 ** shift;
  const scale = (SIZE * k) / layer.extent;
  // Ordinary photos first, so 360° lines draw over them where both run.
  for (const pass of [false, true]) {
    ctx.strokeStyle = pass ? COLOR_360 : COLOR_FLAT;
    ctx.lineWidth = (pass ? 3 : 1.6) * SCALE;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type !== 2 || is360(feature.properties) !== pass) continue;
      ctx.beginPath();
      for (const part of feature.loadGeometry())
        part.forEach((p, j) => {
          const px = p.x * scale - ox * SIZE;
          const py = p.y * scale - oy * SIZE;
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
      ctx.stroke();
    }
  }
};

/** Draws where street-level imagery exists, from each source's coverage tiles. */
class CoverageProvider extends UrlTemplateImageryProvider {
  constructor(private readonly sources: ReadonlyArray<Source>) {
    super({
      // Never fetched: `requestImage` draws every tile from vector data.
      url: 'data:,',
      tilingScheme: new WebMercatorTilingScheme(),
      maximumLevel: 20,
      hasAlphaChannel: true,
      credit: new Credit(
        sources
          .map((s) =>
            s.id === 'panoramax'
              ? '<a href="https://panoramax.fr" target="_blank" rel="noreferrer">Panoramax</a>'
              : '<a href="https://www.mapillary.com" target="_blank" rel="noreferrer">Mapillary</a>',
          )
          .join(' · '),
      ),
    });
  }

  override requestImage(x: number, y: number, level: number, _request?: Request) {
    return this.draw(x, y, level);
  }

  private async draw(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    const canvas = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    await Promise.all(
      this.sources.map(async (source) => {
        if (level < source.minZoom) return;
        const z = Math.min(level, source.maxZoom);
        const shift = level - z;
        const sx = x >> shift;
        const sy = y >> shift;
        const tile = await source.tile(z, sx, sy).catch(() => undefined);
        const layer = tile?.layers[source.layer];
        if (layer) stroke(ctx, layer, shift, x - (sx << shift), y - (sy << shift), source.is360);
      }),
    );
    return canvas;
  }
}

export const streetLevelLayer: LayerDef = {
  id: 'street-level',
  title: 'Street-level imagery',
  category: 'street',
  description:
    'Where 360° street-level photos exist (bright lines) and ordinary photos (faint). Click a street to look around from the nearest panorama.',
  source: {
    name: 'Panoramax and Mapillary',
    url: 'https://panoramax.fr',
    license: 'CC BY-SA 4.0, Licence Ouverte',
  },
  defaultVisible: true,
  range: { max: 2_000 },
  filters: coverageFilters,
  // Mapillary's coverage tiles are heavy in cities (about 1.3 MB each), so its lines are opt-in.
  // Its panoramas are still found when you click a street.
  defaultHidden: ['mapillary'],
  create(globe): LayerHandle {
    const token = globe.config.keys.mapillary;
    const all: ReadonlyArray<Source> = [panoramax, ...(token ? [mapillary(token)] : [])];
    let shown: ReadonlySet<string> = new Set(['panoramax']);
    let visible = false;
    let layer: ImageryLayer | undefined;
    const mount = () => {
      if (layer) globe.removeImagery(layer);
      layer = undefined;
      const sources = all.filter((s) => shown.has(s.id));
      if (!visible || sources.length === 0) return;
      layer = new ImageryLayer(new CoverageProvider(sources));
      globe.addImagery(layer);
    };
    return {
      setVisible(next) {
        visible = next;
        mount();
      },
      setFilter(next) {
        // The panel re-applies every filter on any settings change: only redraw when this one changed.
        if (next.size === shown.size && [...next].every((id) => shown.has(id))) return;
        shown = next;
        if (visible) mount();
      },
      destroy() {
        if (layer) globe.removeImagery(layer);
      },
    };
  },
};
