import { Color } from 'cesium';
import { wildlifeSource } from '../../../src/catalog.ts';
import type { Sighting, SightingArea } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { AreaTiles } from '../data/area.ts';
import { formatAge, formatLatLon, formatUtc } from '../lib/format.ts';
import { around, GroundPins, matching } from './pins.ts';
import type { Details, Filter, LayerDef, LayerHandle } from './types.ts';

/** Groups of iNaturalist's iconic taxa, in the order the filter lists them. */
const groups: ReadonlyArray<Filter> = [
  { id: 'birds', label: 'Birds', color: '#6aa8ff' },
  { id: 'mammals', label: 'Mammals', color: '#f0a046' },
  { id: 'herps', label: 'Reptiles and amphibians', color: '#3fcf9a' },
  { id: 'fish', label: 'Fish', color: '#3cc8e0' },
  { id: 'insects', label: 'Insects and spiders', color: '#e6c84a' },
  { id: 'plants', label: 'Plants', color: '#7bd365' },
  { id: 'fungi', label: 'Fungi', color: '#e97fb4' },
  { id: 'other', label: 'Other', color: '#b8c0cc' },
];
const groupOfTaxon: Readonly<Record<string, string>> = {
  Aves: 'birds',
  Mammalia: 'mammals',
  Reptilia: 'herps',
  Amphibia: 'herps',
  Actinopterygii: 'fish',
  Insecta: 'insects',
  Arachnida: 'insects',
  Plantae: 'plants',
  Fungi: 'fungi',
};
const groupOf = (s: Sighting) => (s.group && groupOfTaxon[s.group]) || 'other';
const colors = new Map(groups.map((g) => [g.id, Color.fromCssColorString(g.color)]));
const labels = new Map(groups.map((g) => [g.id, g.label]));

const qualities: Readonly<Record<string, string>> = {
  research: 'Research grade',
  needs_id: 'Needs ID',
  casual: 'Casual',
};

const nameOf = (s: Sighting) => s.commonName ?? s.scientificName ?? 'Unidentified';

export const wildlifeLayer: LayerDef = {
  id: 'wildlife',
  title: 'Wildlife sightings',
  category: 'city',
  description:
    'The latest wildlife and plant observations with photos posted to iNaturalist, colored by group.',
  source: wildlifeSource.source,
  defaultVisible: false,
  range: { max: 30_000 },
  filters: groups,
  create(globe): LayerHandle {
    const pins = new GroundPins<Sighting>(globe, 'wildlife', (s) => ({
      lon: s.lon,
      lat: s.lat,
      color: colors.get(groupOf(s)) ?? Color.WHITE,
      size: 10,
    }));
    let shown: ReadonlySet<string> = new Set(groups.map((g) => g.id));

    const area = new AreaTiles<SightingArea>(globe, {
      zoom: wildlifeSource.zoom,
      // Atlas spaces its iNaturalist requests a second apart: a dozen tiles fill a view.
      maxTiles: 12,
      ttlMs: 30 * 60_000,
      load: (tile, signal) => callApi((api) => api.live.wildlife({ params: tile }), { signal }),
      onChange: (tiles) => {
        const items = new Map<string, Sighting>();
        for (const { data } of tiles) for (const s of data.sightings) items.set(String(s.id), s);
        pins.replace(items);
        pins.filter((s) => shown.has(groupOf(s)));
      },
      onError: (error) => console.warn('wildlife sightings unavailable', error),
    });

    const describe = (s: Sighting): Details => {
      const group = groupOf(s);
      const named = s.commonName !== null && s.scientificName !== null;
      return {
        kind: labels.get(group) ?? 'Sighting',
        title: nameOf(s),
        subtitle: named ? (s.scientificName ?? undefined) : (s.rank ?? undefined),
        // The observer's photo and their license, linked to the observation.
        picture: { src: s.photo.url, alt: nameOf(s), aspect: 1, href: s.url, credit: s.photo.attribution },
        fields: [
          {
            label: 'Observed',
            value:
              s.observedAt !== null
                ? `${formatAge(globe.now() - s.observedAt)} · ${formatUtc(s.observedAt)}`
                : (s.observedOn ?? 'Unknown'),
          },
          { label: 'Observer', value: s.observer },
          { label: 'Identification', value: qualities[s.quality] ?? s.quality },
          ...(s.place ? [{ label: 'Place', value: s.place }] : []),
          {
            label: 'Location',
            value: `${formatLatLon(s.lat, s.lon)}${s.obscured ? ' (approximate)' : ''}`,
          },
        ],
        links: [{ label: 'iNaturalist', href: s.url }],
        extent: around(s.lon, s.lat, 1_500),
      };
    };

    return {
      setVisible(visible) {
        area.setActive(visible);
        pins.setShow(visible);
        if (!visible) pins.clear();
      },
      setFilter(next) {
        shown = next;
        pins.filter((s) => shown.has(groupOf(s)));
      },
      details(key) {
        const s = pins.get(key);
        return s ? describe(s) : undefined;
      },
      highlight: (key) => pins.highlight(key),
      countIn: (bounds) => pins.countIn(bounds),
      loaded: pins.changed,
      search(query, limit) {
        const shownItems = [...pins.items()].filter(([key]) => pins.isShown(key));
        return matching(
          shownItems,
          query,
          limit,
          ([, s]) => `${s.commonName ?? ''} ${s.scientificName ?? ''}`,
        ).map(([key, s]) => ({
          layer: 'wildlife',
          key,
          title: nameOf(s),
          subtitle: [labels.get(groupOf(s)), s.observedOn].filter(Boolean).join(' · '),
        }));
      },
      destroy() {
        area.destroy();
        pins.destroy();
      },
    };
  },
};
