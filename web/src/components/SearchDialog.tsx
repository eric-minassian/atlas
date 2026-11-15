import { useMemo, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { SearchHit } from '../layers/types.ts';
import type { World } from '../world.ts';

export function SearchDialog({
  world,
  open,
  onOpenChange,
  onSelect,
}: {
  readonly world: World | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState('');
  const hits = useMemo(() => (world && open ? world.search(query) : []), [world, query, open]);
  const groups = useMemo(() => {
    const byLayer = new Map<string, SearchHit[]>();
    for (const hit of hits) byLayer.set(hit.layer, [...(byLayer.get(hit.layer) ?? []), hit]);
    return [...byLayer];
  }, [hits]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
      title="Search"
      description="Find an aircraft, satellite, earthquake or event"
      className="bg-popover/95 backdrop-blur-md"
      shouldFilter={false}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Callsign, satellite name or NORAD id, place…"
      />
      <CommandList>
        {query.trim().length >= 2 && <CommandEmpty>Nothing matches in the visible layers.</CommandEmpty>}
        {groups.map(([layer, items]) => (
          <CommandGroup key={layer} heading={world?.layerTitle(layer)}>
            {items.map((hit) => (
              <CommandItem
                key={`${hit.layer}:${hit.key}`}
                value={`${hit.layer}:${hit.key}`}
                onSelect={() => {
                  onSelect(hit);
                  onOpenChange(false);
                  setQuery('');
                }}
              >
                <div className="min-w-0">
                  <p className="truncate">{hit.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{hit.subtitle}</p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
