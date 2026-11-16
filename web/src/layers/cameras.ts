import { Color } from 'cesium';
import { feeds, webcamSource } from '../../../src/catalog.ts';
import type { CameraData, Webcam, WebcamArea } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { AreaTiles } from '../data/area.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import { formatAge, formatLatLon } from '../lib/format.ts';
import { Listeners } from '../lib/listeners.ts';
import { around, cameraIcon, GroundPins, matching } from './pins.ts';
import type { Details, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

const kinds: ReadonlyArray<Filter> = [
  { id: 'traffic', label: 'Traffic', color: '#f2b84b' },
  { id: 'webcams', label: 'Webcams', color: '#5fd4c4', available: (config) => config.sources.windy },
];
const trafficColor = Color.fromCssColorString(kinds[0]?.color ?? '#f2b84b');
const webcamColor = Color.fromCssColorString(kinds[1]?.color ?? '#5fd4c4');

/** How often an open camera's frame reloads; relayed frames are edge-cached for as long. */
const FRAME_MS = 30_000;
/**
 * Webcam tiles reload this often while in view. With the server's and the
 * edge's caching, a Windy image URL is at most ~7 minutes old when shown, under
 * the 10 minutes Windy's free tier signs it for.
 */
const WEBCAM_TTL_MS = 3 * 60_000;

/** One traffic camera: its row in the current snapshot. */
interface TrafficCamera {
  readonly data: CameraData;
  readonly i: number;
}

const trafficKey = 't:';
const webcamKey = 'w:';

export const cameraLayer: LayerDef = {
  id: 'cameras',
  title: 'Live cameras',
  category: 'city',
  description:
    'Traffic cameras from TfL, NYC DOT, Caltrans and US state agencies, and webcams worldwide provided by windy.com. Select one to see its latest frame.',
  source: feeds.cameras.source,
  feed: 'cameras',
  defaultVisible: true,
  range: { max: 300_000 },
  filters: kinds,
  create(globe): LayerHandle {
    const windy = globe.config.sources.windy;
    const traffic = new GroundPins<TrafficCamera>(globe, 'cameras', ({ data, i }) => ({
      lon: data.lon[i] as number,
      lat: data.lat[i] as number,
      color: trafficColor,
      image: cameraIcon,
      size: 18,
    }));
    const webcams = new GroundPins<Webcam>(globe, 'cameras', (w) => ({
      lon: w.lon,
      lat: w.lat,
      color: webcamColor,
      image: cameraIcon,
      size: 18,
    }));
    const loaded = new Listeners<void>();
    traffic.changed.add(() => loaded.emit());
    webcams.changed.add(() => loaded.emit());
    let visible = false;
    let shown: ReadonlySet<string> = new Set(kinds.map((k) => k.id));
    let unsubscribe: (() => void) | undefined;

    const renderTraffic = (snapshot: Snapshot<'cameras'>) => {
      const data = snapshot.data;
      const items = new Map<string, TrafficCamera>();
      for (let i = 0; i < data.id.length; i++) items.set(`${trafficKey}${data.id[i]}`, { data, i });
      traffic.replace(items);
    };

    const area = new AreaTiles<WebcamArea>(globe, {
      zoom: webcamSource.zoom,
      // ~16 tiles cover the view at the layer's top height; Windy's rate limit is per key.
      maxTiles: 16,
      ttlMs: WEBCAM_TTL_MS,
      load: (tile, signal) => callApi((api) => api.live.webcams({ params: tile }), { signal }),
      onChange: (tiles) => {
        const items = new Map<string, Webcam>();
        for (const { data } of tiles) for (const w of data.webcams) items.set(`${webcamKey}${w.id}`, w);
        webcams.replace(items);
      },
      onError: (error) => console.warn('webcams unavailable', error),
    });

    /** Loads only what's shown: the traffic feed and Windy (which needs this deployment's key). */
    const sync = () => {
      const wantTraffic = visible && shown.has('traffic');
      if (wantTraffic && !unsubscribe) unsubscribe = feedPoller.subscribe('cameras', renderTraffic);
      if (!wantTraffic && unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
        traffic.clear();
      }
      const wantWebcams = visible && windy && shown.has('webcams');
      area.setActive(wantWebcams);
      if (!wantWebcams) webcams.clear();
      traffic.setShow(visible);
      webcams.setShow(visible);
    };

    const describeTraffic = ({ data, i }: TrafficCamera): Details => {
      const id = data.id[i] as string;
      const name = data.name[i] as string;
      const lon = data.lon[i] as number;
      const lat = data.lat[i] as number;
      const view = data.view[i];
      const operator = data.operators[data.operator[i] as number];
      return {
        kind: 'Traffic camera',
        title: name,
        subtitle: operator?.name,
        picture: {
          // HTTPS pages can't show HTTP images: those frames come through Atlas's relay.
          src: data.relayed[i]
            ? `/api/live/cameras/${encodeURIComponent(id)}/image`
            : (data.image[i] as string),
          alt: `Latest frame from ${name}`,
          aspect: 4 / 3,
          refreshMs: FRAME_MS,
          ...(operator ? { credit: operator.credit, href: operator.url } : {}),
        },
        fields: [
          ...(operator ? [{ label: 'Operator', value: operator.name }] : []),
          ...(view ? [{ label: 'Facing', value: view }] : []),
          { label: 'Location', value: formatLatLon(lat, lon) },
        ],
        ...(operator ? { links: [{ label: operator.name, href: operator.url }] } : {}),
        extent: around(lon, lat),
      };
    };

    const describeWebcam = (w: Webcam): Details => ({
      kind: 'Webcam',
      title: w.title,
      subtitle: [w.city, w.country].filter(Boolean).join(', ') || undefined,
      // Windy's terms: every image links to its Windy page and carries their credit.
      picture: {
        src: w.preview.url,
        alt: w.title,
        aspect: w.preview.width / w.preview.height,
        href: w.page,
        credit: 'Webcams provided by windy.com',
      },
      fields: [
        ...(w.updatedAt === null
          ? []
          : [{ label: 'Latest image', value: formatAge(globe.now() - w.updatedAt) }]),
        { label: 'Location', value: formatLatLon(w.lat, w.lon) },
      ],
      links: [
        { label: 'Windy', href: w.page },
        ...(w.timelapse ? [{ label: 'Timelapse', href: w.timelapse }] : []),
      ],
      extent: around(w.lon, w.lat),
    });

    return {
      setVisible(next) {
        visible = next;
        sync();
      },
      setFilter(next) {
        shown = next;
        sync();
      },
      details(key) {
        const camera = traffic.get(key);
        if (camera) return describeTraffic(camera);
        const webcam = webcams.get(key);
        return webcam ? describeWebcam(webcam) : undefined;
      },
      highlight(key) {
        return key.startsWith(trafficKey) ? traffic.highlight(key) : webcams.highlight(key);
      },
      countIn(bounds) {
        return traffic.countIn(bounds) + webcams.countIn(bounds);
      },
      loaded,
      search(query, limit) {
        const hits: SearchHit[] = matching(
          traffic.items(),
          query,
          limit,
          ([, c]) => c.data.name[c.i] ?? '',
        ).map(([key, { data, i }]) => ({
          layer: 'cameras',
          key,
          title: data.name[i] as string,
          subtitle: `Traffic camera · ${data.operators[data.operator[i] as number]?.name ?? ''}`,
        }));
        for (const [key, webcam] of matching(webcams.items(), query, limit - hits.length, ([, w]) => w.title))
          hits.push({ layer: 'cameras', key, title: webcam.title, subtitle: 'Webcam · Windy' });
        return hits;
      },
      destroy() {
        area.destroy();
        unsubscribe?.();
        traffic.destroy();
        webcams.destroy();
      },
    };
  },
};
