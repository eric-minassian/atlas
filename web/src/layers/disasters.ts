import {
  type Billboard,
  BillboardCollection,
  Cartesian3,
  Color,
  HeightReference,
  NearFarScalar,
} from 'cesium';
import { contains } from '../../../src/area.ts';
import { feeds } from '../../../src/catalog.ts';
import type { Disaster, DisasterAlert, TsunamiBulletin } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { formatAge, formatLatLon, formatUtc } from '../lib/format.ts';
import { type Area, boundsOf, GroundShapes, type Line } from './areas.ts';
import type { Details, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

type Kind = Disaster['type'] | 'TS';

const NEUTRAL = '#c5ccd6';
/** Event types; the layer's filters. Each marker's color is its alert level, so the chips stay neutral. */
const kinds: ReadonlyArray<Filter & { readonly id: Kind; readonly title: string }> = [
  { id: 'TC', label: 'Tropical cyclones', title: 'Tropical cyclone', color: NEUTRAL },
  { id: 'EQ', label: 'Earthquakes', title: 'Earthquake', color: NEUTRAL },
  { id: 'TS', label: 'Tsunamis', title: 'Tsunami bulletin', color: NEUTRAL },
  { id: 'FL', label: 'Floods', title: 'Flood', color: NEUTRAL },
  { id: 'VO', label: 'Volcanoes', title: 'Volcanic eruption', color: NEUTRAL },
  { id: 'DR', label: 'Droughts', title: 'Drought', color: NEUTRAL },
  { id: 'WF', label: 'Wildfires', title: 'Wildfire', color: NEUTRAL },
];
const titleOf = new Map(kinds.map((k) => [k.id, k.title]));

const alerts = [
  { id: 'red', label: 'Red alert', color: '#e5484d', scale: 0.95 },
  { id: 'orange', label: 'Orange alert', color: '#f39a3a', scale: 0.8 },
  { id: 'green', label: 'Green alert', color: '#45b36b', scale: 0.62 },
] as const;
const alertOf = new Map(alerts.map((a) => [a.id, { ...a, fill: Color.fromCssColorString(a.color) }]));
const meaning: Readonly<Record<DisasterAlert, string>> = {
  red: 'Red: likely need for international assistance',
  orange: 'Orange: possible need for national or international response',
  green: 'Green: little humanitarian impact expected',
};

/** Tsunami bulletins in the same colors: a warning is red, an advisory, watch or threat orange. */
const tsunamiAlert = (category: string): DisasterAlert =>
  /warning/i.test(category) ? 'red' : /advisory|watch|threat/i.test(category) ? 'orange' : 'green';

const glyphs: Readonly<Record<Kind, string>> = {
  EQ: '<path d="M7 16h3.5l2-5 3 10 3-8 2 3h4.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  TC: '<circle cx="16" cy="16" r="2.4" fill="#fff"/><path d="M16 8.5c-4.2 0-7.5 3.3-7.5 7.5M16 23.5c4.2 0 7.5-3.3 7.5-7.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  FL: '<path d="M7.5 13.5q2.1-2 4.2 0t4.3 0 4.3 0 4.2 0M7.5 19q2.1-2 4.2 0t4.3 0 4.3 0 4.2 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  VO: '<path d="M7.5 22.5 13 13.5h6l5.5 9z" fill="#fff"/><path d="M14 10.5l2-2.5 2 2.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  DR: '<circle cx="16" cy="16" r="3.6" fill="#fff"/><path d="M16 7.5v2.5M16 22v2.5M7.5 16H10M22 16h2.5M10 10l1.7 1.7M20.3 20.3 22 22M10 22l1.7-1.7M20.3 11.7 22 10" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  WF: '<path d="M16 7.5c.8 3 5 5 5 9.8a5 5 0 0 1-10 0c0-2.8 1.8-3.8 2.2-5.8 1 1.2 1.6 2 2.8 2.3-.9-2-.9-4.1 0-6.3z" fill="#fff"/>',
  TS: '<path d="M7 21c3.2 0 4.3-8.5 9.5-8.5 3 0 4.5 2 4.5 4-1.8-1-4-.2-4 1.8 0 1.4 1.2 2.7 3.5 2.7H25" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

/** A round badge in the alert's color with the event type's glyph. */
const iconCache = new Map<string, string>();
const icon = (kind: Kind, alert: DisasterAlert): string => {
  const key = `${kind}/${alert}`;
  let url = iconCache.get(key);
  if (!url) {
    url = `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13.5" fill="${alertOf.get(alert)?.color}" stroke="rgba(10,12,16,0.85)" stroke-width="2"/>${glyphs[kind]}</svg>`,
    )}`;
    iconCache.set(key, url);
  }
  return url;
};

type Item =
  | {
      readonly source: 'gdacs';
      readonly key: string;
      readonly kind: Kind;
      readonly alert: DisasterAlert;
      readonly event: Disaster;
    }
  | {
      readonly source: 'tsunami';
      readonly key: string;
      readonly kind: 'TS';
      readonly alert: DisasterAlert;
      readonly bulletin: TsunamiBulletin;
    };

const positionOf = (item: Item) => (item.source === 'gdacs' ? item.event : item.bulletin);
const nameOf = (item: Item) =>
  item.source === 'gdacs' ? item.event.name : `Tsunami ${item.bulletin.category.toLowerCase()}`;
const day = (ms: number) => formatUtc(ms).slice(0, 10);

const describeEvent = (e: Disaster, now: number): Details => {
  const extent = boundsOf([...e.areas.flat(), ...e.track]);
  return {
    kind: titleOf.get(e.type) ?? 'Disaster',
    title: e.name,
    ...(e.country ? { subtitle: e.country } : {}),
    fields: [
      { label: 'Alert level', value: meaning[e.alert] },
      ...(e.severity ? [{ label: 'Severity', value: e.severity }] : []),
      ...(e.type === 'EQ'
        ? [{ label: 'Time', value: `${formatAge(now - e.from)} · ${formatUtc(e.from)}` }]
        : [
            { label: 'Since', value: day(e.from) },
            { label: 'Latest update', value: `${formatAge(now - e.to)} · ${day(e.to)}` },
          ]),
      ...(e.track.length > 0 ? [{ label: 'Track', value: 'Observed and forecast' }] : []),
      { label: 'Position', value: formatLatLon(e.lat, e.lon) },
    ],
    links: [{ label: 'GDACS report', href: e.url }],
    ...(extent && (e.areas.length > 0 || e.track.length > 0)
      ? { extent }
      : { position: () => Cartesian3.fromDegrees(e.lon, e.lat, 0) }),
  };
};

const describeBulletin = (b: TsunamiBulletin, now: number): Details => ({
  kind: 'Tsunami bulletin',
  title: `Tsunami ${b.category.toLowerCase()}`,
  subtitle: b.region,
  ...(b.note ? { body: b.note } : {}),
  fields: [
    { label: 'Issued', value: `${formatAge(now - b.issued)} · ${formatUtc(b.issued)}` },
    {
      label: 'Center',
      value: b.center === 'NTWC' ? 'National Tsunami Warning Center' : 'Pacific Tsunami Warning Center',
    },
    ...(b.magnitude ? [{ label: 'Earthquake', value: `M ${b.magnitude}` }] : []),
    { label: 'Epicenter', value: formatLatLon(b.lat, b.lon) },
  ],
  links: [
    { label: 'Bulletin', href: b.url },
    { label: 'tsunami.gov', href: 'https://www.tsunami.gov' },
  ],
  position: () => Cartesian3.fromDegrees(b.lon, b.lat, 0),
});

export const disasterLayer: LayerDef = {
  id: 'disasters',
  title: 'Disaster alerts',
  category: 'hazards',
  description:
    'Current earthquakes, cyclones, floods, eruptions, droughts and wildfires rated by GDACS for their expected humanitarian impact, with cyclone forecast cones and NOAA tsunami bulletins.',
  source: feeds.disasters.source,
  feed: 'disasters',
  defaultVisible: true,
  legend: alerts.map(({ label, color }) => ({ label, color })),
  filters: kinds.map(({ id, label, color }) => ({ id, label, color })),
  create(globe): LayerHandle {
    const badges = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    const shapes = new GroundShapes(globe, 'disasters');
    let events: ReadonlyArray<Disaster> = [];
    let bulletins: ReadonlyArray<TsunamiBulletin> = [];
    let items = new Map<string, { readonly item: Item; readonly badge: Billboard }>();
    let shown: ReadonlySet<string> = new Set(kinds.map((k) => k.id));
    let selected: string | undefined;
    let stops: Array<() => void> = [];

    const scaleOf = (item: Item) =>
      (alertOf.get(item.alert)?.scale ?? 0.62) * (item.key === selected ? 1.3 : 1);

    const draw = () => {
      badges.removeAll();
      items = new Map();
      const all: Item[] = [
        ...events.map((event): Item => ({
          source: 'gdacs',
          key: event.id,
          kind: event.type,
          alert: event.alert,
          event,
        })),
        ...bulletins.map((bulletin): Item => ({
          source: 'tsunami',
          key: `ts:${bulletin.id}`,
          kind: 'TS',
          alert: tsunamiAlert(bulletin.category),
          bulletin,
        })),
      ];
      // Green first, so red and orange draw on top where they overlap.
      const order: Readonly<Record<DisasterAlert, number>> = { green: 0, orange: 1, red: 2 };
      all.sort((a, b) => order[a.alert] - order[b.alert]);
      for (const item of all) {
        const { lon, lat } = positionOf(item);
        const badge = badges.add({
          image: icon(item.kind, item.alert),
          position: Cartesian3.fromDegrees(lon, lat, 0),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          scale: scaleOf(item),
          scaleByDistance: new NearFarScalar(3e5, 1.25, 2e7, 0.7),
          show: shown.has(item.kind),
          id: { layer: 'disasters', key: item.key } satisfies PickId,
        });
        items.set(item.key, { item, badge });
      }
      const areas: Area[] = [];
      const lines: Line[] = [];
      for (const e of events) {
        if (!shown.has(e.type)) continue;
        const color = alertOf.get(e.alert)?.fill ?? Color.WHITE;
        const on = e.id === selected;
        if (e.areas.length > 0)
          areas.push({
            key: e.id,
            polygons: e.areas,
            fill: color.withAlpha(on ? 0.3 : 0.16),
            outline: on ? Color.WHITE : color.withAlpha(0.75),
            width: on ? 2 : 1.2,
          });
        for (const positions of e.track)
          lines.push({ key: e.id, positions, color: on ? Color.WHITE : color.withAlpha(0.9), width: 2 });
      }
      shapes.set(areas, lines);
    };

    const describe = (key: string): Details | undefined => {
      const item = items.get(key)?.item;
      if (!item) return undefined;
      return item.source === 'gdacs'
        ? describeEvent(item.event, globe.now())
        : describeBulletin(item.bulletin, globe.now());
    };

    return {
      setVisible(visible) {
        badges.show = visible;
        shapes.setVisible(visible);
        if (visible && stops.length === 0)
          stops = [
            feedPoller.subscribe('disasters', (snapshot: Snapshot<'disasters'>) => {
              events = snapshot.data.events;
              draw();
            }),
            feedPoller.subscribe('tsunamis', (snapshot: Snapshot<'tsunamis'>) => {
              bulletins = snapshot.data.bulletins;
              draw();
            }),
          ];
        if (!visible && stops.length > 0) {
          for (const stop of stops) stop();
          stops = [];
          events = [];
          bulletins = [];
          badges.removeAll();
          items = new Map();
          shapes.clear();
        }
      },
      setFilter(visible) {
        shown = visible;
        draw();
      },
      details: describe,
      highlight(key) {
        selected = key;
        draw();
        return () => {
          if (selected !== key) return;
          selected = undefined;
          draw();
        };
      },
      search(query, limit) {
        const q = query.trim().toLowerCase();
        const hits: SearchHit[] = [];
        for (const { item } of items.values()) {
          if (hits.length >= limit) break;
          if (!shown.has(item.kind)) continue;
          const name = nameOf(item);
          const where = item.source === 'gdacs' ? item.event.country : item.bulletin.region;
          if (!name.toLowerCase().includes(q) && !where.toLowerCase().includes(q)) continue;
          hits.push({
            layer: 'disasters',
            key: item.key,
            title: name,
            subtitle: [alertOf.get(item.alert)?.label, where].filter(Boolean).join(' · '),
          });
        }
        return hits;
      },
      countIn(bounds) {
        let n = 0;
        for (const { item } of items.values()) {
          const { lon, lat } = positionOf(item);
          if (shown.has(item.kind) && contains(bounds, lon, lat)) n++;
        }
        return n;
      },
      destroy() {
        for (const stop of stops) stop();
        shapes.destroy();
        globe.scene.primitives.remove(badges);
      },
    };
  },
};
