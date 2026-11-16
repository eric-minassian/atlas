import {
  Cartesian3,
  Cesium3DTileFeature,
  type Cesium3DTileset,
  Cesium3DTileStyle,
  Color,
  createOsmBuildingsAsync,
} from 'cesium';
import type { Details, Field, LayerDef, LayerHandle } from './types.ts';

const BUILDING = '#e7e3da';
const SELECTED = Color.fromCssColorString('#ffd166');

/** Readable names for the commonest OSM `building` values; others are shown as tagged. */
const kinds: Readonly<Record<string, string>> = {
  yes: 'Building',
  house: 'House',
  residential: 'Residential',
  apartments: 'Apartments',
  commercial: 'Commercial',
  retail: 'Retail',
  office: 'Office',
  industrial: 'Industrial',
  warehouse: 'Warehouse',
  school: 'School',
  university: 'University',
  hospital: 'Hospital',
  church: 'Church',
  cathedral: 'Cathedral',
  mosque: 'Mosque',
  temple: 'Temple',
  synagogue: 'Synagogue',
  train_station: 'Train station',
  transportation: 'Transport',
  hotel: 'Hotel',
  stadium: 'Stadium',
  garage: 'Garage',
  parking: 'Parking',
  public: 'Public',
  civic: 'Civic',
  government: 'Government',
};

const text = (feature: Cesium3DTileFeature, name: string): string | undefined => {
  const value: unknown = feature.getProperty(name);
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const keyOf = (feature: Cesium3DTileFeature) => text(feature, 'elementId');

export const buildingsLayer: LayerDef = {
  id: 'buildings',
  title: '3D buildings',
  category: 'base',
  description: 'Every building mapped in OpenStreetMap, in 3D, with its height where it is known.',
  source: {
    name: 'Cesium OSM Buildings',
    url: 'https://cesium.com/platform/cesium-ion/content/cesium-osm-buildings/',
    license: 'ODbL (OpenStreetMap)',
  },
  defaultVisible: true,
  // Beyond this they're specks that still cost a stream of tiles.
  range: { max: 40_000 },
  basemaps: ['satellite'],
  available: (config) => config.keys.cesiumIon !== null,
  create(globe): LayerHandle {
    let tileset: Cesium3DTileset | undefined;
    let loading: Promise<Cesium3DTileset | undefined> | undefined;
    let visible = false;
    /** Features picked recently, by OSM id: the inspector reads their properties. */
    const picked = new Map<string, Cesium3DTileFeature>();

    const load = () => {
      loading ??= createOsmBuildingsAsync({
        style: new Cesium3DTileStyle({ color: `color('${BUILDING}')` }),
        // Outlines double the geometry each tile uploads; flat-shaded boxes read fine without them.
        enableShowOutline: false,
      })
        .then((created) => {
          // The camera stops at rooftops instead of passing through them.
          created.enableCollision = true;
          tileset = globe.scene.primitives.add(created);
          created.show = visible;
          return created;
        })
        .catch((error: unknown) => {
          console.error('OSM buildings unavailable', error);
          loading = undefined;
          return undefined;
        });
      return loading;
    };

    const stopPicking = globe.addPicker((value) => {
      if (!(value instanceof Cesium3DTileFeature) || value.tileset !== tileset) return undefined;
      const key = keyOf(value);
      if (!key) return undefined;
      picked.set(key, value);
      // Only the latest few are needed; the rest may already be unloaded with their tile.
      if (picked.size > 20) picked.delete(picked.keys().next().value as string);
      return { layer: 'buildings', key };
    });

    const describe = (key: string): Details | undefined => {
      const feature = picked.get(key);
      if (!feature) return undefined;
      const kind = text(feature, 'building');
      const name = text(feature, 'name');
      const street = [text(feature, 'addr:housenumber'), text(feature, 'addr:street')]
        .filter(Boolean)
        .join(' ');
      const city = text(feature, 'addr:city');
      const height = Number(feature.getProperty('cesium#estimatedHeight'));
      const levels = text(feature, 'building:levels');
      const lat = Number(feature.getProperty('cesium#latitude'));
      const lon = Number(feature.getProperty('cesium#longitude'));
      const type = text(feature, 'elementType') ?? 'way';
      const fields: Field[] = [
        ...(street ? [{ label: 'Address', value: [street, city].filter(Boolean).join(', ') }] : []),
        ...(kind ? [{ label: 'Type', value: kinds[kind] ?? kind.replaceAll('_', ' ') }] : []),
        ...(Number.isFinite(height) ? [{ label: 'Height', value: `${Math.round(height)} m` }] : []),
        ...(levels ? [{ label: 'Floors', value: levels }] : []),
        ...(text(feature, 'start_date')
          ? [{ label: 'Built', value: text(feature, 'start_date') ?? '' }]
          : []),
        ...(text(feature, 'architect')
          ? [{ label: 'Architect', value: text(feature, 'architect') ?? '' }]
          : []),
      ];
      return {
        kind: 'Building',
        title: name ?? (street || (kind ? (kinds[kind] ?? 'Building') : 'Building')),
        ...(name && street ? { subtitle: street } : {}),
        fields,
        links: [
          { label: 'OpenStreetMap', href: `https://www.openstreetmap.org/${type}/${key}` },
          ...(text(feature, 'website') ? [{ label: 'Website', href: text(feature, 'website') ?? '' }] : []),
          ...(text(feature, 'wikipedia')
            ? [
                {
                  label: 'Wikipedia',
                  href: `https://wikipedia.org/wiki/${encodeURIComponent(text(feature, 'wikipedia') ?? '')}`,
                },
              ]
            : []),
        ],
        ...(Number.isFinite(lat) && Number.isFinite(lon)
          ? { position: () => Cartesian3.fromDegrees(lon, lat, Number.isFinite(height) ? height / 2 : 0) }
          : {}),
      };
    };

    return {
      setVisible(next) {
        visible = next;
        if (tileset) tileset.show = next;
        else if (next) void load();
      },
      details: describe,
      highlight(key) {
        const feature = picked.get(key);
        if (!feature) return () => {};
        const original = feature.color;
        feature.color = SELECTED;
        return () => {
          // The feature may have been unloaded with its tile meanwhile.
          if (feature.tileset && !feature.tileset.isDestroyed()) feature.color = original;
        };
      },
      destroy() {
        stopPicking();
        if (tileset) globe.scene.primitives.remove(tileset);
      },
    };
  },
};
