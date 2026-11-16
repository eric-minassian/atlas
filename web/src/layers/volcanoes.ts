import { Cartesian3, Color } from 'cesium';
import { feeds } from '../../../src/catalog.ts';
import type { VolcanoData } from '../../../src/domain.ts';
import { formatInt, formatLatLon, metersToFeet } from '../lib/format.ts';
import { feedPoints, type Rows } from './points.ts';
import type { LayerDef } from './types.ts';

const kinds = [
  { label: 'Erupting', color: '#ff4a3a', size: 9 },
  { label: 'Erupted since 1900', color: '#f08a4b', size: 5.5 },
  { label: 'Earlier or unknown', color: '#a97b5f', size: 4 },
] as const;
const kindColors = kinds.map((k) => Color.fromCssColorString(k.color));

type VolcanoRows = Rows & { readonly data: VolcanoData };

const kindOf = (data: VolcanoData, i: number): 0 | 1 | 2 =>
  data.erupting[i] ? 0 : (data.lastEruption[i] ?? Number.NEGATIVE_INFINITY) >= 1900 ? 1 : 2;

/** `-8300` → "8300 BCE"; GVP years are negative before the common era. */
const year = (y: number) => (y < 0 ? `${-y} BCE` : String(y));

/** `2024-12-00` → "December 2024"; GVP leaves unknown days or months as `00`. */
const startOf = (date: string): string => {
  if (date === 'unknown') return 'start unknown';
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (!m) return String(y);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return d ? `${d} ${month} ${y}` : `${month} ${y}`;
};

export const volcanoLayer: LayerDef = {
  id: 'volcanoes',
  title: 'Volcanoes',
  category: 'hazards',
  description:
    'The 1,200 volcanoes active in the past 12,000 years, with eruptions the Smithsonian lists as continuing highlighted.',
  source: feeds.volcanoes.source,
  feed: 'volcanoes',
  defaultVisible: false,
  legend: kinds.map(({ label, color }) => ({ label, color })),
  create(globe) {
    return feedPoints<'volcanoes', VolcanoRows>(globe, {
      layer: 'volcanoes',
      feed: 'volcanoes',
      rows: ({ data }) => ({
        data,
        size: data.number.length,
        lon: (i) => data.lon[i] as number,
        lat: (i) => data.lat[i] as number,
      }),
      key: ({ data }, i) => String(data.number[i]),
      style: ({ data }, i) => {
        const kind = kindOf(data, i);
        return { color: kindColors[kind] as Color, size: kinds[kind].size };
      },
      rank: ({ data }, i) => 2 - kindOf(data, i),
      label: ({ data }, i) => data.name[i],
      describe: ({ data }, i) => {
        const lat = data.lat[i] as number;
        const lon = data.lon[i] as number;
        const number = data.number[i] as number;
        const elevation = data.elevation[i];
        const last = data.lastEruption[i];
        const erupting = data.erupting[i];
        const photo = data.photo[i];
        return {
          kind: 'Volcano',
          title: data.name[i] as string,
          subtitle: [data.type[i], data.country[i]].filter(Boolean).join(' · '),
          ...(photo
            ? {
                picture: {
                  src: `https://volcano.si.edu/gallery/photos/${photo}.jpg`,
                  alt: data.name[i] as string,
                  aspect: 4 / 3,
                  href: `https://volcano.si.edu/volcano.cfm?vn=${number}`,
                  ...(data.photoCredit[i] ? { credit: data.photoCredit[i] } : {}),
                },
              }
            : {}),
          fields: [
            {
              label: 'Activity',
              value: erupting
                ? `Erupting since ${startOf(erupting)}`
                : last === null || last === undefined
                  ? 'No dated eruption'
                  : `Last erupted ${year(last)}`,
            },
            ...(elevation === null || elevation === undefined
              ? []
              : [
                  {
                    label: 'Elevation',
                    value: `${formatInt(elevation)} m · ${formatInt(metersToFeet(elevation))} ft`,
                  },
                ]),
            { label: 'GVP number', value: String(number) },
            { label: 'Position', value: formatLatLon(lat, lon) },
          ],
          links: [
            { label: 'Global Volcanism Program', href: `https://volcano.si.edu/volcano.cfm?vn=${number}` },
          ],
          position: () => Cartesian3.fromDegrees(lon, lat, 0),
        };
      },
      search: ({ data }, i, q) => {
        const name = data.name[i] as string;
        if (!name.toLowerCase().includes(q)) return undefined;
        return {
          layer: 'volcanoes',
          key: String(data.number[i]),
          title: name,
          subtitle: `${data.erupting[i] ? 'Erupting volcano' : 'Volcano'} · ${data.country[i]}`,
        };
      },
    });
  },
};
