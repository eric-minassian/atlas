import { Cartesian3, Color, NearFarScalar, type PointPrimitive, PointPrimitiveCollection } from 'cesium';
import { contains } from '../../../src/area.ts';
import { feeds } from '../../../src/catalog.ts';
import type { Earthquake } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import { formatAge, formatInt, formatLatLon, formatNumber, formatUtc } from '../lib/format.ts';
import type { Details, LayerDef, LayerHandle, SearchHit } from './types.ts';

const HOUR = 3_600_000;
const ages = [
  { label: 'Past hour', color: '#ff3b3b', within: HOUR },
  { label: 'Past day', color: '#f0605a', within: 24 * HOUR },
  { label: 'Past week', color: '#9c5a63', within: Number.POSITIVE_INFINITY },
] as const;
const ageColors = ages.map((a) => Color.fromCssColorString(a.color));

const colorFor = (age: number): Color => {
  for (let i = 0; i < ages.length; i++)
    if (age < (ages[i] as (typeof ages)[number]).within) return ageColors[i] as Color;
  return ageColors[ageColors.length - 1] as Color;
};

/** Pixel size grows with magnitude (each step ~ 32x the energy, drawn far less steeply). */
const sizeFor = (magnitude: number | null) => 3 + Math.max(0, (magnitude ?? 2.5) - 2.5) * 2.4;

export const earthquakeLayer: LayerDef = {
  id: 'earthquakes',
  title: 'Earthquakes',
  category: 'hazards',
  description: 'Magnitude 2.5 and up worldwide over the past week, sized by magnitude and colored by age.',
  source: feeds.earthquakes.source,
  feed: 'earthquakes',
  defaultVisible: true,
  legend: ages.map(({ label, color }) => ({ label, color })),
  create(globe): LayerHandle {
    const points = globe.scene.primitives.add(new PointPrimitiveCollection());
    let events: ReadonlyArray<Earthquake> = [];
    let byId = new Map<string, { quake: Earthquake; point: PointPrimitive }>();
    let seated: Array<{ quake: Earthquake; point: PointPrimitive }> = [];
    const ground = trackGround(globe, () => ({
      size: seated.length,
      lon: (i) => seated[i]?.quake.lon ?? 0,
      lat: (i) => seated[i]?.quake.lat ?? 0,
      place: (i, position) => {
        const entry = seated[i];
        if (entry) entry.point.position = position;
      },
    }));

    const restyle = () => {
      const now = globe.now();
      for (const { quake, point } of byId.values()) point.color = colorFor(now - quake.time);
    };

    const render = (snapshot: Snapshot<'earthquakes'>) => {
      events = snapshot.data.events;
      points.removeAll();
      byId = new Map();
      const now = globe.now();
      // Smallest first, so large quakes draw on top.
      const ordered = events.toSorted((a, b) => (a.magnitude ?? 0) - (b.magnitude ?? 0));
      for (const quake of ordered) {
        const point = points.add({
          position: Cartesian3.fromDegrees(quake.lon, quake.lat, 0),
          pixelSize: sizeFor(quake.magnitude),
          color: colorFor(now - quake.time),
          outlineColor: Color.BLACK.withAlpha(0.55),
          outlineWidth: 1,
          scaleByDistance: new NearFarScalar(5e5, 1.5, 3e7, 0.75),
          id: { layer: 'earthquakes', key: quake.id } satisfies PickId,
        });
        byId.set(quake.id, { quake, point });
      }
      seated = [...byId.values()];
      ground.refresh();
    };
    const timer = setInterval(restyle, 60_000);
    let unsubscribe: (() => void) | undefined;

    const describe = (id: string): Details | undefined => {
      const entry = byId.get(id);
      if (!entry) return undefined;
      const q = entry.quake;
      return {
        kind: 'Earthquake',
        title:
          q.magnitude === null
            ? 'Earthquake'
            : `M ${formatNumber(q.magnitude)}${q.magnitudeType ? ` (${q.magnitudeType})` : ''}`,
        subtitle: q.place ?? formatLatLon(q.lat, q.lon),
        fields: [
          { label: 'Time', value: `${formatAge(globe.now() - q.time)} · ${formatUtc(q.time)}` },
          { label: 'Depth', value: `${formatNumber(q.depth)} km` },
          { label: 'Location', value: formatLatLon(q.lat, q.lon) },
          ...(q.alert ? [{ label: 'PAGER alert', value: q.alert[0]?.toUpperCase() + q.alert.slice(1) }] : []),
          ...(q.tsunami ? [{ label: 'Tsunami', value: 'Possible: see the tsunami warning centers' }] : []),
          ...(q.felt ? [{ label: 'Felt reports', value: formatInt(q.felt) }] : []),
        ],
        links: [{ label: 'USGS event page', href: q.url }],
        position: () => Cartesian3.fromDegrees(q.lon, q.lat, 0),
      };
    };

    return {
      setVisible(visible) {
        points.show = visible;
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('earthquakes', render);
        if (!visible && unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      },
      details: describe,
      countIn(bounds) {
        let n = 0;
        for (const quake of events) if (contains(bounds, quake.lon, quake.lat)) n++;
        return n;
      },
      highlight(id) {
        const entry = byId.get(id);
        if (!entry) return () => {};
        const { point } = entry;
        point.outlineColor = Color.WHITE;
        point.outlineWidth = 2;
        return () => {
          point.outlineColor = Color.BLACK.withAlpha(0.55);
          point.outlineWidth = 1;
        };
      },
      search(query, limit) {
        const q = query.trim().toLowerCase();
        const hits: SearchHit[] = [];
        for (const quake of events) {
          if (hits.length >= limit) break;
          if (quake.place?.toLowerCase().includes(q))
            hits.push({
              layer: 'earthquakes',
              key: quake.id,
              title: `M ${formatNumber(quake.magnitude ?? 0)} · ${quake.place}`,
              subtitle: `Earthquake · ${formatAge(globe.now() - quake.time)}`,
            });
        }
        return hits;
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
