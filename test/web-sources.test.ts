import { assert, describe, it } from '@effect/vitest';
import { Schema } from 'effect';
import { tileAt, tileBounds } from '../src/area.ts';
import { biasZoom, PhotonResponse, parsePhoton, photonUrl } from '../web/src/data/places.ts';
import {
  filePageOf,
  fileTitle,
  GeoSearchResponse,
  geoSearchUrl,
  ImageInfoResponse,
  PageSummary,
  parseGeoSearch,
  parseImageInfo,
  textOf,
  WIKIPEDIA_ZOOM,
} from '../web/src/data/wikimedia.ts';
import { fixture } from './support.ts';

// Sources the browser calls directly: their responses are decoded with the same schemas there.
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, name: string) =>
  Schema.decodeSync(Schema.fromJsonString(schema))(fixture(name));

describe('Wikipedia places', () => {
  it('asks GeoSearch for a tile, most significant pages first', () => {
    const { x, y } = tileAt(WIKIPEDIA_ZOOM, -0.1276, 51.5072);
    const b = tileBounds(WIKIPEDIA_ZOOM, x, y);
    const url = new URL(geoSearchUrl('wikipedia', b));
    assert.strictEqual(url.host, 'en.wikipedia.org');
    assert.strictEqual(url.searchParams.get('gsbbox'), `${b.north}|${b.west}|${b.south}|${b.east}`);
    assert.strictEqual(url.searchParams.get('gssort'), 'relevance');
    assert.strictEqual(url.searchParams.get('gslimit'), '500');
    assert.strictEqual(url.searchParams.get('origin'), '*');
    assert.strictEqual(new URL(geoSearchUrl('commons', b)).searchParams.get('gsnamespace'), '6');
  });

  it('ranks pages in the order GeoSearch gave them', () => {
    const pages = parseGeoSearch(decode(GeoSearchResponse, 'wikipedia-geosearch.json'));
    assert.deepStrictEqual(
      pages.map((p) => [p.rank, p.title, p.type]),
      [
        [0, 'London', null],
        [1, 'House of Lords', null],
        [2, 'House of Commons of the United Kingdom', null],
        [3, 'MI6', 'landmark'],
        [4, 'Parliament of the United Kingdom', 'landmark'],
      ],
    );
  });

  it('reports a box GeoSearch refuses', () => {
    const refused = Schema.decodeSync(GeoSearchResponse)({
      error: { code: 'toobig', info: 'Bounding box is too big' },
    });
    assert.throws(() => parseGeoSearch(refused), /too big/);
  });

  it('reads an article summary and links its image to the file page', () => {
    const summary = decode(PageSummary, 'wikipedia-summary.json');
    assert.strictEqual(summary.description, 'Castle in London, England');
    assert.match(summary.extract ?? '', /^The Tower of London/);
    assert.strictEqual(
      filePageOf(summary.thumbnail?.source ?? ''),
      'https://commons.wikimedia.org/wiki/File:Tower_of_London_from_the_Shard_%288515883950%29.jpg',
    );
  });
});

describe('Commons photos', () => {
  it('reads a file’s thumbnail and the author and license its credit needs, as plain text', () => {
    const info = parseImageInfo(decode(ImageInfoResponse, 'commons-imageinfo.json'));
    assert.strictEqual(info?.author, 'Martin Falbisoner');
    assert.strictEqual(info?.license, 'CC BY-SA 3.0');
    assert.strictEqual(info?.description, 'London Eye at Night.');
    assert.strictEqual(info?.taken, '2013-03-26 20:06:33');
    assert.strictEqual(
      info?.page,
      'https://commons.wikimedia.org/wiki/File:London_Eye_at_Night_(long_exposure).JPG',
    );
    assert.deepStrictEqual([info?.thumbnail?.width, info?.thumbnail?.height], [640, 640]);
  });

  it('names a file by its title without the namespace and extension', () => {
    assert.strictEqual(
      fileTitle('File:London Eye at Night (long exposure).JPG'),
      'London Eye at Night (long exposure)',
    );
  });

  it('turns metadata HTML into text', () => {
    assert.strictEqual(
      textOf('<a href="x">Jane &amp; John</a>&#160;<bdi>Doe</bdi> &#x263A; &bogus; &#99999999;'),
      'Jane & John Doe ☺ &bogus; &#99999999;',
    );
  });
});

describe('place search (Photon)', () => {
  it('biases toward the view, less the higher the camera', () => {
    const url = new URL(photonUrl('paris', { lat: 48.8566, lon: 2.3522, zoom: biasZoom(20_000) }));
    assert.strictEqual(url.searchParams.get('q'), 'paris');
    assert.strictEqual(url.searchParams.get('lat'), '48.857');
    assert.strictEqual(url.searchParams.get('zoom'), '13');
    assert.strictEqual(biasZoom(21_000_000), 3);
    assert.isNull(new URL(photonUrl('paris')).searchParams.get('lat'));
  });

  it('reads places with their extent, once each', () => {
    const hits = parsePhoton(decode(PhotonResponse, 'photon-paris.json'));
    // The city and its two administrative boundaries are one place.
    assert.deepStrictEqual(
      hits.map((h) => [h.title, h.subtitle]),
      [
        ['Paris', 'City · Île-de-France, France'],
        ['Paris', 'Hamlet · Suchdol nad Lužnicí, South Bohemian Region, Czechia'],
        ['Paris', 'Hamlet · Brossasco, Piedmont, Italy'],
        ['Paris', 'Hamlet · Norrtälje kommun, Sweden'],
      ],
    );
    assert.deepStrictEqual(hits[0]?.bounds, {
      west: 2.224122,
      north: 48.902156,
      east: 2.4697602,
      south: 48.8155755,
    });
    assert.strictEqual(hits[0]?.height, 25_000);
    assert.isUndefined(hits[1]?.bounds);
  });
});
