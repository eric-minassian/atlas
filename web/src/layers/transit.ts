import {
  type Billboard,
  BillboardCollection,
  Cartesian3,
  Color,
  HeightReference,
  Math as CesiumMath,
  NearFarScalar,
} from 'cesium';
import { contains } from '../../../src/area.ts';
import { areaZooms, transitSource } from '../../../src/catalog.ts';
import type { TransitMode, TransitVehicles } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { AreaTiles } from '../data/area.ts';
import { layerStatus } from '../data/status.ts';
import type { PickId } from '../globe/globe.ts';
import { followGround } from '../globe/ground.ts';
import { formatAge, formatBearing, formatInt, formatLatLon } from '../lib/format.ts';
import { advance } from '../lib/motion.ts';
import type { Details, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

type Mode = TransitMode | 'unknown';

const modes: ReadonlyArray<Filter & { readonly id: Mode; readonly name: string }> = [
  { id: 'bus', label: 'Bus', name: 'Bus', color: '#f0b44c' },
  { id: 'tram', label: 'Tram', name: 'Tram', color: '#e0605a' },
  { id: 'metro', label: 'Metro', name: 'Metro train', color: '#5f9ee8' },
  { id: 'rail', label: 'Rail', name: 'Train', color: '#a184e6' },
  { id: 'ferry', label: 'Ferry', name: 'Ferry', color: '#4fc1c9' },
  { id: 'cable', label: 'Cable', name: 'Cable car', color: '#6fcf97' },
  { id: 'other', label: 'Other', name: 'Transit vehicle', color: '#c9cfd6' },
  { id: 'unknown', label: 'Mode unknown', name: 'Transit vehicle', color: '#8b939e' },
];
const modeById = new Map(modes.map((m) => [m.id, { ...m, cesium: Color.fromCssColorString(m.color) }]));

/** Reported positions are carried forward at most this long. */
const MAX_EXTRAPOLATION_S = 120;

/** A dot with a notch toward the direction of travel; billboards tint it. */
const headingIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
    '<path d="M10 1.5 14 6.2A6 6 0 1 1 6 6.2Z" fill="#fff" stroke="rgba(0,0,0,0.7)" stroke-width="1.3"/></svg>',
)}`;
const dotIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="5.5" fill="#fff" stroke="rgba(0,0,0,0.7)" stroke-width="1.3"/></svg>',
)}`;

interface Vehicle {
  readonly key: string;
  readonly feed: { readonly id: string; readonly provider: string };
  readonly id: string;
  readonly label: string;
  readonly route: string;
  readonly routeName: string;
  readonly trip: string;
  readonly mode: Mode;
  readonly lon: number;
  readonly lat: number;
  readonly bearing: number | null;
  readonly speed: number | null;
  readonly timestamp: number | null;
}

const vehiclesOf = (answer: TransitVehicles): Vehicle[] => {
  const d = answer.data;
  return d.id.map((id, i) => {
    const feed = answer.feeds[d.feed[i] as number] ?? { id: '', provider: '' };
    return {
      key: `${feed.id}:${id}`,
      feed,
      id,
      label: d.label[i] as string,
      route: d.route[i] as string,
      routeName: d.routeName[i] as string,
      trip: d.trip[i] as string,
      mode: d.mode[i] ?? 'unknown',
      lon: d.lon[i] as number,
      lat: d.lat[i] as number,
      bearing: d.bearing[i] ?? null,
      speed: d.speed[i] ?? null,
      timestamp: d.timestamp[i] ?? null,
    };
  });
};

const routeOf = (v: Vehicle) => v.routeName || v.route;

export const transitLayer: LayerDef = {
  id: 'transit',
  title: 'Transit vehicles',
  category: 'city',
  description:
    'Live buses, trams and trains from every open GTFS-realtime feed in the Mobility Database: about 550 agencies worldwide. Zoom in to a city to load them.',
  source: transitSource,
  defaultVisible: true,
  range: { max: 150_000 },
  filters: modes,
  create(globe): LayerHandle {
    const billboards = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    const ground = followGround(globe, [billboards]);
    let vehicles = new Map<string, { vehicle: Vehicle; billboard: Billboard }>();
    let shown: ReadonlySet<string> = new Set(modes.map((m) => m.id));
    let selected: string | undefined;
    const scratch = new Cartesian3();

    const where = (v: Vehicle, now: number) => {
      if (v.bearing === null || v.speed === null || v.speed <= 0 || v.timestamp === null) return v;
      const age = now / 1000 - v.timestamp;
      if (age <= 0 || age > MAX_EXTRAPOLATION_S) return v;
      return advance(v.lat, v.lon, v.bearing, v.speed, age);
    };
    /** Clamped on terrain; under Photorealistic 3D, at the height it was last seated at. */
    const positionOf = (v: Vehicle, now: number, result = scratch, billboard?: Billboard) => {
      const p = where(v, now);
      return Cartesian3.fromDegrees(
        p.lon,
        p.lat,
        billboard ? ground.heightOf(billboard) : 0,
        undefined,
        result,
      );
    };

    const style = (key: string) => {
      const entry = vehicles.get(key);
      if (!entry) return;
      const { vehicle, billboard } = entry;
      billboard.show = shown.has(vehicle.mode);
      billboard.color = key === selected ? Color.WHITE : (modeById.get(vehicle.mode)?.cesium ?? Color.WHITE);
      billboard.scale = key === selected ? 0.95 : 0.65;
    };

    /** Updates vehicles in place, so a refreshed tile doesn't make them jump or flicker. */
    const show = (answers: ReadonlyArray<TransitVehicles>) => {
      const now = globe.now();
      const next = new Map<string, { vehicle: Vehicle; billboard: Billboard }>();
      for (const answer of answers)
        for (const vehicle of vehiclesOf(answer)) {
          if (next.has(vehicle.key)) continue;
          const existing = vehicles.get(vehicle.key);
          const directional = vehicle.bearing !== null;
          const billboard =
            existing?.billboard ??
            billboards.add({
              image: directional ? headingIcon : dotIcon,
              position: positionOf(vehicle, now),
              heightReference: HeightReference.CLAMP_TO_GROUND,
              scaleByDistance: new NearFarScalar(1_000, 1.3, 150_000, 0.5),
              alignedAxis: Cartesian3.UNIT_Z,
              id: { layer: 'transit', key: vehicle.key } satisfies PickId,
            });
          // Setting an image reloads it, even the same one.
          if (existing && (existing.vehicle.bearing !== null) !== directional)
            billboard.image = directional ? headingIcon : dotIcon;
          billboard.rotation = directional ? -CesiumMath.toRadians(vehicle.bearing ?? 0) : 0;
          billboard.position = positionOf(vehicle, now, scratch, billboard);
          next.set(vehicle.key, { vehicle, billboard });
        }
      for (const [key, { billboard }] of vehicles) if (!next.has(key)) billboards.remove(billboard);
      vehicles = next;
      for (const key of vehicles.keys()) style(key);

      const feeds = new Map(answers.flatMap((a) => a.feeds.map((f) => [f.id, f] as const)));
      const failed = [...feeds.values()].filter((f) => !f.ok);
      layerStatus.set('transit', {
        text: feeds.size === 0 ? 'None here' : formatInt(vehicles.size),
        detail:
          feeds.size === 0
            ? 'No open realtime feed covers this area.'
            : [
                `From ${[...feeds.values()]
                  .filter((f) => f.ok)
                  .map((f) => f.provider)
                  .join(', ')}.`,
                failed.length > 0 ? `Not answering: ${failed.map((f) => f.provider).join(', ')}.` : '',
              ]
                .filter(Boolean)
                .join(' '),
        tone: failed.length > 0 && failed.length === feeds.size ? 'warn' : 'muted',
      });
    };

    const tiles = new AreaTiles<TransitVehicles>(globe, {
      zoom: areaZooms.transit,
      maxTiles: 12,
      // Feeds update every 10–30 s; the API caches each for 15.
      ttlMs: 15_000,
      load: (tile) => callApi((api) => api.live.transit({ params: tile })),
      onChange: (loaded) => show(loaded.map((t) => t.data)),
      onError: () =>
        layerStatus.set('transit', {
          text: 'Unavailable',
          detail: 'Atlas didn’t answer. Retrying.',
          tone: 'warn',
        }),
    });

    // Every frame rather than on a timer: Cesium rebuilds a billboard collection's buffers each time
    // updates start or stop arriving between frames, so a timer would rebuild them twice per tick.
    const stopAnimating = globe.scene.preRender.addEventListener(() => {
      if (!billboards.show || vehicles.size === 0) return;
      const now = globe.now();
      for (const { vehicle, billboard } of vehicles.values())
        if (billboard.show && vehicle.bearing !== null && vehicle.speed)
          billboard.position = positionOf(vehicle, now, scratch, billboard);
    });

    const describe = (key: string): Details | undefined => {
      const vehicle = vehicles.get(key)?.vehicle;
      if (!vehicle) return undefined;
      const mode = modeById.get(vehicle.mode);
      const now = globe.now();
      const at = where(vehicle, now);
      const route = routeOf(vehicle);
      return {
        kind: mode?.name ?? 'Transit vehicle',
        title: route
          ? `${mode?.id === 'unknown' || mode?.id === 'other' ? 'Route ' : ''}${route}`
          : vehicle.label || vehicle.id,
        subtitle: vehicle.feed.provider,
        fields: [
          { label: 'Provider', value: vehicle.feed.provider },
          ...(route
            ? [
                {
                  label: 'Route',
                  value:
                    vehicle.routeName && vehicle.route !== vehicle.routeName
                      ? `${vehicle.routeName} (${vehicle.route})`
                      : route,
                },
              ]
            : []),
          { label: 'Vehicle', value: vehicle.label || vehicle.id },
          ...(vehicle.trip ? [{ label: 'Trip', value: vehicle.trip }] : []),
          ...(vehicle.speed !== null
            ? [{ label: 'Speed', value: `${formatInt(vehicle.speed * 3.6)} km/h` }]
            : []),
          ...(vehicle.bearing !== null ? [{ label: 'Heading', value: formatBearing(vehicle.bearing) }] : []),
          { label: 'Position', value: formatLatLon(at.lat, at.lon) },
          ...(vehicle.timestamp !== null
            ? [{ label: 'Last update', value: formatAge(now - vehicle.timestamp * 1000) }]
            : []),
        ],
        links: [
          {
            label: 'Feed in the Mobility Database',
            href: `https://mobilitydatabase.org/feeds/gtfs_rt/${encodeURIComponent(vehicle.feed.id)}`,
          },
        ],
        position: () => {
          const current = vehicles.get(key)?.vehicle;
          if (!current) return undefined;
          const p = where(current, globe.now());
          return Cartesian3.fromDegrees(p.lon, p.lat, globe.heightAt(p.lon, p.lat) ?? 0);
        },
      };
    };

    return {
      loaded: tiles.loaded,
      setVisible(visible) {
        billboards.show = visible;
        tiles.setActive(visible);
        if (!visible) {
          billboards.removeAll();
          vehicles = new Map();
          layerStatus.set('transit', { text: '' });
        }
      },
      setFilter(visible) {
        shown = visible;
        for (const key of vehicles.keys()) style(key);
      },
      details: describe,
      countIn(bounds) {
        let n = 0;
        for (const { vehicle } of vehicles.values())
          if (shown.has(vehicle.mode) && contains(bounds, vehicle.lon, vehicle.lat)) n++;
        return n;
      },
      highlight(key) {
        selected = key;
        style(key);
        return () => {
          if (selected === key) selected = undefined;
          style(key);
        };
      },
      search(query, limit) {
        const q = query.trim().toLowerCase();
        const hits: SearchHit[] = [];
        for (const { vehicle } of vehicles.values()) {
          if (hits.length >= limit) break;
          const route = routeOf(vehicle);
          if (
            route.toLowerCase() === q ||
            vehicle.label.toLowerCase() === q ||
            vehicle.id.toLowerCase() === q ||
            (q.length >= 3 && vehicle.routeName.toLowerCase().includes(q))
          )
            hits.push({
              layer: 'transit',
              key: vehicle.key,
              title: route
                ? `${modeById.get(vehicle.mode)?.name ?? 'Vehicle'} ${route}`
                : vehicle.label || vehicle.id,
              subtitle: [vehicle.label && `Vehicle ${vehicle.label}`, vehicle.feed.provider]
                .filter(Boolean)
                .join(' · '),
            });
        }
        return hits;
      },
      destroy() {
        ground.stop();
        stopAnimating();
        tiles.destroy();
        globe.scene.primitives.remove(billboards);
      },
    };
  },
};
