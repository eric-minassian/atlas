import { Color } from 'cesium';
import { tileBounds } from '../../../src/area.ts';
import { AreaTiles } from '../data/area.ts';
import { fetchJson, wikimediaHeaders } from '../data/fetch.ts';
import {
  COMMONS_ZOOM,
  fileTitle,
  type GeoPage,
  GeoSearchResponse,
  geoSearchUrl,
  ImageInfoResponse,
  imageInfoUrl,
  parseGeoSearch,
  parseImageInfo,
  type PhotoInfo,
} from '../data/wikimedia.ts';
import { formatLatLon } from '../lib/format.ts';
import { around, GroundPins, reachOf, type Tiers } from './pins.ts';
import type { Details, LayerDef, LayerHandle } from './types.ts';

const COLOR = Color.fromCssColorString('#b9a7ff');

/** Each tile's photos come most relevant first; the rest show as the camera nears them. */
const tiers: Tiers = [
  [80, 15_000],
  [250, 5_000],
  [500, 2_000],
];

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Info =
  | { readonly state: 'loading' }
  | { readonly state: 'done'; readonly info: PhotoInfo }
  | { readonly state: 'error' };

const commonsPage = (title: string) =>
  `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;

export const photoLayer: LayerDef = {
  id: 'photos',
  title: 'Photos',
  category: 'city',
  description:
    'Geotagged photos from Wikimedia Commons, the most notable first. Select one to see it with its author and license.',
  source: {
    name: 'Wikimedia Commons',
    url: 'https://commons.wikimedia.org',
    license: "Each photo's own license",
  },
  defaultVisible: false,
  range: { max: 10_000 },
  create(globe): LayerHandle {
    const pins = new GroundPins<GeoPage>(globe, 'photos', (photo) => ({
      lon: photo.lon,
      lat: photo.lat,
      color: COLOR,
      size: 8,
      reach: reachOf(tiers, photo.rank),
    }));
    /** File details (thumbnail, author, license), fetched when a photo is selected. */
    const infos = new Map<string, Info>();

    const area = new AreaTiles<GeoPage[]>(globe, {
      zoom: COMMONS_ZOOM,
      maxTiles: 16,
      ttlMs: 60 * 60_000,
      load: async ({ z, x, y }, signal) =>
        parseGeoSearch(
          await fetchJson(geoSearchUrl('commons', tileBounds(z, x, y)), GeoSearchResponse, {
            signal,
            headers: wikimediaHeaders(),
          }),
        ),
      onChange: (tiles) => {
        const items = new Map<string, GeoPage>();
        for (const { data } of tiles) for (const photo of data) items.set(String(photo.id), photo);
        pins.replace(items);
      },
      onError: (error) => console.warn('Commons photos unavailable', error),
    });

    // A tile lists 500 photos; thumbnails are asked for one at a time, when one is opened.
    const loadInfo = async (title: string) => {
      if (infos.has(title)) return;
      infos.set(title, { state: 'loading' });
      try {
        const info = parseImageInfo(
          await fetchJson(imageInfoUrl(title), ImageInfoResponse, { headers: wikimediaHeaders() }),
        );
        infos.set(title, info ? { state: 'done', info } : { state: 'error' });
      } catch (error) {
        console.warn('Commons file details unavailable', error);
        infos.set(title, { state: 'error' });
      }
    };

    const describe = (photo: GeoPage): Details => {
      const loaded = infos.get(photo.title);
      const info = loaded?.state === 'done' ? loaded.info : undefined;
      const page = info?.page ?? commonsPage(photo.title);
      const title = fileTitle(photo.title);
      return {
        kind: 'Photo',
        title,
        subtitle: info?.author ?? undefined,
        ...(info?.thumbnail
          ? {
              picture: {
                src: info.thumbnail.url,
                alt: title,
                aspect: info.thumbnail.width / info.thumbnail.height,
                href: page,
                credit: [info.author, info.license].filter(Boolean).join(' · ') || 'Wikimedia Commons',
              },
            }
          : {}),
        body:
          loaded?.state === 'loading'
            ? 'Loading the photo…'
            : loaded?.state === 'error'
              ? 'The photo is unavailable right now.'
              : info?.description
                ? shorten(info.description, 360)
                : undefined,
        fields: [
          ...(info?.taken ? [{ label: 'Taken', value: info.taken }] : []),
          ...(info?.author ? [{ label: 'Author', value: info.author }] : []),
          ...(info?.license ? [{ label: 'License', value: info.license }] : []),
          { label: 'Location', value: formatLatLon(photo.lat, photo.lon) },
        ],
        links: [{ label: 'Wikimedia Commons', href: page }],
        extent: around(photo.lon, photo.lat, 600),
      };
    };

    return {
      setVisible(visible) {
        area.setActive(visible);
        pins.setShow(visible);
        if (!visible) {
          pins.clear();
          infos.clear();
        }
      },
      details(key) {
        const photo = pins.get(key);
        return photo ? describe(photo) : undefined;
      },
      highlight(key) {
        const photo = pins.get(key);
        if (photo) void loadInfo(photo.title);
        return pins.highlight(key);
      },
      countIn: (bounds) => pins.countIn(bounds),
      loaded: pins.changed,
      destroy() {
        area.destroy();
        pins.destroy();
      },
    };
  },
};
