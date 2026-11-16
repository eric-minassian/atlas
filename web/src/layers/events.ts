import {
  ArcType,
  Cartesian3,
  Color,
  Material,
  NearFarScalar,
  type PointPrimitive,
  PointPrimitiveCollection,
  PolylineCollection,
} from 'cesium';
import { contains } from '../../../src/area.ts';
import { feeds } from '../../../src/catalog.ts';
import type { NaturalEvent } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import { formatAge, formatLatLon, formatNumber, formatUtc } from '../lib/format.ts';
import type { Details, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

/** EONET categories, in the order the filter lists them. */
const kinds: ReadonlyArray<Filter> = [
  { id: 'wildfires', label: 'Wildfires', color: '#ff7043' },
  { id: 'severeStorms', label: 'Severe storms', color: '#9d8cff' },
  { id: 'volcanoes', label: 'Volcanoes', color: '#ef5350' },
  { id: 'seaLakeIce', label: 'Sea and lake ice', color: '#80d4f0' },
  { id: 'floods', label: 'Floods', color: '#4f8dff' },
  { id: 'other', label: 'Other', color: '#c5ccd6' },
];
const known = new Set(kinds.map((k) => k.id));
const kindOf = (category: string) => (known.has(category) ? category : 'other');
const colorOf = new Map(kinds.map((k) => [k.id, Color.fromCssColorString(k.color)]));
const labelOf = new Map(kinds.map((k) => [k.id, k.label]));

export const eventLayer: LayerDef = {
  id: 'events',
  title: 'Natural events',
  category: 'hazards',
  description:
    'Ongoing wildfires, storms, volcanic eruptions and ice events curated by NASA, with storm tracks.',
  source: feeds.events.source,
  feed: 'events',
  defaultVisible: true,
  filters: kinds,
  create(globe): LayerHandle {
    const points = globe.scene.primitives.add(new PointPrimitiveCollection());
    const tracks = globe.scene.primitives.add(new PolylineCollection());
    let events: ReadonlyArray<NaturalEvent> = [];
    let byId = new Map<string, { event: NaturalEvent; point: PointPrimitive }>();
    let shown: ReadonlySet<string> = new Set(kinds.map((k) => k.id));
    let seated: Array<{ event: NaturalEvent; point: PointPrimitive }> = [];
    const ground = trackGround(globe, () => ({
      size: seated.length,
      lon: (i) => seated[i]?.event.lon ?? 0,
      lat: (i) => seated[i]?.event.lat ?? 0,
      place: (i, position) => {
        const entry = seated[i];
        if (entry) entry.point.position = position;
      },
    }));

    const render = (snapshot: Snapshot<'events'>) => {
      events = snapshot.data.events;
      points.removeAll();
      tracks.removeAll();
      byId = new Map();
      for (const event of events) {
        const kind = kindOf(event.category);
        const color = colorOf.get(kind) ?? Color.WHITE;
        const point = points.add({
          position: Cartesian3.fromDegrees(event.lon, event.lat, 0),
          pixelSize: 9,
          color: color.withAlpha(0.95),
          outlineColor: Color.fromCssColorString('#0b0d10').withAlpha(0.85),
          outlineWidth: 2,
          scaleByDistance: new NearFarScalar(5e5, 1.3, 3e7, 0.8),
          show: shown.has(kind),
          id: { layer: 'events', key: event.id } satisfies PickId,
        });
        byId.set(event.id, { event, point });
        if (event.track.length > 0) {
          tracks.add({
            positions: Cartesian3.fromDegreesArray([...event.track.flat(), event.lon, event.lat]),
            width: 1.5,
            arcType: ArcType.GEODESIC,
            material: Material.fromType('Color', { color: color.withAlpha(0.6) }),
            show: shown.has(kind),
            id: { layer: 'events', key: event.id } satisfies PickId,
          });
        }
      }
      seated = [...byId.values()];
      ground.refresh();
    };
    let unsubscribe: (() => void) | undefined;

    const applyFilter = () => {
      for (const { event, point } of byId.values()) point.show = shown.has(kindOf(event.category));
      for (let i = 0; i < tracks.length; i++) {
        const line = tracks.get(i);
        const event = byId.get((line.id as PickId).key)?.event;
        line.show = event ? shown.has(kindOf(event.category)) : false;
      }
    };

    const describe = (id: string): Details | undefined => {
      const entry = byId.get(id);
      if (!entry) return undefined;
      const e = entry.event;
      const kind = kindOf(e.category);
      return {
        kind: labelOf.get(kind) ?? 'Event',
        title: e.title,
        subtitle: formatLatLon(e.lat, e.lon),
        fields: [
          { label: 'Latest observation', value: `${formatAge(globe.now() - e.time)} · ${formatUtc(e.time)}` },
          ...(e.magnitude
            ? [{ label: 'Magnitude', value: `${formatNumber(e.magnitude.value)} ${e.magnitude.unit}` }]
            : []),
          ...(e.track.length > 0 ? [{ label: 'Track', value: `${e.track.length + 1} observations` }] : []),
        ],
        ...(e.source ? { links: [{ label: 'Source report', href: e.source }] } : {}),
        position: () => Cartesian3.fromDegrees(e.lon, e.lat, 0),
      };
    };

    return {
      setVisible(visible) {
        points.show = visible;
        tracks.show = visible;
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('events', render);
        if (!visible && unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      },
      setFilter(visible) {
        shown = visible;
        applyFilter();
      },
      details: describe,
      countIn(bounds) {
        let n = 0;
        for (const e of events) if (shown.has(kindOf(e.category)) && contains(bounds, e.lon, e.lat)) n++;
        return n;
      },
      highlight(id) {
        const entry = byId.get(id);
        if (!entry) return () => {};
        const { point } = entry;
        point.outlineColor = Color.WHITE;
        point.pixelSize = 12;
        return () => {
          point.outlineColor = Color.fromCssColorString('#0b0d10').withAlpha(0.85);
          point.pixelSize = 9;
        };
      },
      search(query, limit) {
        const q = query.trim().toLowerCase();
        const hits: SearchHit[] = [];
        for (const e of events) {
          if (hits.length >= limit) break;
          if (e.title.toLowerCase().includes(q))
            hits.push({
              layer: 'events',
              key: e.id,
              title: e.title,
              subtitle: `${labelOf.get(kindOf(e.category)) ?? 'Event'} · ${formatAge(globe.now() - e.time)}`,
            });
        }
        return hits;
      },
      destroy() {
        ground.stop();
        unsubscribe?.();
        globe.scene.primitives.remove(points);
        globe.scene.primitives.remove(tracks);
      },
    };
  },
};
