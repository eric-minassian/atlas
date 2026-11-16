import { Math as CesiumMath } from 'cesium';

const EARTH_RADIUS = 6_371_000;

/**
 * Where something is after moving `seconds` along `bearing` (degrees from
 * north) at `speed` m/s, on a sphere: plenty for the minutes between reports.
 */
export const advance = (lat: number, lon: number, bearing: number, speed: number, seconds: number) => {
  const d = (speed * seconds) / EARTH_RADIUS;
  const t = CesiumMath.toRadians(bearing);
  const φ = CesiumMath.toRadians(lat);
  const dλ = (d * Math.sin(t)) / Math.max(0.01, Math.cos(φ));
  return {
    lat: lat + CesiumMath.toDegrees(d * Math.cos(t)),
    lon: CesiumMath.toDegrees(CesiumMath.negativePiToPi(CesiumMath.toRadians(lon) + dλ)),
  };
};

export const KNOT = 0.514444;
