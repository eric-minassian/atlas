import {
  type Billboard,
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CorridorGeometry,
  DistanceDisplayCondition,
  GeometryInstance,
  GroundPrimitive,
  type Label,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  PerInstanceColorAppearance,
  VerticalOrigin,
} from 'cesium';
import { Effect } from 'effect';
import { contains, tileAt } from '../../../src/area.ts';
import { areaZooms, feeds } from '../../../src/catalog.ts';
import type { AirportData, AirportType } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { AreaTiles, type Tile } from '../data/area.ts';
import { feedPoller, type Snapshot } from '../data/feeds.ts';
import type { PickId } from '../globe/globe.ts';
import { trackGround } from '../globe/ground.ts';
import { formatInt, formatLatLon } from '../lib/format.ts';
import type { Details, Field, Filter, LayerDef, LayerHandle, SearchHit } from './types.ts';

const types: ReadonlyArray<Filter & { readonly id: AirportType }> = [
  { id: 'large', label: 'Large', color: '#e8eef5' },
  { id: 'medium', label: 'Medium', color: '#9fc4e8' },
  { id: 'small', label: 'Small', color: '#8ea3ba' },
  { id: 'heliport', label: 'Heliports', color: '#c79be0' },
  { id: 'seaplane', label: 'Seaplane bases', color: '#5fc2c7' },
  { id: 'balloonport', label: 'Balloonports', color: '#d8a86a' },
];
const colorOf = new Map(types.map((t) => [t.id, Color.fromCssColorString(t.color)]));
const typeLabel: Readonly<Record<AirportType, string>> = {
  large: 'Large airport',
  medium: 'Medium airport',
  small: 'Small airport',
  heliport: 'Heliport',
  seaplane: 'Seaplane base',
  balloonport: 'Balloonport',
};

/**
 * Camera heights each kind appears below. Large and medium airports come with
 * the global feed; the rest load by tile once the view is a city or two across.
 */
const MEDIUM_HEIGHT = 900_000;
const TILE_HEIGHT = 150_000;
const RUNWAY_HEIGHT = 60_000;
/** Labels at once, at most: past this they overlap into noise anyway. */
const MAX_LABELS = 300;
const LABEL_HEIGHT: Readonly<Record<AirportType, number>> = {
  large: 1_500_000,
  medium: 400_000,
  small: 40_000,
  heliport: 25_000,
  seaplane: 25_000,
  balloonport: 25_000,
};
const FEET = 0.3048;
const RUNWAY = Color.fromCssColorString('#d6dce3').withAlpha(0.6);

const glyph = (body: string, size: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${body}</svg>`,
  )}`;
const ring = 'stroke="rgba(0,0,0,0.7)" stroke-width="1.4"';
/** White glyphs that billboards tint: a runway cross for airports, H for heliports, a wave for seaplane bases. */
const icons: Readonly<Record<AirportType, string>> = {
  large: glyph(
    `<circle cx="12" cy="12" r="10" fill="#fff" ${ring}/><path d="M7 15.5 17 8.5M9.5 7.5l6.5 9" stroke="#000" stroke-opacity="0.75" stroke-width="2.2" stroke-linecap="round"/>`,
    24,
  ),
  medium: glyph(
    `<circle cx="12" cy="12" r="9" fill="#fff" ${ring}/><path d="M7.5 15 16.5 9" stroke="#000" stroke-opacity="0.75" stroke-width="2.2" stroke-linecap="round"/>`,
    20,
  ),
  small: glyph(`<circle cx="12" cy="12" r="7" fill="#fff" ${ring}/>`, 16),
  heliport: glyph(
    `<circle cx="12" cy="12" r="9" fill="#fff" ${ring}/><path d="M8.5 7v10M15.5 7v10M8.5 12h7" stroke="#000" stroke-opacity="0.75" stroke-width="2"/>`,
    18,
  ),
  seaplane: glyph(
    `<circle cx="12" cy="12" r="9" fill="#fff" ${ring}/><path d="M6.5 13c1.8-1.6 3.7-1.6 5.5 0s3.7 1.6 5.5 0" fill="none" stroke="#000" stroke-opacity="0.75" stroke-width="2"/>`,
    18,
  ),
  balloonport: glyph(`<circle cx="12" cy="12" r="7" fill="#fff" ${ring}/>`, 16),
};

const surfaces: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(ASP|ASPH|ASPHALT|BIT|BITUMEN|TAR|MAC)/, 'Asphalt'],
  [/^(CON|CONC|CONCRETE|PEM|PAV|PAVED)/, 'Paved'],
  [/^(GRS|GRASS|TURF|TRF)/, 'Grass'],
  [/^(GRE|GRV|GRVL|GRAVEL|GVL)/, 'Gravel'],
  [/^(DIRT|EARTH|SOIL|CLA|CLAY|LAT)/, 'Dirt'],
  [/^(WATER|WAT)/, 'Water'],
  [/^SAND/, 'Sand'],
  [/^(SNOW|ICE)/, 'Snow or ice'],
];
const surfaceLabel = (surface: string): string | undefined => {
  const code = surface.trim().toUpperCase();
  if (!code || code === 'UNK' || code === 'U') return undefined;
  return surfaces.find(([pattern]) => pattern.test(code))?.[1] ?? surface;
};

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code: string) => {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
};

/** One airport as drawn: where it is, and which dataset (global or a tile) has it. */
interface Drawn {
  readonly ident: string;
  readonly type: AirportType;
  readonly lon: number;
  readonly lat: number;
  readonly code: string;
  readonly billboard: Billboard;
}

/** An airport's full record: the dataset holding it and its index there. */
interface AirportRecord {
  readonly data: AirportData;
  readonly index: number;
}

export const airportLayer: LayerDef = {
  id: 'airports',
  title: 'Airports',
  category: 'air',
  description:
    'Open airports, heliports and seaplane bases. Large airports from regional zoom, medium closer in, the rest and their runways at city scale.',
  source: feeds.airports.source,
  feed: 'airports',
  defaultVisible: true,
  range: { max: 3_000_000 },
  filters: types,
  create(globe): LayerHandle {
    const billboards = globe.scene.primitives.add(new BillboardCollection({ scene: globe.scene }));
    const labels = globe.scene.primitives.add(new LabelCollection({ scene: globe.scene }));
    let runways: GroundPrimitive | undefined;
    let visible = false;
    let shown: ReadonlySet<string> = new Set(types.map((t) => t.id));
    let unsubscribe: (() => void) | undefined;
    let selected: string | undefined;

    /** The global cut: large and medium airports, no runways. */
    let major: AirportData | undefined;
    let majorByIdent = new Map<string, number>();
    /** Every airport in the loaded tiles, with runways. */
    let local: ReadonlyArray<AirportData> = [];
    let localByIdent = new Map<string, AirportRecord>();
    /** Tiles fetched to describe a selected airport the view hasn't loaded. */
    const forDetails = new Map<string, AirportData | 'loading'>();
    let drawn: Drawn[] = [];
    let drawnByIdent = new Map<string, Drawn>();
    const labelOf = new Map<string, Label>();

    const ground = trackGround(globe, () => ({
      size: drawn.length,
      lon: (i) => drawn[i]?.lon ?? 0,
      lat: (i) => drawn[i]?.lat ?? 0,
      lift: () => 2,
      place: (i, position) => {
        const d = drawn[i];
        if (!d) return;
        d.billboard.position = position;
        const label = labelOf.get(d.ident);
        if (label) label.position = position;
      },
    }));

    const style = (d: Drawn) => {
      d.billboard.show = shown.has(d.type);
      d.billboard.color = d.ident === selected ? Color.WHITE : (colorOf.get(d.type) as Color);
      d.billboard.scale = d.ident === selected ? 1.35 : 1;
    };

    const draw = (data: AirportData, i: number) => {
      const a = data.airports;
      const ident = a.ident[i] as string;
      const type = a.type[i] as AirportType;
      const lon = a.lon[i] as number;
      const lat = a.lat[i] as number;
      const position = Cartesian3.fromDegrees(lon, lat, 0);
      const id = { layer: 'airports', key: ident } satisfies PickId;
      const below =
        type === 'large' ? Number.POSITIVE_INFINITY : type === 'medium' ? MEDIUM_HEIGHT : TILE_HEIGHT * 1.2;
      const entry: Drawn = {
        ident,
        type,
        lon,
        lat,
        code: a.iata[i] || ident,
        billboard: billboards.add({
          image: icons[type],
          position,
          scaleByDistance: new NearFarScalar(2e4, 1.1, 3e6, 0.55),
          distanceDisplayCondition: new DistanceDisplayCondition(0, below),
          id,
        }),
      };
      style(entry);
      drawn.push(entry);
      drawnByIdent.set(ident, entry);
    };

    /**
     * Labels only the airports in view that are close enough to read: thousands
     * of labels, each glyph a billboard, would cost every frame for nothing.
     */
    const relabel = () => {
      const { bounds, height } = globe.view;
      const want = new Set<string>();
      if (visible && bounds)
        for (const type of types)
          for (const d of drawn) {
            if (want.size >= MAX_LABELS) break;
            if (d.type !== type.id || !shown.has(d.type) || height > LABEL_HEIGHT[d.type]) continue;
            if (contains(bounds, d.lon, d.lat)) want.add(d.ident);
          }
      for (const [ident, label] of labelOf)
        if (!want.has(ident)) {
          labels.remove(label);
          labelOf.delete(ident);
        }
      for (const ident of want) {
        const d = drawnByIdent.get(ident);
        if (!d || labelOf.has(ident)) continue;
        labelOf.set(
          ident,
          labels.add({
            position: d.billboard.position,
            text: d.code,
            font: '500 11px Inter, system-ui, sans-serif',
            fillColor: Color.WHITE.withAlpha(0.88),
            outlineColor: Color.BLACK.withAlpha(0.8),
            outlineWidth: 3,
            style: LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: VerticalOrigin.TOP,
            pixelOffset: new Cartesian2(0, 10),
            id: { layer: 'airports', key: ident } satisfies PickId,
          }),
        );
      }
    };

    /** Draws the global airports plus the tiles' others, and the tiles' runways. */
    const redraw = () => {
      billboards.removeAll();
      labels.removeAll();
      labelOf.clear();
      drawn = [];
      drawnByIdent = new Map();
      if (major) for (let i = 0; i < major.airports.ident.length; i++) draw(major, i);
      for (const data of local)
        for (let i = 0; i < data.airports.ident.length; i++) {
          const type = data.airports.type[i];
          if (type !== 'large' && type !== 'medium' && !drawnByIdent.has(data.airports.ident[i] as string))
            draw(data, i);
        }
      drawRunways();
      relabel();
      ground.refresh();
    };

    const drawRunways = () => {
      if (runways) globe.scene.primitives.remove(runways);
      runways = undefined;
      const instances: GeometryInstance[] = [];
      for (const data of local) {
        const r = data.runways;
        for (let k = 0; k < r.airport.length; k++) {
          const lowLon = r.lowLon[k];
          const lowLat = r.lowLat[k];
          const highLon = r.highLon[k];
          const highLat = r.highLat[k];
          // Only surveyed thresholds: a runway guessed from the airport's reference point would be misplaced.
          if (lowLon == null || lowLat == null || highLon == null || highLat == null) continue;
          if (lowLon === highLon && lowLat === highLat) continue;
          const type = data.airports.type[r.airport[k] as number] as AirportType;
          if (!shown.has(type)) continue;
          instances.push(
            new GeometryInstance({
              geometry: new CorridorGeometry({
                positions: Cartesian3.fromDegreesArray([lowLon, lowLat, highLon, highLat]),
                // As wide as the runway is (unrecorded: a typical 75 ft).
                width: (r.width[k] ?? 75) * FEET,
                vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
              }),
              attributes: { color: ColorGeometryInstanceAttribute.fromColor(RUNWAY) },
              id: {
                layer: 'airports',
                key: data.airports.ident[r.airport[k] as number] as string,
              } satisfies PickId,
            }),
          );
        }
      }
      if (instances.length === 0) return;
      runways = globe.scene.primitives.add(
        new GroundPrimitive({
          geometryInstances: instances,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
          show: visible && globe.view.height <= RUNWAY_HEIGHT,
        }),
      );
    };

    const tiles = new AreaTiles<AirportData>(globe, {
      zoom: areaZooms.airports,
      maxTiles: 9,
      // Airports change daily; the edge holds tiles for an hour.
      ttlMs: 60 * 60_000,
      load: (tile: Tile, signal) =>
        callApi((api) => api.live.airports({ params: tile })).then((answer) => {
          if (signal.aborted) throw new Error('aborted');
          return answer.data;
        }),
      onChange: (loaded) => {
        local = loaded.map((t) => t.data);
        localByIdent = new Map();
        for (const data of local)
          data.airports.ident.forEach((ident, index) => localByIdent.set(ident, { data, index }));
        redraw();
      },
    });

    const fitToHeight = () => {
      const height = globe.view.height;
      tiles.setActive(visible && height <= TILE_HEIGHT);
      if (runways) runways.show = visible && height <= RUNWAY_HEIGHT;
      relabel();
    };
    const stops = [
      globe.viewSettled.add(fitToHeight),
      globe.viewChanged.add(() => {
        if (runways) runways.show = visible && globe.view.height <= RUNWAY_HEIGHT;
      }),
    ];

    const render = (snapshot: Snapshot<'airports'>) => {
      major = snapshot.data;
      majorByIdent = new Map(major.airports.ident.map((ident, i) => [ident, i]));
      redraw();
    };

    const clear = () => {
      major = undefined;
      majorByIdent = new Map();
      local = [];
      localByIdent = new Map();
      forDetails.clear();
      redraw();
    };

    /** The fullest record of an airport there is: a tile's, else the global one (no runways). */
    const recordOf = (ident: string): (AirportRecord & { readonly complete: boolean }) | undefined => {
      const inTile = localByIdent.get(ident);
      if (inTile) return { ...inTile, complete: true };
      for (const data of forDetails.values()) {
        if (data === 'loading') continue;
        const index = data.airports.ident.indexOf(ident);
        if (index >= 0) return { data, index, complete: true };
      }
      const index = majorByIdent.get(ident);
      return index === undefined || !major ? undefined : { data: major, index, complete: false };
    };

    /** Fetches the tile holding an airport, so its details include runways. */
    const fetchFor = (lon: number, lat: number) => {
      const { x, y } = tileAt(areaZooms.airports, lon, lat);
      const key = `${x}/${y}`;
      if (forDetails.has(key)) return;
      forDetails.set(key, 'loading');
      void (async () => {
        const result = await callApi((api) =>
          Effect.result(api.live.airports({ params: { z: areaZooms.airports, x, y } })),
        ).catch(() => undefined);
        if (result?._tag === 'Success') forDetails.set(key, result.success.data);
        else forDetails.delete(key);
        // Only the latest few: they're for the inspector, not drawing.
        while (forDetails.size > 4) forDetails.delete(forDetails.keys().next().value as string);
      })();
    };

    const describe = (ident: string): Details | undefined => {
      const record = recordOf(ident);
      if (!record) return undefined;
      const { data, index: i, complete } = record;
      const a = data.airports;
      const lon = a.lon[i] as number;
      const lat = a.lat[i] as number;
      if (!complete) fetchFor(lon, lat);
      const type = a.type[i] as AirportType;
      const codes = [
        a.icao[i] && `ICAO ${a.icao[i]}`,
        a.iata[i] && `IATA ${a.iata[i]}`,
        a.local[i] && a.local[i] !== a.icao[i] && `Local ${a.local[i]}`,
      ].filter(Boolean);
      const elevation = a.elevation[i];
      const runwayFields: Field[] = [];
      if (complete)
        for (let k = 0; k < data.runways.airport.length; k++) {
          if (data.runways.airport[k] !== i) continue;
          const r = data.runways;
          const length = r.length[k];
          const surface = surfaceLabel(r.surface[k] as string);
          runwayFields.push({
            label: `Runway ${[r.low[k], r.high[k]].filter(Boolean).join('/')}`,
            value:
              [
                length == null ? undefined : `${formatInt(length * FEET)} m`,
                surface,
                r.lighted[k] ? 'lit' : undefined,
              ]
                .filter(Boolean)
                .join(' · ') || '—',
          });
        }
      return {
        kind: typeLabel[type],
        title: a.name[i] as string,
        subtitle:
          [a.municipality[i], countryName(a.country[i] as string)].filter(Boolean).join(', ') || undefined,
        fields: [
          { label: 'Codes', value: codes.join(' · ') || (a.ident[i] as string) },
          ...(elevation == null
            ? []
            : [
                {
                  label: 'Elevation',
                  value: `${formatInt(elevation)} ft · ${formatInt(elevation * FEET)} m`,
                },
              ]),
          ...(a.scheduled[i] ? [{ label: 'Airline service', value: 'Scheduled' }] : []),
          { label: 'Position', value: formatLatLon(lat, lon) },
          ...(complete ? runwayFields : [{ label: 'Runways', value: 'Loading…' }]),
        ],
        links: [
          { label: 'OurAirports', href: `https://ourairports.com/airports/${encodeURIComponent(ident)}/` },
          ...(a.website[i] ? [{ label: 'Website', href: a.website[i] }] : []),
          ...(a.wikipedia[i] ? [{ label: 'Wikipedia', href: a.wikipedia[i] }] : []),
        ],
        position: () => Cartesian3.fromDegrees(lon, lat, globe.heightAt(lon, lat) ?? 0),
      };
    };

    return {
      loaded: tiles.loaded,
      setVisible(next) {
        visible = next;
        billboards.show = next;
        labels.show = next;
        if (next && !unsubscribe) unsubscribe = feedPoller.subscribe('airports', render);
        if (!next) {
          unsubscribe?.();
          unsubscribe = undefined;
          clear();
        }
        fitToHeight();
      },
      setFilter(next) {
        shown = next;
        for (const d of drawn) style(d);
        drawRunways();
        relabel();
      },
      details: describe,
      countIn(bounds) {
        const height = globe.view.height;
        let n = 0;
        for (const d of drawn) {
          if (!shown.has(d.type)) continue;
          if (d.type === 'medium' && height > MEDIUM_HEIGHT) continue;
          if (d.type !== 'large' && d.type !== 'medium' && height > TILE_HEIGHT) continue;
          if (contains(bounds, d.lon, d.lat)) n++;
        }
        return n;
      },
      highlight(ident) {
        selected = ident;
        const entry = drawnByIdent.get(ident);
        if (entry) style(entry);
        return () => {
          if (selected === ident) selected = undefined;
          const now = drawnByIdent.get(ident);
          if (now) style(now);
        };
      },
      search(query, limit) {
        const q = query.trim().toUpperCase();
        const codeHits: SearchHit[] = [];
        const nameHits: SearchHit[] = [];
        const seen = new Set<string>();
        for (const data of major ? [major, ...local] : local) {
          const a = data.airports;
          for (let i = 0; i < a.ident.length; i++) {
            const ident = a.ident[i] as string;
            if (seen.has(ident)) continue;
            const byCode = [ident, a.iata[i], a.icao[i], a.local[i]].some((code) => code === q);
            const byName = !byCode && (a.name[i] as string).toUpperCase().includes(q);
            if (!byCode && !byName) continue;
            seen.add(ident);
            (byCode ? codeHits : nameHits).push({
              layer: 'airports',
              key: ident,
              title: a.name[i] as string,
              subtitle: [
                typeLabel[a.type[i] as AirportType],
                (a.iata[i] as string) || ident,
                a.municipality[i],
              ]
                .filter(Boolean)
                .join(' · '),
            });
          }
        }
        return [...codeHits, ...nameHits].slice(0, limit);
      },
      destroy() {
        for (const stop of stops) stop();
        tiles.destroy();
        ground.stop();
        unsubscribe?.();
        if (runways) globe.scene.primitives.remove(runways);
        globe.scene.primitives.remove(billboards);
        globe.scene.primitives.remove(labels);
      },
    };
  },
};
