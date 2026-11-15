/** SGP4 helpers shared by the satellite layer and its propagation worker. */
import {
  eciToEcf,
  eciToGeodetic,
  gstime,
  json2satrec,
  type OMMJsonObject,
  propagate,
  type SatRec,
} from 'satellite.js';
import type { SatelliteData } from '../../../src/domain.ts';

const EARTH_RADIUS_KM = 6378.137;
const MU = 398600.4418; // km³/s²

export const toOmm = (d: SatelliteData, i: number): OMMJsonObject => ({
  OBJECT_NAME: d.name[i] as string,
  OBJECT_ID: d.objectId[i] as string,
  EPOCH: d.epoch[i] as string,
  MEAN_MOTION: d.meanMotion[i] as number,
  ECCENTRICITY: d.eccentricity[i] as number,
  INCLINATION: d.inclination[i] as number,
  RA_OF_ASC_NODE: d.raan[i] as number,
  ARG_OF_PERICENTER: d.argOfPericenter[i] as number,
  MEAN_ANOMALY: d.meanAnomaly[i] as number,
  NORAD_CAT_ID: d.noradId[i] as number,
  ELEMENT_SET_NO: d.elementSetNo[i] as number,
  REV_AT_EPOCH: d.revAtEpoch[i],
  BSTAR: d.bstar[i] as number,
  MEAN_MOTION_DOT: d.meanMotionDot[i] as number,
  MEAN_MOTION_DDOT: d.meanMotionDdot[i] as number,
});

export const satrecOf = (d: SatelliteData, i: number): SatRec | null => {
  try {
    return json2satrec(toOmm(d, i));
  } catch {
    return null;
  }
};

/** Earth-fixed position in meters at `time`, or undefined where SGP4 fails. */
export const ecfAt = (satrec: SatRec, time: number): { x: number; y: number; z: number } | undefined => {
  const date = new Date(time);
  const pv = propagate(satrec, date);
  if (!pv) return undefined;
  const ecf = eciToEcf(pv.position, gstime(date));
  return { x: ecf.x * 1000, y: ecf.y * 1000, z: ecf.z * 1000 };
};

export interface OrbitState {
  /** km above the ellipsoid */
  readonly altitude: number;
  /** km/s, inertial */
  readonly speed: number;
  readonly lat: number;
  readonly lon: number;
}

export const stateAt = (satrec: SatRec, time: number): OrbitState | undefined => {
  const date = new Date(time);
  const pv = propagate(satrec, date);
  if (!pv) return undefined;
  const geo = eciToGeodetic(pv.position, gstime(date));
  const v = pv.velocity;
  return {
    altitude: geo.height,
    speed: Math.hypot(v.x, v.y, v.z),
    lat: (geo.latitude * 180) / Math.PI,
    lon: (geo.longitude * 180) / Math.PI,
  };
};

/** Period (min), perigee and apogee (km above the equatorial radius) from mean elements. */
export const orbitShape = (meanMotion: number, eccentricity: number) => {
  const n = (meanMotion * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU / (n * n));
  return {
    period: 1440 / meanMotion,
    perigee: a * (1 - eccentricity) - EARTH_RADIUS_KM,
    apogee: a * (1 + eccentricity) - EARTH_RADIUS_KM,
  };
};

/**
 * One revolution as Earth-fixed points (meters), every point rotated with the
 * Earth's orientation at `time`: the closed ellipse a viewer expects, rather
 * than the spiral the ground moving underneath would give.
 */
export const orbitPath = (satrec: SatRec, time: number, meanMotion: number, samples = 180): number[] => {
  const period = (1440 / meanMotion) * 60_000;
  const gmst = gstime(new Date(time));
  const out: number[] = [];
  for (let k = 0; k <= samples; k++) {
    const pv = propagate(satrec, new Date(time + (period * k) / samples));
    if (!pv) continue;
    const ecf = eciToEcf(pv.position, gmst);
    out.push(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000);
  }
  return out;
};
