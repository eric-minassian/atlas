import {
  ArcType,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  GeometryInstance,
  LabelCollection,
  LabelStyle,
  Matrix3,
  Matrix4,
  NearFarScalar,
  type PointPrimitive,
  PointPrimitiveCollection,
  PolylineColorAppearance,
  PolylineGeometry,
  Primitive,
  PrimitiveCollection,
  VerticalOrigin,
} from 'cesium';
import type { SatRec } from 'satellite.js';
import { feeds } from '../../../src/catalog.ts';
import type { SatelliteData, SatelliteGroup } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { Globe, PickId } from '../globe/globe.ts';
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
const ORBIT = Color.fromCssColorString('#cfd8e3');
/** The orbit line is this opaque at the satellite, fading along the revolution ahead of it to the tail. */
const ORBIT_ALPHA = { head: 0.85, tail: 0.1 };
const ORBIT_SAMPLES = 360;
/** The orbit is recomputed this often; in between it turns with the Earth (drag and perturbations are slow). */
const ORBIT_REFRESH_MS = 30_000;
/** The Earth's rotation rate, rad/s. */
const EARTH_ROTATION = 7.292115e-5;
/** A low orbit's speed (m/s) and height (m): what sets how fast satellites cross the screen. */
const LEO_SPEED = 7600;
const LEO_HEIGHT = 550_000;

/**
 * How often satellites need moving so none jumps more than about half a pixel
 * (seconds): every frame up close, once a second (each new state) from far
 * out, where they creep.
 */
const placeInterval = (globe: Globe): number => {
  const { height } = globe.view;
  const distance = Math.max(400_000, Math.abs(height - LEO_HEIGHT));
  // About 60° of view across the canvas height.
  const metersPerPixel = (distance * 1.15) / Math.max(1, globe.scene.canvas.clientHeight);
  return Math.min(1, 0.5 / (LEO_SPEED / metersPerPixel));
};

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
    const orbits = globe.scene.primitives.add(new PrimitiveCollection());
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

    /** Each satellite's Earth-fixed position and velocity at `statesAt` (see the worker). */
    let states: Float64Array | undefined;
    let statesAt = 0;
    let placedAt = Number.NEGATIVE_INFINITY;
    const scratch = new Cartesian3();
    /** Where satellite i is now: its last state carried along its velocity (meters off after a second). */
    const positionAt = (i: number, seconds: number, s: Float64Array): Cartesian3 => {
      const o = i * 6;
      return Cartesian3.fromElements(
        (s[o] as number) + (s[o + 3] as number) * seconds,
        (s[o + 1] as number) + (s[o + 4] as number) * seconds,
        (s[o + 2] as number) + (s[o + 5] as number) * seconds,
        scratch,
      );
    };
    const place = () => {
      const s = states;
      if (!s) return;
      placedAt = performance.now();
      const seconds = (globe.now() - statesAt) / 1000;
      // The setters copy, so one scratch vector serves every point.
      for (let i = 0; i < items.length; i++) {
        const point = items[i] as PointPrimitive;
        if (point.show) point.position = positionAt(i, seconds, s);
      }
      for (let k = 0; k < labels.length; k++) {
        const label = labels.get(k);
        if (label.show)
          label.position = positionAt((label.id as PickId & { index: number }).index, seconds, s);
      }
    };

    worker.addEventListener('message', ({ data: message }: MessageEvent<WorkerResponse>) => {
      inFlight = false;
      if (message.version !== version) return;
      const s = message.states;
      states = s;
      statesAt = message.time;
      for (let i = 0; i < items.length; i++)
        (items[i] as PointPrimitive).show = !Number.isNaN(s[i * 6]) && visibleGroup(i);
      for (let k = 0; k < labels.length; k++) {
        const label = labels.get(k);
        const i = (label.id as PickId & { index: number }).index;
        label.show = !Number.isNaN(s[i * 6]) && visibleGroup(i);
      }
      place();
    });

    // Between states, satellites move along their velocity: every frame when they're crossing the
    // screen fast enough to show steps, less often from far out.
    const stopPlacing = globe.scene.preRender.addEventListener(() => {
      if (!states || !points.show) return;
      if (performance.now() - placedAt >= placeInterval(globe) * 1000 - 4) place();
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
      states = undefined;
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

    /** The drawn orbit, and the time its points are Earth-fixed for. */
    let orbit: { readonly primitive: Primitive; readonly at: number } | undefined;
    const drawOrbit = (i: number) => {
      orbits.removeAll();
      orbit = undefined;
      const rec = satrec(i);
      if (!rec || !data) return;
      const at = globe.now();
      const positions = Cartesian3.unpackArray(
        orbitPath(rec, at, data.meanMotion[i] as number, ORBIT_SAMPLES),
      );
      if (positions.length < 2) return;
      // Bright where the satellite is and heading, fading around the revolution to just behind it.
      const colors = positions.map((_, k) =>
        ORBIT.withAlpha(
          ORBIT_ALPHA.head + (ORBIT_ALPHA.tail - ORBIT_ALPHA.head) * (k / (positions.length - 1)),
        ),
      );
      const primitive = new Primitive({
        geometryInstances: new GeometryInstance({
          geometry: new PolylineGeometry({
            positions,
            colors,
            colorsPerVertex: true,
            width: 1.5,
            arcType: ArcType.NONE,
            vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
          }),
        }),
        appearance: new PolylineColorAppearance({ translucent: true }),
        asynchronous: false,
        allowPicking: false,
      });
      orbits.add(primitive);
      orbit = { primitive, at };
    };
    const orbitTimer = setInterval(() => {
      if (selected !== undefined && points.show) drawOrbit(selected);
    }, ORBIT_REFRESH_MS);
    // The orbit's points are fixed to the Earth as it was when they were computed; the orbit itself
    // stays put while the Earth turns under it, so turn them back by as much, every frame.
    const turn = new Matrix3();
    const stopTurning = globe.scene.preRender.addEventListener(() => {
      if (!orbit) return;
      const angle = (-EARTH_ROTATION * (globe.now() - orbit.at)) / 1000;
      Matrix4.fromRotation(Matrix3.fromRotationZ(angle, turn), orbit.primitive.modelMatrix);
    });

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
          orbit = undefined;
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
        stopPlacing();
        stopTurning();
        unsubscribe?.();
        worker.terminate();
        globe.scene.primitives.remove(points);
        globe.scene.primitives.remove(labels);
        globe.scene.primitives.remove(orbits);
      },
    };
  },
};
