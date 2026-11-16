import { Effect, Schema } from 'effect';
import { wfigsPerimeters } from '../catalog.ts';
import type { FirePerimeter, FirePerimeterData } from '../domain.ts';
import { centerOf, GeoJsonArea, toPolygons } from './geometry.ts';
import { decodeJson, get, okText, round, type Source, updated } from './source.ts';

const FIELDS = [
  'poly_IncidentName',
  'poly_GISAcres',
  'poly_PolygonDateTime',
  'poly_IRWINID',
  'attr_IncidentName',
  'attr_IncidentSize',
  'attr_PercentContained',
  'attr_FireDiscoveryDateTime',
  'attr_FireCause',
  'attr_POOState',
  'attr_POOCounty',
  'attr_IncidentTypeCategory',
  'attr_UniqueFireIdentifier',
  'attr_IrwinID',
  'attr_TotalIncidentPersonnel',
] as const;
const PAGE = 1000;
const MAX_PAGES = 5;
/**
 * The service simplifies on its side (`maxAllowableOffset`, in degrees:
 * ~200 m, about a perimeter's mapping accuracy) and rounds coordinates,
 * which shrinks the response about tenfold; the result is simplified again
 * here to drop vertices that rounding made redundant.
 */
const OFFSET = 0.002;
const queryUrl = (offset: number) =>
  `${wfigsPerimeters}/query?${new URLSearchParams({
    where: '1=1',
    outFields: FIELDS.join(','),
    outSR: '4326',
    maxAllowableOffset: String(OFFSET),
    geometryPrecision: '4',
    orderByFields: 'OBJECTID',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: 'geojson',
  }).toString()}`;

const S = Schema.NullOr(Schema.String);
const N = Schema.NullOr(Schema.Finite);
const Feature = Schema.Struct({
  geometry: Schema.NullOr(GeoJsonArea),
  properties: Schema.Struct({
    poly_IncidentName: S,
    poly_GISAcres: N,
    poly_PolygonDateTime: N,
    poly_IRWINID: S,
    attr_IncidentName: S,
    attr_IncidentSize: N,
    attr_PercentContained: N,
    attr_FireDiscoveryDateTime: N,
    attr_FireCause: S,
    attr_POOState: S,
    attr_POOCounty: S,
    attr_IncidentTypeCategory: S,
    attr_UniqueFireIdentifier: S,
    attr_IrwinID: S,
    attr_TotalIncidentPersonnel: N,
  }),
});
type Feature = typeof Feature.Type;
export const FeatureCollection = Schema.Struct({
  features: Schema.Array(Feature),
  /** Set when a page is full and more remain. */
  exceededTransferLimit: Schema.optionalKey(Schema.Boolean),
  properties: Schema.optionalKey(
    Schema.Struct({ exceededTransferLimit: Schema.optionalKey(Schema.Boolean) }),
  ),
});

/** `{CD72CDA6-…}` → `cd72cda6-…`, the form IRWIN ids take in links. */
const irwin = (value: string | null) => (value ?? '').replace(/[{}]/g, '').toLowerCase();

/** One perimeter per incident: a complex's fires each have their own. Largest first. */
export const parsePerimeters = (features: ReadonlyArray<Feature>): FirePerimeterData => {
  const fires: FirePerimeter[] = [];
  const seen = new Set<string>();
  for (const { geometry, properties: p } of features) {
    if (!geometry) continue;
    const id = irwin(p.attr_IrwinID ?? p.poly_IRWINID) || (p.attr_UniqueFireIdentifier ?? '');
    if (!id || seen.has(id)) continue;
    const polygons = toPolygons(geometry, OFFSET / 2, 4);
    const center = centerOf(polygons);
    if (!center) continue;
    seen.add(id);
    const acres = p.poly_GISAcres ?? p.attr_IncidentSize;
    fires.push({
      id,
      name: (p.attr_IncidentName ?? p.poly_IncidentName ?? 'Unnamed fire').trim(),
      kind: p.attr_IncidentTypeCategory ?? 'WF',
      fireId: p.attr_UniqueFireIdentifier ?? '',
      acres: acres === null ? null : round(acres, 0),
      contained: p.attr_PercentContained,
      discovered: p.attr_FireDiscoveryDateTime,
      mapped: p.poly_PolygonDateTime,
      state: (p.attr_POOState ?? '').replace(/^US-/, ''),
      county: p.attr_POOCounty ?? '',
      cause: p.attr_FireCause,
      personnel: p.attr_TotalIncidentPersonnel === null ? null : Math.round(p.attr_TotalIncidentPersonnel),
      lon: center[0],
      lat: center[1],
      polygons,
    });
  }
  return { fires: fires.toSorted((a, b) => (b.acres ?? 0) - (a.acres ?? 0)) };
};

export const makePerimeterSource = (): Source<'firePerimeters'> => ({
  read: () =>
    Effect.gen(function* () {
      const features: Feature[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const collection = yield* decodeJson(FeatureCollection)(
          yield* okText(yield* get(queryUrl(page * PAGE))),
        );
        features.push(...collection.features);
        const more =
          collection.exceededTransferLimit ?? collection.properties?.exceededTransferLimit ?? false;
        if (!more) break;
        if (page === MAX_PAGES - 1)
          yield* Effect.logWarning('more perimeters than read; publishing the first pages').pipe(
            Effect.annotateLogs({ read: features.length }),
          );
      }
      const data = parsePerimeters(features);
      return updated<'firePerimeters'>(data, data.fires.length);
    }),
});
