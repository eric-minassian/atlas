import { ChevronRight, CircleAlert, Clock3, X } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FeedStatus } from '../../../src/domain.ts';
import type { Basemap } from '../globe/globe.ts';
import {
  useFeedView,
  useLayerState,
  useLayerStates,
  useLayerStatus,
  useNow,
  usePersistentState,
} from '../hooks.ts';
import { layers } from '../layers/registry.ts';
import { categories, type LayerDef } from '../layers/types.ts';
import { formatAge, formatInt } from '../lib/format.ts';
import { cn } from '../lib/utils.ts';
import type { LayerState, World } from '../world.ts';

export interface LayerSettings {
  readonly visible: Readonly<Record<string, boolean>>;
  readonly opacity: Readonly<Record<string, number>>;
  /** Filter ids each filterable layer hides. */
  readonly hidden: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const defaultSettings: LayerSettings = {
  visible: Object.fromEntries(layers.map((l) => [l.id, l.defaultVisible])),
  opacity: Object.fromEntries(layers.flatMap((l) => (l.opacity === undefined ? [] : [[l.id, l.opacity]]))),
  hidden: Object.fromEntries(layers.flatMap((l) => (l.defaultHidden ? [[l.id, l.defaultHidden]] : []))),
};

interface Props {
  readonly world: World | undefined;
  readonly settings: LayerSettings;
  readonly statuses: ReadonlyMap<string, FeedStatus>;
  readonly basemap: Basemap;
  readonly onChange: (settings: LayerSettings) => void;
  readonly onBasemap: (basemap: Basemap) => void;
  readonly onClose: () => void;
}

/**
 * A layer belongs in "In view" while it draws something here (or draws without
 * counting, like weather imagery). Base-map layers are always there, so they
 * stay in the catalog.
 */
const isInView = (layer: LayerDef, state: LayerState) =>
  layer.category !== 'base' && state.kind === 'shown' && (state.inView === undefined || state.inView > 0);

/**
 * Two parts: what's drawing in the current view, with legends and controls,
 * and below it the whole catalog by category, collapsed, for switching
 * things on. As the camera moves, layers move between "In view" and the
 * catalog by themselves.
 */
export function LayerPanel({ world, settings, statuses, basemap, onChange, onBasemap, onClose }: Props) {
  useLayerStates(world);
  const [open, setOpen] = usePersistentState<{ readonly categories: Readonly<Record<string, boolean>> }>(
    'atlas:panel:v1',
    { categories: {} },
  );
  const offered = world?.available ?? layers;
  const inView = offered.filter((l) => world && isInView(l, world.state(l.id)));

  return (
    <aside
      aria-label="Layers"
      className="pointer-events-auto flex max-h-full w-[288px] flex-col overflow-hidden rounded-lg border bg-panel shadow-xl shadow-black/30 backdrop-blur-md"
    >
      <header className="flex items-center justify-between px-3.5 pt-3 pb-1">
        <h2 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Layers</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Hide layers"
        >
          <X className="size-3.5" />
        </button>
      </header>
      {world?.globe.canPhotoreal && (
        <div className="px-3.5 pt-1.5 pb-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={basemap}
            onValueChange={(value) => {
              if (value === 'satellite' || value === 'photoreal') onBasemap(value);
            }}
            className="w-full"
            aria-label="Base map"
          >
            <ToggleGroupItem value="satellite" className="h-7 text-[12px]">
              Satellite
            </ToggleGroupItem>
            <ToggleGroupItem value="photoreal" className="h-7 text-[12px]">
              Photorealistic 3D
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      )}
      <div className="min-h-0 overflow-y-auto px-1.5 pb-2">
        <section aria-label="In view" className="pt-1">
          <h3 className="px-2 pb-1 text-[11px] text-muted-foreground/80">In view</h3>
          {inView.length === 0 ? (
            <p className="px-2 pb-1 text-[12px] text-muted-foreground/70">
              Nothing switched on is drawing here.
            </p>
          ) : (
            <ul>
              {inView.map((layer) => (
                <LayerRow
                  key={layer.id}
                  world={world}
                  layer={layer}
                  settings={settings}
                  status={layer.feed ? statuses.get(layer.feed) : undefined}
                  onChange={onChange}
                />
              ))}
            </ul>
          )}
        </section>
        <section aria-label="All layers" className="mt-2 border-t pt-2">
          {categories.map((category) => {
            const inCategory = offered.filter((l) => l.category === category.id);
            if (inCategory.length === 0) return null;
            const on = inCategory.filter((l) => settings.visible[l.id] ?? l.defaultVisible).length;
            return (
              <Collapsible
                key={category.id}
                open={open.categories[category.id] ?? false}
                onOpenChange={(next) => setOpen({ categories: { ...open.categories, [category.id]: next } })}
              >
                <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-foreground/85 hover:bg-white/[0.04]">
                  <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                  <span className="flex-1">{category.title}</span>
                  <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                    {on > 0 ? `${on} of ${inCategory.length} on` : inCategory.length}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="pb-1 pl-3">
                    {inCategory.map((layer) => (
                      <CatalogRow
                        key={layer.id}
                        world={world}
                        layer={layer}
                        settings={settings}
                        onChange={onChange}
                      />
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </section>
      </div>
    </aside>
  );
}

const setVisibleIn = (settings: LayerSettings, layer: string, value: boolean): LayerSettings => ({
  ...settings,
  visible: { ...settings.visible, [layer]: value },
});

function LayerTitle({ layer, htmlFor }: { readonly layer: LayerDef; readonly htmlFor: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label
          htmlFor={htmlFor}
          className="min-w-0 flex-1 cursor-pointer truncate text-[13px] text-foreground/95"
        >
          {layer.title}
        </label>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        <p>{layer.description}</p>
        <p className="mt-1 opacity-70">Source: {layer.source.name}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const hints: Record<Exclude<LayerState['kind'], 'shown'>, string> = {
  off: '',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  basemap: 'Satellite map only',
};

/** Why a switched-on layer isn't drawing, in a word or two; or how much it draws here. */
const hintFor = (state: LayerState): string =>
  state.kind === 'shown' ? (state.inView === undefined ? '' : formatInt(state.inView)) : hints[state.kind];

/** A catalog entry: the switch, the name, and a short hint about where it draws. */
function CatalogRow({
  world,
  layer,
  settings,
  onChange,
}: {
  readonly world: World | undefined;
  readonly layer: LayerDef;
  readonly settings: LayerSettings;
  readonly onChange: (settings: LayerSettings) => void;
}) {
  const state = useLayerState(world, layer.id);
  const visible = settings.visible[layer.id] ?? layer.defaultVisible;
  const id = `catalog-${layer.id}`;
  const hint = hintFor(state);
  return (
    <li className="flex items-center gap-2.5 rounded-md px-2 py-1">
      <Switch
        id={id}
        checked={visible}
        onCheckedChange={(value) => onChange(setVisibleIn(settings, layer.id, value))}
        size="sm"
      />
      <LayerTitle layer={layer} htmlFor={id} />
      {hint && <span className="text-[11px] text-muted-foreground/70 tabular-nums">{hint}</span>}
    </li>
  );
}

/** A layer drawing in the view: its count and freshness, legend, filters and opacity. */
function LayerRow({
  world,
  layer,
  settings,
  status,
  onChange,
}: {
  readonly world: World | undefined;
  readonly layer: LayerDef;
  readonly settings: LayerSettings;
  readonly status: FeedStatus | undefined;
  readonly onChange: (settings: LayerSettings) => void;
}) {
  const state = useLayerState(world, layer.id);
  const opacity = settings.opacity[layer.id] ?? layer.opacity;
  const hidden = new Set(settings.hidden[layer.id] ?? []);
  const id = `layer-${layer.id}`;
  const inView = state.kind === 'shown' ? state.inView : undefined;

  const setOpacity = (value: number) =>
    onChange({ ...settings, opacity: { ...settings.opacity, [layer.id]: value } });
  const toggleFilter = (filter: string) => {
    const next = new Set(hidden);
    if (next.has(filter)) next.delete(filter);
    else next.add(filter);
    onChange({ ...settings, hidden: { ...settings.hidden, [layer.id]: [...next] } });
  };

  return (
    <li className="rounded-md bg-white/[0.03] px-2 py-1.5 [&+&]:mt-0.5">
      <div className="flex items-center gap-2.5">
        <Switch
          id={id}
          checked
          onCheckedChange={(value) => onChange(setVisibleIn(settings, layer.id, value))}
          size="sm"
        />
        <LayerTitle layer={layer} htmlFor={id} />
        {layer.feed ? (
          <FeedMeta layer={layer} status={status} inView={inView} />
        ) : (
          <LiveMeta layer={layer.id} inView={inView} />
        )}
      </div>
      {(layer.legend || layer.filters || opacity !== undefined) && (
        <div className="mt-2 ml-[38px] space-y-2 pb-0.5">
          {layer.legend && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {layer.legend.map((entry) => (
                <li key={entry.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  {entry.label}
                </li>
              ))}
            </ul>
          )}
          {layer.filters && (
            <ul className="flex flex-wrap gap-1">
              {layer.filters.map((filter) => {
                const on = !hidden.has(filter.id);
                return (
                  <li key={filter.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleFilter(filter.id)}
                      className={cn(
                        'flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                        on
                          ? 'border-white/12 text-foreground/90 hover:bg-white/5'
                          : 'border-transparent text-muted-foreground/60 hover:text-muted-foreground',
                      )}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: filter.color, opacity: on ? 1 : 0.35 }}
                      />
                      {filter.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {opacity !== undefined && (
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] text-muted-foreground">Opacity</span>
              <Slider
                value={[opacity]}
                min={0.1}
                max={1}
                step={0.05}
                onValueChange={([value]) => value !== undefined && setOpacity(value)}
                className="flex-1"
                aria-label={`${layer.title} opacity`}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function FeedMeta({
  layer,
  status,
  inView,
}: {
  readonly layer: LayerDef;
  readonly status: FeedStatus | undefined;
  readonly inView: number | undefined;
}) {
  const view = useFeedView(layer.feed);
  const now = useNow(15_000);
  if (!view || view.state === 'idle' || view.state === 'loading')
    return <span className="text-[11px] text-muted-foreground/70">Loading</span>;
  if (view.state === 'pending' || view.state === 'error') {
    const message =
      view.state === 'pending'
        ? status?.error
          ? `The first update failed: ${status.error}`
          : 'Waiting for the first update from the source.'
        : 'Could not reach Atlas. Retrying.';
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {view.state === 'pending' ? (
              <Clock3 className="size-3" />
            ) : (
              <CircleAlert className="size-3 text-destructive" />
            )}
            {view.state === 'pending' ? 'Pending' : 'Offline'}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          {message}
        </TooltipContent>
      </Tooltip>
    );
  }
  const stale = status?.error;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
          {stale && <CircleAlert className="size-3 text-amber-400/90" />}
          {inView !== undefined && formatInt(inView)}
          {view.fetchedAt !== undefined && (
            <span className="text-muted-foreground/60">
              {inView !== undefined && '· '}
              {formatAge(now - view.fetchedAt).replace(' ago', '')}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        {inView !== undefined && view.count !== undefined && (
          <p>
            {formatInt(inView)} in view of {formatInt(view.count)}.
          </p>
        )}
        {view.fetchedAt !== undefined && (
          <p>
            Updated {formatAge(now - view.fetchedAt)} from {layer.source.name}.
          </p>
        )}
        {stale && <p className="mt-1 text-amber-200/90">The latest refresh failed: {stale}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

/** For layers loaded by area: what they report (an error, a source note), else the count in view. */
function LiveMeta({ layer, inView }: { readonly layer: string; readonly inView: number | undefined }) {
  const status = useLayerStatus(layer);
  // A warning beats the count; otherwise prefer what's in view over the layer's own total.
  const text = status.tone === 'warn' || inView === undefined ? status.text : formatInt(inView);
  if (!text) return null;
  const label = (
    <span
      className={cn(
        'flex items-center gap-1 text-[11px] tabular-nums',
        status.tone === 'warn' ? 'text-amber-300/90' : 'text-muted-foreground',
      )}
    >
      {status.tone === 'warn' && <CircleAlert className="size-3" />}
      {text}
    </span>
  );
  if (!status.detail) return label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        {status.detail}
      </TooltipContent>
    </Tooltip>
  );
}
