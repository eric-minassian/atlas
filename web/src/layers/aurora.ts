import { Credit, ImageryLayer, Rectangle, SingleTileImageryProvider } from 'cesium';
import { feeds } from '../../../src/catalog.ts';
import type { AuroraData } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import { layerStatus } from '../data/status.ts';
import { formatAge, formatUtc } from '../lib/format.ts';
import type { LayerDef } from './types.ts';

/** The grid's shape (see `AuroraData.grid`). */
const WIDTH = 360;
const HEIGHT = 181;
/** The overlay image: four pixels per grid cell each way, interpolated, so the glow has no blocks. */
const IMAGE_WIDTH = 1440;
const IMAGE_HEIGHT = 720;

/** Probabilities below this are left transparent: OVATION's floor is a few percent everywhere near the ovals. */
const FLOOR = 3;
/** The glow is fully opaque from here up. */
const FULL = 60;

const decode = (grid: string): Uint8Array => {
  const binary = atob(grid);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Probability at a point, bilinear between grid cells (longitude wraps). */
const sample = (grid: Uint8Array, lon: number, lat: number): number => {
  const x = ((lon % 360) + 360) % 360;
  const y = Math.max(0, Math.min(HEIGHT - 1, lat + 90));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % WIDTH;
  const y1 = Math.min(HEIGHT - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (cx: number, cy: number) => grid[cy * WIDTH + cx] ?? 0;
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x1, y0) * fx * (1 - fy) +
    at(x0, y1) * (1 - fx) * fy +
    at(x1, y1) * fx * fy
  );
};

/** A soft green glow, turning paler where the aurora is likely: the colors it's mostly seen in. */
const render = (data: AuroraData): string => {
  const grid = decode(data.grid);
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_WIDTH;
  canvas.height = IMAGE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const image = ctx.createImageData(IMAGE_WIDTH, IMAGE_HEIGHT);
  const d = image.data;
  for (let row = 0; row < IMAGE_HEIGHT; row++) {
    const lat = 90 - ((row + 0.5) * 180) / IMAGE_HEIGHT;
    for (let col = 0; col < IMAGE_WIDTH; col++) {
      const p = sample(grid, -180 + ((col + 0.5) * 360) / IMAGE_WIDTH, lat);
      if (p < FLOOR) continue;
      const t = Math.min(1, (p - FLOOR) / (FULL - FLOOR));
      const i = (row * IMAGE_WIDTH + col) * 4;
      d[i] = 60 + 140 * t;
      d[i + 1] = 255;
      d[i + 2] = 130 + 30 * t;
      d[i + 3] = 255 * Math.sqrt(t) * 0.9;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
};

const peakOf = (grid: string): number => decode(grid).reduce((max, p) => Math.max(max, p), 0);

export const auroraLayer: LayerDef = {
  id: 'aurora',
  title: 'Aurora forecast',
  category: 'space',
  description:
    'Where the aurora is likely to be seen overhead in the next 30 to 90 minutes, from NOAA’s OVATION model, updated every 5 minutes.',
  source: feeds.aurora.source,
  defaultVisible: false,
  opacity: 0.9,
  // A 1° grid: it reads at the scale of continents and fades into noise over a city.
  range: { min: 600_000 },
  legend: [
    { label: '10%', color: '#2f7f54' },
    { label: '30%', color: '#58c98a' },
    { label: '60% and up', color: '#c8ffa0' },
  ],
  create(globe) {
    let layer: ImageryLayer | undefined;
    let opacity = 0.9;
    let unsubscribe: (() => void) | undefined;
    let stopViews: (() => void) | undefined;
    let latest: { readonly snapshot: Snapshot<'aurora'>; readonly peak: number } | undefined;

    // Called on every feed's poll: keep it to formatting.
    const status = () => {
      const view = feedPoller.view('aurora');
      if (latest) {
        const { snapshot, peak } = latest;
        layerStatus.set('aurora', {
          text: `Up to ${peak}%`,
          detail: `Chance of aurora overhead, forecast for ${formatUtc(snapshot.data.forecast)}. Updated ${formatAge(Date.now() - snapshot.fetchedAt)} from ${feeds.aurora.source.name}.`,
        });
      } else if (view.state === 'pending' || view.state === 'error')
        layerStatus.set('aurora', {
          text: view.state === 'pending' ? 'Pending' : 'Offline',
          detail:
            view.state === 'pending'
              ? 'Waiting for the first forecast from the source.'
              : 'Could not reach Atlas. Retrying.',
          tone: 'warn',
        });
      else layerStatus.set('aurora', { text: 'Loading', tone: 'muted' });
    };

    const show = (snapshot: Snapshot<'aurora'>) => {
      latest = { snapshot, peak: peakOf(snapshot.data.grid) };
      const url = render(snapshot.data);
      status();
      if (!url) return;
      const next = new ImageryLayer(
        new SingleTileImageryProvider({
          url,
          rectangle: Rectangle.fromDegrees(-180, -90, 180, 90),
          tileWidth: IMAGE_WIDTH,
          tileHeight: IMAGE_HEIGHT,
          credit: new Credit('NOAA SWPC OVATION'),
        }),
        { alpha: opacity },
      );
      globe.addImagery(next, { data: true });
      const previous = layer;
      layer = next;
      if (previous) setTimeout(() => globe.removeImagery(previous), 1000);
    };

    const hide = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      stopViews?.();
      stopViews = undefined;
      if (layer) globe.removeImagery(layer);
      layer = undefined;
      latest = undefined;
      layerStatus.set('aurora', { text: '' });
    };

    return {
      setVisible(visible) {
        if (visible && !unsubscribe) {
          stopViews = feedPoller.onViews(status);
          unsubscribe = feedPoller.subscribe('aurora', show);
          status();
        }
        if (!visible) hide();
      },
      setOpacity(value) {
        opacity = value;
        if (layer) layer.alpha = value;
      },
      destroy: hide,
    };
  },
};
