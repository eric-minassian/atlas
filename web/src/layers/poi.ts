import type { VectorTileLayer } from '@mapbox/vector-tile';
import { Cartesian3 } from 'cesium';
import { nameOf, osmElement } from '../data/vectortiles.ts';
import type { Details, Field, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';
import { type Candidate, type Extract, toLonLat, VectorLabels } from './vectorlabels.ts';

/** OpenMapTiles POI classes, grouped into what a visitor would look for. */
const groups: ReadonlyArray<Filter & { readonly classes: ReadonlyArray<string> }> = [
  {
    id: 'food',
    label: 'Food and drink',
    color: '#ffa25c',
    classes: ['restaurant', 'cafe', 'fast_food', 'bar', 'beer', 'ice_cream', 'bakery'],
  },
  {
    id: 'shops',
    label: 'Shops',
    color: '#63b3ff',
    classes: [
      'shop',
      'grocery',
      'clothing_store',
      'alcohol_shop',
      'convenience',
      'hairdresser',
      'jewelry',
      'music',
      'furniture',
      'florist',
      'bag',
      'harbor',
      'laundry',
      'car',
      'golf',
    ],
  },
  {
    id: 'sights',
    label: 'Sights and culture',
    color: '#c896ff',
    classes: [
      'attraction',
      'museum',
      'art_gallery',
      'castle',
      'monument',
      'theatre',
      'cinema',
      'library',
      'place_of_worship',
      'religion',
      'town_hall',
      'zoo',
      'aquarium',
    ],
  },
  {
    id: 'transport',
    label: 'Transport',
    color: '#a9bdd2',
    classes: [
      'bus',
      'railway',
      'ferry_terminal',
      'airport',
      'aerialway',
      'bicycle_rental',
      'parking',
      'fuel',
      'car_rental',
      'entrance',
    ],
  },
  {
    id: 'health',
    label: 'Health',
    color: '#ff7676',
    classes: ['hospital', 'pharmacy', 'doctors', 'dentist', 'veterinary'],
  },
  { id: 'lodging', label: 'Lodging', color: '#f3c652', classes: ['lodging', 'campsite'] },
  {
    id: 'outdoors',
    label: 'Parks and sport',
    color: '#82d68d',
    classes: ['park', 'playground', 'stadium', 'swimming', 'sports', 'pitch', 'garden', 'golf_course'],
  },
  { id: 'other', label: 'Other', color: '#cfd6df', classes: [] },
];
const groupOf = new Map(groups.flatMap((g) => g.classes.map((c) => [c, g])));
const other = groups[groups.length - 1] as (typeof groups)[number];

/** Above this camera height only the most important points of interest are named. */
const ALL_BELOW = 1_200;

/** The most specific type a point of interest carries (`subclass`, else `class`). */
const kindOf = (props: Readonly<Record<string, unknown>>): string => {
  const value = props.subclass ?? props.class;
  return typeof value === 'string' && value !== '' ? value : 'place';
};

const humanize = (value: string) => value.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Tags worth showing from the full OSM element, in order. */
const tagFields: ReadonlyArray<readonly [string, string]> = [
  ['opening_hours', 'Hours'],
  ['cuisine', 'Cuisine'],
  ['phone', 'Phone'],
  ['contact:phone', 'Phone'],
  ['wheelchair', 'Wheelchair access'],
  ['operator', 'Operator'],
  ['brand', 'Brand'],
];

type Tags = Readonly<Record<string, string>>;

export const poiLayer: LayerDef = {
  id: 'poi',
  title: 'Points of interest',
  category: 'city',
  description:
    'Shops, restaurants, sights, stations and more from OpenStreetMap, as you get close to the street.',
  source: { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
  defaultVisible: true,
  range: { max: 4_000 },
  basemaps: ['satellite'],
  filters: groups,
  create(globe): LayerHandle {
    let shown: ReadonlySet<string> = new Set(groups.map((g) => g.id));
    const extract: Extract = (tile, at) => {
      const layer = tile.layers.poi;
      const out: Candidate[] = [];
      for (let i = 0; i < (layer?.length ?? 0); i++) {
        const feature = (layer as VectorTileLayer).feature(i);
        const name = nameOf(feature.properties);
        const rank = Number(feature.properties.rank ?? 99);
        if (!name || (at.height > ALL_BELOW && rank > 12)) continue;
        const cls = String(feature.properties.class ?? '');
        const group = groupOf.get(cls) ?? other;
        if (!shown.has(group.id)) continue;
        const first = feature.loadGeometry()[0]?.[0];
        if (!first) continue;
        const where = toLonLat(at.z, at.x, at.y, (layer as VectorTileLayer).extent, first.x, first.y);
        out.push({
          key: String(feature.id ?? `${name}:${where.lon.toFixed(5)}:${where.lat.toFixed(5)}`),
          text: name,
          ...where,
          priority: rank,
          size: 12,
          color: '#f2f2f2',
          dot: group.color,
          near: true,
          properties: feature.properties,
        });
      }
      return out;
    };
    let labels = new VectorLabels(globe, { layer: 'poi', extract, pickable: true });
    let visible = false;
    /** Full OSM tags fetched for selected points, by key. */
    const tags = new Map<string, Tags | 'loading' | 'failed'>();

    const loadTags = (key: string) => {
      const element = osmElement(Number(key));
      if (!element || tags.has(key)) return;
      tags.set(key, 'loading');
      void (async () => {
        try {
          // One request per selection: well within the OSM API's usage policy for reads.
          const response = await fetch(
            `https://api.openstreetmap.org/api/0.6/${element.type}/${element.id}.json`,
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const json = (await response.json()) as { elements?: Array<{ tags?: Tags }> };
          tags.set(key, json.elements?.[0]?.tags ?? {});
        } catch {
          tags.set(key, 'failed');
        }
      })();
    };

    const describe = (key: string): Details | undefined => {
      const c = labels.candidate(key);
      if (!c) return undefined;
      loadTags(key);
      const element = osmElement(Number(key));
      const props = c.properties ?? {};
      const full = tags.get(key);
      const t: Tags = typeof full === 'object' ? full : {};
      const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
      const fields: Field[] = [
        { label: 'Type', value: humanize(kindOf(props)) },
        ...(street ? [{ label: 'Address', value: [street, t['addr:city']].filter(Boolean).join(', ') }] : []),
      ];
      const seen = new Set<string>();
      for (const [tag, label] of tagFields) {
        const value = t[tag];
        if (value && !seen.has(label)) {
          seen.add(label);
          fields.push({
            label,
            value: tag === 'cuisine' ? value.split(';').map(humanize).join(', ') : value,
          });
        }
      }
      const website = t.website ?? t['contact:website'];
      return {
        kind: 'Point of interest',
        title: c.text,
        ...(full === 'loading' ? { subtitle: 'Loading details…' } : {}),
        fields,
        links: [
          ...(element
            ? [
                {
                  label: 'OpenStreetMap',
                  href: `https://www.openstreetmap.org/${element.type}/${element.id}`,
                },
              ]
            : []),
          ...(website ? [{ label: 'Website', href: website }] : []),
        ],
        position: () => Cartesian3.fromDegrees(c.lon, c.lat, globe.heightAt(c.lon, c.lat) ?? 0),
      };
    };

    return {
      setVisible(next) {
        visible = next;
        labels.setActive(next);
      },
      setFilter(next) {
        shown = next;
        // Filters apply while reading tiles: start over so hidden groups drop out.
        labels.destroy();
        labels = new VectorLabels(globe, { layer: 'poi', extract, pickable: true });
        labels.setActive(visible);
      },
      details: describe,
      countIn: (bounds) => labels.countIn(bounds),
      search(query, limit) {
        const q = query.trim().toLowerCase();
        const hits: SearchHit[] = [];
        for (const c of labels.candidates()) {
          if (hits.length >= limit) break;
          if (!c.text.toLowerCase().includes(q)) continue;
          const props = c.properties ?? {};
          hits.push({
            layer: 'poi',
            key: c.key,
            title: c.text,
            subtitle: `Point of interest · ${humanize(kindOf(props))}`,
          });
        }
        return hits;
      },
      destroy() {
        labels.destroy();
      },
    };
  },
};
