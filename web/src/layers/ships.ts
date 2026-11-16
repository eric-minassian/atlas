import {
  type Billboard,
  BillboardCollection,
  Cartesian3,
  Cartographic,
  Color,
  Math as CesiumMath,
  NearFarScalar,
} from 'cesium';
import { contains } from '../../../src/area.ts';
import { feeds, type Source } from '../../../src/catalog.ts';
import type { ShipData } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import { flagOf, navStatusLabel, type ShipCategory, shipCategoryOf, shipTypeLabel } from '../lib/ais.ts';
import { formatAge, formatBearing, formatInt, formatLatLon, formatNumber } from '../lib/format.ts';
import { advance, KNOT } from '../lib/motion.ts';
import type { Details, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

const categories: ReadonlyArray<Filter & { readonly id: ShipCategory }> = [
  { id: 'cargo', label: 'Cargo', color: '#4fb08c' },
  { id: 'tanker', label: 'Tanker', color: '#e0645a' },
  { id: 'passenger', label: 'Passenger', color: '#5a9ae6' },
  { id: 'fishing', label: 'Fishing', color: '#e6b84d' },
  { id: 'pleasure', label: 'Pleasure and sailing', color: '#b28ae0' },
  { id: 'other', label: 'Other', color: '#a3adb8' },
];
const colorOf = new Map(categories.map((c) => [c.id, Color.fromCssColorString(c.color)]));
const SELECTED = Color.WHITE;

/** Below this a vessel is treated as stopped: GPS jitter makes moored ships "move" at a few tenths of a knot. */
const MOVING_KNOTS = 0.5;
/** Positions are carried forward at most this long; a vessel can turn in that time. */
const MAX_EXTRAPOLATION_S = 15 * 60;
const ANIMATE_BELOW = 2_000_000;

/** A hull seen from above, bow up; billboards tint it. */
const hullIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="32" viewBox="0 0 20 32">' +
    '<path d="M10 1.5C13.5 5.5 16 10 16 15v14.5H4V15c0-5 2.5-9.5 6-13.5Z" fill="#fff" stroke="rgba(0,0,0,0.7)" stroke-width="1.5"/></svg>',
)}`;
/** A vessel with no heading or course to point along. */
const stillIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="5.5" fill="#fff" stroke="rgba(0,0,0,0.7)" stroke-width="1.5"/></svg>',
)}`;

/** Larger vessels draw larger, within limits that keep small craft visible and tankers from covering a port. */
const scaleOf = (length: number) => (length > 0 ? 0.45 + Math.min(1, length / 300) * 0.5 : 0.55);

/**
 * Without an aisstream.io key the server reads only Fintraffic's Baltic
 * network: the panel says so. Set from the deployment's config when the layer
 * is created, before the panel first reads it.
 */
let worldwide = true;
const balticOnly: Source = {
  name: 'Fintraffic',
  url: 'https://www.digitraffic.fi/en/marine-traffic/',
  license: 'Fintraffic / digitraffic.fi, CC BY 4.0',
};

export const shipLayer: LayerDef = {
  id: 'ships',
  title: 'Ships',
  category: 'sea',
  get description() {
    return worldwide
      ? 'AIS positions broadcast by vessels, carried forward along their course between reports. Worldwide where aisstream.io’s volunteer receivers hear them, and across the Baltic from Fintraffic.'
      : 'AIS positions broadcast by vessels across the Baltic, from Fintraffic, carried forward along their course between reports.';
  },
  get source() {
    return worldwide ? feeds.ships.source : balticOnly;
  },
  feed: 'ships',
  defaultVisible: true,
  // Beyond this, tens of thousands of icons are a smear along the coasts.
  range: { max: 8_000_000 },
  filters: categories,
  create(globe): LayerHandle {
    worldwide = globe.config.sources.aisstream;
    const billboards = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    let data: ShipData | undefined;
    let items: Billboard[] = [];
    let byMmsi = new Map<number, number>();
    let category: ShipCategory[] = [];
    /** Ground height under each vessel (inland waterways sit well above sea level). */
    let heights = new Float64Array(0);
    /** Vessels under way, the ones dead reckoning moves. */
    let moving: number[] = [];
    let shown: ReadonlySet<string> = new Set(categories.map((c) => c.id));
    let selected: number | undefined;
    let unsubscribe: (() => void) | undefined;
    const scratch = new Cartesian3();
    const cartographic = new Cartographic();

    const isMoving = (i: number) => {
      const speed = data?.speed[i];
      return speed != null && speed >= MOVING_KNOTS && data?.course[i] != null;
    };

    /** Where vessel i is now: its last report, carried forward along its course if it's under way. */
    const where = (i: number, now: number): { lon: number; lat: number } => {
      const d = data as ShipData;
      const lon = d.lon[i] as number;
      const lat = d.lat[i] as number;
      if (!isMoving(i)) return { lon, lat };
      const age = now / 1000 - (d.since + (d.time[i] as number));
      if (age <= 0 || age > MAX_EXTRAPOLATION_S) return { lon, lat };
      return advance(lat, lon, d.course[i] as number, (d.speed[i] as number) * KNOT, age);
    };
    const positionOf = (i: number, now: number, result: Cartesian3) => {
      const p = where(i, now);
      return Cartesian3.fromDegrees(p.lon, p.lat, heights[i] ?? 0, undefined, result);
    };

    const ground = trackGround(globe, () =>
      data && items.length === data.mmsi.length
        ? {
            size: items.length,
            lon: (i) => data?.lon[i] as number,
            lat: (i) => data?.lat[i] as number,
            place: (i, position) => {
              heights[i] = Cartographic.fromCartesian(position, undefined, cartographic).height;
              const b = items[i];
              if (b) b.position = positionOf(i, globe.now(), scratch);
            },
          }
        : undefined,
    );

    const style = (i: number) => {
      const b = items[i];
      if (!b) return;
      b.color = i === selected ? SELECTED : (colorOf.get(category[i] as ShipCategory) as Color);
      b.scale = scaleOf(data?.length[i] ?? 0) * (i === selected ? 1.5 : 1);
      b.show = shown.has(category[i] as string);
    };

    const clear = () => {
      data = undefined;
      items = [];
      byMmsi = new Map();
      category = [];
      moving = [];
      heights = new Float64Array(0);
      billboards.removeAll();
    };

    const render = (snapshot: Snapshot<'ships'>) => {
      const selectedMmsi = selected === undefined ? undefined : data?.mmsi[selected];
      clear();
      data = snapshot.data;
      heights = new Float64Array(data.mmsi.length);
      const now = globe.now();
      const scale = new NearFarScalar(1e4, 1.25, 5e6, 0.45);
      for (let i = 0; i < data.mmsi.length; i++) {
        const mmsi = data.mmsi[i] as number;
        byMmsi.set(mmsi, i);
        category.push(shipCategoryOf(data.shipType[i] as number));
        if (isMoving(i)) moving.push(i);
        const direction = (isMoving(i) ? data.course[i] : null) ?? data.heading[i] ?? data.course[i] ?? null;
        items.push(
          billboards.add({
            image: direction === null ? stillIcon : hullIcon,
            position: positionOf(i, now, scratch),
            rotation: direction === null ? 0 : -CesiumMath.toRadians(direction),
            alignedAxis: direction === null ? Cartesian3.ZERO : Cartesian3.UNIT_Z,
            scaleByDistance: scale,
            id: { layer: 'ships', key: String(mmsi) } satisfies PickId,
          }),
        );
      }
      selected = selectedMmsi === undefined ? undefined : byMmsi.get(selectedMmsi);
      for (let i = 0; i < items.length; i++) style(i);
      ground.refresh();
    };

    // Every frame rather than on a timer: Cesium rebuilds a billboard collection's buffers each time
    // updates start or stop arriving between frames, so a timer would rebuild them twice per tick.
    // From afar a ship moves less than a pixel in minutes: only animate up close, and only what's in view.
    const stopAnimating = globe.scene.preRender.addEventListener(() => {
      const { height, bounds } = globe.view;
      if (!data || !billboards.show || height > ANIMATE_BELOW || !bounds) return;
      const now = globe.now();
      for (const i of moving) {
        const b = items[i];
        if (b?.show && contains(bounds, data.lon[i] as number, data.lat[i] as number))
          b.position = positionOf(i, now, scratch);
      }
    });

    const describe = (key: string): Details | undefined => {
      const i = byMmsi.get(Number(key));
      if (i === undefined || !data) return undefined;
      const d = data;
      const mmsi = d.mmsi[i] as number;
      const type = shipTypeLabel(d.shipType[i] as number);
      const flag = flagOf(mmsi);
      const speed = d.speed[i];
      const course = d.course[i];
      const heading = d.heading[i];
      const status = navStatusLabel(d.status[i] as number);
      const length = d.length[i] as number;
      const width = d.width[i] as number;
      const now = globe.now();
      const at = where(i, now);
      return {
        kind: 'Ship',
        title: d.name[i] || `MMSI ${mmsi}`,
        subtitle: [type, flag].filter(Boolean).join(' · ') || undefined,
        fields: [
          { label: 'MMSI', value: String(mmsi) },
          ...(d.callsign[i] ? [{ label: 'Call sign', value: d.callsign[i] }] : []),
          ...(d.imo[i] ? [{ label: 'IMO', value: String(d.imo[i]) }] : []),
          { label: 'Type', value: type ?? '—' },
          ...(flag ? [{ label: 'Flag', value: flag }] : []),
          { label: 'Speed', value: speed == null ? '—' : `${formatNumber(speed)} kn` },
          { label: 'Course', value: course == null ? '—' : formatBearing(course) },
          ...(heading != null ? [{ label: 'Heading', value: formatBearing(heading) }] : []),
          ...(status ? [{ label: 'Status', value: status }] : []),
          ...(d.destination[i] ? [{ label: 'Destination', value: d.destination[i] }] : []),
          ...(length > 0
            ? [
                {
                  label: 'Size',
                  value:
                    width > 0 ? `${formatInt(length)} × ${formatInt(width)} m` : `${formatInt(length)} m`,
                },
              ]
            : []),
          { label: 'Position', value: formatLatLon(at.lat, at.lon) },
          { label: 'Last report', value: formatAge(now - (d.since + (d.time[i] as number)) * 1000) },
        ],
        links: [
          { label: 'MarineTraffic', href: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}` },
          { label: 'VesselFinder', href: `https://www.vesselfinder.com/vessels/details/${mmsi}` },
        ],
        position: () => {
          const index = byMmsi.get(mmsi);
          return index === undefined ? undefined : positionOf(index, globe.now(), new Cartesian3());
        },
      };
    };

    return {
      setVisible(visible) {
        billboards.show = visible;
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('ships', render);
        if (!visible) {
          unsubscribe?.();
          unsubscribe = undefined;
          clear();
        }
      },
      setFilter(visible) {
        shown = visible;
        for (let i = 0; i < items.length; i++) style(i);
      },
      details: describe,
      countIn(bounds) {
        if (!data) return 0;
        let n = 0;
        for (let i = 0; i < data.mmsi.length; i++)
          if (
            shown.has(category[i] as string) &&
            contains(bounds, data.lon[i] as number, data.lat[i] as number)
          )
            n++;
        return n;
      },
      highlight(key) {
        const i = byMmsi.get(Number(key));
        if (i === undefined) return () => {};
        const mmsi = data?.mmsi[i];
        selected = i;
        style(i);
        return () => {
          // A new snapshot may have moved the vessel to another index.
          const index = mmsi === undefined ? undefined : byMmsi.get(mmsi);
          if (selected === index) selected = undefined;
          if (index !== undefined) style(index);
        };
      },
      search(query, limit) {
        if (!data) return [];
        const q = query.trim().toUpperCase();
        const digits = /^\d+$/.test(q);
        const hits: SearchHit[] = [];
        for (let i = 0; i < data.mmsi.length && hits.length < limit; i++) {
          const name = data.name[i] as string;
          const mmsi = String(data.mmsi[i]);
          if (digits ? mmsi.startsWith(q) : name.includes(q) || data.callsign[i] === q)
            hits.push({
              layer: 'ships',
              key: mmsi,
              title: name || `MMSI ${mmsi}`,
              subtitle: ['Ship', shipTypeLabel(data.shipType[i] as number), flagOf(data.mmsi[i] as number)]
                .filter(Boolean)
                .join(' · '),
            });
        }
        return hits;
      },
      destroy() {
        stopAnimating();
        ground.stop();
        unsubscribe?.();
        globe.scene.primitives.remove(billboards);
      },
    };
  },
};
