/**
 * Wikipedia and Wikimedia Commons, called straight from the browser: their
 * APIs allow any origin and need no key. Responses are decoded with these
 * schemas; this module has no DOM or Cesium imports so tests can run it.
 */
import { Schema } from 'effect';
import type { Bounds } from '../../../src/area.ts';

/**
 * GeoData caps a bounding box at about 20 x 20 km (larger ones answer
 * `toobig`), and a search at 500 results: zoom-11 tiles (~20 km at the
 * equator, smaller toward the poles) fit everywhere.
 */
export const WIKIPEDIA_ZOOM = 11;
/** Photos are dense: zoom-12 tiles (~10 km at the equator), 500 each. */
export const COMMONS_ZOOM = 12;

export const GeoSearchResponse = Schema.Struct({
  query: Schema.optionalKey(
    Schema.Struct({
      geosearch: Schema.Array(
        Schema.Struct({
          pageid: Schema.Finite,
          title: Schema.String,
          lat: Schema.Finite,
          lon: Schema.Finite,
          type: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, info: Schema.String })),
});

/** A page with coordinates: a Wikipedia article, or a Commons file. */
export interface GeoPage {
  readonly id: number;
  readonly title: string;
  readonly lat: number;
  readonly lon: number;
  /** GeoData's type for what the coordinates mark (`city`, `landmark`, `railwaystation`, …). */
  readonly type: string | null;
  /** Place in the search's relevance order, 0 the most significant: labels go to the first few. */
  readonly rank: number;
}

/**
 * The GeoSearch URL for a tile. Sorted by relevance (CirrusSearch's measure of
 * how linked and visited a page is), so when a dense tile has more than 500
 * the ones kept are the significant ones rather than those nearest its center.
 */
export const geoSearchUrl = (site: 'wikipedia' | 'commons', b: Bounds): string => {
  const host = site === 'wikipedia' ? 'en.wikipedia.org' : 'commons.wikimedia.org';
  const params = new URLSearchParams({
    action: 'query',
    list: 'geosearch',
    gsbbox: `${b.north}|${b.west}|${b.south}|${b.east}`,
    gslimit: '500',
    gssort: 'relevance',
    gsprop: 'type',
    gsnamespace: site === 'wikipedia' ? '0' : '6',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  return `https://${host}/w/api.php?${params}`;
};

export const parseGeoSearch = (response: typeof GeoSearchResponse.Type): GeoPage[] => {
  if (response.error) throw new Error(`GeoSearch: ${response.error.info}`);
  return (response.query?.geosearch ?? []).map((p, rank) => ({
    id: p.pageid,
    title: p.title,
    lat: p.lat,
    lon: p.lon,
    type: p.type ?? null,
    rank,
  }));
};

// ---------------------------------------------------------------------------
// Wikipedia article summaries
// ---------------------------------------------------------------------------

export const PageSummary = Schema.Struct({
  title: Schema.String,
  /** A short description ("Castle in London, England"). */
  description: Schema.optionalKey(Schema.String),
  extract: Schema.optionalKey(Schema.String),
  thumbnail: Schema.optionalKey(
    Schema.Struct({ source: Schema.String, width: Schema.Finite, height: Schema.Finite }),
  ),
  content_urls: Schema.optionalKey(Schema.Struct({ desktop: Schema.Struct({ page: Schema.String }) })),
});
export type PageSummary = typeof PageSummary.Type;

export const summaryUrl = (title: string): string =>
  `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`;

export const articleUrl = (title: string): string =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;

/**
 * The file page of a Wikimedia thumbnail (`…/commons/thumb/e/ec/<file>/330px-…`),
 * where its author and license are: the image's credit links there.
 */
export const filePageOf = (thumbnail: string): string | undefined => {
  const match = /\/wikipedia\/(commons|en)\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)\//.exec(thumbnail);
  if (!match) return undefined;
  const host = match[1] === 'commons' ? 'commons.wikimedia.org' : 'en.wikipedia.org';
  return `https://${host}/wiki/File:${match[2]}`;
};

// ---------------------------------------------------------------------------
// Commons files
// ---------------------------------------------------------------------------

const MetaValue = Schema.Struct({ value: Schema.Union([Schema.String, Schema.Finite]) });

export const ImageInfoResponse = Schema.Struct({
  query: Schema.optionalKey(
    Schema.Struct({
      pages: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          imageinfo: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                thumburl: Schema.optionalKey(Schema.String),
                thumbwidth: Schema.optionalKey(Schema.Finite),
                thumbheight: Schema.optionalKey(Schema.Finite),
                descriptionurl: Schema.String,
                extmetadata: Schema.optionalKey(Schema.Record(Schema.String, MetaValue)),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
});

/** A Commons photo, with what its credit needs. */
export interface PhotoInfo {
  readonly thumbnail: { readonly url: string; readonly width: number; readonly height: number } | null;
  /** The file page: author, license, full resolution. */
  readonly page: string;
  readonly author: string | null;
  readonly license: string | null;
  readonly description: string | null;
  /** As the uploader recorded it (`2013-03-26 20:06:33`, or just a year). */
  readonly taken: string | null;
}

/** Asks for one file's 640 px thumbnail and the metadata its credit needs. */
export const imageInfoUrl = (title: string): string =>
  `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: 'query',
    prop: 'imageinfo',
    titles: title,
    iiprop: 'url|extmetadata',
    iiurlwidth: '640',
    iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription|DateTimeOriginal',
    format: 'json',
    formatversion: '2',
    origin: '*',
  })}`;

export const parseImageInfo = (response: typeof ImageInfoResponse.Type): PhotoInfo | undefined => {
  const info = response.query?.pages[0]?.imageinfo?.[0];
  if (!info) return undefined;
  const meta = (key: string) => {
    const value = info.extmetadata?.[key]?.value;
    const text = value === undefined ? '' : textOf(String(value));
    return text || null;
  };
  return {
    thumbnail:
      info.thumburl && info.thumbwidth && info.thumbheight
        ? { url: info.thumburl, width: info.thumbwidth, height: info.thumbheight }
        : null,
    page: info.descriptionurl,
    author: meta('Artist'),
    license: meta('LicenseShortName'),
    description: meta('ImageDescription'),
    taken: meta('DateTimeOriginal'),
  };
};

/** `File:Big Ben at sunset - 2014-10-27.jpg` → `Big Ben at sunset - 2014-10-27`. */
export const fileTitle = (title: string): string =>
  title.replace(/^File:/, '').replace(/\.[a-z0-9]{2,5}$/i, '');

const entities: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeEntity = (whole: string, code: string): string => {
  const point = /^#x/i.test(code)
    ? Number.parseInt(code.slice(2), 16)
    : code.startsWith('#')
      ? Number(code.slice(1))
      : undefined;
  if (point === undefined) return entities[code.toLowerCase()] ?? whole;
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
};

/** Plain text of the small HTML snippets Commons metadata comes as (links, `<bdi>`, entities). */
export const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim();
