/** What a layer that isn't a scheduled feed reports in the panel: "Zoom in", a count, an error. */
export interface LayerStatus {
  /** Short, shown next to the layer name. */
  readonly text: string;
  /** Shown in the tooltip. */
  readonly detail?: string;
  readonly tone?: 'muted' | 'warn';
}

const IDLE: LayerStatus = { text: '', tone: 'muted' };

class StatusStore {
  private readonly statuses = new Map<string, LayerStatus>();
  private readonly listeners = new Set<() => void>();

  set(layer: string, status: LayerStatus): void {
    this.statuses.set(layer, status);
    for (const l of this.listeners) l();
  }

  get(layer: string): LayerStatus {
    return this.statuses.get(layer) ?? IDLE;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const layerStatus = new StatusStore();
