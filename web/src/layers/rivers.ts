import { Cartesian3, Color, NearFarScalar } from 'cesium';
import { feeds } from '../../../src/catalog.ts';
import type { FloodWarning, GaugeCountry, GaugeData, GaugeStatus, RiverData } from '../../../src/domain.ts';
import { formatAge, formatLatLon, formatNumber, formatUtc } from '../lib/format.ts';
import { feedPoints, type Rows } from './points.ts';
import type { Details, Filter, LayerDef, Link } from './types.ts';

/** Statuses, most severe first; also the layer's filters. */
const statuses: ReadonlyArray<Filter & { readonly id: GaugeStatus; readonly size: number }> = [
  { id: 'major', label: 'Major flooding', color: '#b04ad6', size: 9 },
  { id: 'moderate', label: 'Moderate flooding', color: '#e5484d', size: 8 },
  { id: 'minor', label: 'Minor flooding', color: '#f39a3a', size: 7 },
  { id: 'action', label: 'Near flood stage', color: '#e2cf3f', size: 6 },
  { id: 'high', label: 'Above normal', color: '#5fb7e8', size: 5 },
  { id: 'normal', label: 'Normal', color: '#3aa76d', size: 4 },
  { id: 'low', label: 'Low', color: '#b5895a', size: 4 },
  { id: 'unknown', label: 'No flood levels', color: '#8b919b', size: 3.5 },
];
interface StatusStyle {
  readonly label: string;
  readonly size: number;
  /** 0 for the most severe. */
  readonly rank: number;
  readonly fill: Color;
}
const byStatus = new Map<GaugeStatus, StatusStyle>(
  statuses.map((s, rank) => [
    s.id,
    { label: s.label, size: s.size, rank, fill: Color.fromCssColorString(s.color) },
  ]),
);
const UNKNOWN: StatusStyle = { label: 'No flood levels', size: 3.5, rank: statuses.length, fill: Color.GRAY };
const styleOf = (status: GaugeStatus): StatusStyle => byStatus.get(status) ?? UNKNOWN;

/** England's warning levels, drawn in the flooding colors. */
const warningLevels: Readonly<Record<number, { readonly label: string; readonly status: GaugeStatus }>> = {
  1: { label: 'Severe flood warning', status: 'major' },
  2: { label: 'Flood warning', status: 'moderate' },
  3: { label: 'Flood alert', status: 'minor' },
};

const agencies: Readonly<Record<GaugeCountry, string>> = {
  US: 'National Weather Service',
  GB: 'Environment Agency',
  DE: 'Wasserstraßen- und Schifffahrtsverwaltung',
};

interface Item {
  readonly country: GaugeCountry;
  readonly gauges: GaugeData;
  readonly index: number;
}

type RiverRows = Rows & {
  readonly items: ReadonlyArray<Item>;
  readonly warnings: ReadonlyArray<FloodWarning>;
};

const toRows = (data: RiverData): RiverRows => {
  const items: Item[] = [];
  for (const { country, gauges } of data.countries)
    for (let index = 0; index < gauges.id.length; index++) items.push({ country, gauges, index });
  const warnings = data.warnings;
  const gauge = (i: number) => items[i] as Item;
  const warning = (i: number) => warnings[i - items.length] as FloodWarning;
  return {
    items,
    warnings,
    size: items.length + warnings.length,
    lon: (i) => (i < items.length ? (gauge(i).gauges.lon[gauge(i).index] as number) : warning(i).lon),
    lat: (i) => (i < items.length ? (gauge(i).gauges.lat[gauge(i).index] as number) : warning(i).lat),
  };
};

const statusOf = (rows: RiverRows, i: number): GaugeStatus => {
  const item = rows.items[i];
  if (item) return item.gauges.status[item.index] as GaugeStatus;
  const w = rows.warnings[i - rows.items.length];
  return warningLevels[w?.level ?? 3]?.status ?? 'minor';
};

const gaugeLinks = (country: GaugeCountry, id: string): Link[] => {
  if (country === 'US')
    return [{ label: 'NWPS hydrograph', href: `https://water.noaa.gov/gauges/${id.toLowerCase()}` }];
  if (country === 'DE')
    return [
      {
        label: 'Pegelonline',
        href: `https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=${encodeURIComponent(id)}`,
      },
    ];
  // The public flood site numbers stations differently from the API; only those ids link there.
  return /^\d+$/.test(id)
    ? [{ label: 'Check for flooding', href: `https://check-for-flooding.service.gov.uk/station/${id}` }]
    : [];
};

const describeGauge = (item: Item, now: number): Details => {
  const { gauges: g, index: i, country } = item;
  const time = g.since + (g.observed[i] as number) * 60_000;
  const lat = g.lat[i] as number;
  const lon = g.lon[i] as number;
  const unit = g.unit[i] as string;
  const threshold = g.threshold[i];
  const status = styleOf(g.status[i] as GaugeStatus);
  return {
    kind: 'River gauge',
    title: g.name[i] as string,
    subtitle: [g.river[i], status.label].filter(Boolean).join(' · '),
    fields: [
      { label: 'Level', value: `${formatNumber(g.value[i] as number, 2)} ${unit}` },
      { label: 'Status', value: status.label },
      ...(threshold === null || threshold === undefined
        ? []
        : [
            {
              label: country === 'US' ? 'Flood stage' : 'Top of normal range',
              value: `${formatNumber(threshold, 2)} ${unit}`,
            },
          ]),
      { label: 'Measured', value: `${formatAge(now - time)} · ${formatUtc(time)}` },
      { label: 'Agency', value: agencies[country] },
      { label: 'Gauge', value: g.id[i] as string },
      { label: 'Position', value: formatLatLon(lat, lon) },
    ],
    links: gaugeLinks(country, g.id[i] as string),
    position: () => Cartesian3.fromDegrees(lon, lat, 0),
  };
};

const describeWarning = (w: FloodWarning, now: number): Details => ({
  kind: warningLevels[w.level]?.label ?? 'Flood warning',
  title: w.area || w.id,
  ...(w.county ? { subtitle: w.county } : {}),
  ...(w.message ? { body: w.message } : {}),
  fields: [
    ...(w.changed
      ? [{ label: 'Updated', value: `${formatAge(now - w.changed)} · ${formatUtc(w.changed)}` }]
      : []),
    { label: 'Area code', value: w.id },
    { label: 'Issued by', value: agencies.GB },
  ],
  links: [
    {
      label: 'Check for flooding',
      href: `https://check-for-flooding.service.gov.uk/target-area/${encodeURIComponent(w.id)}`,
    },
  ],
  position: () => Cartesian3.fromDegrees(w.lon, w.lat, 0),
});

export const riverLayer: LayerDef = {
  id: 'rivers',
  title: 'River gauges',
  category: 'hazards',
  description:
    'Latest river levels from gauges in the US, England and Germany, colored by flood status where the agency defines one, with England’s flood warnings.',
  source: feeds.rivers.source,
  feed: 'rivers',
  defaultVisible: false,
  // 13,000 gauges are a carpet of dots at globe scale; they read from a country's size down.
  range: { max: 5_000_000 },
  filters: statuses.map(({ id, label, color }) => ({ id, label, color })),
  create(globe) {
    return feedPoints<'rivers', RiverRows>(globe, {
      layer: 'rivers',
      feed: 'rivers',
      rows: ({ data }) => toRows(data),
      key: (rows, i) => {
        const item = rows.items[i];
        return item
          ? `${item.country}:${item.gauges.id[item.index]}`
          : `warning:${rows.warnings[i - rows.items.length]?.id}`;
      },
      style: (rows, i) => {
        const s = styleOf(statusOf(rows, i));
        // Warnings cover an area: drawn larger than the gauges around them.
        return { color: s.fill, size: i >= rows.items.length ? s.size + 4 : s.size };
      },
      rank: (rows, i) => -styleOf(statusOf(rows, i)).rank + (i >= rows.items.length ? 0.5 : 0),
      filter: statusOf,
      scale: new NearFarScalar(1e5, 1.6, 5e6, 0.7),
      describe: (rows, i) => {
        const item = rows.items[i];
        const now = globe.now();
        return item
          ? describeGauge(item, now)
          : describeWarning(rows.warnings[i - rows.items.length] as FloodWarning, now);
      },
      search: (rows, i, q) => {
        const item = rows.items[i];
        if (item) {
          const { gauges: g, index } = item;
          const name = g.name[index] as string;
          const river = g.river[index] as string;
          const id = g.id[index] as string;
          if (!name.toLowerCase().includes(q) && !river.toLowerCase().includes(q) && id.toLowerCase() !== q)
            return undefined;
          return {
            layer: 'rivers',
            key: `${item.country}:${id}`,
            title: name,
            subtitle: ['River gauge', river].filter(Boolean).join(' · '),
          };
        }
        const w = rows.warnings[i - rows.items.length];
        if (!w || !w.area.toLowerCase().includes(q)) return undefined;
        return {
          layer: 'rivers',
          key: `warning:${w.id}`,
          title: w.area,
          subtitle: warningLevels[w.level]?.label ?? 'Flood warning',
        };
      },
    });
  },
};
