import { Cartesian3, Color } from 'cesium';
import { feeds } from '../../../src/catalog.ts';
import type { MetarData } from '../../../src/domain.ts';
import { formatAge, formatBearing, formatInt, formatLatLon, formatNumber, formatUtc } from '../lib/format.ts';
import { feedPoints, type Rows } from './points.ts';
import type { LayerDef } from './types.ts';

/** Air temperature, °C: a cold-to-hot ramp in 10° steps. */
export const temperatureBands = [
  { label: 'Below −20 °C', color: '#8a6be0', below: -20 },
  { label: '−20 to −10', color: '#4f7fe0', below: -10 },
  { label: '−10 to 0', color: '#5fb4e6', below: 0 },
  { label: '0 to 10', color: '#6fd0a8', below: 10 },
  { label: '10 to 20', color: '#d6d36a', below: 20 },
  { label: '20 to 30', color: '#f0a04b', below: 30 },
  { label: '30 °C and above', color: '#e5544b', below: Number.POSITIVE_INFINITY },
] as const;
const bandColors = temperatureBands.map((b) => Color.fromCssColorString(b.color));
const NO_READING = Color.fromCssColorString('#8b919b');

export const temperatureColor = (celsius: number | null | undefined): Color => {
  if (celsius === null || celsius === undefined) return NO_READING;
  for (let i = 0; i < temperatureBands.length; i++)
    if (celsius < (temperatureBands[i] as (typeof temperatureBands)[number]).below)
      return bandColors[i] as Color;
  return bandColors[bandColors.length - 1] as Color;
};

const categories: Readonly<Record<string, string>> = {
  VFR: 'VFR (visual)',
  MVFR: 'Marginal VFR',
  IFR: 'IFR (instrument)',
  LIFR: 'Low IFR',
};

const INHG_TO_HPA = 33.8639;

type MetarRows = Rows & { readonly data: MetarData };

const describeWind = (data: MetarData, i: number): string => {
  const speed = data.windSpeed[i];
  if (speed === null || speed === undefined) return '—';
  if (speed === 0) return 'Calm';
  const direction = data.windDirection[i];
  const gust = data.windGust[i];
  return `${direction === null || direction === undefined ? 'Variable' : `From ${formatBearing(direction)}`} at ${formatInt(speed)} kt${gust ? `, gusts ${formatInt(gust)} kt` : ''}`;
};

export const metarLayer: LayerDef = {
  id: 'weather-stations',
  title: 'Weather stations',
  category: 'weather',
  description:
    'Latest observations from about 5,000 airport weather stations (METAR), colored by air temperature. Temperatures label the stations up close.',
  source: feeds.metars.source,
  feed: 'metars',
  defaultVisible: false,
  legend: temperatureBands.map(({ label, color }) => ({ label, color })),
  create(globe) {
    return feedPoints<'metars', MetarRows>(globe, {
      layer: 'weather-stations',
      feed: 'metars',
      rows: ({ data }) => ({
        data,
        size: data.station.length,
        lon: (i) => data.lon[i] as number,
        lat: (i) => data.lat[i] as number,
      }),
      key: ({ data }, i) => data.station[i] as string,
      style: ({ data }, i) => ({ color: temperatureColor(data.temperature[i]), size: 5 }),
      label: ({ data }, i) => {
        const t = data.temperature[i];
        return t === null || t === undefined ? undefined : `${formatInt(t)}°`;
      },
      describe: ({ data }, i) => {
        const time = data.since + (data.observed[i] as number) * 60_000;
        const lat = data.lat[i] as number;
        const lon = data.lon[i] as number;
        const station = data.station[i] as string;
        const t = data.temperature[i];
        const dew = data.dewpoint[i];
        const altimeter = data.altimeter[i];
        const visibility = data.visibility[i];
        const category = data.flightCategory[i];
        const weather = data.weather[i];
        return {
          kind: 'Weather station',
          title: station,
          subtitle: [
            t === null || t === undefined ? undefined : `${formatNumber(t)} °C`,
            category ? categories[category] : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
          body: data.raw[i] || undefined,
          fields: [
            { label: 'Observed', value: `${formatAge(globe.now() - time)} · ${formatUtc(time)}` },
            { label: 'Temperature', value: t === null || t === undefined ? '—' : `${formatNumber(t)} °C` },
            {
              label: 'Dew point',
              value: dew === null || dew === undefined ? '—' : `${formatNumber(dew)} °C`,
            },
            { label: 'Wind', value: describeWind(data, i) },
            { label: 'Visibility', value: visibility ? `${visibility} mi` : '—' },
            {
              label: 'Altimeter',
              value:
                altimeter === null || altimeter === undefined
                  ? '—'
                  : `${altimeter.toFixed(2)} inHg · ${formatInt(altimeter * INHG_TO_HPA)} hPa`,
            },
            ...(category ? [{ label: 'Flight category', value: categories[category] ?? category }] : []),
            ...(weather ? [{ label: 'Weather', value: weather }] : []),
            { label: 'Position', value: formatLatLon(lat, lon) },
          ],
          links: [
            {
              label: 'Aviation Weather Center',
              href: `https://aviationweather.gov/data/metar/?id=${encodeURIComponent(station)}&hours=24&decoded=yes`,
            },
          ],
          position: () => Cartesian3.fromDegrees(lon, lat, 0),
        };
      },
      search: ({ data }, i, q) => {
        const station = data.station[i] as string;
        if (!station.toLowerCase().startsWith(q)) return undefined;
        const t = data.temperature[i];
        return {
          layer: 'weather-stations',
          key: station,
          title: station,
          subtitle: `Weather station${t === null || t === undefined ? '' : ` · ${formatNumber(t)} °C`}`,
        };
      },
    });
  },
};
