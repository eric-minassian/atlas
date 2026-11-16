import type { Cartesian3 } from 'cesium';
import type { ClientConfig } from '../../src/domain.ts';
import { type Basemap, Globe, type Pick, type View } from './globe/globe.ts';
import { layerById, layers } from './layers/registry.ts';
import type { Details, LayerDef, LayerHandle, Range, SearchHit } from './layers/types.ts';
import { Listeners } from './lib/listeners.ts';

export interface EntityRef {
  readonly layer: string;
  readonly key: string;
}

/**
 * Why a switched-on layer isn't drawing, or that it is. The panel shows the
 * reason next to the layer.
 */
export type LayerState =
  | { readonly kind: 'off' }
  | { readonly kind: 'shown'; readonly inView: number | undefined }
  | { readonly kind: 'zoom-in' }
  | { readonly kind: 'zoom-out' }
  | { readonly kind: 'basemap' };

/** A layer's range check gets this much slack once inside it, so it doesn't flicker at the edge. */
const HYSTERESIS = 0.08;

const inRange = (range: Range | undefined, height: number, wasIn: boolean): 'in' | 'below' | 'above' => {
  if (!range) return 'in';
  const slack = wasIn ? HYSTERESIS : 0;
  if (range.max !== undefined && height > range.max * (1 + slack)) return 'above';
  if (range.min !== undefined && height < range.min * (1 - slack)) return 'below';
  return 'in';
};

/**
 * The imperative core the React UI drives: the globe, every layer's handle,
 * and the selected entity's emphasis. Layers are created once and shown or
 * hidden as the viewer switches them, the camera moves through their range,
 * or the base map changes; a hidden layer stops loading data.
 */
export class World {
  readonly globe: Globe;
  readonly config: ClientConfig;
  /** Layers this deployment can offer (their keys and sources are configured). */
  readonly available: ReadonlyArray<LayerDef>;
  /** Fires when any layer's state or in-view count changes. */
  readonly statesChanged = new Listeners<void>();
  private readonly handles = new Map<string, LayerHandle>();
  private readonly wanted = new Map<string, boolean>();
  private readonly states = new Map<string, LayerState>();
  private clearHighlight: (() => void) | undefined;
  private readonly stops: Array<() => void> = [];

  constructor(container: HTMLElement, config: ClientConfig, creditContainer: HTMLElement) {
    this.config = config;
    this.globe = new Globe(container, config, creditContainer);
    this.available = layers.filter((def) => def.available?.(config) ?? true);
    for (const def of this.available) {
      const handle = def.create(this.globe);
      this.handles.set(def.id, handle);
      if (handle.loaded) this.stops.push(handle.loaded.add(() => this.apply(this.globe.view, true, def.id)));
    }
    this.stops.push(
      this.globe.viewChanged.add((view) => this.apply(view, false)),
      this.globe.viewSettled.add((view) => this.apply(view, true)),
      this.globe.basemapChanged.add(() => this.apply(this.globe.view, true)),
    );
  }

  /** Switches a layer on or off (the viewer's setting). */
  setVisible(layer: string, visible: boolean): void {
    if (this.wanted.get(layer) === visible) return;
    this.wanted.set(layer, visible);
    this.apply(this.globe.view, true, layer);
  }

  setOpacity(layer: string, opacity: number): void {
    this.handles.get(layer)?.setOpacity?.(opacity);
  }

  setFilter(layer: string, visible: ReadonlySet<string>): void {
    this.handles.get(layer)?.setFilter?.(visible);
    this.apply(this.globe.view, true, layer);
  }

  state(layer: string): LayerState {
    return this.states.get(layer) ?? { kind: 'off' };
  }

  async setBasemap(basemap: Basemap): Promise<void> {
    await this.globe.setBasemap(basemap);
  }

  /**
   * Works out each layer's state for the view and shows or hides it to match.
   * `settled` also recounts what's in view (only then: counting walks every entity).
   */
  private apply(view: View, settled: boolean, only?: string): void {
    let changed = false;
    for (const def of this.available) {
      if (only && def.id !== only) continue;
      const handle = this.handles.get(def.id);
      if (!handle) continue;
      const previous = this.states.get(def.id);
      let next: LayerState;
      if (!this.wanted.get(def.id)) next = { kind: 'off' };
      else if (def.basemaps && !def.basemaps.includes(this.globe.basemap)) next = { kind: 'basemap' };
      else {
        const where = inRange(def.range, view.height, previous?.kind === 'shown');
        if (where === 'above') next = { kind: 'zoom-in' };
        else if (where === 'below') next = { kind: 'zoom-out' };
        else {
          const counted = settled && view.bounds && handle.countIn ? handle.countIn(view.bounds) : undefined;
          next = {
            kind: 'shown',
            inView: counted ?? (previous?.kind === 'shown' ? previous.inView : undefined),
          };
        }
      }
      const wasShown = previous?.kind === 'shown';
      const isShown = next.kind === 'shown';
      if (wasShown !== isShown || previous === undefined) handle.setVisible(isShown);
      if (!sameState(previous, next)) {
        this.states.set(def.id, next);
        changed = true;
      }
    }
    if (changed) this.statesChanged.emit();
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

  /** Matches across every searchable layer that's showing, a few per layer. */
  search(query: string): ReadonlyArray<SearchHit> {
    if (query.trim().length < 2) return [];
    return this.available.flatMap((def) =>
      this.state(def.id).kind === 'shown' ? (this.handles.get(def.id)?.search?.(query, 8) ?? []) : [],
    );
  }

  layerTitle(id: string): string {
    return layerById.get(id)?.title ?? id;
  }

  onPointer(onPick: (pick: Pick) => void, onHover: (pick: Pick) => void): void {
    this.globe.onPointer(onPick, onHover);
  }

  destroy(): void {
    this.select(undefined);
    for (const stop of this.stops) stop();
    for (const handle of this.handles.values()) handle.destroy();
    this.globe.destroy();
  }
}

const sameState = (a: LayerState | undefined, b: LayerState): boolean =>
  a !== undefined && a.kind === b.kind && (a.kind !== 'shown' || a.inView === (b as typeof a).inView);
