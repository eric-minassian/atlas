import { Cartesian3, Color } from 'cesium';
import { feeds } from '../../../src/catalog.ts';
import type { BuoyData } from '../../../src/domain.ts';
import {
  formatAge,
  formatBearing,
  formatInt,
  formatLatLon,
  formatNumber,
  formatUtc,
  metersToFeet,
  msToKnots,
} from '../lib/format.ts';
import { feedPoints, type Rows } from './points.ts';
import type { LayerDef } from './types.ts';

/** Significant wave height, meters. */
const waves = [
  { label: 'Under 1 m', color: '#6cc3d5', below: 1 },
  { label: '1–2 m', color: '#4f9de0', below: 2 },
  { label: '2–4 m', color: '#7a72e6', below: 4 },
  { label: '4–6 m', color: '#c26bd6', below: 6 },
  { label: '6 m and up', color: '#ef5a8f', below: Number.POSITIVE_INFINITY },
] as const;
const waveColors = waves.map((w) => Color.fromCssColorString(w.color));
const NO_WAVES = Color.fromCssColorString('#8b919b');

const colorFor = (height: number | null | undefined): Color => {
  if (height === null || height === undefined) return NO_WAVES;
  for (let i = 0; i < waves.length; i++)
    if (height < (waves[i] as (typeof waves)[number]).below) return waveColors[i] as Color;
  return waveColors[waveColors.length - 1] as Color;
};

type BuoyRows = Rows & { readonly data: BuoyData };

const measure = (value: number | null | undefined, format: (v: number) => string) =>
  value === null || value === undefined ? '—' : format(value);

export const buoyLayer: LayerDef = {
  id: 'buoys',
  title: 'Ocean buoys',
  category: 'sea',
  description:
    'Latest readings from moored buoys and coastal stations reporting to NOAA, colored by significant wave height.',
  source: feeds.buoys.source,
  feed: 'buoys',
  defaultVisible: false,
  legend: [
    ...waves.map(({ label, color }) => ({ label, color })),
    { label: 'No wave data', color: '#8b919b' },
  ],
  create(globe) {
    return feedPoints<'buoys', BuoyRows>(globe, {
      layer: 'buoys',
      feed: 'buoys',
      rows: ({ data }) => ({
        data,
        size: data.station.length,
        lon: (i) => data.lon[i] as number,
        lat: (i) => data.lat[i] as number,
      }),
      key: ({ data }, i) => data.station[i] as string,
      style: ({ data }, i) => ({
        color: colorFor(data.waveHeight[i]),
        size: (data.waveHeight[i] ?? null) === null ? 4 : 6,
      }),
      rank: ({ data }, i) => data.waveHeight[i] ?? -1,
      label: ({ data }, i) => {
        const h = data.waveHeight[i];
        return h === null || h === undefined ? undefined : `${formatNumber(h)} m`;
      },
      describe: ({ data }, i) => {
        const time = data.since + (data.observed[i] as number) * 60_000;
        const lat = data.lat[i] as number;
        const lon = data.lon[i] as number;
        const station = data.station[i] as string;
        const name = data.name[i];
        const wind = data.windSpeed[i];
        const gust = data.windGust[i];
        const direction = data.windDirection[i];
        return {
          kind: 'Ocean buoy',
          title: name || `Station ${station}`,
          subtitle: name ? `Station ${station}` : formatLatLon(lat, lon),
          fields: [
            { label: 'Observed', value: `${formatAge(globe.now() - time)} · ${formatUtc(time)}` },
            {
              label: 'Wave height',
              value: measure(
                data.waveHeight[i],
                (h) => `${formatNumber(h)} m · ${formatNumber(metersToFeet(h))} ft`,
              ),
            },
            { label: 'Wave period', value: measure(data.wavePeriod[i], (s) => `${formatInt(s)} s`) },
            { label: 'Waves from', value: measure(data.waveDirection[i], formatBearing) },
            {
              label: 'Wind',
              value:
                wind === null || wind === undefined
                  ? '—'
                  : `${direction === null || direction === undefined ? '' : `From ${formatBearing(direction)} at `}${formatInt(msToKnots(wind))} kt${gust ? `, gusts ${formatInt(msToKnots(gust))} kt` : ''}`,
            },
            { label: 'Pressure', value: measure(data.pressure[i], (p) => `${formatNumber(p)} hPa`) },
            { label: 'Air', value: measure(data.airTemperature[i], (t) => `${formatNumber(t)} °C`) },
            { label: 'Water', value: measure(data.waterTemperature[i], (t) => `${formatNumber(t)} °C`) },
            { label: 'Position', value: formatLatLon(lat, lon) },
          ],
          links: [
            {
              label: 'NDBC station page',
              href: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(station.toLowerCase())}`,
            },
          ],
          position: () => Cartesian3.fromDegrees(lon, lat, 0),
        };
      },
      search: ({ data }, i, q) => {
        const station = data.station[i] as string;
        const name = data.name[i] ?? '';
        if (!station.toLowerCase().startsWith(q) && !name.toLowerCase().includes(q)) return undefined;
        return {
          layer: 'buoys',
          key: station,
          title: name || station,
          subtitle: `Ocean buoy · ${station}`,
        };
      },
    });
  },
};
