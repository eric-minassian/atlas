import {
  Math as CesiumMath,
  Credit,
  ImageryLayer,
  type ImageryProvider,
  type ImageryTypes,
  type Request,
  UrlTemplateImageryProvider,
  GeographicTilingScheme,
  WebMercatorTilingScheme,
} from 'cesium';
import { feeds } from '../../../src/catalog.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import { type Globe, gibs } from '../globe/globe.ts';
import { extractNames } from './names.ts';
import type { LayerDef, LayerHandle } from './types.ts';
import { VectorLabels } from './vectorlabels.ts';

/** Below this camera height, OpenStreetMap names take over from NASA's coarse label overlay. */
const NAMES_BELOW = 150_000;

/** Retries a failed tile a couple of times before leaving the hole for the next refresh. */
export const retrying = <P extends ImageryProvider>(provider: P): P => {
  provider.errorEvent.addEventListener((error: { timesRetried: number; retry: boolean }) => {
    error.retry = error.timesRetried < 2;
  });
  return provider;
};

const nasaGibs = { name: 'NASA GIBS', url: 'https://www.earthdata.nasa.gov/gibs', license: 'NASA open data' };

/**
 * Coarse weather imagery (kilometers per pixel) turns into blurry blobs over a
 * city: fade it from `full` opacity at `from` meters of camera height down to
 * `floor` of it at `to`.
 */
export interface Fade {
  readonly from: number;
  readonly to: number;
  readonly floor: number;
}

export const fadeFactor = (fade: Fade | undefined, height: number): number => {
  if (!fade || height >= fade.from) return 1;
  if (height <= fade.to) return fade.floor;
  const t = (height - fade.to) / (fade.from - fade.to);
  return fade.floor + (1 - fade.floor) * t * t * (3 - 2 * t);
};

/**
 * An imagery layer whose provider is rebuilt every `refreshMs` (for sources
 * that publish new frames at the same URL), or never.
 */
const imageryHandle = (
  globe: Globe,
  makeProvider: () => ImageryProvider,
  options: { readonly opacity: number; readonly refreshMs?: number; readonly fade?: Fade },
): LayerHandle => {
  let layer: ImageryLayer | undefined;
  let opacity = options.opacity;
  let timer: ReturnType<typeof setInterval> | undefined;
  const alpha = () => opacity * fadeFactor(options.fade, globe.view.height);
  const stopFade = options.fade
    ? globe.viewChanged.add(() => {
        if (layer) layer.alpha = alpha();
      })
    : undefined;

  const mount = () => {
    const next = new ImageryLayer(retrying(makeProvider()), { alpha: alpha() });
    globe.addImagery(next);
    const previous = layer;
    layer = next;
    // Let the new frame's tiles arrive before the old ones go, so it doesn't flash.
    if (previous) setTimeout(() => globe.removeImagery(previous), 4000);
  };
  const unmount = () => {
    if (layer) globe.removeImagery(layer);
    layer = undefined;
  };

  return {
    setVisible(visible) {
      if (visible && !layer) {
        mount();
        if (options.refreshMs) timer = setInterval(mount, options.refreshMs);
      }
      if (!visible) {
        if (timer) clearInterval(timer);
        timer = undefined;
        unmount();
      }
    },
    setOpacity(value) {
      opacity = value;
      if (layer) layer.alpha = alpha();
    },
    destroy() {
      stopFade?.();
      if (timer) clearInterval(timer);
      unmount();
    },
  };
};

/**
 * NOAA's global mosaic of geostationary infrared imagery is grayscale: cold
 * cloud tops bright, the warm surface dark. Turning brightness into opacity
 * leaves white clouds over the Blue Marble instead of a gray sheet. The mosaic
 * ends around 72° N/S, so opacity also fades out towards that edge.
 */
const LOW = 118;
const HIGH = 222;
const FADE_FROM = 58;
const FADE_TO = 71;

const toClouds = (image: ImageryTypes, north: number, south: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;
  if (image instanceof ImageBitmap) {
    // Cesium decodes tiles into bitmaps already flipped for WebGL, but uploads canvases
    // flipped too: draw it upright so the tile isn't turned upside down twice.
    ctx.translate(0, canvas.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  const w = canvas.width;
  const h = canvas.height;
  for (let row = 0; row < h; row++) {
    const lat = Math.abs(north - ((north - south) * (row + 0.5)) / h);
    const edge = lat <= FADE_FROM ? 1 : lat >= FADE_TO ? 0 : (FADE_TO - lat) / (FADE_TO - FADE_FROM);
    for (let col = 0; col < w; col++) {
      const i = (row * w + col) * 4;
      const a = d[i + 3] as number;
      if (a === 0) continue;
      const t = Math.min(1, Math.max(0, ((d[i] as number) - LOW) / (HIGH - LOW)));
      const s = t * t * (3 - 2 * t);
      const shade = 210 + 45 * t;
      d[i] = shade;
      d[i + 1] = shade;
      d[i + 2] = Math.min(255, shade + 6);
      d[i + 3] = s * 235 * edge * (a / 255);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
};

/** Infrared cloud tiles relayed by Atlas's API (see `TilesApi`), turned into white clouds. */
class CloudImageryProvider extends UrlTemplateImageryProvider {
  override requestImage(x: number, y: number, level: number, request?: Request) {
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    const north = CesiumMath.toDegrees(rect.north);
    const south = CesiumMath.toDegrees(rect.south);
    return super.requestImage(x, y, level, request)?.then((image) => toClouds(image, north, south));
  }
}

/** The mosaic is hourly; asking by half hour picks up each new frame without refetching within one. */
const cloudFrame = () => Math.floor(Date.now() / 1_800_000);

export const cloudLayer: LayerDef = {
  id: 'clouds',
  title: 'Clouds',
  category: 'weather',
  description:
    'Global infrared cloud cover from geostationary satellites (GOES, Meteosat, Himawari), updated hourly.',
  source: { name: 'NOAA nowCOAST (GMGSI)', url: 'https://nowcoast.noaa.gov', license: 'Public domain' },
  defaultVisible: true,
  opacity: 0.85,
  // At ~5 km per pixel the mosaic is only haze over a city.
  range: { min: 40_000 },
  create(globe) {
    return imageryHandle(
      globe,
      () =>
        new CloudImageryProvider({
          url: `/api/tiles/clouds/{z}/{x}/{y}?frame=${cloudFrame()}`,
          tilingScheme: new GeographicTilingScheme(),
          maximumLevel: 5,
          credit: new Credit('NOAA nowCOAST'),
        }),
      { opacity: 0.85, refreshMs: 30 * 60_000, fade: { from: 600_000, to: 50_000, floor: 0.15 } },
    );
  },
};

export const radarLayer: LayerDef = {
  id: 'radar',
  title: 'Weather radar',
  category: 'weather',
  description: 'Precipitation from ground radar networks, composited worldwide every 10 minutes.',
  source: feeds.radar.source,
  feed: 'radar',
  defaultVisible: true,
  opacity: 0.6,
  create(globe) {
    let frame = '';
    let host = '';
    let opacity = 0.6;
    let layer: ImageryLayer | undefined;
    let unsubscribe: (() => void) | undefined;
    // Rain over your city still matters close up, so it stays faintly visible there.
    const fade: Fade = { from: 150_000, to: 15_000, floor: 0.35 };
    const alpha = () => opacity * fadeFactor(fade, globe.view.height);
    const stopFade = globe.viewChanged.add(() => {
      if (layer) layer.alpha = alpha();
    });

    const show = () => {
      if (!frame) return;
      const next = new ImageryLayer(
        retrying(
          new UrlTemplateImageryProvider({
            url: `${host}${frame}/256/{z}/{x}/{y}/2/1_1.png`,
            tilingScheme: new WebMercatorTilingScheme(),
            maximumLevel: 7,
            credit: new Credit('RainViewer'),
          }),
        ),
        { alpha: alpha() },
      );
      globe.addImagery(next);
      const previous = layer;
      layer = next;
      if (previous) setTimeout(() => globe.removeImagery(previous), 4000);
    };

    const render = (snapshot: Snapshot<'radar'>) => {
      const latest = snapshot.data.frames.at(-1);
      if (!latest || latest.path === frame) return;
      frame = latest.path;
      host = snapshot.data.host;
      show();
    };

    return {
      setVisible(visible) {
        if (visible && !unsubscribe) {
          unsubscribe = feedPoller.subscribe('radar', render);
          if (!layer) show();
        }
        if (!visible) {
          unsubscribe?.();
          unsubscribe = undefined;
          if (layer) globe.removeImagery(layer);
          layer = undefined;
        }
      },
      setOpacity(value) {
        opacity = value;
        if (layer) layer.alpha = alpha();
      },
      destroy() {
        stopFade();
        unsubscribe?.();
        if (layer) globe.removeImagery(layer);
      },
    };
  },
};

export const precipitationLayer: LayerDef = {
  id: 'precipitation',
  title: 'Precipitation (satellite)',
  category: 'weather',
  description:
    'Rain and snow rates estimated from the GPM satellite constellation (IMERG), every 30 minutes, including over oceans. Runs a few hours behind.',
  source: nasaGibs,
  defaultVisible: false,
  opacity: 0.8,
  create(globe) {
    return imageryHandle(globe, () => gibs('IMERG_Precipitation_Rate_30min', { level: 6, format: 'png' }), {
      opacity: 0.8,
      refreshMs: 30 * 60_000,
      fade: { from: 300_000, to: 30_000, floor: 0.3 },
    });
  },
};

export const seaTemperatureLayer: LayerDef = {
  id: 'sea-temperature',
  title: 'Sea surface temperature',
  category: 'earth',
  description: 'Daily blended sea surface temperature analysis (GHRSST MUR, 1 km).',
  source: nasaGibs,
  defaultVisible: false,
  opacity: 0.85,
  create(globe) {
    return imageryHandle(
      globe,
      () => gibs('GHRSST_L4_MUR_Sea_Surface_Temperature', { level: 7, format: 'png' }),
      { opacity: 0.85 },
    );
  },
};

/** Yesterday (UTC): today's true-color mosaic is still being filled in by passes. */
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

export const trueColorLayer: LayerDef = {
  id: 'true-color',
  title: 'True color (daily)',
  category: 'earth',
  description:
    "Yesterday's view of the whole Earth from the VIIRS instrument on NOAA-20, stitched from its passes.",
  source: nasaGibs,
  defaultVisible: false,
  opacity: 1,
  basemaps: ['satellite'],
  create(globe) {
    return imageryHandle(
      globe,
      () =>
        gibs('VIIRS_NOAA20_CorrectedReflectance_TrueColor', { level: 9, format: 'jpg', time: yesterday() }),
      { opacity: 1 },
    );
  },
};

export const dayNightLayer: LayerDef = {
  id: 'day-night',
  title: 'Day and night',
  category: 'base',
  description: "Lights the globe from the Sun's current position, with city lights on the night side.",
  source: nasaGibs,
  defaultVisible: true,
  basemaps: ['satellite'],
  create(globe) {
    return { setVisible: (visible) => globe.setLighting(visible), destroy: () => globe.setLighting(true) };
  },
};

export const referenceLayer: LayerDef = {
  id: 'reference',
  title: 'Borders and labels',
  category: 'base',
  description:
    'Borders and place names: countries and regions from afar, then cities, neighbourhoods, streets and house numbers as you zoom in.',
  source: nasaGibs,
  defaultVisible: true,
  basemaps: ['satellite'],
  create(globe) {
    // NASA's overlay names countries and regions from afar; closer in, names come from OpenStreetMap
    // as screen-space labels (cities, then neighbourhoods, streets and house numbers).
    const names = new VectorLabels(globe, {
      layer: 'reference',
      extract: extractNames,
      pickable: false,
      maxHeight: NAMES_BELOW,
    });
    return {
      setVisible(visible) {
        globe.setReference(visible);
        names.setActive(visible);
      },
      destroy() {
        names.destroy();
        globe.setReference(false);
      },
    };
  },
};
