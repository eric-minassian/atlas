import { Minus, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Globe } from '../globe/globe.ts';

/** Zoom in and out around the center, and a compass that turns the view back to north. */
export function MapControls({ globe }: { readonly globe: Globe }) {
  const needle = useRef<SVGSVGElement | null>(null);

  // The needle turns with the camera every frame, outside React.
  useEffect(() => {
    const camera = globe.scene.camera;
    let shown = Number.NaN;
    return globe.scene.postRender.addEventListener(() => {
      const heading = camera.heading;
      if (Math.abs(heading - shown) < 0.002) return;
      shown = heading;
      if (needle.current) needle.current.style.transform = `rotate(${-heading}rad)`;
    });
  }, [globe]);

  return (
    <div className="pointer-events-auto flex flex-col overflow-hidden rounded-lg border bg-panel shadow-lg shadow-black/20 backdrop-blur-md">
      <Control label="Zoom in" shortcut="+" onClick={() => globe.navigation.zoomBy(1)}>
        <Plus className="size-4" />
      </Control>
      <Control label="Zoom out" shortcut="−" onClick={() => globe.navigation.zoomBy(-1)}>
        <Minus className="size-4" />
      </Control>
      <Control label="North up" shortcut="N" onClick={() => globe.navigation.resetNorth()}>
        <svg ref={needle} viewBox="0 0 16 16" className="size-4" aria-hidden>
          <path d="M8 1.5 10.6 8H5.4Z" fill="#e5484d" />
          <path d="M8 14.5 5.4 8h5.2Z" className="fill-muted-foreground/70" />
        </svg>
      </Control>
    </div>
  );
}

function Control({
  label,
  shortcut,
  onClick,
  children,
}: {
  readonly label: string;
  readonly shortcut: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="flex size-8 items-center justify-center text-muted-foreground not-last:border-b hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="flex items-center gap-2">
        {label}
        <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
