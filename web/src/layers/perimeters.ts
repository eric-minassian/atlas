import { Cartesian3, Color, NearFarScalar, type PointPrimitive, PointPrimitiveCollection } from 'cesium';
import { contains } from '../../../src/area.ts';
import { feeds, wfigsPerimeters } from '../../../src/catalog.ts';
import type { FirePerimeter } from '../../../src/domain.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import { formatAge, formatInt, formatNumber, formatUtc } from '../lib/format.ts';
import { boundsOf, GroundShapes, ringsOf } from './areas.ts';
import type { Details, LayerDef, LayerHandle, SearchHit } from './types.ts';

const kinds = [
  { id: 'active', label: 'Not contained', color: '#ff6a3d' },
  { id: 'contained', label: 'Contained', color: '#c9a27a' },
  { id: 'prescribed', label: 'Prescribed fire', color: '#e0b84a' },
] as const;
type Kind = (typeof kinds)[number]['id'];
const colors = new Map(kinds.map((k) => [k.id, Color.fromCssColorString(k.color)]));

const kindOf = (fire: FirePerimeter): Kind =>
  fire.kind === 'RX' ? 'prescribed' : (fire.contained ?? 0) >= 100 ? 'contained' : 'active';

const ACRES_PER_KM2 = 247.105;
const SELECTED = Color.WHITE;

const titles: Readonly<Record<string, string>> = {
  WF: 'Wildfire',
  RX: 'Prescribed fire',
  CX: 'Fire complex',
};

export const perimeterLayer: LayerDef = {
  id: 'fire-perimeters',
  title: 'Wildfire perimeters',
  category: 'hazards',
  description:
    'Current mapped perimeters of US wildland fires, with containment, from the interagency WFIGS service.',
  source: feeds.firePerimeters.source,
  feed: 'firePerimeters',
  defaultVisible: true,
  legend: kinds.map(({ label, color }) => ({ label, color })),
  create(globe): LayerHandle {
    const shapes = new GroundShapes(globe, 'fire-perimeters');
    const selection = new GroundShapes(globe, 'fire-perimeters');
    // A marker per fire: most perimeters are too small to see from beyond a few hundred kilometers.
    const points = globe.scene.primitives.add(new PointPrimitiveCollection());
    let fires: ReadonlyArray<FirePerimeter> = [];
    let byId = new Map<string, { readonly fire: FirePerimeter; readonly point: PointPrimitive }>();
    let seated: Array<{ readonly fire: FirePerimeter; readonly point: PointPrimitive }> = [];
    let selected: string | undefined;
    let unsubscribe: (() => void) | undefined;
    const ground = trackGround(globe, () => ({
      size: seated.length,
      lon: (i) => seated[i]?.fire.lon ?? 0,
      lat: (i) => seated[i]?.fire.lat ?? 0,
      place: (i, position) => {
        const entry = seated[i];
        if (entry) entry.point.position = position;
      },
    }));

    const draw = () => {
      shapes.set(
        fires.map((fire) => {
          const color = colors.get(kindOf(fire)) as Color;
          return {
            key: fire.id,
            polygons: fire.polygons,
            fill: color.withAlpha(0.3),
            outline: color.withAlpha(0.95),
          };
        }),
      );
    };

    const outlineSelected = () => {
      const fire = selected === undefined ? undefined : byId.get(selected)?.fire;
      selection.set(fire ? [{ key: fire.id, polygons: fire.polygons, outline: SELECTED, width: 2.5 }] : []);
    };

    const render = (snapshot: Snapshot<'firePerimeters'>) => {
      fires = snapshot.data.fires;
      points.removeAll();
      byId = new Map();
      // Largest first (the snapshot's order), so a small fire's marker isn't hidden under a large one's.
      for (const fire of fires) {
        const point = points.add({
          position: Cartesian3.fromDegrees(fire.lon, fire.lat, 0),
          pixelSize: 6,
          color: colors.get(kindOf(fire)) as Color,
          outlineColor: Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          scaleByDistance: new NearFarScalar(2e5, 1.2, 1e7, 0.7),
          id: { layer: 'fire-perimeters', key: fire.id } satisfies PickId,
        });
        byId.set(fire.id, { fire, point });
      }
      seated = [...byId.values()];
      ground.refresh();
      draw();
      outlineSelected();
    };

    const describe = (id: string): Details | undefined => {
      const fire = byId.get(id)?.fire;
      if (!fire) return undefined;
      const extent = boundsOf(ringsOf(fire.polygons));
      const place = [fire.county ? `${fire.county} County` : '', fire.state].filter(Boolean).join(', ');
      const now = globe.now();
      return {
        kind: titles[fire.kind] ?? 'Wildfire',
        title: fire.name,
        ...(place ? { subtitle: place } : {}),
        fields: [
          ...(fire.acres === null
            ? []
            : [
                {
                  label: 'Size',
                  value: `${formatInt(fire.acres)} acres · ${formatNumber(fire.acres / ACRES_PER_KM2)} km²`,
                },
              ]),
          {
            label: 'Containment',
            value: fire.contained === null ? 'Not reported' : `${formatInt(fire.contained)}%`,
          },
          ...(fire.discovered === null
            ? []
            : [
                {
                  label: 'Discovered',
                  value: `${formatAge(now - fire.discovered)} · ${formatUtc(fire.discovered)}`,
                },
              ]),
          ...(fire.mapped === null
            ? []
            : [
                {
                  label: 'Perimeter mapped',
                  value: `${formatAge(now - fire.mapped)} · ${formatUtc(fire.mapped)}`,
                },
              ]),
          ...(fire.cause ? [{ label: 'Cause', value: fire.cause }] : []),
          ...(fire.personnel ? [{ label: 'Personnel', value: formatInt(fire.personnel) }] : []),
          ...(fire.fireId ? [{ label: 'Fire ID', value: fire.fireId }] : []),
        ],
        links: [
          {
            label: 'WFIGS record',
            href: `${wfigsPerimeters}/query?where=${encodeURIComponent(`attr_IrwinID='{${fire.id.toUpperCase()}}'`)}&outFields=*&returnGeometry=false&f=html`,
          },
        ],
        ...(extent ? { extent } : {}),
      };
    };

    return {
      setVisible(visible) {
        points.show = visible;
        shapes.setVisible(visible);
        selection.setVisible(visible);
        if (visible && !unsubscribe) unsubscribe = feedPoller.subscribe('firePerimeters', render);
        if (!visible && unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
          shapes.clear();
          selection.clear();
          points.removeAll();
          fires = [];
          byId = new Map();
          seated = [];
        }
      },
      details: describe,
      highlight(id) {
        selected = id;
        const point = byId.get(id)?.point;
        if (point) point.outlineColor = SELECTED;
        outlineSelected();
        return () => {
          if (point) point.outlineColor = Color.BLACK.withAlpha(0.6);
          if (selected !== id) return;
          selected = undefined;
          outlineSelected();
        };
      },
      search(query, limit) {
        const q = query.trim().toLowerCase();
        const hits: SearchHit[] = [];
        for (const fire of fires) {
          if (hits.length >= limit) break;
          if (fire.name.toLowerCase().includes(q))
            hits.push({
              layer: 'fire-perimeters',
              key: fire.id,
              title: fire.name,
              subtitle: [
                titles[fire.kind] ?? 'Wildfire',
                fire.state,
                fire.acres === null ? '' : `${formatInt(fire.acres)} acres`,
              ]
                .filter(Boolean)
                .join(' · '),
            });
        }
        return hits;
      },
      countIn(bounds) {
        let n = 0;
        for (const fire of fires) if (contains(bounds, fire.lon, fire.lat)) n++;
        return n;
      },
      destroy() {
        ground.stop();
        unsubscribe?.();
        shapes.destroy();
        selection.destroy();
        globe.scene.primitives.remove(points);
      },
    };
  },
};
