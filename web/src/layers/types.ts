import type { Cartesian3 } from 'cesium';
import type { Bounds } from '../../../src/area.ts';
import type { Source } from '../../../src/catalog.ts';
import type { ClientConfig, FeedId } from '../../../src/domain.ts';
import type { Basemap, Globe } from '../globe/globe.ts';
import type { Listeners } from '../lib/listeners.ts';

export type Category = 'air' | 'sea' | 'space' | 'hazards' | 'weather' | 'earth' | 'city' | 'street' | 'base';

export const categories: ReadonlyArray<{ readonly id: Category; readonly title: string }> = [
  { id: 'air', title: 'Air' },
  { id: 'sea', title: 'Sea' },
  { id: 'space', title: 'Space' },
  { id: 'hazards', title: 'Hazards' },
  { id: 'weather', title: 'Weather' },
  { id: 'earth', title: 'Earth' },
  { id: 'city', title: 'City' },
  { id: 'street', title: 'Street level' },
  { id: 'base', title: 'Base map' },
];

export interface Field {
  readonly label: string;
  readonly value: string;
}

export interface Link {
  readonly label: string;
  readonly href: string;
}

/** A picture in the inspector: a camera's latest frame, a place's photo. */
export interface Picture {
  readonly src: string;
  readonly alt: string;
  /** Width / height, to reserve space before it loads. */
  readonly aspect?: number;
  /** Where clicking the picture goes (the source's page for it). */
  readonly href?: string;
  /** Shown under the picture: author and license, "Webcam by …". */
  readonly credit?: string;
  /** Reloads it this often (live cameras). */
  readonly refreshMs?: number;
}

/**
 * What the inspector shows for a selected entity. The inspector asks for it
 * again every second, so a layer that fetches more on selection (a Wikipedia
 * summary, say) returns what it has and fills in the rest on a later call.
 */
export interface Details {
  /** "Aircraft", "Satellite", … */
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly picture?: Picture;
  /** A paragraph of text: an article's summary, an alert's description. */
  readonly body?: string;
  readonly fields: ReadonlyArray<Field>;
  readonly links?: ReadonlyArray<Link>;
  /** Where it is now, for the camera to follow; absent for things that don't move. */
  readonly position?: () => Cartesian3 | undefined;
  /** Where to fly to see it, when that's not just above its position (a polygon, a large area). */
  readonly extent?: Bounds;
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

/** Camera heights above the ellipsoid, in meters, between which a layer draws. */
export interface Range {
  readonly min?: number;
  readonly max?: number;
}

/** A layer once it's on the globe. */
export interface LayerHandle {
  /**
   * Shown or hidden. A layer is shown only while it's switched on, the camera
   * is within its range, and the base map allows it; a hidden layer stops
   * loading data.
   */
  setVisible(visible: boolean): void;
  setOpacity?(opacity: number): void;
  /** Hides entities outside the given filter ids. */
  setFilter?(visible: ReadonlySet<string>): void;
  /** Current details of an entity this layer drew, or undefined once it's gone. */
  details?(key: string): Details | undefined;
  /** Emphasizes the selected entity (orbit, track); returns the cleanup. */
  highlight?(key: string): () => void;
  search?(query: string, limit: number): ReadonlyArray<SearchHit>;
  /** How many of its entities are within `bounds`, for the panel's "In view" list. */
  countIn?(bounds: Bounds): number;
  /**
   * Fires when data the layer loads in the background arrives (after the view
   * settled and was counted), so its "In view" count is taken again.
   */
  readonly loaded?: Listeners<void>;
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
  /** Where it draws; everywhere when absent. */
  readonly range?: Range;
  /**
   * The base maps it can be shown on. Google's terms keep other map imagery
   * off Photorealistic 3D, so base-map layers (imagery, labels, buildings)
   * list only `satellite`; data drawn on top works on both. Both when absent.
   */
  readonly basemaps?: ReadonlyArray<Basemap>;
  /** Whether this deployment has what it needs (a key, a configured source); hidden otherwise. */
  readonly available?: (config: ClientConfig) => boolean;
  /** Imagery layers offer an opacity slider starting here. */
  readonly opacity?: number;
  readonly filters?: ReadonlyArray<Filter>;
  /** Filters off until the viewer turns them on. */
  readonly defaultHidden?: ReadonlyArray<string>;
  /** A legend line under the layer when it's on, e.g. a color ramp. */
  readonly legend?: ReadonlyArray<{ readonly label: string; readonly color: string }>;
  create(globe: Globe): LayerHandle;
}
