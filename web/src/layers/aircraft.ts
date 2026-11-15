import {
  type Billboard,
  BillboardCollection,
  Cartesian3,
  Color,
  NearFarScalar,
  Math as CesiumMath,
} from 'cesium';
import { aircraftCategories, feeds } from '../../../src/catalog.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { formatAge, formatBearing, formatInt, formatLatLon, metersToFeet, msToKnots } from '../lib/format.ts';
import type { Details, LayerDef, LayerHandle, SearchHit } from './types.ts';

const EARTH_RADIUS = 6_371_000;
/** Beyond this, positions are shown where they were last reported rather than extrapolated. */
const MAX_EXTRAPOLATION_S = 600;
const UPDATE_MS = 200;

const bands = [
  { label: 'On ground', color: '#8b919b', below: 0 },
  { label: 'Below 10,000 ft', color: '#ee9a4d', below: 3048 },
  { label: '10,000–30,000 ft', color: '#f2c45a', below: 9144 },
  { label: 'Above 30,000 ft', color: '#f4e6b0', below: Number.POSITIVE_INFINITY },
] as const;
const bandColors = bands.map((b) => Color.fromCssColorString(b.color));
const SELECTED = Color.fromCssColorString('#ffffff');

const colorFor = (altitude: number | null, onGround: boolean): Color => {
  if (onGround) return bandColors[0] as Color;
  const a = altitude ?? 0;
  for (let i = 1; i < bands.length; i++)
    if (a < (bands[i] as (typeof bands)[number]).below) return bandColors[i] as Color;
  return bandColors[bandColors.length - 1] as Color;
};

/** A plane silhouette pointing north; billboards tint it. */
const planeIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<path d="M16 2C17.3 2 18 3.2 18 4.6V12l11 6.5V21l-11-3.4V25l3.5 2.6v2L16 28.2l-5.5 1.4v-2L14 25v-7.4L3 21v-2.5L14 12V4.6C14 3.2 14.7 2 16 2Z" ' +
    'fill="#fff" stroke="rgba(0,0,0,0.65)" stroke-width="1.5"/></svg>',
)}`;

type Data = Snapshot<'aircraft'>['data'];

/** Position after flying `seconds` along `track` at `speed`, on a sphere (good enough for minutes). */
const advance = (lat: number, lon: number, track: number, speed: number, seconds: number) => {
  const d = (speed * seconds) / EARTH_RADIUS;
  const t = CesiumMath.toRadians(track);
  const φ = CesiumMath.toRadians(lat);
  const dφ = d * Math.cos(t);
  const dλ = (d * Math.sin(t)) / Math.max(0.01, Math.cos(φ));
  return {
    lat: lat + CesiumMath.toDegrees(dφ),
    lon: CesiumMath.negativePiToPi(CesiumMath.toRadians(lon) + dλ) * (180 / Math.PI),
  };
};

export const aircraftLayer: LayerDef = {
  id: 'aircraft',
  title: 'Aircraft',
  category: 'air',
  description: 'Live ADS-B positions worldwide, extrapolated between reports along each heading.',
  source: feeds.aircraft.source,
  feed: 'aircraft',
  defaultVisible: true,
  legend: bands.map(({ label, color }) => ({ label, color })),
  create(globe): LayerHandle {
    const billboards = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    let data: Data | undefined;
    let byIcao = new Map<string, number>();
    let items: Billboard[] = [];
    let selected: string | undefined;
    const scratch = new Cartesian3();

    const positionOf = (i: number, now: number): Cartesian3 | undefined => {
      if (!data) return undefined;
      const lat = data.lat[i] as number;
      const lon = data.lon[i] as number;
      const speed = data.speed[i];
      const track = data.track[i];
      const altitude = data.onGround[i] ? 0 : Math.max(0, data.altitude[i] ?? 0);
      const age = now / 1000 - (data.positionTime[i] as number);
      if (
        data.onGround[i] ||
        speed === null ||
        speed === undefined ||
        track === null ||
        track === undefined ||
        age <= 0 ||
        age > MAX_EXTRAPOLATION_S
      )
        return Cartesian3.fromDegrees(lon, lat, altitude, undefined, scratch);
      const p = advance(lat, lon, track, speed, age);
      return Cartesian3.fromDegrees(p.lon, p.lat, altitude, undefined, scratch);
    };

    const render = (snapshot: Snapshot<'aircraft'>) => {
      data = snapshot.data;
      const n = data.icao.length;
      billboards.removeAll();
      items = [];
      byIcao = new Map();
      const now = globe.now();
      for (let i = 0; i < n; i++) {
        const icao = data.icao[i] as string;
        byIcao.set(icao, i);
        const position = positionOf(i, now);
        items.push(
          billboards.add({
            image: planeIcon,
            position: position ? Cartesian3.clone(position) : Cartesian3.ZERO,
            color:
              icao === selected ? SELECTED : colorFor(data.altitude[i] ?? null, data.onGround[i] ?? false),
            scale: icao === selected ? 0.8 : 0.5,
            rotation: -CesiumMath.toRadians(data.track[i] ?? 0),
            alignedAxis: Cartesian3.UNIT_Z,
            scaleByDistance: new NearFarScalar(2e5, 1.1, 1.5e7, 0.32),
            id: { layer: 'aircraft', key: icao } satisfies PickId,
          }),
        );
      }
    };

    const timer = setInterval(() => {
      if (!data || !billboards.show) return;
      const now = globe.now();
      for (let i = 0; i < items.length; i++) {
        const position = positionOf(i, now);
        const b = items[i];
        if (b && position) b.position = position;
      }
    }, UPDATE_MS);

    let unsubscribe: (() => void) | undefined;

    const describe = (icao: string): Details | undefined => {
      const i = byIcao.get(icao);
      if (i === undefined || !data) return undefined;
      const callsign = data.callsign[i] || icao.toUpperCase();
      const altitude = data.altitude[i];
      const speed = data.speed[i];
      const track = data.track[i];
      const vrate = data.verticalRate[i];
      const category = aircraftCategories[data.category[i] ?? 0];
      const squawk = data.squawk[i];
      const now = globe.now();
      const fields = [
        { label: 'ICAO address', value: icao.toUpperCase() },
        { label: 'Registered in', value: data.country[i] ?? '—' },
        {
          label: 'Altitude',
          value: data.onGround[i]
            ? 'On ground'
            : altitude === null || altitude === undefined
              ? '—'
              : `${formatInt(metersToFeet(altitude))} ft · ${formatInt(altitude)} m`,
        },
        {
          label: 'Ground speed',
          value: speed === null || speed === undefined ? '—' : `${formatInt(msToKnots(speed))} kt`,
        },
        { label: 'Track', value: track === null || track === undefined ? '—' : formatBearing(track) },
        {
          label: 'Vertical rate',
          value:
            vrate === null || vrate === undefined
              ? '—'
              : `${vrate > 0 ? '+' : ''}${formatInt(metersToFeet(vrate) * 60)} ft/min`,
        },
        ...(squawk ? [{ label: 'Squawk', value: squawk }] : []),
        ...(category ? [{ label: 'Category', value: category }] : []),
        { label: 'Position', value: formatLatLon(data.lat[i] as number, data.lon[i] as number) },
        { label: 'Last report', value: formatAge(now - (data.positionTime[i] as number) * 1000) },
      ];
      return {
        kind: 'Aircraft',
        title: callsign,
        subtitle: data.country[i],
        fields,
        link: {
          label: 'OpenSky aircraft profile',
          href: `https://opensky-network.org/aircraft-profile?icao24=${icao}`,
        },
        position: () => {
          const p = positionOf(i, globe.now());
          return p ? Cartesian3.clone(p) : undefined;
        },
      };
    };

    return {
      setVisible(visible) {
        billboards.show = visible;
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('aircraft', render);
        if (!visible && unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      },
      details: describe,
      highlight(icao) {
        selected = icao;
        const restyle = (key: string, on: boolean) => {
          const i = byIcao.get(key);
          const b = i === undefined ? undefined : items[i];
          if (!b || !data || i === undefined) return;
          b.color = on ? SELECTED : colorFor(data.altitude[i] ?? null, data.onGround[i] ?? false);
          b.scale = on ? 0.8 : 0.5;
        };
        restyle(icao, true);
        return () => {
          restyle(icao, false);
          if (selected === icao) selected = undefined;
        };
      },
      search(query, limit) {
        if (!data) return [];
        const q = query.trim().toUpperCase();
        const hits: SearchHit[] = [];
        for (let i = 0; i < data.icao.length && hits.length < limit; i++) {
          const callsign = data.callsign[i] ?? '';
          const icao = data.icao[i] as string;
          if (callsign.toUpperCase().startsWith(q) || icao.toUpperCase().startsWith(q))
            hits.push({
              layer: 'aircraft',
              key: icao,
              title: callsign || icao.toUpperCase(),
              subtitle: `Aircraft · ${data.country[i] ?? ''}`,
            });
        }
        return hits;
      },
      destroy() {
        clearInterval(timer);
        unsubscribe?.();
        globe.scene.primitives.remove(billboards);
      },
    };
  },
};
