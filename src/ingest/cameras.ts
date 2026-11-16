import { Effect, Option, Result, Schema } from 'effect';
import type { HttpClient } from 'effect/http';
import type { CameraData, CameraOperator } from '../domain.ts';
import { type Columns, decodeJson, get, IngestError, okText, round, type Source, updated } from './source.ts';

/**
 * Traffic cameras that publish a still frame, from the agencies that run them
 * (TfL, NYC DOT, Caltrans) and, for other US states, from OpenTrafficCamMap's
 * community-maintained list. Only the list is stored: browsers load each frame
 * from its operator when someone opens the camera.
 */

/** Operators in snapshot order (a camera's `operator` indexes this); ids start with the key. */
const operatorKeys = ['tfl', 'nyc', 'caltrans', 'ohio', 'trimarc', 'indiana', 'arizona'] as const;
type OperatorKey = (typeof operatorKeys)[number];

const viaOtcm = (name: string) => `${name}, via OpenTrafficCamMap`;

export const operators: { readonly [K in OperatorKey]: CameraOperator } = {
  // TfL's open data terms ask for this wording.
  tfl: {
    name: 'Transport for London',
    url: 'https://tfl.gov.uk/traffic/status/',
    credit: 'Powered by TfL Open Data',
  },
  nyc: { name: 'NYC DOT', url: 'https://webcams.nyctmc.org/map', credit: 'NYC DOT' },
  caltrans: { name: 'Caltrans', url: 'https://quickmap.dot.ca.gov/', credit: 'Caltrans' },
  ohio: { name: 'Ohio DOT', url: 'https://www.ohgo.com/', credit: viaOtcm('Ohio DOT') },
  trimarc: { name: 'TRIMARC (Kentucky)', url: 'https://www.trimarc.org/', credit: viaOtcm('TRIMARC') },
  indiana: { name: 'Indiana DOT', url: 'https://511in.org/', credit: viaOtcm('Indiana DOT') },
  arizona: { name: 'Arizona DOT', url: 'https://www.az511.gov/', credit: viaOtcm('Arizona DOT') },
};

const TFL_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
const NYC_URL = 'https://webcams.nyctmc.org/api/cameras';
const caltransUrl = (district: number) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
const CALTRANS_DISTRICTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const OTCM_URL = 'https://raw.githubusercontent.com/AidanWelch/OpenTrafficCamMap/master/cameras/USA.json';

/**
 * OpenTrafficCamMap still images kept, by where they're served (host and path,
 * without the scheme). Its other still-image hosts were checked and left out:
 * Colorado's frames stopped updating in 2024–25, most of Alaska's ids answer
 * with a "no live feed" placeholder, and California's cameras come from
 * Caltrans directly. Its video-only (HLS) cameras can't be shown as a picture.
 */
const otcmOperators: ReadonlyArray<readonly [prefix: string, operator: OperatorKey]> = [
  ['itscameras.dot.state.oh.us/', 'ohio'],
  ['www.trimarc.org/', 'trimarc'],
  ['public.carsprogram.org/cameras/IN/', 'indiana'],
  ['az511.gov/', 'arizona'],
];

/** One camera before it goes into the columnar snapshot. */
export interface Camera {
  readonly id: string;
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
  readonly view: string;
  readonly image: string;
}

/**
 * A camera, or undefined when it has no usable position or image URL. The URL
 * is normalized (`:443` dropped, spaces escaped) so duplicates across lists match.
 */
const camera = (
  operator: OperatorKey,
  nativeId: string,
  fields: { name: string; lon: number; lat: number; view?: string | undefined; image: string },
): Camera | undefined => {
  const { lon, lat } = fields;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return undefined;
  if (lon === 0 && lat === 0) return undefined;
  let image: URL;
  try {
    image = new URL(fields.image.trim());
  } catch {
    return undefined;
  }
  if (image.protocol !== 'https:' && image.protocol !== 'http:') return undefined;
  return {
    id: `${operator}-${nativeId}`,
    name: fields.name.trim() || 'Traffic camera',
    lon: round(lon, 5),
    lat: round(lat, 5),
    view: fields.view?.trim() ?? '',
    image: image.href,
  };
};

const operatorOf = (id: string): OperatorKey | undefined => {
  const key = id.slice(0, id.indexOf('-'));
  return (operatorKeys as ReadonlyArray<string>).includes(key) ? (key as OperatorKey) : undefined;
};

/** FNV-1a: a short, stable id for cameras whose list gives them none. */
const hashOf = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// ---------------------------------------------------------------------------
// TfL JamCams
// ---------------------------------------------------------------------------

const TflPlace = Schema.Struct({
  id: Schema.String,
  commonName: Schema.String,
  lat: Schema.Finite,
  lon: Schema.Finite,
  additionalProperties: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
});
export const TflPlaces = Schema.Array(TflPlace);

/** JamCams marked available; each frame is a JPEG refreshed every few minutes. */
export const parseTfl = (places: typeof TflPlaces.Type): Camera[] =>
  places.flatMap((place) => {
    const props = new Map(place.additionalProperties.map((p) => [p.key, p.value]));
    const image = props.get('imageUrl');
    if (props.get('available') !== 'true' || !image) return [];
    return (
      camera('tfl', place.id.replace(/^JamCams_/, ''), {
        name: place.commonName,
        lon: place.lon,
        lat: place.lat,
        view: props.get('view'),
        image,
      }) ?? []
    );
  });

// ---------------------------------------------------------------------------
// NYC DOT
// ---------------------------------------------------------------------------

const NycCamera = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  latitude: Schema.Finite,
  longitude: Schema.Finite,
  isOnline: Schema.Union([Schema.String, Schema.Boolean]),
  imageUrl: Schema.String,
});
export const NycCameras = Schema.Array(NycCamera);

export const parseNyc = (cameras: typeof NycCameras.Type): Camera[] =>
  cameras.flatMap((c) =>
    String(c.isOnline) === 'true'
      ? (camera('nyc', c.id, { name: c.name, lon: c.longitude, lat: c.latitude, image: c.imageUrl }) ?? [])
      : [],
  );

// ---------------------------------------------------------------------------
// Caltrans
// ---------------------------------------------------------------------------

export const CaltransFile = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cctv: Schema.Struct({
        location: Schema.Struct({
          district: Schema.String,
          locationName: Schema.String,
          latitude: Schema.String,
          longitude: Schema.String,
          direction: Schema.optionalKey(Schema.String),
        }),
        inService: Schema.String,
        imageData: Schema.Struct({
          static: Schema.Struct({ currentImageURL: Schema.optionalKey(Schema.String) }),
        }),
      }),
    }),
  ),
});

/**
 * Cameras in service. Each frame lives at `…/image/<slug>/<slug>.jpg`; the slug
 * is unique within a district, so it makes the id.
 */
export const parseCaltrans = (file: typeof CaltransFile.Type): Camera[] =>
  file.data.flatMap(({ cctv }) => {
    const image = cctv.imageData.static.currentImageURL;
    if (cctv.inService !== 'true' || !image) return [];
    const slug = image.split('/').at(-2);
    if (!slug) return [];
    return (
      camera('caltrans', `${cctv.location.district}-${slug}`, {
        name: cctv.location.locationName,
        lon: Number(cctv.location.longitude),
        lat: Number(cctv.location.latitude),
        view: cctv.location.direction,
        image,
      }) ?? []
    );
  });

// ---------------------------------------------------------------------------
// OpenTrafficCamMap
// ---------------------------------------------------------------------------

const OtcmCamera = Schema.Struct({
  description: Schema.String,
  latitude: Schema.Finite,
  longitude: Schema.Finite,
  direction: Schema.optionalKey(Schema.String),
  url: Schema.String,
  /** `JPEG` for still images; `H.264` for HLS streams. */
  encoding: Schema.String,
});
/** State → county → cameras. */
export const OtcmFile = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Array(OtcmCamera)));

export const parseOtcm = (file: typeof OtcmFile.Type): Camera[] => {
  const out: Camera[] = [];
  for (const counties of Object.values(file))
    for (const cameras of Object.values(counties))
      for (const c of cameras) {
        if (c.encoding !== 'JPEG') continue;
        let where: string;
        try {
          const url = new URL(c.url);
          where = `${url.host}${url.pathname}`;
        } catch {
          continue;
        }
        const operator = otcmOperators.find(([prefix]) => where.startsWith(prefix))?.[1];
        if (!operator) continue;
        const made = camera(operator, hashOf(where), {
          name: c.description,
          lon: c.longitude,
          lat: c.latitude,
          view: c.direction,
          image: c.url,
        });
        if (made) out.push(made);
      }
  return out;
};

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * Cameras into the columnar payload, first occurrence winning: a camera is
 * dropped when its id or its image URL was already seen (lists overlap, and
 * OpenTrafficCamMap lists some border cameras under two states).
 */
export const assemble = (cameras: Iterable<Camera>): CameraData => {
  const out: Columns<CameraData> = {
    operators: operatorKeys.map((key) => operators[key]),
    id: [],
    name: [],
    lon: [],
    lat: [],
    operator: [],
    view: [],
    image: [],
    relayed: [],
  };
  const ids = new Set<string>();
  const images = new Set<string>();
  for (const c of cameras) {
    const operator = operatorOf(c.id);
    if (operator === undefined || ids.has(c.id) || images.has(c.image)) continue;
    ids.add(c.id);
    images.add(c.image);
    out.id.push(c.id);
    out.name.push(c.name);
    out.lon.push(c.lon);
    out.lat.push(c.lat);
    out.operator.push(operatorKeys.indexOf(operator));
    out.view.push(c.view);
    out.image.push(c.image);
    // An HTTPS page can't show a plain-HTTP image, so these go through the API's relay.
    out.relayed.push(c.image.startsWith('http:'));
  }
  return out;
};

/** The cameras in a published payload whose ids start with one of `prefixes`. */
const carryOver = (data: CameraData, prefixes: ReadonlyArray<string>): Camera[] => {
  const out: Camera[] = [];
  for (let i = 0; i < data.id.length; i++) {
    const id = data.id[i] as string;
    if (!prefixes.some((p) => id.startsWith(p))) continue;
    out.push({
      id,
      name: data.name[i] as string,
      lon: data.lon[i] as number,
      lat: data.lat[i] as number,
      view: data.view[i] as string,
      image: data.image[i] as string,
    });
  }
  return out;
};

/** One upstream list. When it fails, its cameras are carried over from the previous snapshot. */
interface Part {
  readonly name: string;
  /** The ids of the cameras it lists start with one of these. */
  readonly prefixes: ReadonlyArray<string>;
  readonly read: Effect.Effect<Camera[], IngestError, HttpClient.HttpClient>;
}

const fetchJson = <S extends Schema.Top>(url: string, schema: S) =>
  get(url).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(schema)));

const parts: ReadonlyArray<Part> = [
  { name: 'TfL', prefixes: ['tfl-'], read: Effect.map(fetchJson(TFL_URL, TflPlaces), parseTfl) },
  { name: 'NYC DOT', prefixes: ['nyc-'], read: Effect.map(fetchJson(NYC_URL, NycCameras), parseNyc) },
  ...CALTRANS_DISTRICTS.map((d): Part => ({
    name: `Caltrans D${d}`,
    prefixes: [`caltrans-${d}-`],
    read: Effect.map(fetchJson(caltransUrl(d), CaltransFile), parseCaltrans),
  })),
  {
    name: 'OpenTrafficCamMap',
    prefixes: otcmOperators.map(([, operator]) => `${operator}-`),
    read: Effect.map(fetchJson(OTCM_URL, OtcmFile), parseOtcm),
  },
];

export const makeCameraSource = (): Source<'cameras'> => ({
  read: (_validators, previous) =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        parts,
        (part) => Effect.map(Effect.result(part.read), (result) => ({ part, result })),
        { concurrency: 4 },
      );
      const cameras: Camera[] = [];
      const failed: Array<{ readonly part: Part; readonly error: string }> = [];
      for (const { part, result } of results) {
        if (Result.isSuccess(result)) cameras.push(...result.success);
        else failed.push({ part, error: `${part.name}: ${result.failure.message}` });
      }
      if (failed.length === parts.length)
        return yield* new IngestError({ message: `every camera list failed (${failed[0]?.error})` });
      if (failed.length > 0) {
        // Keep the cameras of a list that failed this time rather than drop them for an hour.
        const kept = Option.match(yield* previous, {
          onNone: (): Camera[] => [],
          onSome: (data) =>
            carryOver(
              data,
              failed.flatMap((f) => f.part.prefixes),
            ),
        });
        cameras.push(...kept);
        yield* Effect.logWarning('camera lists failed; kept their previous cameras').pipe(
          Effect.annotateLogs({ kept: kept.length, errors: failed.map((f) => f.error).join(' | ') }),
        );
      }
      const data = assemble(cameras);
      return updated<'cameras'>(data, data.id.length);
    }),
});
