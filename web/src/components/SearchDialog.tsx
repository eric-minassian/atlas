import { MapPin } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { type Geocoder, geocoderFor, searchPlaces } from '../data/geocode.ts';
import type { PlaceHit } from '../data/places.ts';
import type { SearchHit } from '../layers/types.ts';
import type { World } from '../world.ts';

/** Waits this long after the last keystroke before asking a geocoder. */
const DEBOUNCE_MS = 300;

const attribution: Record<Geocoder, string> = {
  google: 'Places by Google',
  photon: 'Places by Photon · © OpenStreetMap contributors',
};

type PlaceSearch =
  | { readonly state: 'idle' }
  | { readonly state: 'loading'; readonly query: string }
  | {
      readonly state: 'done';
      readonly query: string;
      readonly geocoder: Geocoder;
      readonly hits: ReadonlyArray<PlaceHit>;
    }
  | { readonly state: 'error'; readonly query: string };

/** Places matching `query` (debounced; a newer query or closing aborts the request in flight). */
function usePlaceSearch(world: World | undefined, query: string, open: boolean): PlaceSearch {
  const [search, setSearch] = useState<PlaceSearch>({ state: 'idle' });
  const q = query.trim();
  useEffect(() => {
    if (!world || !open || q.length < 2) return undefined;
    const controller = new AbortController();
    const run = async () => {
      setSearch({ state: 'loading', query: q });
      const geocoder = geocoderFor(world.globe);
      try {
        const hits = await searchPlaces(world.globe, q, controller.signal);
        if (!controller.signal.aborted) setSearch({ state: 'done', query: q, geocoder, hits });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn('place search failed', error);
        setSearch({ state: 'error', query: q });
      }
    };
    const timer = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [world, q, open]);
  // An answer for an older query isn't shown while the new one loads.
  return search.state !== 'idle' && search.query === q && open ? search : { state: 'idle' };
}

export function SearchDialog({
  world,
  open,
  onOpenChange,
  onSelect,
  onPlace,
}: {
  readonly world: World | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (hit: SearchHit) => void;
  readonly onPlace: (place: PlaceHit) => void;
}) {
  const [query, setQuery] = useState('');
  const places = usePlaceSearch(world, query, open);
  const hits = useMemo(() => (world && open ? world.search(query) : []), [world, query, open]);
  const groups = useMemo(() => {
    const byLayer = new Map<string, SearchHit[]>();
    for (const hit of hits) byLayer.set(hit.layer, [...(byLayer.get(hit.layer) ?? []), hit]);
    return [...byLayer];
  }, [hits]);

  const close = () => {
    onOpenChange(false);
    setQuery('');
  };
  const searching = query.trim().length >= 2;
  const placeHits = places.state === 'done' ? places.hits : [];

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
      title="Search"
      description="Go to a place or address, or find an aircraft, satellite, camera or event on the map"
      className="bg-popover/95 backdrop-blur-md"
      shouldFilter={false}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Place, address, callsign, satellite…"
      />
      <CommandList>
        {/* Until the geocoder answers, "nothing matches" would be premature. */}
        {searching && places.state === 'done' && <CommandEmpty>Nothing matches.</CommandEmpty>}
        {placeHits.length > 0 && places.state === 'done' && (
          <CommandGroup heading="Places">
            {placeHits.map((place) => (
              <CommandItem
                key={place.key}
                value={place.key}
                onSelect={() => {
                  onPlace(place);
                  close();
                }}
              >
                <MapPin className="text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate">{place.title}</p>
                  {place.subtitle && (
                    <p className="truncate text-[11px] text-muted-foreground">{place.subtitle}</p>
                  )}
                </div>
              </CommandItem>
            ))}
            <p className="px-2 pt-1 pb-0.5 text-[10.5px] text-muted-foreground/60">
              {attribution[places.geocoder]}
            </p>
          </CommandGroup>
        )}
        {searching && places.state === 'loading' && (
          <p className="px-4 py-2 text-[12px] text-muted-foreground">Searching places…</p>
        )}
        {searching && places.state === 'error' && (
          <p className="px-4 py-2 text-[12px] text-muted-foreground">
            Place search is unavailable right now.
          </p>
        )}
        {groups.map(([layer, items]) => (
          <CommandGroup key={layer} heading={world?.layerTitle(layer)}>
            {items.map((hit) => (
              <CommandItem
                key={`${hit.layer}:${hit.key}`}
                value={`${hit.layer}:${hit.key}`}
                onSelect={() => {
                  onSelect(hit);
                  close();
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
