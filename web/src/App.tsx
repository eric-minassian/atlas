import { Earth, Layers, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Inspector, type Selection } from './components/Inspector.tsx';
import { defaultSettings, type LayerSettings, LayerPanel } from './components/LayerPanel.tsx';
import { PanoramaOverlay, usePanorama } from './components/PanoramaOverlay.tsx';
import { SearchDialog } from './components/SearchDialog.tsx';
import { loadConfig } from './config.ts';
import type { Basemap, Pick } from './globe/globe.ts';
import { useCatalog, useLayerStates, useNow, usePersistentState } from './hooks.ts';
import { layerById, layers } from './layers/registry.ts';
import type { Details, SearchHit } from './layers/types.ts';
import { cn } from './lib/utils.ts';
import { World } from './world.ts';

const SETTINGS_KEY = 'atlas:layers:v1';

export function App() {
  const container = useRef<HTMLDivElement | null>(null);
  const [world, setWorld] = useState<World>();
  const [globeError, setGlobeError] = useState(false);
  const [settings, setSettings] = usePersistentState<LayerSettings>(SETTINGS_KEY, defaultSettings);
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  const [selection, setSelection] = useState<Selection>();
  const [following, setFollowing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hover, setHover] = useState<{ title: string; x: number; y: number }>();
  const pointer = useRef({ x: 0, y: 0 });
  const statuses = useCatalog();
  const [view, setView] = usePersistentState<{ readonly basemap: Basemap }>('atlas:view:v1', {
    basemap: 'satellite',
  });
  useLayerStates(world);
  const inPanorama = usePanorama(world?.street) !== undefined;

  // Map credits (imagery, terrain, 3D tiles) go here; Cesium keeps them current for what's on screen.
  const credits = useRef<HTMLDivElement | null>(null);

  // The globe and its layers live outside React: created when their container mounts, once
  // this deployment's config (which keys it has) is known.
  const mountGlobe = useCallback((element: HTMLDivElement | null) => {
    container.current = element;
    if (!element) return undefined;
    let cancelled = false;
    let created: World | undefined;
    void (async () => {
      const config = await loadConfig();
      if (cancelled || !credits.current) return;
      try {
        created = new World(element, config, credits.current);
        setWorld(created);
        // A handle for poking at the scene from devtools during development.
        if (import.meta.env.DEV) Object.assign(window, { atlas: created });
      } catch (error) {
        // No WebGL (or it was refused): keep the page usable and say why the globe is missing.
        console.error(error);
        setGlobeError(true);
      }
    })();
    return () => {
      cancelled = true;
      setWorld(undefined);
      created?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!world) return;
    for (const layer of layers) {
      const visible = settings.visible[layer.id] ?? layer.defaultVisible;
      world.setVisible(layer.id, visible);
      const opacity = settings.opacity[layer.id] ?? layer.opacity;
      if (opacity !== undefined) world.setOpacity(layer.id, opacity);
      if (layer.filters) {
        const hidden = new Set(settings.hidden[layer.id] ?? []);
        world.setFilter(layer.id, new Set(layer.filters.map((f) => f.id).filter((id) => !hidden.has(id))));
      }
    }
  }, [world, settings]);

  useEffect(() => {
    void world?.setBasemap(view.basemap);
  }, [world, view.basemap]);

  const select = useCallback(
    (next: Selection | undefined) => {
      setSelection(next);
      setFollowing(false);
      world?.select(next?.kind === 'entity' ? next.ref : undefined);
    },
    [world],
  );

  useEffect(() => {
    if (!world) return;
    world.onPointer(
      (pick: Pick) => {
        if (pick.kind === 'entity') select({ kind: 'entity', ref: { layer: pick.layer, key: pick.key } });
        else if (pick.kind === 'place') select({ kind: 'place', lat: pick.lat, lon: pick.lon });
        else select(undefined);
      },
      (pick: Pick) => {
        const title = pick.kind === 'entity' ? world.details(pick)?.title : undefined;
        if (container.current) container.current.style.cursor = title ? 'pointer' : '';
        setHover(title ? { title, ...pointer.current } : undefined);
      },
    );
  }, [world, select]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      if (event.key === 'Escape' && !searchOpen) select(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, select]);

  const follow = (details: Details | undefined) => {
    world?.follow(details?.position);
    setFollowing(details !== undefined);
  };

  const goTo = (hit: SearchHit) => {
    if (!world) return;
    const ref = { layer: hit.layer, key: hit.key };
    select({ kind: 'entity', ref });
    const details = world.details(ref);
    if (details?.position) {
      world.follow(details.position);
      setFollowing(true);
    }
  };

  // Credit the sources of what's drawing now; map imagery credits itself (the `credits` element).
  const visibleSources = [
    ...new Set(
      (world?.available ?? [])
        .filter((l) => world?.state(l.id).kind === 'shown')
        .map((l) => layerById.get(l.id)?.source.name ?? ''),
    ),
  ].filter(Boolean);

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="relative h-full w-full bg-black"
        onPointerMove={(e) => {
          pointer.current = { x: e.clientX, y: e.clientY };
        }}
      >
        <div ref={mountGlobe} className="absolute inset-0" data-testid="globe" />
        {globeError && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <p className="max-w-sm text-center text-[13px] text-muted-foreground">
              The globe needs WebGL, which this browser didn't provide. Try another browser, or turn on
              hardware acceleration.
            </p>
          </div>
        )}

        {world && inPanorama && (
          <div className="pointer-events-none absolute inset-0">
            <PanoramaOverlay viewer={world.street} />
          </div>
        )}
        <div
          className={cn(
            'pointer-events-none absolute inset-0 flex flex-col p-3 sm:p-4',
            inPanorama && 'hidden',
          )}
        >
          <TopBar
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((open) => !open)}
            onSearch={() => setSearchOpen(true)}
          />
          <div className="mt-3 flex min-h-0 flex-1 items-start justify-between gap-3">
            <div className="flex max-h-full min-h-0">
              {panelOpen && (
                <LayerPanel
                  world={world}
                  settings={settings}
                  statuses={statuses}
                  basemap={view.basemap}
                  onChange={setSettings}
                  onBasemap={(basemap) => setView({ ...view, basemap })}
                  onClose={() => setPanelOpen(false)}
                />
              )}
            </div>
            {world && selection && (
              <Inspector
                world={world}
                selection={selection}
                following={following}
                onFollow={follow}
                onClose={() => select(undefined)}
              />
            )}
          </div>
          <footer className="mt-2 flex justify-end">
            <div className="pointer-events-auto flex max-w-full min-w-0 items-center gap-1.5 rounded bg-black/40 px-2 py-0.5 text-[10.5px] text-white/55">
              <div ref={credits} className="atlas-credits flex min-w-0 shrink items-center" />
              <p className="min-w-0 truncate">
                {visibleSources.join(' · ')}
                {selection?.kind === 'place' && ' · Open-Meteo'}
              </p>
            </div>
          </footer>
        </div>

        {hover && (
          <div
            className="pointer-events-none fixed z-10 rounded border bg-popover/90 px-1.5 py-0.5 text-[11px] text-popover-foreground shadow"
            style={{ left: hover.x + 14, top: hover.y + 18 }}
          >
            {hover.title}
          </div>
        )}

        <SearchDialog world={world} open={searchOpen} onOpenChange={setSearchOpen} onSelect={goTo} />
      </div>
    </TooltipProvider>
  );
}

function TopBar({
  panelOpen,
  onTogglePanel,
  onSearch,
}: {
  readonly panelOpen: boolean;
  readonly onTogglePanel: () => void;
  readonly onSearch: () => void;
}) {
  const now = useNow(1000);
  return (
    <header className="flex items-center justify-between gap-3">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-panel px-2.5 py-1.5 backdrop-blur-md">
        <Earth className="size-4 text-foreground/80" aria-hidden />
        <h1 className="text-[13px] font-semibold tracking-tight">Atlas</h1>
        <span className="text-muted-foreground/50">/</span>
        <time
          className="text-[12px] text-muted-foreground tabular-nums"
          dateTime={new Date(now).toISOString()}
        >
          {new Date(now).toISOString().slice(11, 19)} UTC
        </time>
        {!panelOpen && (
          <button
            type="button"
            onClick={onTogglePanel}
            className="ml-1 flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Layers className="size-3.5" />
            Layers
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onSearch}
        className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-panel px-2.5 py-1.5 text-[12px] text-muted-foreground backdrop-blur-md hover:text-foreground"
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">Search</span>
        <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
      </button>
    </header>
  );
}
