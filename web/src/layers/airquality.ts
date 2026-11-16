import { Cartesian3, Color, NearFarScalar } from 'cesium';
import { feeds } from '../../../src/catalog.ts';
import type { AirQualityData } from '../../../src/domain.ts';
import { pm25Band, pm25Bands } from '../lib/airquality.ts';
import { formatAge, formatLatLon, formatNumber, formatUtc } from '../lib/format.ts';
import { feedPoints, type Rows } from './points.ts';
import type { LayerDef } from './types.ts';

const bandColors = pm25Bands.map((b) => Color.fromCssColorString(b.color));

type AirRows = Rows & { readonly data: AirQualityData };

export const airQualityLayer: LayerDef = {
  id: 'air-quality',
  title: 'Air quality sensors',
  category: 'weather',
  description:
    'Fine particulate matter (PM2.5) from about 9,000 outdoor community sensors, averaged over 5 minutes and colored by US EPA health band.',
  source: feeds.airQuality.source,
  feed: 'airQuality',
  defaultVisible: false,
  legend: pm25Bands.map(({ label, color }) => ({ label, color })),
  create(globe) {
    return feedPoints<'airQuality', AirRows>(globe, {
      layer: 'air-quality',
      feed: 'airQuality',
      rows: ({ data }) => ({
        data,
        size: data.sensor.length,
        lon: (i) => data.lon[i] as number,
        lat: (i) => data.lat[i] as number,
      }),
      key: ({ data }, i) => String(data.sensor[i]),
      style: ({ data }, i) => ({ color: bandColors[pm25Band(data.pm25[i] as number)] as Color, size: 4.5 }),
      // Worse air draws on top, so a smoky town isn't hidden under its clean neighbors.
      rank: ({ data }, i) => data.pm25[i] as number,
      scale: new NearFarScalar(2e5, 1.6, 1.2e7, 0.5),
      describe: ({ data }, i) => {
        const time = data.since + (data.observed[i] as number) * 60_000;
        const lat = data.lat[i] as number;
        const lon = data.lon[i] as number;
        const pm25 = data.pm25[i] as number;
        const band = pm25Bands[pm25Band(pm25)];
        return {
          kind: 'Air quality sensor',
          title: `${formatNumber(pm25)} µg/m³ PM2.5`,
          subtitle: band?.label,
          fields: [
            { label: 'PM2.5', value: `${formatNumber(pm25)} µg/m³` },
            { label: 'PM10', value: `${formatNumber(data.pm10[i] as number)} µg/m³` },
            { label: 'Measured', value: `${formatAge(globe.now() - time)} · ${formatUtc(time)}` },
            { label: 'Sensor', value: `${data.model[i]} #${data.sensor[i]}` },
            { label: 'Position', value: formatLatLon(lat, lon) },
          ],
          links: [
            {
              label: 'Sensor.Community map',
              href: `https://maps.sensor.community/#14/${lat.toFixed(4)}/${lon.toFixed(4)}`,
            },
          ],
          position: () => Cartesian3.fromDegrees(lon, lat, 0),
        };
      },
    });
  },
};
