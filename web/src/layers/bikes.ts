import {
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  HeightReference,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  VerticalOrigin,
} from 'cesium';
import { contains } from '../../../src/area.ts';
import { areaZooms, feeds } from '../../../src/catalog.ts';
import type { BikeStations } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { AreaTiles } from '../data/area.ts';
import { layerStatus } from '../data/status.ts';
import type { PickId } from '../globe/globe.ts';
import { followGround } from '../globe/ground.ts';
import { formatAge, formatInt, formatLatLon } from '../lib/format.ts';
import type { Details, LayerDef, LayerHandle, SearchHit } from './types.ts';

const availability = [
  { id: 'plenty', label: '3 or more bikes', color: '#5cc98a' },
  { id: 'few', label: '1–2 bikes', color: '#e6b84d' },
  { id: 'empty', label: 'No bikes', color: '#e0645a' },
  { id: 'closed', label: 'Not renting', color: '#7d848e' },
] as const;
type Availability = (typeof availability)[number]['id'];
const colorOf = new Map(availability.map((a) => [a.id, Color.fromCssColorString(a.color)]));

const availabilityOf = (bikes: number, renting: boolean): Availability =>
  !renting ? 'closed' : bikes === 0 ? 'empty' : bikes < 3 ? 'few' : 'plenty';

/** Bike counts show beside stations this close in. */
const COUNT_LABEL_HEIGHT = 3_000;

const stationIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="6" fill="#fff" stroke="rgba(0,0,0,0.7)" stroke-width="1.5"/></svg>',
)}`;

interface Station {
  readonly key: string;
  readonly system: BikeStations['systems'][number];
  readonly id: string;
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
  readonly bikes: number;
  readonly ebikes: number | null;
  readonly docks: number | null;
  readonly capacity: number | null;
  readonly renting: boolean;
  readonly returning: boolean;
  readonly reported: number | null;
}

const stationsOf = (answer: BikeStations): Station[] => {
  const d = answer.data;
  return d.id.map((id, i) => {
    const system = answer.systems[d.system[i] as number] ?? { id: '', name: '', website: '', ok: true };
    return {
      key: `${system.id}:${id}`,
      system,
      id,
      name: d.name[i] as string,
      lon: d.lon[i] as number,
      lat: d.lat[i] as number,
      bikes: d.bikes[i] as number,
      ebikes: d.ebikes[i] ?? null,
      docks: d.docks[i] ?? null,
      capacity: d.capacity[i] ?? null,
      renting: d.renting[i] as boolean,
      returning: d.returning[i] as boolean,
      reported: d.reported[i] ?? null,
    };
  });
};

export const bikeLayer: LayerDef = {
  id: 'bikes',
  title: 'Bike share',
  category: 'city',
  description:
    'Docked bike-share stations and what they have now: bikes, e-bikes and free docks, from each system’s GBFS feed.',
  source: feeds.bikeSystems.source,
  defaultVisible: false,
  range: { max: 30_000 },
  legend: availability.map(({ label, color }) => ({ label, color })),
  create(globe): LayerHandle {
    const billboards = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    const labels = globe.scene.primitives.add(new LabelCollection({ scene: globe.scene }));
    const ground = followGround(globe, [billboards, labels]);
    let stations = new Map<string, Station>();
    let selected: string | undefined;
    const billboardOf = new Map<string, ReturnType<typeof billboards.add>>();

    const style = (key: string) => {
      const station = stations.get(key);
      const billboard = billboardOf.get(key);
      if (!station || !billboard) return;
      billboard.color =
        key === selected
          ? Color.WHITE
          : (colorOf.get(availabilityOf(station.bikes, station.renting)) as Color);
      billboard.scale = key === selected ? 1.3 : 0.85;
    };

    const clear = () => {
      billboards.removeAll();
      labels.removeAll();
      billboardOf.clear();
      stations = new Map();
    };

    const show = (answers: ReadonlyArray<BikeStations>) => {
      clear();
      const scale = new NearFarScalar(500, 1.3, 30_000, 0.45);
      for (const answer of answers)
        for (const station of stationsOf(answer)) {
          if (stations.has(station.key)) continue;
          stations.set(station.key, station);
          const position = Cartesian3.fromDegrees(station.lon, station.lat, 0);
          const id = { layer: 'bikes', key: station.key } satisfies PickId;
          billboardOf.set(
            station.key,
            billboards.add({
              image: stationIcon,
              position,
              heightReference: HeightReference.CLAMP_TO_GROUND,
              scaleByDistance: scale,
              id,
            }),
          );
          labels.add({
            position,
            text: String(station.bikes),
            heightReference: HeightReference.CLAMP_TO_GROUND,
            font: '600 11px Inter, system-ui, sans-serif',
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK.withAlpha(0.8),
            outlineWidth: 3,
            style: LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(0, -9),
            distanceDisplayCondition: new DistanceDisplayCondition(0, COUNT_LABEL_HEIGHT),
            id,
          });
          style(station.key);
        }

      const systems = new Map(answers.flatMap((a) => a.systems.map((s) => [s.id, s] as const)));
      const failed = [...systems.values()].filter((s) => !s.ok);
      layerStatus.set('bikes', {
        text: systems.size === 0 ? 'None here' : formatInt(stations.size),
        detail:
          systems.size === 0
            ? 'No docked bike-share system publishes stations here.'
            : [
                `${[...systems.values()]
                  .filter((s) => s.ok)
                  .map((s) => s.name)
                  .join(', ')}.`,
                failed.length > 0 ? `Not answering: ${failed.map((s) => s.name).join(', ')}.` : '',
              ]
                .filter(Boolean)
                .join(' '),
        tone: failed.length > 0 && failed.length === systems.size ? 'warn' : 'muted',
      });
    };

    const tiles = new AreaTiles<BikeStations>(globe, {
      zoom: areaZooms.bikes,
      maxTiles: 16,
      ttlMs: 60_000,
      load: (tile) => callApi((api) => api.live.bikes({ params: tile })),
      onChange: (loaded) => show(loaded.map((t) => t.data)),
      onError: () =>
        layerStatus.set('bikes', {
          text: 'Unavailable',
          detail: 'Atlas didn’t answer. Retrying.',
          tone: 'warn',
        }),
    });

    const describe = (key: string): Details | undefined => {
      const s = stations.get(key);
      if (!s) return undefined;
      const status = !s.renting
        ? 'Not renting'
        : s.returning
          ? 'Renting and taking returns'
          : 'Renting; no returns';
      return {
        kind: 'Bike-share station',
        title: s.name || s.id,
        subtitle: s.system.name,
        fields: [
          { label: 'Bikes', value: formatInt(s.bikes) },
          ...(s.ebikes !== null ? [{ label: 'E-bikes', value: formatInt(s.ebikes) }] : []),
          ...(s.docks !== null ? [{ label: 'Free docks', value: formatInt(s.docks) }] : []),
          ...(s.capacity !== null ? [{ label: 'Capacity', value: formatInt(s.capacity) }] : []),
          { label: 'Status', value: status },
          { label: 'Position', value: formatLatLon(s.lat, s.lon) },
          ...(s.reported !== null
            ? [{ label: 'Last report', value: formatAge(globe.now() - s.reported * 1000) }]
            : []),
        ],
        links: s.system.website ? [{ label: s.system.name, href: s.system.website }] : [],
        position: () => Cartesian3.fromDegrees(s.lon, s.lat, globe.heightAt(s.lon, s.lat) ?? 0),
      };
    };

    return {
      loaded: tiles.loaded,
      setVisible(visible) {
        billboards.show = visible;
        labels.show = visible;
        tiles.setActive(visible);
        if (!visible) {
          clear();
          layerStatus.set('bikes', { text: '' });
        }
      },
      details: describe,
      countIn(bounds) {
        let n = 0;
        for (const s of stations.values()) if (contains(bounds, s.lon, s.lat)) n++;
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
        for (const s of stations.values()) {
          if (hits.length >= limit) break;
          if (s.name.toLowerCase().includes(q))
            hits.push({
              layer: 'bikes',
              key: s.key,
              title: s.name,
              subtitle: `Bike share · ${s.system.name} · ${formatInt(s.bikes)} bikes`,
            });
        }
        return hits;
      },
      destroy() {
        ground.stop();
        tiles.destroy();
        globe.scene.primitives.remove(billboards);
        globe.scene.primitives.remove(labels);
      },
    };
  },
};
