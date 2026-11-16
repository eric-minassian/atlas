import {
  Cartographic,
  GeocodeType,
  type GeocoderService,
  IonGeocodeProviderType,
  IonGeocoderService,
  Math as CesiumMath,
  Rectangle,
} from 'cesium';
import type { Bounds } from '../../../src/area.ts';
import type { Globe } from '../globe/globe.ts';
import { fetchJson } from './fetch.ts';
import { biasZoom, type PlaceHit, PhotonResponse, parsePhoton, photonUrl } from './places.ts';

export type Geocoder = 'photon' | 'google';

/**
 * Google's terms tie Photorealistic 3D tiles to Google's geocoder, so place
 * search uses it (through Cesium ion) while that base map is on, and Photon
 * (OpenStreetMap) otherwise.
 */
export const geocoderFor = (globe: Globe): Geocoder => (globe.basemap === 'photoreal' ? 'google' : 'photon');

const googleServices = new WeakMap<Globe, IonGeocoderService>();

const fromGeocoder = (result: GeocoderService.Result, index: number): PlaceHit => {
  const [title = result.displayName, ...rest] = result.displayName.split(', ');
  const base = { key: `google:${index}:${result.displayName}`, title, subtitle: rest.join(', ') };
  const d = result.destination;
  if (d instanceof Rectangle) {
    const center = Rectangle.center(d);
    return {
      ...base,
      lat: CesiumMath.toDegrees(center.latitude),
      lon: CesiumMath.toDegrees(center.longitude),
      bounds: {
        west: CesiumMath.toDegrees(d.west),
        south: CesiumMath.toDegrees(d.south),
        east: CesiumMath.toDegrees(d.east),
        north: CesiumMath.toDegrees(d.north),
      },
      height: 3_000,
    };
  }
  const c = Cartographic.fromCartesian(d);
  return {
    ...base,
    lat: CesiumMath.toDegrees(c.latitude),
    lon: CesiumMath.toDegrees(c.longitude),
    height: 1_500,
  };
};

/** Places matching `query`, the nearest ones to the view favored. Rejects when `signal` aborts. */
export const searchPlaces = async (
  globe: Globe,
  query: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<PlaceHit>> => {
  if (geocoderFor(globe) === 'google') {
    let service = googleServices.get(globe);
    if (!service) {
      service = new IonGeocoderService({
        scene: globe.scene,
        geocodeProviderType: IonGeocodeProviderType.GOOGLE,
      });
      googleServices.set(globe, service);
    }
    // Cesium's geocoder can't be aborted; a superseded answer is dropped here instead.
    const results = await service.geocode(query, GeocodeType.SEARCH);
    signal.throwIfAborted();
    return results.map(fromGeocoder);
  }
  const { center, height } = globe.view;
  const near = center ? { ...center, zoom: biasZoom(height) } : undefined;
  return parsePhoton(await fetchJson(photonUrl(query, near), PhotonResponse, { signal }));
};

/** About how many meters an area spans at its widest. */
const spanOf = (b: Bounds): number => {
  const lat = ((b.north + b.south) / 2) * (Math.PI / 180);
  const lon = b.west <= b.east ? b.east - b.west : b.east + 360 - b.west;
  return Math.max(b.north - b.south, lon * Math.cos(lat)) * 111_320;
};

/**
 * Flies to a place: to its extent, with a margin, when it has one large enough
 * to frame; a building's footprint would put the camera on its roof, so small
 * places and points are viewed from a height that suits what they are.
 */
export const flyToPlace = (globe: Globe, place: PlaceHit): void => {
  const b = place.bounds;
  if (b && spanOf(b) >= 800) {
    const padLat = (b.north - b.south) * 0.1;
    const padLon = ((b.west <= b.east ? b.east - b.west : b.east + 360 - b.west) * 0.1) % 360;
    globe.flyToBounds({
      west: ((b.west - padLon + 540) % 360) - 180,
      east: ((b.east + padLon + 540) % 360) - 180,
      south: Math.max(-89.9, b.south - padLat),
      north: Math.min(89.9, b.north + padLat),
    });
  } else globe.flyTo(place.lat, place.lon, place.height);
};
