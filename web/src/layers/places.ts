import { Color } from 'cesium';
import { tileBounds } from '../../../src/area.ts';
import { AreaTiles } from '../data/area.ts';
import { fetchJson, wikimediaHeaders } from '../data/fetch.ts';
import {
  articleUrl,
  filePageOf,
  type GeoPage,
  GeoSearchResponse,
  geoSearchUrl,
  PageSummary,
  parseGeoSearch,
  summaryUrl,
  WIKIPEDIA_ZOOM,
} from '../data/wikimedia.ts';
import { formatLatLon } from '../lib/format.ts';
import { around, GroundPins, matching, reachOf, type Tiers } from './pins.ts';
import type { Details, LayerDef, LayerHandle } from './types.ts';

const COLOR = Color.fromCssColorString('#ece4d0');

/**
 * Decluttering by significance: each tile's places come in relevance order,
 * and lower-ranked ones show (and get labels) only nearer the camera.
 */
const dotTiers: Tiers = [
  [40, 80_000],
  [120, 25_000],
  [300, 10_000],
  [500, 4_000],
];
const labelTiers: Tiers = [
  [3, 80_000],
  [10, 25_000],
  [30, 8_000],
  [80, 3_000],
  [200, 1_200],
];

/** GeoData's types for what coordinates mark, as shown in the inspector. */
const typeLabels: Readonly<Record<string, string>> = {
  city: 'City',
  adm1st: 'Region',
  adm2nd: 'District',
  adm3rd: 'Municipality',
  landmark: 'Landmark',
  railwaystation: 'Station',
  airport: 'Airport',
  edu: 'School',
  mountain: 'Mountain',
  pass: 'Mountain pass',
  isle: 'Island',
  waterbody: 'Lake',
  river: 'River',
  glacier: 'Glacier',
  forest: 'Forest',
  event: 'Historic event',
};

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Summary =
  | { readonly state: 'loading' }
  | { readonly state: 'done'; readonly summary: PageSummary }
  | { readonly state: 'error' };

export const placeLayer: LayerDef = {
  id: 'places',
  title: 'Wikipedia places',
  category: 'city',
  description:
    'Places, landmarks and buildings with a Wikipedia article; the most significant are labeled. Select one for its summary.',
  source: { name: 'Wikipedia', url: 'https://en.wikipedia.org', license: 'CC BY-SA 4.0' },
  defaultVisible: true,
  range: { max: 60_000 },
  create(globe): LayerHandle {
    const pins = new GroundPins<GeoPage>(globe, 'places', (page) => ({
      lon: page.lon,
      lat: page.lat,
      color: COLOR,
      size: 9,
      reach: reachOf(dotTiers, page.rank),
      label: { text: shorten(page.title, 32), reach: reachOf(labelTiers, page.rank) },
    }));
    /** Article summaries, fetched when a place is selected. */
    const summaries = new Map<string, Summary>();

    const area = new AreaTiles<GeoPage[]>(globe, {
      zoom: WIKIPEDIA_ZOOM,
      maxTiles: 24,
      ttlMs: 60 * 60_000,
      load: async ({ z, x, y }, signal) =>
        parseGeoSearch(
          await fetchJson(geoSearchUrl('wikipedia', tileBounds(z, x, y)), GeoSearchResponse, {
            signal,
            headers: wikimediaHeaders(),
          }),
        ),
      onChange: (tiles) => {
        const items = new Map<string, GeoPage>();
        for (const { data } of tiles) for (const page of data) items.set(String(page.id), page);
        pins.replace(items);
      },
      onError: (error) => console.warn('Wikipedia places unavailable', error),
    });

    const loadSummary = async (title: string) => {
      if (summaries.has(title)) return;
      summaries.set(title, { state: 'loading' });
      try {
        const summary = await fetchJson(summaryUrl(title), PageSummary, { headers: wikimediaHeaders() });
        summaries.set(title, { state: 'done', summary });
      } catch (error) {
        console.warn('Wikipedia summary unavailable', error);
        summaries.set(title, { state: 'error' });
      }
    };

    const describe = (page: GeoPage): Details => {
      const loaded = summaries.get(page.title);
      const summary = loaded?.state === 'done' ? loaded.summary : undefined;
      const thumbnail = summary?.thumbnail;
      const article = summary?.content_urls?.desktop.page ?? articleUrl(page.title);
      return {
        kind: (page.type && typeLabels[page.type]) || 'Place',
        title: page.title,
        subtitle: summary?.description,
        ...(thumbnail
          ? {
              picture: {
                src: thumbnail.source,
                alt: page.title,
                aspect: thumbnail.width / thumbnail.height,
                href: filePageOf(thumbnail.source) ?? article,
                credit: 'Image: Wikimedia Commons',
              },
            }
          : {}),
        body:
          loaded?.state === 'loading'
            ? 'Loading the article summary…'
            : loaded?.state === 'error'
              ? 'The article summary is unavailable right now.'
              : summary?.extract,
        fields: [{ label: 'Location', value: formatLatLon(page.lat, page.lon) }],
        links: [{ label: 'Wikipedia', href: article }],
        extent: around(page.lon, page.lat, 2_000),
      };
    };

    return {
      setVisible(visible) {
        area.setActive(visible);
        pins.setShow(visible);
        if (!visible) {
          pins.clear();
          summaries.clear();
        }
      },
      details(key) {
        const page = pins.get(key);
        return page ? describe(page) : undefined;
      },
      highlight(key) {
        // Fetched on selection only: hovering asks for details too, and shouldn't cost a request.
        const page = pins.get(key);
        if (page) void loadSummary(page.title);
        return pins.highlight(key);
      },
      countIn: (bounds) => pins.countIn(bounds),
      loaded: pins.changed,
      search(query, limit) {
        return matching(pins.items(), query, limit, ([, page]) => page.title).map(([key, page]) => ({
          layer: 'places',
          key,
          title: page.title,
          subtitle: (page.type && typeLabels[page.type]) || 'Place',
        }));
      },
      destroy() {
        area.destroy();
        pins.destroy();
      },
    };
  },
};
