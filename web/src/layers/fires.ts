import { Cartesian3, Color, NearFarScalar, PointPrimitiveCollection } from 'cesium';
import { contains } from '../../../src/area.ts';
import { feeds } from '../../../src/catalog.ts';
import type { FireData } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import { formatAge, formatLatLon, formatNumber, formatUtc } from '../lib/format.ts';
import type { Details, LayerDef, LayerHandle } from './types.ts';

/** Fire radiative power, MW: a measure of how intensely the pixel burns. */
const intensity = [
  { label: 'Under 5 MW', color: '#ffb54d', below: 5, size: 2.5 },
  { label: '5–50 MW', color: '#ff7a33', below: 50, size: 3.5 },
  { label: '50 MW and up', color: '#ff3d2e', below: Number.POSITIVE_INFINITY, size: 5 },
] as const;
const intensityColors = intensity.map((b) => Color.fromCssColorString(b.color));
const confidence = ['Low', 'Nominal', 'High'] as const;

const bandOf = (frp: number) => {
  for (let i = 0; i < intensity.length; i++)
    if (frp < (intensity[i] as (typeof intensity)[number]).below) return i;
  return intensity.length - 1;
};

export const fireLayer: LayerDef = {
  id: 'fires',
  title: 'Fire detections',
  category: 'hazards',
  description:
    'Thermal anomalies seen by the VIIRS instrument on NOAA-20 in the past 24 hours: wildfires, agricultural burns, flares.',
  source: feeds.fires.source,
  feed: 'fires',
  defaultVisible: false,
  legend: intensity.map(({ label, color }) => ({ label, color })),
  create(globe): LayerHandle {
    const points = globe.scene.primitives.add(new PointPrimitiveCollection());
    let data: FireData | undefined;
    let version = '';
    const ground = trackGround(globe, () =>
      data && points.length === data.lat.length
        ? {
            size: data.lat.length,
            lon: (i) => data?.lon[i] as number,
            lat: (i) => data?.lat[i] as number,
            place: (i, position) => {
              points.get(i).position = position;
            },
          }
        : undefined,
    );

    const render = (snapshot: Snapshot<'fires'>) => {
      data = snapshot.data;
      version = snapshot.version;
      points.removeAll();
      const scale = new NearFarScalar(2e5, 2.2, 2e7, 0.7);
      for (let i = 0; i < data.lat.length; i++) {
        const band = bandOf(data.frp[i] as number);
        const low = data.confidence[i] === 0;
        points.add({
          position: Cartesian3.fromDegrees(data.lon[i] as number, data.lat[i] as number, 0),
          pixelSize: (intensity[band] as (typeof intensity)[number]).size,
          color: low ? (intensityColors[band] as Color).withAlpha(0.45) : (intensityColors[band] as Color),
          scaleByDistance: scale,
          id: { layer: 'fires', key: `${version}:${i}` } satisfies PickId,
        });
      }
      ground.refresh();
    };
    let unsubscribe: (() => void) | undefined;

    const describe = (key: string): Details | undefined => {
      const [v, index] = key.split(':');
      const i = Number(index);
      if (!data || v !== version || !Number.isInteger(i) || i >= data.lat.length) return undefined;
      const time = data.since + (data.acquired[i] as number) * 60_000;
      const lat = data.lat[i] as number;
      const lon = data.lon[i] as number;
      return {
        kind: 'Fire detection',
        title: `${formatNumber(data.frp[i] as number)} MW`,
        subtitle: formatLatLon(lat, lon),
        fields: [
          { label: 'Observed', value: `${formatAge(globe.now() - time)} · ${formatUtc(time)}` },
          { label: 'Confidence', value: confidence[data.confidence[i] as 0 | 1 | 2] ?? '—' },
          { label: 'Pass', value: data.day[i] === 1 ? 'Daytime' : 'Nighttime' },
          { label: 'Radiative power', value: `${formatNumber(data.frp[i] as number)} MW` },
        ],
        links: [
          {
            label: 'Open in FIRMS Fire Map',
            href: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon.toFixed(3)},${lat.toFixed(3)},9.00z`,
          },
        ],
        position: () => Cartesian3.fromDegrees(lon, lat, 0),
      };
    };

    return {
      setVisible(visible) {
        points.show = visible;
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('fires', render);
        if (!visible && unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      },
      details: describe,
      countIn(bounds) {
        if (!data) return 0;
        let n = 0;
        for (let i = 0; i < data.lat.length; i++)
          if (contains(bounds, data.lon[i] as number, data.lat[i] as number)) n++;
        return n;
      },
      destroy() {
        ground.stop();
        unsubscribe?.();
        globe.scene.primitives.remove(points);
      },
    };
  },
};
