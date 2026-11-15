const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const formatInt = (n: number): string => integer.format(n);
export const formatNumber = (n: number, digits = 1): string =>
  digits === 1 ? oneDecimal.format(n) : n.toFixed(digits);

/** "now", "45 s ago", "12 min ago", "3 h ago", "2 d ago". */
export const formatAge = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

export const formatUtc = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export const formatLatLon = (lat: number, lon: number): string =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export const formatBearing = (degrees: number): string =>
  `${Math.round(degrees)}° ${compass[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]}`;

export const metersToFeet = (m: number): number => m * 3.28084;
export const msToKnots = (ms: number): number => ms * 1.943844;
