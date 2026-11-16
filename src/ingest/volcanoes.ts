import { Effect, Schema } from 'effect';
import type { VolcanoData } from '../domain.ts';
import { type Columns, decodeJson, get, okText, round, type Source, updated } from './source.ts';

const WFS =
  'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json';
const VOLCANOES_URL = `${WFS}&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&propertyName=${[
  'Volcano_Number',
  'Volcano_Name',
  'Primary_Volcano_Type',
  'Last_Eruption_Year',
  'Country',
  'Elevation',
  'Primary_Photo_Link',
  'Primary_Photo_Credit',
  'GeoLocation',
].join(',')}`;
/** Eruptions since 1960 that GVP lists as continuing (its weekly-updated current eruptions). */
const ERUPTING_URL = `${WFS}&typeName=GVP-VOTW:E3WebApp_Eruptions1960&CQL_FILTER=${encodeURIComponent("ContinuingEruption='True'")}`;

const Volcano = Schema.Struct({
  geometry: Schema.Struct({ coordinates: Schema.Array(Schema.Finite) }),
  properties: Schema.Struct({
    Volcano_Number: Schema.Int,
    Volcano_Name: Schema.String,
    Primary_Volcano_Type: Schema.NullOr(Schema.String),
    Last_Eruption_Year: Schema.NullOr(Schema.Int),
    Country: Schema.NullOr(Schema.String),
    Elevation: Schema.NullOr(Schema.Finite),
    Primary_Photo_Link: Schema.optionalKey(Schema.NullOr(Schema.String)),
    Primary_Photo_Credit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});
export const Volcanoes = Schema.Struct({ features: Schema.Array(Volcano) });
type Volcanoes = typeof Volcanoes.Type;

const Eruption = Schema.Struct({
  properties: Schema.Struct({
    VolcanoNumber: Schema.Int,
    /** `YYYYMMDD`; month or day `00` when unknown. */
    StartDate: Schema.NullOr(Schema.String),
    ContinuingEruption: Schema.String,
  }),
});
export const Eruptions = Schema.Struct({ features: Schema.Array(Eruption) });
type Eruptions = typeof Eruptions.Type;

/** `GVP-01511` from `https://volcano.si.edu/gallery/photos/GVP-01511.jpg`. */
const photoId = (link: string | null | undefined) => /\/([\w-]+)\.jpg$/i.exec(link ?? '')?.[1] ?? '';

/** Volcanoes with their continuing eruptions marked; `erupting` is the eruption's start date. */
export const parseVolcanoes = (volcanoes: Volcanoes, eruptions: Eruptions): VolcanoData => {
  const erupting = new Map<number, string>();
  for (const { properties: e } of eruptions.features) {
    if (e.ContinuingEruption !== 'True') continue;
    const d = e.StartDate ?? '';
    const start = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : 'unknown';
    // A volcano with overlapping eruptions keeps the earliest start.
    const earlier = erupting.get(e.VolcanoNumber);
    if (!earlier || (start !== 'unknown' && start < earlier)) erupting.set(e.VolcanoNumber, start);
  }
  const out: Columns<VolcanoData> = {
    number: [],
    name: [],
    type: [],
    country: [],
    lon: [],
    lat: [],
    elevation: [],
    lastEruption: [],
    erupting: [],
    photo: [],
    photoCredit: [],
  };
  for (const { geometry, properties: v } of volcanoes.features) {
    const [lon, lat] = geometry.coordinates;
    if (lon === undefined || lat === undefined) continue;
    const photo = photoId(v.Primary_Photo_Link);
    out.number.push(v.Volcano_Number);
    out.name.push(v.Volcano_Name);
    out.type.push(v.Primary_Volcano_Type ?? '');
    out.country.push(v.Country ?? '');
    out.lon.push(round(lon, 4));
    out.lat.push(round(lat, 4));
    out.elevation.push(v.Elevation);
    out.lastEruption.push(v.Last_Eruption_Year);
    out.erupting.push(erupting.get(v.Volcano_Number) ?? '');
    out.photo.push(photo);
    out.photoCredit.push(photo ? (v.Primary_Photo_Credit ?? '').trim() : '');
  }
  return out;
};

export const makeVolcanoSource = (): Source<'volcanoes'> => ({
  read: () =>
    Effect.gen(function* () {
      const [volcanoes, eruptions] = yield* Effect.all(
        [
          get(VOLCANOES_URL).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(Volcanoes))),
          get(ERUPTING_URL).pipe(Effect.flatMap(okText), Effect.flatMap(decodeJson(Eruptions))),
        ],
        { concurrency: 2 },
      );
      const data = parseVolcanoes(volcanoes, eruptions);
      return updated<'volcanoes'>(data, data.number.length);
    }),
});
