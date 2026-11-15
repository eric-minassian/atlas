import { CircleAlert, Clock3, X } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FeedStatus } from '../../../src/domain.ts';
import { useFeedView, useNow } from '../hooks.ts';
import { layers } from '../layers/registry.ts';
import { categories, type LayerDef } from '../layers/types.ts';
import { formatAge, formatInt } from '../lib/format.ts';
import { cn } from '../lib/utils.ts';

export interface LayerSettings {
  readonly visible: Readonly<Record<string, boolean>>;
  readonly opacity: Readonly<Record<string, number>>;
  /** Filter ids each filterable layer hides. */
  readonly hidden: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const defaultSettings: LayerSettings = {
  visible: Object.fromEntries(layers.map((l) => [l.id, l.defaultVisible])),
  opacity: Object.fromEntries(layers.flatMap((l) => (l.opacity === undefined ? [] : [[l.id, l.opacity]]))),
  hidden: {},
};

interface Props {
  readonly settings: LayerSettings;
  readonly statuses: ReadonlyMap<string, FeedStatus>;
  readonly onChange: (settings: LayerSettings) => void;
  readonly onClose: () => void;
}

export function LayerPanel({ settings, statuses, onChange, onClose }: Props) {
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
      <div className="min-h-0 overflow-y-auto px-1.5 pb-2">
        {categories.map((category) => {
          const inCategory = layers.filter((l) => l.category === category.id);
          if (inCategory.length === 0) return null;
          return (
            <section key={category.id} className="pt-2">
              <h3 className="px-2 pb-1 text-[11px] text-muted-foreground/80">{category.title}</h3>
              <ul>
                {inCategory.map((layer) => (
                  <LayerRow
                    key={layer.id}
                    layer={layer}
                    settings={settings}
                    status={layer.feed ? statuses.get(layer.feed) : undefined}
                    onChange={onChange}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function LayerRow({
  layer,
  settings,
  status,
  onChange,
}: {
  readonly layer: LayerDef;
  readonly settings: LayerSettings;
  readonly status: FeedStatus | undefined;
  readonly onChange: (settings: LayerSettings) => void;
}) {
  const visible = settings.visible[layer.id] ?? layer.defaultVisible;
  const opacity = settings.opacity[layer.id] ?? layer.opacity;
  const hidden = new Set(settings.hidden[layer.id] ?? []);
  const id = `layer-${layer.id}`;

  const setVisible = (value: boolean) =>
    onChange({ ...settings, visible: { ...settings.visible, [layer.id]: value } });
  const setOpacity = (value: number) =>
    onChange({ ...settings, opacity: { ...settings.opacity, [layer.id]: value } });
  const toggleFilter = (filter: string) => {
    const next = new Set(hidden);
    if (next.has(filter)) next.delete(filter);
    else next.add(filter);
    onChange({ ...settings, hidden: { ...settings.hidden, [layer.id]: [...next] } });
  };

  return (
    <li className={cn('rounded-md px-2 py-1.5', visible && 'bg-white/[0.03]')}>
      <div className="flex items-center gap-2.5">
        <Switch id={id} checked={visible} onCheckedChange={setVisible} size="sm" />
        <Tooltip>
          <TooltipTrigger asChild>
            <label
              htmlFor={id}
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
        {layer.feed && visible && <FeedMeta layer={layer} status={status} />}
      </div>
      {visible && (layer.legend || layer.filters || opacity !== undefined) && (
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

function FeedMeta({ layer, status }: { readonly layer: LayerDef; readonly status: FeedStatus | undefined }) {
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
          {view.count !== undefined && layer.id !== 'radar' && formatInt(view.count)}
          {view.fetchedAt !== undefined && (
            <span className="text-muted-foreground/60">
              · {formatAge(now - view.fetchedAt).replace(' ago', '')}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
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
