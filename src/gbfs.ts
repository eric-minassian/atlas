/**
 * GBFS (General Bikeshare Feed Specification) documents, versions 1.0–3.0, as
 * schemas: the parts Atlas reads to locate bike-share systems and report their
 * stations. Extra keys are ignored. https://github.com/MobilityData/gbfs
 */
import { Schema } from 'effect';

const FeedList = Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String }));

/** `gbfs.json`: the system's feeds, per language before 3.0. */
export const Discovery = Schema.Struct({
  data: Schema.Union([
    Schema.Struct({ feeds: FeedList }),
    Schema.Record(Schema.String, Schema.Struct({ feeds: FeedList })),
  ]),
});
export type Discovery = typeof Discovery.Type;

/** The feed URLs a discovery document lists, by name; English where there's a choice of language. */
export const feedUrls = (discovery: Discovery): ReadonlyMap<string, string> => {
  const { data } = discovery;
  let list: typeof FeedList.Type = [];
  if ('feeds' in data && Array.isArray(data.feeds)) list = data.feeds;
  else {
    const byLanguage = data as Readonly<Record<string, { readonly feeds: typeof FeedList.Type }>>;
    const languages = Object.keys(byLanguage);
    const language =
      languages.find((l) => l === 'en') ?? languages.find((l) => l.startsWith('en')) ?? languages[0];
    list = language === undefined ? [] : (byLanguage[language]?.feeds ?? []);
  }
  return new Map(list.map((f) => [f.name, f.url]));
};

/** Some systems publish coordinates as strings. */
const Coordinate = Schema.Union([Schema.Finite, Schema.FiniteFromString]);
/** Ids are strings, though some older feeds use numbers. */
const Id = Schema.Union([Schema.String, Schema.Finite]);
/** A plain name before 3.0; one per language from 3.0. */
const Name = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ text: Schema.String, language: Schema.String })),
]);
const Count = Schema.optionalKey(Schema.Finite);
/** `true`/`false`, or `1`/`0` before 2.0. */
const Flag = Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Finite]));

export const StationInformation = Schema.Struct({
  data: Schema.Struct({
    stations: Schema.Array(
      Schema.Struct({
        station_id: Id,
        name: Schema.optionalKey(Name),
        lat: Coordinate,
        lon: Coordinate,
        capacity: Count,
        /** A marked spot rather than a dock (free-floating fleets' parking areas); from 2.1. */
        is_virtual_station: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
});
export type StationInformation = typeof StationInformation.Type;

export const StationStatus = Schema.Struct({
  data: Schema.Struct({
    stations: Schema.Array(
      Schema.Struct({
        station_id: Id,
        /** Before 3.0. */
        num_bikes_available: Count,
        /** From 3.0. */
        num_vehicles_available: Count,
        /** A Lyft (Motivate) extension. */
        num_ebikes_available: Count,
        num_docks_available: Count,
        is_installed: Flag,
        is_renting: Flag,
        is_returning: Flag,
        /** Epoch seconds before 3.0, RFC 3339 from 3.0. */
        last_reported: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
        /** From 2.1. */
        vehicle_types_available: Schema.optionalKey(
          Schema.Array(Schema.Struct({ vehicle_type_id: Id, count: Schema.Finite })),
        ),
        /** Smovengo's (Vélib') extension: `[{ mechanical: n }, { ebike: n }]`. */
        num_bikes_available_types: Schema.optionalKey(
          Schema.Array(Schema.Record(Schema.String, Schema.Finite)),
        ),
      }),
    ),
  }),
});
export type StationStatus = typeof StationStatus.Type;

export const VehicleTypes = Schema.Struct({
  data: Schema.Struct({
    vehicle_types: Schema.Array(
      Schema.Struct({
        vehicle_type_id: Id,
        form_factor: Schema.optionalKey(Schema.String),
        propulsion_type: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
});
export type VehicleTypes = typeof VehicleTypes.Type;

/** A station's name, in English where there's a choice. */
export const nameOf = (name: typeof Name.Type | undefined): string => {
  if (name === undefined) return '';
  if (typeof name === 'string') return name;
  return (name.find((n) => n.language.startsWith('en')) ?? name[0])?.text ?? '';
};

export const flag = (value: boolean | number | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : value === true || value === 1;

type Station = StationInformation['data']['stations'][number];

/** A dock someone can walk up to, not a free-floating fleet's parking area. */
export const isPhysical = (station: Station): boolean => station.is_virtual_station !== true;

const isBicycle = (formFactor: string | undefined) =>
  formFactor === undefined || formFactor === 'bicycle' || formFactor === 'cargo_bicycle';

/** Whether a system has bicycles at all (some GBFS systems are car share or scooters only). */
export const hasBicycles = (types: VehicleTypes): boolean =>
  types.data.vehicle_types.length === 0 || types.data.vehicle_types.some((t) => isBicycle(t.form_factor));

/** Bicycle types (mixed systems also list cars or scooters), as ids. */
export const bicycleTypes = (types: VehicleTypes | undefined): ReadonlySet<string> | undefined =>
  types && types.data.vehicle_types.length > 0
    ? new Set(
        types.data.vehicle_types
          .filter((t) => isBicycle(t.form_factor))
          .map((t) => String(t.vehicle_type_id)),
      )
    : undefined;

/** Electric bicycles (pedal-assisted or not) among a system's vehicle types. */
export const electricBikeTypes = (types: VehicleTypes | undefined): ReadonlySet<string> =>
  new Set(
    (types?.data.vehicle_types ?? [])
      .filter(
        (t) =>
          (t.propulsion_type === 'electric_assist' || t.propulsion_type === 'electric') &&
          isBicycle(t.form_factor),
      )
      .map((t) => String(t.vehicle_type_id)),
  );
