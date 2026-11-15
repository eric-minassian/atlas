import {
  ArcType,
  type Billboard,
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Material,
  Math as CesiumMath,
  NearFarScalar,
  PolylineCollection,
} from 'cesium';
import { Effect } from 'effect';
import { aircraftCategories, aircraftSources } from '../../../src/catalog.ts';
import type { AircraftData, AircraftNearby } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { layerStatus } from '../data/status.ts';
import type { Globe, PickId } from '../globe/globe.ts';
import { formatAge, formatBearing, formatInt, formatLatLon, metersToFeet, msToKnots } from '../lib/format.ts';
import type { Details, LayerDef, LayerHandle, SearchHit } from './types.ts';

const EARTH_RADIUS = 6_371_000;
const NM = 1852;
/** Above this camera height the 250 nm area is a small part of the view: ask the viewer to zoom in. */
const MAX_HEIGHT = 2_500_000;
const POLL_MS = 10_000;
/** Beyond this, positions stay where they were last reported rather than being extrapolated. */
const MAX_EXTRAPOLATION_S = 120;
const UPDATE_MS = 200;

const bands = [
  { label: 'On ground', color: '#8b919b', below: 0 },
  { label: 'Below 10,000 ft', color: '#ee9a4d', below: 3048 },
  { label: '10,000–30,000 ft', color: '#f2c45a', below: 9144 },
  { label: 'Above 30,000 ft', color: '#f4e6b0', below: Number.POSITIVE_INFINITY },
] as const;
const bandColors = bands.map((b) => Color.fromCssColorString(b.color));
const SELECTED = Color.fromCssColorString('#ffffff');
const AREA = Color.fromCssColorString('#f2c45a').withAlpha(0.28);

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

/** Position after flying `seconds` along `track` at `speed`, on a sphere (good enough for minutes). */
const advance = (lat: number, lon: number, track: number, speed: number, seconds: number) => {
  const d = (speed * seconds) / EARTH_RADIUS;
  const t = CesiumMath.toRadians(track);
  const φ = CesiumMath.toRadians(lat);
  const dλ = (d * Math.sin(t)) / Math.max(0.01, Math.cos(φ));
  return {
    lat: lat + CesiumMath.toDegrees(d * Math.cos(t)),
    lon: CesiumMath.toDegrees(CesiumMath.negativePiToPi(CesiumMath.toRadians(lon) + dλ)),
  };
};

/** A circle of `radius` meters around a point, as lon/lat pairs. */
const circle = (lat: number, lon: number, radius: number): number[] => {
  const points: number[] = [];
  for (let k = 0; k <= 96; k++) {
    const p = advance(lat, lon, (k * 360) / 96, radius, 1);
    points.push(p.lon, p.lat);
  }
  return points;
};

/** The point at the center of the view, or undefined when the view's center is sky. */
const viewCenter = (globe: Globe) => {
  const canvas = globe.scene.canvas;
  const hit = globe.scene.camera.pickEllipsoid(
    new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    globe.scene.globe.ellipsoid,
  );
  if (!hit) return undefined;
  const c = Cartographic.fromCartesian(hit);
  return { lat: CesiumMath.toDegrees(c.latitude), lon: CesiumMath.toDegrees(c.longitude) };
};

const describeSources = aircraftSources.map((s) => s.name).join(' and ');

export const aircraftLayer: LayerDef = {
  id: 'aircraft',
  title: 'Aircraft',
  category: 'air',
  description:
    'Live ADS-B positions within 250 nautical miles of the center of the view, refreshed every 10 seconds. Zoom in to load them.',
  source: aircraftSources[0] ?? { name: 'adsb.fi', url: 'https://adsb.fi', license: '' },
  defaultVisible: true,
  legend: bands.map(({ label, color }) => ({ label, color })),
  create(globe): LayerHandle {
    const billboards = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    const area = globe.scene.primitives.add(new PolylineCollection());
    let data: AircraftData | undefined;
    let byIcao = new Map<string, number>();
    let items: Billboard[] = [];
    let selected: string | undefined;
    let visible = false;
    let loading = false;
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

    const clear = () => {
      data = undefined;
      byIcao = new Map();
      items = [];
      billboards.removeAll();
      area.removeAll();
    };

    const render = (nearby: AircraftNearby) => {
      data = nearby.data;
      billboards.removeAll();
      items = [];
      byIcao = new Map();
      const now = globe.now();
      for (let i = 0; i < data.icao.length; i++) {
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
            scaleByDistance: new NearFarScalar(2e5, 1.1, 2.5e6, 0.55),
            id: { layer: 'aircraft', key: icao } satisfies PickId,
          }),
        );
      }
      area.removeAll();
      area.add({
        positions: Cartesian3.fromDegreesArray(circle(nearby.lat, nearby.lon, nearby.radiusNm * NM)),
        width: 1,
        arcType: ArcType.GEODESIC,
        material: Material.fromType('Color', { color: AREA }),
      });
      layerStatus.set('aircraft', {
        text: formatInt(data.icao.length),
        detail: `Within ${nearby.radiusNm} nm of ${formatLatLon(nearby.lat, nearby.lon)}, from ${nearby.source}.`,
      });
    };

    /** Loads the aircraft around the center of the view, or explains why it can't. */
    const refresh = async () => {
      if (!visible || loading) return;
      if (globe.scene.camera.positionCartographic.height > MAX_HEIGHT) {
        clear();
        layerStatus.set('aircraft', {
          text: 'Zoom in',
          detail: 'Aircraft load for the area in view once you zoom in closer.',
          tone: 'muted',
        });
        return;
      }
      const center = viewCenter(globe);
      if (!center) return;
      loading = true;
      const lat = Math.round(center.lat);
      const lon = Math.round(center.lon);
      const result = await callApi((api) => Effect.result(api.live.aircraft({ query: { lat, lon } }))).catch(
        () => undefined,
      );
      loading = false;
      if (!visible) return;
      if (result?._tag === 'Success') render(result.success);
      else
        layerStatus.set('aircraft', {
          text: 'Unavailable',
          detail: `${describeSources} didn't answer. Retrying.`,
          tone: 'warn',
        });
    };

    const poll = setInterval(() => void refresh(), POLL_MS);
    const removeMoveEnd = globe.scene.camera.moveEnd.addEventListener(() => void refresh());
    const animate = setInterval(() => {
      if (!data || !visible) return;
      const now = globe.now();
      for (let i = 0; i < items.length; i++) {
        const position = positionOf(i, now);
        const b = items[i];
        if (b && position) b.position = position;
      }
    }, UPDATE_MS);

    const describe = (icao: string): Details | undefined => {
      const i = byIcao.get(icao);
      if (i === undefined || !data) return undefined;
      const callsign = data.callsign[i] || data.registration[i] || icao.toUpperCase();
      const altitude = data.altitude[i];
      const speed = data.speed[i];
      const track = data.track[i];
      const vrate = data.verticalRate[i];
      const category = aircraftCategories[data.category[i] ?? ''];
      const squawk = data.squawk[i];
      const registration = data.registration[i];
      const type = data.type[i];
      return {
        kind: 'Aircraft',
        title: callsign,
        subtitle: [type, registration].filter(Boolean).join(' · ') || undefined,
        fields: [
          { label: 'ICAO address', value: icao.toUpperCase() },
          ...(registration ? [{ label: 'Registration', value: registration }] : []),
          ...(type ? [{ label: 'Type', value: type }] : []),
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
          { label: 'Last report', value: formatAge(globe.now() - (data.positionTime[i] as number) * 1000) },
        ],
        link: { label: 'adsb.fi map', href: `https://globe.adsb.fi/?icao=${icao}` },
        position: () => {
          const index = byIcao.get(icao);
          const p = index === undefined ? undefined : positionOf(index, globe.now());
          return p ? Cartesian3.clone(p) : undefined;
        },
      };
    };

    return {
      setVisible(next) {
        visible = next;
        billboards.show = next;
        area.show = next;
        if (next) void refresh();
        else {
          clear();
          layerStatus.set('aircraft', { text: '' });
        }
      },
      details: describe,
      highlight(icao) {
        selected = icao;
        const restyle = (on: boolean) => {
          const i = byIcao.get(icao);
          const b = i === undefined ? undefined : items[i];
          if (!b || !data || i === undefined) return;
          b.color = on ? SELECTED : colorFor(data.altitude[i] ?? null, data.onGround[i] ?? false);
          b.scale = on ? 0.8 : 0.5;
        };
        restyle(true);
        return () => {
          restyle(false);
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
          const registration = data.registration[i] ?? '';
          if (
            callsign.toUpperCase().startsWith(q) ||
            icao.toUpperCase().startsWith(q) ||
            registration.toUpperCase().startsWith(q)
          )
            hits.push({
              layer: 'aircraft',
              key: icao,
              title: callsign || registration || icao.toUpperCase(),
              subtitle: ['Aircraft', data.type[i], registration].filter(Boolean).join(' · '),
            });
        }
        return hits;
      },
      destroy() {
        clearInterval(poll);
        clearInterval(animate);
        removeMoveEnd();
        globe.scene.primitives.remove(billboards);
        globe.scene.primitives.remove(area);
      },
    };
  },
};
