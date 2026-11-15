import type { Cartesian3 } from 'cesium';
import type { Source } from '../../../src/catalog.ts';
import type { FeedId } from '../../../src/domain.ts';
import type { Globe } from '../globe/globe.ts';

export type Category = 'air' | 'space' | 'earth' | 'weather' | 'base';

export const categories: ReadonlyArray<{ readonly id: Category; readonly title: string }> = [
  { id: 'air', title: 'Air' },
  { id: 'space', title: 'Space' },
  { id: 'earth', title: 'Earth' },
  { id: 'weather', title: 'Weather' },
  { id: 'base', title: 'Base map' },
];

export interface Field {
  readonly label: string;
  readonly value: string;
}

/** What the inspector shows for a selected entity. */
export interface Details {
  /** "Aircraft", "Satellite", … */
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly fields: ReadonlyArray<Field>;
  readonly link?: { readonly label: string; readonly href: string };
  /** Where it is now, for the camera to follow; absent for things that don't move. */
  readonly position?: () => Cartesian3 | undefined;
}

export interface SearchHit {
  readonly layer: string;
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
}

/** A sub-filter a layer offers (satellite groups, event categories). */
export interface Filter {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

/** A layer once it's on the globe. */
export interface LayerHandle {
  setVisible(visible: boolean): void;
  setOpacity?(opacity: number): void;
  /** Hides entities outside the given filter ids. */
  setFilter?(visible: ReadonlySet<string>): void;
  /** Current details of an entity this layer drew, or undefined once it's gone. */
  details?(key: string): Details | undefined;
  /** Emphasizes the selected entity (orbit, track); returns the cleanup. */
  highlight?(key: string): () => void;
  search?(query: string, limit: number): ReadonlyArray<SearchHit>;
  destroy(): void;
}

export interface LayerDef {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  readonly description: string;
  readonly source: Source;
  /** Layers backed by a server feed show its freshness. */
  readonly feed?: FeedId;
  readonly defaultVisible: boolean;
  /** Imagery layers offer an opacity slider starting here. */
  readonly opacity?: number;
  readonly filters?: ReadonlyArray<Filter>;
  /** A legend line under the layer when it's on, e.g. a color ramp. */
  readonly legend?: ReadonlyArray<{ readonly label: string; readonly color: string }>;
  create(globe: Globe): LayerHandle;
}
