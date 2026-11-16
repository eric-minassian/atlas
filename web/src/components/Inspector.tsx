import { ArrowUpRight, Crosshair, Footprints, LocateFixed, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Here } from '../../../src/domain.ts';
import { callApi } from '../client.ts';
import { useNow } from '../hooks.ts';
import type { Details, Field, Picture } from '../layers/types.ts';
import { describeAqi } from '../lib/airquality.ts';
import { formatInt, formatLatLon, formatNumber } from '../lib/format.ts';
import { describeWeather } from '../lib/weather.ts';
import { distance, type Pano } from '../street/providers.ts';
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
      <div className="max-h-[calc(100vh-11rem)] overflow-y-auto">
        {details.picture && <PictureView picture={details.picture} />}
        {details.body && (
          // Alerts and warnings come as paragraphs separated by blank lines.
          <p className="border-b px-4 py-3 text-[12px] leading-relaxed whitespace-pre-line text-foreground/85">
            {details.body}
          </p>
        )}
        {details.fields.length > 0 && <Fields fields={details.fields} />}
      </div>
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
        ) : details.extent ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => details.extent && world.globe.flyToBounds(details.extent)}
          >
            <Crosshair />
            Show all
          </Button>
        ) : (
          <span />
        )}
        {details.links && details.links.length > 0 && (
          <div className="flex min-w-0 flex-wrap justify-end gap-x-3 gap-y-1">
            {details.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                {link.label}
                <ArrowUpRight className="size-3.5" />
              </a>
            ))}
          </div>
        )}
      </footer>
    </Panel>
  );
}

/** A picture, reloaded every `refreshMs` when it's a live camera; keeps the last frame if a reload fails. */
function PictureView({ picture }: { readonly picture: Picture }) {
  const tick = useNow(picture.refreshMs ?? 24 * 3_600_000);
  const [failed, setFailed] = useState<string>();
  const src = picture.refreshMs
    ? `${picture.src}${picture.src.includes('?') ? '&' : '?'}t=${Math.floor(tick / picture.refreshMs)}`
    : picture.src;
  const image = (
    <img
      src={src}
      alt={picture.alt}
      onError={() => setFailed(picture.src)}
      onLoad={() => setFailed(undefined)}
      className="block w-full bg-black/40 object-cover"
      style={{ aspectRatio: picture.aspect ?? 16 / 9 }}
      referrerPolicy="no-referrer"
    />
  );
  return (
    <figure className="border-b">
      {failed === picture.src ? (
        <div
          className="flex w-full items-center justify-center bg-black/30 text-[12px] text-muted-foreground"
          style={{ aspectRatio: picture.aspect ?? 16 / 9 }}
        >
          Image unavailable right now
        </div>
      ) : picture.href ? (
        <a href={picture.href} target="_blank" rel="noreferrer">
          {image}
        </a>
      ) : (
        image
      )}
      {picture.credit && (
        <figcaption className="truncate px-4 pt-1.5 pb-2 text-[11px] text-muted-foreground/80">
          {picture.credit}
        </figcaption>
      )}
    </figure>
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
    const air = here.airQuality;
    if (air) {
      const micrograms = (value: number | null) => (value === null ? '—' : `${formatNumber(value)} µg/m³`);
      if (air.usAqi !== null)
        fields.push({
          label: 'Air quality',
          value: `${formatInt(air.usAqi)} US AQI · ${describeAqi(air.usAqi)}`,
        });
      fields.push(
        { label: 'PM2.5', value: micrograms(air.pm25) },
        { label: 'PM10', value: micrograms(air.pm10) },
        { label: 'Ozone', value: micrograms(air.ozone) },
        { label: 'Nitrogen dioxide', value: micrograms(air.nitrogenDioxide) },
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
      <StreetLevelPreview world={world} lat={lat} lon={lon} />
      <footer className="flex items-center justify-between border-t px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            world.globe.flyTo(lat, lon, Math.max(300, Math.min(1_500_000, world.globe.view.height / 6)))
          }
        >
          <Crosshair />
          Zoom in
        </Button>
        <span className="text-[11px] text-muted-foreground/70">
          Weather: Open-Meteo{typeof here === 'object' && here.airQuality ? ' · Air quality: CAMS' : ''}
        </span>
      </footer>
    </Panel>
  );
}

/** How far from a clicked point a panorama still counts as "here": about half a street's width each way. */
const STREET_RADIUS = 40;
/** Only look for panoramas when zoomed in far enough that a click means a street, not a region. */
const STREET_SEARCH_BELOW = 20_000;

/**
 * The nearest 360° panorama to a clicked point, from any street-level source,
 * with a way in. Shows nothing when there's none nearby.
 */
function StreetLevelPreview({
  world,
  lat,
  lon,
}: {
  readonly world: World;
  readonly lat: number;
  readonly lon: number;
}) {
  const key = `${lat},${lon}`;
  const [found, setFound] = useState<{ readonly key: string; readonly pano: Pano | undefined }>();
  const near = world.globe.view.height < STREET_SEARCH_BELOW;
  useEffect(() => {
    if (!near) return undefined;
    const abort = new AbortController();
    void (async () => {
      const results = await Promise.all(
        world.street.sources.map((source) =>
          source.nearest(lon, lat, STREET_RADIUS, abort.signal).catch(() => undefined),
        ),
      );
      const panos = results.filter((p): p is Pano => p !== undefined);
      const nearest = panos.toSorted((a, b) => distance({ lon, lat }, a) - distance({ lon, lat }, b))[0];
      if (!abort.signal.aborted) setFound({ key, pano: nearest });
    })();
    return () => abort.abort();
  }, [world, key, lat, lon, near]);
  const pano = found?.key === key ? found.pano : undefined;
  if (!pano) return null;
  const date = pano.capturedAt
    ? new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short' }).format(pano.capturedAt)
    : undefined;
  return (
    <button
      type="button"
      aria-label="Look around from the nearest street-level panorama"
      onClick={() => void world.street.open(pano)}
      className="group flex w-full items-center gap-3 border-t px-3 py-2.5 text-left hover:bg-white/[0.04]"
    >
      <img
        src={pano.thumbnail}
        alt=""
        className="h-12 w-20 shrink-0 rounded object-cover"
        referrerPolicy="no-referrer"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <Footprints className="size-3.5" />
          Look around
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {[
            pano.provider === 'mapillary' ? 'Mapillary' : 'Panoramax',
            date,
            `${Math.round(distance({ lon, lat }, pano))} m away`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </button>
  );
}
