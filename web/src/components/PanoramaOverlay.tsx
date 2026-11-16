import { ArrowUpRight, ChevronUp, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { bearing } from '../street/providers.ts';
import type { PanoramaState, PanoramaViewer } from '../street/viewer.ts';

export function usePanorama(viewer: PanoramaViewer | undefined): PanoramaState | undefined {
  return useSyncExternalStore(
    (listener) => viewer?.changed.add(listener) ?? (() => {}),
    () => viewer?.state,
  );
}

const providerName = { panoramax: 'Panoramax', mapillary: 'Mapillary' } as const;

const formatDate = (ms: number | undefined) =>
  ms === undefined
    ? undefined
    : new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(ms);

/**
 * What's on screen while standing in a panorama: where the image comes from
 * (with the credit its license requires), arrows toward the next images along
 * the street, and the way back out.
 */
export function PanoramaOverlay({ viewer }: { readonly viewer: PanoramaViewer }) {
  const state = usePanorama(viewer);
  const [markers, setMarkers] = useState<ReadonlyArray<{ id: string; x: number; y: number; turn: number }>>(
    [],
  );

  // The arrows sit on the ground toward each neighbor, so they move as the view turns.
  useEffect(() => {
    if (!state) return undefined;
    let frame = 0;
    const tick = () => {
      const heading = viewer.heading();
      const next = state.neighbors.flatMap((neighbor) => {
        const at = viewer.markerAt(neighbor);
        return at ? [{ id: neighbor.id, ...at, turn: bearing(state.pano, neighbor) - heading }] : [];
      });
      setMarkers((previous) =>
        previous.length === next.length &&
        previous.every((m, i) => {
          const n = next[i];
          return n !== undefined && m.id === n.id && Math.abs(m.x - n.x) < 0.5 && Math.abs(m.y - n.y) < 0.5;
        })
          ? previous
          : next,
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [viewer, state]);

  useEffect(() => {
    if (!state) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') viewer.close();
      else if (event.key === 'ArrowUp' || event.key === 'w') viewer.step(viewer.heading());
      else if (event.key === 'ArrowDown' || event.key === 's') viewer.step(viewer.heading() + 180);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, state]);

  if (!state) return null;
  const { pano } = state;
  const date = formatDate(pano.capturedAt);
  return (
    <>
      {markers.map((marker) => {
        const neighbor = state.neighbors.find((n) => n.id === marker.id);
        return (
          <button
            key={marker.id}
            type="button"
            aria-label="Walk this way"
            onClick={() => neighbor && void viewer.go(neighbor)}
            className="pointer-events-auto absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/40 bg-black/35 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/55"
            style={{ left: marker.x, top: marker.y }}
          >
            <ChevronUp className="size-6" style={{ transform: `rotate(${marker.turn}deg)` }} />
          </button>
        );
      })}
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3 sm:top-4">
        <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border bg-panel py-1.5 pr-1.5 pl-3 shadow-xl shadow-black/30 backdrop-blur-md">
          <div className="min-w-0 text-[12px] leading-tight">
            <p className="truncate font-medium text-foreground">
              {providerName[pano.provider]}
              {date && <span className="font-normal text-muted-foreground"> · {date}</span>}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {pano.author && `${pano.author} · `}
              {pano.license.href ? (
                <a
                  href={pano.license.href}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground"
                >
                  {pano.license.label}
                </a>
              ) : (
                pano.license.label
              )}
            </p>
          </div>
          {state.loading && (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
          )}
          <a
            href={pano.page}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[12px] whitespace-nowrap text-muted-foreground hover:text-foreground"
          >
            Open in {providerName[pano.provider]}
            <ArrowUpRight className="size-3.5" />
          </a>
          <Button variant="secondary" size="sm" onClick={() => viewer.close()}>
            <X />
            Exit
            <Kbd className="ml-0.5 hidden sm:inline-flex">Esc</Kbd>
          </Button>
        </div>
      </div>
    </>
  );
}
