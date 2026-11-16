import { Cartesian3, Color, NearFarScalar, type PointPrimitive, PointPrimitiveCollection } from 'cesium';
import { contains } from '../../../src/area.ts';
import { feeds } from '../../../src/catalog.ts';
import type { LightningData } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import { formatAge, formatInt, formatLatLon, formatUtc } from '../lib/format.ts';
import type { Details, LayerDef, LayerHandle } from './types.ts';

const MINUTE = 60_000;
const ages = [
  { label: 'Past minute', color: '#fff6c2', within: MINUTE },
  { label: '1–5 min', color: '#ffd84a', within: 5 * MINUTE },
  { label: '5–15 min', color: '#e8913c', within: 15 * MINUTE },
] as const;
const ageColors = ages.map((a) => Color.fromCssColorString(a.color));
const RESTYLE_MS = 5000;

/** Fresh flashes are bright; older ones fade toward the end of the window. */
const colorFor = (age: number, result: Color): Color => {
  const band = ages.findIndex((a) => age < a.within);
  if (band < 0) return Color.clone(Color.TRANSPARENT, result);
  const fade = 1 - Math.max(0, age - MINUTE) / (15 * MINUTE);
  return Color.clone(ageColors[band] as Color, result).withAlpha(0.35 + 0.65 * fade, result);
};
/** Energies run from a few femtojoules to tens of thousands: size by order of magnitude. */
const sizeFor = (energy: number) => 2.5 + Math.min(4, Math.log10(Math.max(1, energy)));

const satelliteName: Readonly<Record<string, string>> = {
  G19: 'GOES-19 (East)',
  G18: 'GOES-18 (West)',
  G16: 'GOES-16',
  G17: 'GOES-17',
};

export const lightningLayer: LayerDef = {
  id: 'lightning',
  title: 'Lightning',
  category: 'weather',
  description:
    'Lightning flashes over the Americas and the Atlantic and Pacific in the past 15 minutes, seen from geostationary orbit by the GOES-East and GOES-West lightning mappers.',
  source: feeds.lightning.source,
  feed: 'lightning',
  defaultVisible: false,
  legend: ages.map(({ label, color }) => ({ label, color })),
  create(globe): LayerHandle {
    const points = globe.scene.primitives.add(new PointPrimitiveCollection());
    let data: LightningData | undefined;
    let version = '';
    let items: PointPrimitive[] = [];
    let unsubscribe: (() => void) | undefined;
    const ground = trackGround(globe, () =>
      data && items.length === data.lon.length
        ? {
            size: items.length,
            lon: (i) => data?.lon[i] as number,
            lat: (i) => data?.lat[i] as number,
            place: (i, position) => {
              const p = items[i];
              if (p) p.position = position;
            },
          }
        : undefined,
    );

    const timeOf = (i: number) => (data ? data.since + (data.time[i] as number) * 1000 : 0);

    const restyle = () => {
      if (!data) return;
      const now = globe.now();
      for (let i = 0; i < items.length; i++) {
        const p = items[i] as PointPrimitive;
        p.color = colorFor(now - timeOf(i), p.color);
        p.show = now - timeOf(i) < 15 * MINUTE;
      }
    };

    const render = (snapshot: Snapshot<'lightning'>) => {
      data = snapshot.data;
      version = snapshot.version;
      points.removeAll();
      const scale = new NearFarScalar(2e5, 1.6, 2e7, 0.8);
      items = data.lon.map((lon, i) =>
        points.add({
          position: Cartesian3.fromDegrees(lon, data?.lat[i] as number, 0),
          pixelSize: sizeFor(data?.energy[i] as number),
          color: new Color(),
          scaleByDistance: scale,
          id: { layer: 'lightning', key: `${version}:${i}` } satisfies PickId,
        }),
      );
      restyle();
      ground.refresh();
    };
    const timer = setInterval(restyle, RESTYLE_MS);

    const clear = () => {
      data = undefined;
      items = [];
      points.removeAll();
    };

    const describe = (key: string): Details | undefined => {
      const [v, index] = key.split(':');
      const i = Number(index);
      if (!data || v !== version || !Number.isInteger(i) || i >= data.lon.length) return undefined;
      const time = timeOf(i);
      const lon = data.lon[i] as number;
      const lat = data.lat[i] as number;
      const satellite = data.satellite[i] as string;
      return {
        kind: 'Lightning flash',
        title: formatAge(globe.now() - time),
        subtitle: formatLatLon(lat, lon),
        fields: [
          { label: 'Time', value: formatUtc(time) },
          { label: 'Optical energy', value: `${formatInt(data.energy[i] as number)} fJ` },
          { label: 'Area lit', value: `${formatInt(data.area[i] as number)} km²` },
          { label: 'Seen by', value: satelliteName[satellite] ?? satellite },
        ],
        links: [{ label: 'About the GLM', href: 'https://www.goes-r.gov/spacesegment/glm.html' }],
        position: () => Cartesian3.fromDegrees(lon, lat, globe.heightAt(lon, lat) ?? 0),
      };
    };

    return {
      setVisible(visible) {
        points.show = visible;
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('lightning', render);
        if (!visible) {
          unsubscribe?.();
          unsubscribe = undefined;
          clear();
        }
      },
      details: describe,
      countIn(bounds) {
        if (!data) return 0;
        const now = globe.now();
        let n = 0;
        for (let i = 0; i < data.lon.length; i++)
          if (now - timeOf(i) < 15 * MINUTE && contains(bounds, data.lon[i] as number, data.lat[i] as number))
            n++;
        return n;
      },
      highlight(key) {
        const i = Number(key.split(':')[1]);
        const p = key.startsWith(`${version}:`) ? items[i] : undefined;
        if (!p) return () => {};
        const size = p.pixelSize;
        p.pixelSize = size + 5;
        p.outlineColor = Color.WHITE;
        p.outlineWidth = 2;
        return () => {
          p.pixelSize = size;
          p.outlineWidth = 0;
        };
      },
      destroy() {
        clearInterval(timer);
        ground.stop();
        unsubscribe?.();
        globe.scene.primitives.remove(points);
      },
    };
  },
};
