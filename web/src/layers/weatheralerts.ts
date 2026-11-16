import { Color } from 'cesium';
import { type Bounds, overlaps } from '../../../src/area.ts';
import { feeds } from '../../../src/catalog.ts';
import type { Polygon, WeatherAlert, WeatherAlertData } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import { formatAge, formatUtc } from '../lib/format.ts';
import { type Area, boundsOf, GroundShapes, ringsOf } from './areas.ts';
import type { Details, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

/**
 * Hazard groups, matched against the event name in order (so "Winter Storm"
 * is winter, not wind). They're also the layer's filters.
 */
const groups: ReadonlyArray<Filter & { readonly match: RegExp }> = [
  {
    id: 'tropical',
    label: 'Tropical',
    color: '#ff5fa2',
    match: /hurricane(?! force)|tropical|typhoon|storm surge/i,
  },
  {
    id: 'convective',
    label: 'Tornado and thunderstorm',
    color: '#e5484d',
    match: /tornado|thunderstorm|extreme wind|special marine/i,
  },
  { id: 'flood', label: 'Flood', color: '#3fbf7f', match: /flood|hydrologic/i },
  {
    id: 'winter',
    label: 'Winter',
    color: '#8fb0ff',
    match: /winter|blizzard|snow|ice|freez|frost|chill|cold|sleet/i,
  },
  { id: 'fire', label: 'Fire weather', color: '#f07b3f', match: /red flag|fire/i },
  { id: 'heat', label: 'Heat', color: '#f2b13a', match: /heat/i },
  { id: 'wind', label: 'Wind', color: '#d6a35a', match: /wind|gale|storm|dust/i },
  {
    id: 'marine',
    label: 'Marine and coastal',
    color: '#5cc6d6',
    match: /small craft|seas|surf|rip current|beach|marine|low water/i,
  },
  { id: 'other', label: 'Other', color: '#b8bec8', match: /./ },
];
const colorOf = new Map(groups.map((g) => [g.id, Color.fromCssColorString(g.color)]));
const groupOf = (event: string): string => groups.find((g) => g.match.test(event))?.id ?? 'other';

/** Fill opacity by severity: the most severe alerts stand out from the advisories under them. */
const fillAlpha: Readonly<Record<WeatherAlert['severity'], number>> = {
  Extreme: 0.5,
  Severe: 0.38,
  Moderate: 0.26,
  Minor: 0.16,
  Unknown: 0.16,
};

/** NWS text: hard-wrapped lines inside paragraphs, blank lines between them. Rejoined, for a narrow panel. */
const reflow = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');

interface Drawn {
  readonly alert: WeatherAlert;
  readonly group: string;
  readonly polygons: ReadonlyArray<Polygon>;
  readonly bounds: Bounds | undefined;
}

/** The alert's own outline, or its zones'. */
const polygonsOf = (alert: WeatherAlert, data: WeatherAlertData): ReadonlyArray<Polygon> =>
  alert.polygons.length > 0 ? alert.polygons : alert.zones.flatMap((id) => data.zones[id] ?? []);

/** Description and instructions, fetched from NWS when an alert is selected (the snapshot leaves them out). */
type Text =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly text: string };
const texts = new Map<string, Text>();
const loadText = (id: string) => {
  if (texts.has(id)) return;
  texts.set(id, { state: 'loading' });
  void (async () => {
    try {
      const response = await fetch(`https://api.weather.gov/alerts/${encodeURIComponent(id)}`, {
        headers: { accept: 'application/geo+json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        properties?: { description?: unknown; instruction?: unknown };
      };
      const description = typeof body.properties?.description === 'string' ? body.properties.description : '';
      const instruction = typeof body.properties?.instruction === 'string' ? body.properties.instruction : '';
      texts.set(id, {
        state: 'ready',
        text: [description, instruction].map(reflow).filter(Boolean).join('\n\n'),
      });
    } catch {
      texts.set(id, { state: 'failed' });
    }
  })();
};

export const weatherAlertLayer: LayerDef = {
  id: 'weather-alerts',
  title: 'US weather alerts',
  category: 'weather',
  description:
    'National Weather Service warnings, watches and advisories in effect, drawn over the areas they cover. Stronger fill means a more severe alert.',
  source: feeds.weatherAlerts.source,
  feed: 'weatherAlerts',
  defaultVisible: true,
  filters: groups.map(({ id, label, color }) => ({ id, label, color })),
  create(globe): LayerHandle {
    const shapes = new GroundShapes(globe, 'weather-alerts');
    let drawn: ReadonlyArray<Drawn> = [];
    let byId = new Map<string, Drawn>();
    let shown: ReadonlySet<string> = new Set(groups.map((g) => g.id));
    let selected: string | undefined;
    let unsubscribe: (() => void) | undefined;

    const draw = () => {
      const areas: Area[] = [];
      // Least severe first, so warnings draw over the advisories they overlap.
      for (let i = drawn.length - 1; i >= 0; i--) {
        const d = drawn[i] as Drawn;
        if (!shown.has(d.group) || d.polygons.length === 0) continue;
        const color = colorOf.get(d.group) as Color;
        const on = d.alert.id === selected;
        const strong = d.alert.severity === 'Extreme' || d.alert.severity === 'Severe';
        areas.push({
          key: d.alert.id,
          polygons: d.polygons,
          fill: color.withAlpha(on ? 0.55 : fillAlpha[d.alert.severity]),
          outline: on ? Color.WHITE : color.withAlpha(strong ? 0.95 : 0.7),
          width: on ? 2.5 : strong ? 1.8 : 1,
        });
      }
      shapes.set(areas);
    };

    const render = (snapshot: Snapshot<'weatherAlerts'>) => {
      const data = snapshot.data;
      drawn = data.alerts.map((alert) => {
        const polygons = polygonsOf(alert, data);
        return { alert, group: groupOf(alert.event), polygons, bounds: boundsOf(ringsOf(polygons)) };
      });
      byId = new Map(drawn.map((d) => [d.alert.id, d]));
      draw();
    };

    const describe = (id: string): Details | undefined => {
      const d = byId.get(id);
      if (!d) return undefined;
      const a = d.alert;
      loadText(a.id);
      const text = texts.get(a.id);
      const now = globe.now();
      const when = (label: string, t: number | null) =>
        t === null
          ? []
          : [
              {
                label,
                value: `${t < now ? formatAge(now - t) : `in ${formatAge(t - now).replace(' ago', '')}`} · ${formatUtc(t)}`,
              },
            ];
      const center = d.bounds
        ? { lat: (d.bounds.south + d.bounds.north) / 2, lon: (d.bounds.west + d.bounds.east) / 2 }
        : undefined;
      return {
        kind: 'Weather alert',
        title: a.event,
        subtitle: a.area,
        body: [
          a.headline ?? '',
          text?.state === 'ready'
            ? text.text
            : text?.state === 'failed'
              ? 'The full text is unavailable right now.'
              : 'Loading the full text…',
        ]
          .filter(Boolean)
          .join('\n\n'),
        fields: [
          { label: 'Severity', value: a.severity },
          ...when('Onset', a.onset),
          ...when('Expires', a.expires),
          ...when('Ends', a.ends),
          ...when('Issued', a.sent),
          { label: 'Issued by', value: a.sender },
          ...(d.polygons.length === 0 ? [{ label: 'Area', value: 'Outline still loading' }] : []),
        ],
        links: center
          ? [
              {
                label: 'NWS forecast and hazards',
                href: `https://forecast.weather.gov/MapClick.php?lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}`,
              },
            ]
          : [{ label: 'NWS alerts', href: 'https://www.weather.gov/alerts' }],
        ...(d.bounds ? { extent: d.bounds } : {}),
      };
    };

    return {
      setVisible(visible) {
        shapes.setVisible(visible);
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('weatherAlerts', render);
        if (!visible && unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
          shapes.clear();
          drawn = [];
          byId = new Map();
        }
      },
      setFilter(visible) {
        shown = visible;
        draw();
      },
      details: describe,
      highlight(id) {
        selected = id;
        draw();
        return () => {
          if (selected !== id) return;
          selected = undefined;
          draw();
        };
      },
      search(query, limit) {
        const q = query.trim().toLowerCase();
        const hits: SearchHit[] = [];
        for (const d of drawn) {
          if (hits.length >= limit) break;
          if (!shown.has(d.group)) continue;
          const a = d.alert;
          if (
            a.event.toLowerCase().includes(q) ||
            a.area.toLowerCase().includes(q) ||
            a.headline?.toLowerCase().includes(q)
          )
            hits.push({ layer: 'weather-alerts', key: a.id, title: a.event, subtitle: a.area });
        }
        return hits;
      },
      countIn(bounds) {
        let n = 0;
        for (const d of drawn) if (shown.has(d.group) && d.bounds && overlaps(bounds, d.bounds)) n++;
        return n;
      },
      destroy() {
        unsubscribe?.();
        shapes.destroy();
      },
    };
  },
};
