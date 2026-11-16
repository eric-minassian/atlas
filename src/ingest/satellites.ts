import { Effect, Schema } from 'effect';
import type { SatelliteData, SatelliteGroup } from '../domain.ts';
import { type Columns, decodeJson, get, notModified, okText, type Source, updated } from './source.ts';

const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';

/** One CelesTrak GP record (CCSDS OMM keywords). Extra keys are ignored. */
const Omm = Schema.Struct({
  OBJECT_NAME: Schema.String,
  OBJECT_ID: Schema.String,
  EPOCH: Schema.String,
  MEAN_MOTION: Schema.Finite,
  ECCENTRICITY: Schema.Finite,
  INCLINATION: Schema.Finite,
  RA_OF_ASC_NODE: Schema.Finite,
  ARG_OF_PERICENTER: Schema.Finite,
  MEAN_ANOMALY: Schema.Finite,
  NORAD_CAT_ID: Schema.Int,
  ELEMENT_SET_NO: Schema.Int,
  REV_AT_EPOCH: Schema.Int,
  BSTAR: Schema.Finite,
  MEAN_MOTION_DOT: Schema.Finite,
  MEAN_MOTION_DDOT: Schema.Finite,
});
type Omm = typeof Omm.Type;

const groups: ReadonlyArray<readonly [SatelliteGroup, RegExp]> = [
  ['station', /^(ISS|CSS) \(|^(SOYUZ-MS|PROGRESS-MS|CREW DRAGON|DRAGON|SHENZHOU|TIANZHOU|CYGNUS)\b/],
  ['starlink', /^STARLINK/],
  ['oneweb', /^ONEWEB/],
  ['kuiper', /^KUIPER/],
  ['gnss', /^(GPS |NAVSTAR|GLONASS|GALILEO|GSAT0|BEIDOU|QZS|IRNSS|NAVIC)/],
  [
    'weather',
    /^(NOAA |NOAA-|GOES|METEOSAT|METOP|HIMAWARI|FENGYUN|FY-|ELEKTRO|INSAT-3D|DMSP|SUOMI NPP|JPSS|GEO-KOMPSAT-2A|ARKTIKA-M|METEOR-M)/,
  ],
  [
    'earth',
    /^(LANDSAT|SENTINEL|TERRA|AQUA|AURA|WORLDVIEW|PLEIADES|SPOT|RADARSAT|ICESAT|GRACE|SWOT|CALIPSO|CLOUDSAT|JASON|SMAP|OCO|SKYSAT|FLOCK|DOVE|LEMUR|GAOFEN|ZIYUAN|CARTOSAT|RESURS|KOMPSAT|TANDEM|TERRASAR|COSMO-SKYMED|ICEYE|CAPELLA|PRISMA|NUSAT|PACE|NISAR)/,
  ],
];

/**
 * Sorts a satellite into a group by name, then by orbit: GLONASS satellites
 * are named `COSMOS nnnn`, so navigation orbits (12-hour period, inclined
 * ~55-65°) count as GNSS too.
 */
export const groupOf = (omm: Pick<Omm, 'OBJECT_NAME' | 'MEAN_MOTION' | 'INCLINATION'>): SatelliteGroup => {
  for (const [group, pattern] of groups) if (pattern.test(omm.OBJECT_NAME)) return group;
  if (omm.MEAN_MOTION > 1.7 && omm.MEAN_MOTION < 2.3 && omm.INCLINATION > 50 && omm.INCLINATION < 70)
    return 'gnss';
  return 'other';
};

export const parseGp = (records: ReadonlyArray<Omm>): SatelliteData => {
  const out: Columns<SatelliteData> = {
    name: [],
    noradId: [],
    objectId: [],
    group: [],
    epoch: [],
    meanMotion: [],
    eccentricity: [],
    inclination: [],
    raan: [],
    argOfPericenter: [],
    meanAnomaly: [],
    bstar: [],
    meanMotionDot: [],
    meanMotionDdot: [],
    elementSetNo: [],
    revAtEpoch: [],
  };
  for (const r of records) {
    out.name.push(r.OBJECT_NAME);
    out.noradId.push(r.NORAD_CAT_ID);
    out.objectId.push(r.OBJECT_ID);
    out.group.push(groupOf(r));
    out.epoch.push(r.EPOCH);
    out.meanMotion.push(r.MEAN_MOTION);
    out.eccentricity.push(r.ECCENTRICITY);
    out.inclination.push(r.INCLINATION);
    out.raan.push(r.RA_OF_ASC_NODE);
    out.argOfPericenter.push(r.ARG_OF_PERICENTER);
    out.meanAnomaly.push(r.MEAN_ANOMALY);
    out.bstar.push(r.BSTAR);
    out.meanMotionDot.push(r.MEAN_MOTION_DOT);
    out.meanMotionDdot.push(r.MEAN_MOTION_DDOT);
    out.elementSetNo.push(r.ELEMENT_SET_NO);
    out.revAtEpoch.push(r.REV_AT_EPOCH);
  }
  return out;
};

/** CelesTrak answers a repeat download within its two-hour update cycle with a 403 saying so. */
const NOT_UPDATED = /has not updated since your last successful\s+download/i;

/** Every active satellite's latest elements, from CelesTrak. */
export const makeSatelliteSource = (): Source<'satellites'> => ({
  read: (validators) =>
    Effect.gen(function* () {
      const response = yield* get(GP_URL, { validators });
      if (response.status === 304) return notModified;
      if (response.status === 403) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
        if (NOT_UPDATED.test(text)) return notModified;
      }
      const records = yield* decodeJson(Schema.Array(Omm))(yield* okText(response));
      return updated<'satellites'>(parseGp(records), records.length, response);
    }),
});
