import {
  Cartesian3,
  ClassificationType,
  type Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  GroundPrimitive,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineColorAppearance,
} from 'cesium';
import type { Bounds } from '../../../src/area.ts';
import type { Polygon } from '../../../src/domain.ts';
import type { Globe, PickId } from '../globe/globe.ts';

/** Something drawn on the ground as filled outlines. */
export interface Area {
  readonly key: string;
  readonly polygons: ReadonlyArray<Polygon>;
  readonly fill: Color;
  /** Outline color; none when absent. */
  readonly outline?: Color;
  /** Outline width, pixels. */
  readonly width?: number;
}

/** A line drawn on the ground (a storm track). */
export interface Line {
  readonly key: string;
  /** Flat `[lon, lat, …]`. */
  readonly positions: ReadonlyArray<number>;
  readonly color: Color;
  readonly width?: number;
}

/** The bounding box of polygons (or lines), for the camera and in-view counts. */
export const boundsOf = (shapes: ReadonlyArray<ReadonlyArray<number>>): Bounds | undefined => {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const flat of shapes)
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const lon = flat[i] as number;
      const lat = flat[i + 1] as number;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  if (!Number.isFinite(west)) return undefined;
  return { west, south, east, north };
};

/** Outer rings and holes of polygons, flattened into one list. */
export const ringsOf = (polygons: ReadonlyArray<Polygon>): ReadonlyArray<ReadonlyArray<number>> =>
  polygons.flat();

const closed = (ring: ReadonlyArray<number>): number[] => [...ring, ring[0] as number, ring[1] as number];

/**
 * Filled polygons and lines draped on terrain (or on 3D tiles), rebuilt
 * whenever the layer hands over a new set. Ground primitives build in web
 * workers, so the previous set stays until the new one is ready, rather than
 * the ground going blank for a moment.
 */
export class GroundShapes {
  private current: Array<GroundPrimitive | GroundPolylinePrimitive> = [];
  private pending: Array<GroundPrimitive | GroundPolylinePrimitive> = [];
  /** A new set was handed over and hasn't replaced the drawn one yet. */
  private swapping = false;
  private visible = true;
  private readonly stop: () => void;

  constructor(
    private readonly globe: Globe,
    private readonly layer: string,
  ) {
    this.stop = globe.scene.postRender.addEventListener(() => this.swap());
  }

  set(areas: ReadonlyArray<Area>, lines: ReadonlyArray<Line> = []): void {
    for (const primitive of this.pending) this.globe.scene.primitives.remove(primitive);
    this.pending = [];
    const fills: GeometryInstance[] = [];
    const outlines: GeometryInstance[] = [];
    let part = 0;
    for (const area of areas)
      for (const polygon of area.polygons) {
        const [outer, ...holes] = polygon;
        if (!outer || outer.length < 6) continue;
        const id = { layer: this.layer, key: area.key, part: part++ } satisfies PickId & { part: number };
        fills.push(
          new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: new PolygonHierarchy(
                Cartesian3.fromDegreesArray([...outer]),
                holes.map((hole) => new PolygonHierarchy(Cartesian3.fromDegreesArray([...hole]))),
              ),
            }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(area.fill) },
            id,
          }),
        );
        if (area.outline)
          for (const ring of polygon)
            outlines.push(
              new GeometryInstance({
                geometry: new GroundPolylineGeometry({
                  positions: Cartesian3.fromDegreesArray(closed(ring)),
                  width: area.width ?? 1.5,
                }),
                attributes: { color: ColorGeometryInstanceAttribute.fromColor(area.outline) },
                id,
              }),
            );
      }
    for (const line of lines) {
      if (line.positions.length < 4) continue;
      outlines.push(
        new GeometryInstance({
          geometry: new GroundPolylineGeometry({
            positions: Cartesian3.fromDegreesArray([...line.positions]),
            width: line.width ?? 2,
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(line.color) },
          id: { layer: this.layer, key: line.key, part: part++ },
        }),
      );
    }
    const next: Array<GroundPrimitive | GroundPolylinePrimitive> = [];
    if (fills.length > 0)
      next.push(
        new GroundPrimitive({
          geometryInstances: fills,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
          classificationType: ClassificationType.BOTH,
          show: this.visible,
        }),
      );
    if (outlines.length > 0)
      next.push(
        new GroundPolylinePrimitive({
          geometryInstances: outlines,
          appearance: new PolylineColorAppearance({ translucent: true }),
          classificationType: ClassificationType.BOTH,
          show: this.visible,
        }),
      );
    for (const primitive of next) this.globe.scene.primitives.add(primitive);
    this.pending = next;
    this.swapping = true;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const primitive of [...this.current, ...this.pending]) primitive.show = visible;
  }

  clear(): void {
    for (const primitive of [...this.current, ...this.pending]) this.globe.scene.primitives.remove(primitive);
    this.current = [];
    this.pending = [];
    this.swapping = false;
  }

  /** Replaces the drawn set with the pending one once all of it is ready. */
  private swap(): void {
    if (!this.swapping || !this.pending.every((p) => p.ready)) return;
    for (const primitive of this.current) this.globe.scene.primitives.remove(primitive);
    this.current = this.pending;
    this.pending = [];
    this.swapping = false;
  }

  destroy(): void {
    this.stop();
    this.clear();
  }
}
