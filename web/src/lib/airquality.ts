/**
 * PM2.5 health bands: the US EPA's 24-hour breakpoints (2024 revision), in
 * µg/m³. Readings here are 5-minute averages, so a band is a guide to the
 * moment, not a daily index.
 */
export const pm25Bands = [
  { label: 'Good', color: '#3fbf5f', below: 9.1 },
  { label: 'Moderate', color: '#e2cf3f', below: 35.5 },
  { label: 'Unhealthy for sensitive groups', color: '#f39a3a', below: 55.5 },
  { label: 'Unhealthy', color: '#e5484d', below: 125.5 },
  { label: 'Very unhealthy', color: '#9b59c6', below: 225.5 },
  { label: 'Hazardous', color: '#8e2a45', below: Number.POSITIVE_INFINITY },
] as const;

export const pm25Band = (value: number): number => {
  for (let i = 0; i < pm25Bands.length; i++)
    if (value < (pm25Bands[i] as (typeof pm25Bands)[number]).below) return i;
  return pm25Bands.length - 1;
};

/** The US AQI's categories, by index value. */
const aqiCategories = [
  { below: 51, label: 'Good' },
  { below: 101, label: 'Moderate' },
  { below: 151, label: 'Unhealthy for sensitive groups' },
  { below: 201, label: 'Unhealthy' },
  { below: 301, label: 'Very unhealthy' },
  { below: Number.POSITIVE_INFINITY, label: 'Hazardous' },
] as const;

export const describeAqi = (aqi: number): string =>
  aqiCategories.find((c) => aqi < c.below)?.label ?? 'Hazardous';
