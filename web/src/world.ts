import type { Cartesian3 } from 'cesium';
import { Globe, type Pick } from './globe/globe.ts';
import { layerById, layers } from './layers/registry.ts';
import type { Details, LayerHandle, SearchHit } from './layers/types.ts';

export interface EntityRef {
  readonly layer: string;
  readonly key: string;
}

/**
 * The imperative core the React UI drives: the globe, every layer's handle,
 * and the selected entity's emphasis. Layers are created once and shown or
 * hidden; a hidden layer stops polling its feed.
 */
export class World {
  readonly globe: Globe;
  private readonly handles = new Map<string, LayerHandle>();
  private clearHighlight: (() => void) | undefined;

  constructor(container: HTMLElement) {
    this.globe = new Globe(container);
    for (const def of layers) this.handles.set(def.id, def.create(this.globe));
  }

  setVisible(layer: string, visible: boolean): void {
    this.handles.get(layer)?.setVisible(visible);
  }

  setOpacity(layer: string, opacity: number): void {
    this.handles.get(layer)?.setOpacity?.(opacity);
  }

  setFilter(layer: string, visible: ReadonlySet<string>): void {
    this.handles.get(layer)?.setFilter?.(visible);
  }

  details(ref: EntityRef): Details | undefined {
    return this.handles.get(ref.layer)?.details?.(ref.key);
  }

  /** Emphasizes `ref` (or nothing) and stops following anything else. */
  select(ref: EntityRef | undefined): void {
    this.clearHighlight?.();
    this.clearHighlight = undefined;
    this.globe.follow(undefined);
    if (ref) this.clearHighlight = this.handles.get(ref.layer)?.highlight?.(ref.key);
  }

  follow(position: (() => Cartesian3 | undefined) | undefined): void {
    this.globe.follow(position);
  }

  /** Matches across every searchable layer, a few per layer. */
  search(query: string): ReadonlyArray<SearchHit> {
    if (query.trim().length < 2) return [];
    return layers.flatMap((def) => this.handles.get(def.id)?.search?.(query, 8) ?? []);
  }

  layerTitle(id: string): string {
    return layerById.get(id)?.title ?? id;
  }

  onPointer(onPick: (pick: Pick) => void, onHover: (pick: Pick) => void): void {
    this.globe.onPointer(onPick, onHover);
  }

  destroy(): void {
    this.select(undefined);
    for (const handle of this.handles.values()) handle.destroy();
    this.globe.destroy();
  }
}
