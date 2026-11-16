import {
  ArcType,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  LabelCollection,
  LabelStyle,
  Material,
  NearFarScalar,
  type PointPrimitive,
  PointPrimitiveCollection,
  PolylineCollection,
  Cartesian2,
  VerticalOrigin,
} from 'cesium';
import type { SatRec } from 'satellite.js';
import { feeds } from '../../../src/catalog.ts';
import type { SatelliteData, SatelliteGroup } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { formatAge, formatInt, formatLatLon, formatNumber } from '../lib/format.ts';
import { ecfAt, orbitPath, orbitShape, satrecOf, stateAt } from './orbits.ts';
import type { WorkerRequest, WorkerResponse } from './satellites.worker.ts';
import type { Details, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

const groups: ReadonlyArray<Filter & { readonly id: SatelliteGroup; readonly size: number }> = [
  { id: 'station', label: 'Space stations', color: '#ffffff', size: 7 },
  { id: 'gnss', label: 'Navigation', color: '#6fcf97', size: 3.5 },
  { id: 'weather', label: 'Weather', color: '#56c7d8', size: 3.5 },
  { id: 'earth', label: 'Earth observation', color: '#e0b860', size: 3.5 },
  { id: 'starlink', label: 'Starlink', color: '#7f97b8', size: 2 },
  { id: 'oneweb', label: 'OneWeb', color: '#a08fd0', size: 2.5 },
  { id: 'kuiper', label: 'Kuiper', color: '#c98fc0', size: 2.5 },
  { id: 'other', label: 'Other', color: '#b5bfcc', size: 2.5 },
];
const groupById = new Map(groups.map((g) => [g.id, { ...g, cesium: Color.fromCssColorString(g.color) }]));
const groupLabel = (id: SatelliteGroup) => groupById.get(id)?.label ?? id;

const TICK_MS = 1000;
const ORBIT = Color.fromCssColorString('#cfd8e3').withAlpha(0.55);

export const satelliteLayer: LayerDef = {
  id: 'satellites',
  title: 'Satellites',
  category: 'space',
  description: 'Every active satellite, propagated from its latest orbital elements (SGP4) in your browser.',
  source: feeds.satellites.source,
  feed: 'satellites',
  defaultVisible: true,
  filters: groups,
  // The broadband constellations are ~10,000 satellites that would blanket the globe.
  defaultHidden: ['starlink', 'oneweb', 'kuiper'],
  create(globe): LayerHandle {
    const points = globe.scene.primitives.add(new PointPrimitiveCollection());
    const labels = globe.scene.primitives.add(new LabelCollection({ scene: globe.scene }));
    const orbits = globe.scene.primitives.add(new PolylineCollection());
    const worker = new Worker(new URL('./satellites.worker.ts', import.meta.url), { type: 'module' });

    let data: SatelliteData | undefined;
    let version = '';
    let items: PointPrimitive[] = [];
    let byNorad = new Map<number, number>();
    let shownGroups: ReadonlySet<string> = new Set(groups.map((g) => g.id));
    let inFlight = false;
    let selected: number | undefined;
    const satrecs = new Map<number, SatRec | null>();
    const satrec = (i: number) => {
      if (!data) return null;
      if (!satrecs.has(i)) satrecs.set(i, satrecOf(data, i));
      return satrecs.get(i) ?? null;
    };

    const visibleGroup = (i: number) => data !== undefined && shownGroups.has(data.group[i] as string);

    const scratch = new Cartesian3();
    worker.addEventListener('message', ({ data: message }: MessageEvent<WorkerResponse>) => {
      inFlight = false;
      if (message.version !== version) return;
      const p = message.positions;
      for (let i = 0; i < items.length; i++) {
        const point = items[i] as PointPrimitive;
        const x = p[i * 3] as number;
        if (Number.isNaN(x)) {
          point.show = false;
          continue;
        }
        point.show = visibleGroup(i);
        // The setter copies, so one scratch vector serves every point.
        point.position = Cartesian3.fromElements(x, p[i * 3 + 1] as number, p[i * 3 + 2] as number, scratch);
      }
      for (let k = 0; k < labels.length; k++) {
        const label = labels.get(k);
        const i = (label.id as PickId & { index: number }).index;
        const x = p[i * 3] as number;
        label.show = !Number.isNaN(x) && visibleGroup(i);
        if (!Number.isNaN(x))
          label.position = Cartesian3.fromElements(
            x,
            p[i * 3 + 1] as number,
            p[i * 3 + 2] as number,
            scratch,
          );
      }
    });

    const tick = () => {
      if (!data || !points.show || inFlight) return;
      inFlight = true;
      worker.postMessage({ type: 'tick', version, time: globe.now() } satisfies WorkerRequest, []);
    };
    const timer = setInterval(tick, TICK_MS);

    const render = (snapshot: Snapshot<'satellites'>) => {
      data = snapshot.data;
      version = snapshot.version;
      satrecs.clear();
      points.removeAll();
      labels.removeAll();
      byNorad = new Map();
      items = data.name.map((name, i) => {
        const group = groupById.get(data?.group[i] as SatelliteGroup) ?? groupById.get('other');
        const norad = data?.noradId[i] as number;
        byNorad.set(norad, i);
        if (group?.id === 'station' && /^(ISS|CSS) \(/.test(name))
          labels.add({
            position: Cartesian3.ZERO,
            text: name.startsWith('ISS') ? 'ISS' : 'Tiangong',
            font: '500 12px Inter, system-ui, sans-serif',
            fillColor: Color.WHITE.withAlpha(0.9),
            outlineColor: Color.BLACK.withAlpha(0.8),
            outlineWidth: 3,
            style: LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cartesian2(0, -10),
            verticalOrigin: VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new DistanceDisplayCondition(0, 4e7),
            show: false,
            id: { layer: 'satellites', key: String(norad), index: i },
          });
        return points.add({
          show: false,
          pixelSize: group?.size ?? 2.5,
          color: group?.cesium ?? Color.WHITE,
          scaleByDistance: new NearFarScalar(1e6, 1.6, 5e7, 0.8),
          id: { layer: 'satellites', key: String(norad) } satisfies PickId,
        });
      });
      worker.postMessage({ type: 'init', version, data } satisfies WorkerRequest, []);
      inFlight = false;
      tick();
    };

    let unsubscribe: (() => void) | undefined;

    const drawOrbit = (i: number) => {
      orbits.removeAll();
      const rec = satrec(i);
      if (!rec || !data) return;
      const flat = orbitPath(rec, globe.now(), data.meanMotion[i] as number);
      orbits.add({
        positions: Cartesian3.unpackArray(flat),
        width: 1.25,
        arcType: ArcType.NONE,
        material: Material.fromType('Color', { color: ORBIT }),
      });
    };
    const orbitTimer = setInterval(() => {
      if (selected !== undefined && points.show) drawOrbit(selected);
    }, 15_000);

    const describe = (key: string): Details | undefined => {
      const i = byNorad.get(Number(key));
      if (i === undefined || !data) return undefined;
      const rec = satrec(i);
      const now = globe.now();
      const state = rec ? stateAt(rec, now) : undefined;
      const shape = orbitShape(data.meanMotion[i] as number, data.eccentricity[i] as number);
      const epoch = Date.parse(`${data.epoch[i]}Z`);
      return {
        kind: 'Satellite',
        title: data.name[i] as string,
        subtitle: groupLabel(data.group[i] as SatelliteGroup),
        fields: [
          { label: 'NORAD ID', value: String(data.noradId[i]) },
          { label: 'International designator', value: data.objectId[i] as string },
          ...(state
            ? [
                { label: 'Altitude', value: `${formatInt(state.altitude)} km` },
                { label: 'Speed', value: `${formatNumber(state.speed, 2)} km/s` },
                { label: 'Over', value: formatLatLon(state.lat, state.lon) },
              ]
            : [{ label: 'Position', value: 'Elements no longer propagate (likely decayed)' }]),
          { label: 'Period', value: `${formatNumber(shape.period)} min` },
          { label: 'Perigee / apogee', value: `${formatInt(shape.perigee)} / ${formatInt(shape.apogee)} km` },
          { label: 'Inclination', value: `${formatNumber(data.inclination[i] as number)}°` },
          { label: 'Elements epoch', value: Number.isFinite(epoch) ? formatAge(now - epoch) : '—' },
        ],
        links: [
          {
            label: 'CelesTrak catalog entry',
            href: `https://celestrak.org/satcat/table-satcat.php?CATNR=${data.noradId[i]}`,
          },
        ],
        position: () => {
          const r = satrec(i);
          const p = r ? ecfAt(r, globe.now()) : undefined;
          return p ? new Cartesian3(p.x, p.y, p.z) : undefined;
        },
      };
    };

    return {
      setVisible(visible) {
        points.show = visible;
        labels.show = visible;
        orbits.show = visible;
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('satellites', render);
        if (!visible && unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      },
      setFilter(visible) {
        shownGroups = visible;
        inFlight = false;
        tick();
      },
      details: describe,
      highlight(key) {
        const i = byNorad.get(Number(key));
        if (i === undefined) return () => {};
        selected = i;
        const point = items[i];
        const before = point ? { size: point.pixelSize, outline: point.outlineWidth } : undefined;
        if (point) {
          point.pixelSize = Math.max(8, point.pixelSize * 2);
          point.outlineColor = Color.WHITE;
          point.outlineWidth = 2;
        }
        drawOrbit(i);
        return () => {
          if (point && before) {
            point.pixelSize = before.size;
            point.outlineWidth = before.outline;
          }
          orbits.removeAll();
          if (selected === i) selected = undefined;
        };
      },
      search(query, limit) {
        if (!data) return [];
        const q = query.trim().toUpperCase();
        const hits: SearchHit[] = [];
        for (let i = 0; i < data.name.length && hits.length < limit; i++) {
          const name = data.name[i] as string;
          if (name.toUpperCase().includes(q) || String(data.noradId[i]) === q)
            hits.push({
              layer: 'satellites',
              key: String(data.noradId[i]),
              title: name,
              subtitle: `Satellite · ${groupLabel(data.group[i] as SatelliteGroup)} · NORAD ${data.noradId[i]}`,
            });
        }
        return hits;
      },
      destroy() {
        clearInterval(timer);
        clearInterval(orbitTimer);
        unsubscribe?.();
        worker.terminate();
        globe.scene.primitives.remove(points);
        globe.scene.primitives.remove(labels);
        globe.scene.primitives.remove(orbits);
      },
    };
  },
};
