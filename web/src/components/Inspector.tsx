import { ArrowUpRight, Crosshair, LocateFixed, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Here } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { useNow } from '../hooks.ts';
import type { Details, Field } from '../layers/types.ts';
import { formatInt, formatLatLon, formatNumber } from '../lib/format.ts';
import { describeWeather } from '../lib/weather.ts';
import type { EntityRef, World } from '../world.ts';

export type Selection =
  | { readonly kind: 'entity'; readonly ref: EntityRef }
  | { readonly kind: 'place'; readonly lat: number; readonly lon: number };

function Panel({ children, onClose }: { readonly children: React.ReactNode; readonly onClose: () => void }) {
  return (
    <aside
      aria-label="Details"
      className="pointer-events-auto relative w-[320px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-panel shadow-xl shadow-black/30 backdrop-blur-md"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-2.5 right-2.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Close details"
      >
        <X className="size-3.5" />
      </button>
      {children}
    </aside>
  );
}

function Fields({ fields }: { readonly fields: ReadonlyArray<Field> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-[12px]">
      {fields.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-muted-foreground">{f.label}</dt>
          <dd className="text-right text-foreground/95 tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Heading({ kind, title, subtitle }: { kind: string; title: string; subtitle?: string | undefined }) {
  return (
    <header className="border-b px-4 pt-3.5 pr-10 pb-3">
      <p className="text-[11px] tracking-wider text-muted-foreground uppercase">{kind}</p>
      <h2 className="mt-0.5 truncate text-[17px] leading-tight font-semibold">{title}</h2>
      {subtitle && <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{subtitle}</p>}
    </header>
  );
}

export function Inspector({
  world,
  selection,
  following,
  onFollow,
  onClose,
}: {
  readonly world: World;
  readonly selection: Selection;
  readonly following: boolean;
  readonly onFollow: (details: Details | undefined) => void;
  readonly onClose: () => void;
}) {
  return selection.kind === 'entity' ? (
    <EntityInspector
      world={world}
      entity={selection.ref}
      following={following}
      onFollow={onFollow}
      onClose={onClose}
    />
  ) : (
    <PlaceInspector world={world} lat={selection.lat} lon={selection.lon} onClose={onClose} />
  );
}

function EntityInspector({
  world,
  entity,
  following,
  onFollow,
  onClose,
}: {
  readonly world: World;
  readonly entity: EntityRef;
  readonly following: boolean;
  readonly onFollow: (details: Details | undefined) => void;
  readonly onClose: () => void;
}) {
  useNow(1000); // moving things: refresh the numbers every second
  const details = world.details(entity);
  if (!details)
    return (
      <Panel onClose={onClose}>
        <Heading kind={world.layerTitle(entity.layer)} title="No longer reported" />
        <p className="px-4 py-3 text-[12px] text-muted-foreground">
          It dropped out of the latest update from the source.
        </p>
      </Panel>
    );
  return (
    <Panel onClose={onClose}>
      <Heading kind={details.kind} title={details.title} subtitle={details.subtitle} />
      <Fields fields={details.fields} />
      <footer className="flex items-center justify-between gap-2 border-t px-3 py-2.5">
        {details.position ? (
          <Button
            variant={following ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onFollow(following ? undefined : details)}
          >
            {following ? <LocateFixed /> : <Crosshair />}
            {following ? 'Following' : 'Follow'}
          </Button>
        ) : (
          <span />
        )}
        {details.link && (
          <a
            href={details.link.href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            {details.link.label}
            <ArrowUpRight className="size-3.5" />
          </a>
        )}
      </footer>
    </Panel>
  );
}

function PlaceInspector({
  world,
  lat,
  lon,
  onClose,
}: {
  readonly world: World;
  readonly lat: number;
  readonly lon: number;
  readonly onClose: () => void;
}) {
  const now = useNow(1000);
  const key = `${lat},${lon}`;
  const [result, setResult] = useState<{ readonly key: string; readonly here: Here | 'error' }>();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const here = await callApi((api) => api.here({ query: { lat, lon } }));
        if (!cancelled) setResult({ key, here });
      } catch {
        if (!cancelled) setResult({ key, here: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, lat, lon]);
  const here = result?.key === key ? result.here : 'loading';

  const fields: Field[] = [];
  let subtitle: string | undefined;
  if (typeof here === 'object') {
    if (here.utcOffsetSeconds !== null) {
      const local = new Date(now + here.utcOffsetSeconds * 1000).toISOString().slice(11, 16);
      fields.push({ label: 'Local time', value: `${local}${here.timezone ? ` · ${here.timezone}` : ''}` });
    }
    if (here.elevation !== null) fields.push({ label: 'Elevation', value: `${formatInt(here.elevation)} m` });
    const w = here.weather;
    if (w) {
      subtitle = `${describeWeather(w.weatherCode)}, ${formatNumber(w.temperature)} °C`;
      fields.push(
        { label: 'Feels like', value: `${formatNumber(w.apparentTemperature)} °C` },
        {
          label: 'Wind',
          value: `${formatInt(w.windSpeed)} km/h from ${formatInt(w.windDirection)}°, gusts ${formatInt(w.windGusts)}`,
        },
        { label: 'Humidity', value: `${formatInt(w.humidity)}%` },
        { label: 'Cloud cover', value: `${formatInt(w.cloudCover)}%` },
        { label: 'Precipitation', value: `${formatNumber(w.precipitation)} mm` },
        { label: 'Pressure', value: `${formatInt(w.pressure)} hPa` },
      );
    }
  }

  return (
    <Panel onClose={onClose}>
      <Heading kind="Location" title={formatLatLon(lat, lon)} subtitle={subtitle} />
      {here === 'loading' && (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">Looking up conditions…</p>
      )}
      {here === 'error' && (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">
          Conditions here are unavailable right now.
        </p>
      )}
      {typeof here === 'object' && <Fields fields={fields} />}
      <footer className="flex items-center justify-between border-t px-3 py-2.5">
        <Button variant="ghost" size="sm" onClick={() => world.globe.flyTo(lat, lon, 1_500_000)}>
          <Crosshair />
          Zoom in
        </Button>
        <span className="text-[11px] text-muted-foreground/70">Weather: Open-Meteo</span>
      </footer>
    </Panel>
  );
}
