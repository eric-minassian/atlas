import { DateTime, Effect, Option } from 'effect';
import { feeds } from '../catalog.ts';
import type { TsunamiBulletin, TsunamiData } from '../domain.ts';
import { get, IngestError, notModified, okText, round, type Source, updated } from './source.ts';

/**
 * Each warning center's latest bulletin, as Atom: the National Tsunami
 * Warning Center (Palmer, Alaska) and the Pacific Tsunami Warning Center
 * (Honolulu). Usually an information statement about a small quake, or empty.
 */
const CENTERS = [
  { center: 'NTWC', url: 'https://www.tsunami.gov/events/xml/PAAQAtom.xml' },
  { center: 'PTWC', url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml' },
] as const;

/** A bulletin stays on the map this long; warnings are reissued (or cancelled) well within it. */
const KEEP_MS = 24 * 3_600_000;

const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

const entities: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/g, (whole, name: string) =>
      name.startsWith('#') ? String.fromCharCode(Number(name.slice(1))) : (entities[name] ?? whole),
    )
    .replace(/\s+/g, ' ')
    .trim();

/** A labeled value in the bulletin summary: `<strong>Category:</strong> Information<br/>`. */
const field = (summary: string, label: string): string | undefined => {
  const match = new RegExp(`<(?:strong|b)>\\s*${label}:\\s*</(?:strong|b)>([\\s\\S]*?)<br\\s*/?>`).exec(
    summary,
  );
  const value = match?.[1] === undefined ? undefined : text(match[1]);
  return value || undefined;
};

const SMALL_WORDS = new Set(['of', 'the', 'and', 'to', 'in', 'at', 'on', 'off', 'near']);
/** Sentence-cases the shouting some bulletins use: "ABOUT 84 MILES NORTHWEST OF ISLA MONA". */
const calm = (value: string) =>
  value === value.toUpperCase()
    ? value
        .toLowerCase()
        .split(' ')
        .map((word, i) =>
          i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join(' ')
    : value;

/** Bulletins in one center's Atom feed issued within the past day. */
export const parseTsunamiFeed = (
  xml: string,
  center: TsunamiBulletin['center'],
  now: number,
): ReadonlyArray<TsunamiBulletin> => {
  const bulletins: TsunamiBulletin[] = [];
  for (const [, entry = ''] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const issued = Date.parse(tag(entry, 'updated') ?? '');
    const lat = Number(tag(entry, 'geo:lat'));
    const lon = Number(tag(entry, 'geo:long'));
    const id = tag(entry, 'id')?.trim();
    const summary = tag(entry, 'summary') ?? '';
    const url = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(entry)?.[1];
    if (!id || !url || !Number.isFinite(issued) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (now - issued > KEEP_MS) continue;
    bulletins.push({
      id,
      center,
      category: field(summary, 'Category') ?? 'Information',
      region: calm(text(tag(entry, 'title') ?? '')),
      issued,
      lon: round(lon, 4),
      lat: round(lat, 4),
      magnitude: field(summary, 'Preliminary Magnitude') ?? null,
      note: (field(summary, 'Note') ?? '').replace(/^\*\s*/, ''),
      url,
    });
  }
  return bulletins;
};

/**
 * Both centers' current bulletins. One center's feed failing keeps its
 * bulletins from the last snapshot; the refresh fails only if both do.
 */
export const makeTsunamiSource = (): Source<'tsunamis'> => ({
  interval: Effect.succeed(feeds.tsunamis.intervalSeconds),
  read: (_validators, previous) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const results = yield* Effect.forEach(
        CENTERS,
        ({ url }) => get(url).pipe(Effect.flatMap(okText), Effect.result),
        { concurrency: 2 },
      );
      if (results.every((r) => r._tag === 'Failure'))
        return yield* new IngestError({
          message: results.map((r) => (r._tag === 'Failure' ? r.failure.message : '')).join('; '),
        });
      const last = yield* previous;
      const bulletins: TsunamiBulletin[] = [];
      for (const [i, { center }] of CENTERS.entries()) {
        const result = results[i];
        if (result?._tag === 'Success') {
          bulletins.push(...parseTsunamiFeed(result.success, center, now));
          continue;
        }
        yield* Effect.logWarning('tsunami feed unavailable; keeping its last bulletins').pipe(
          Effect.annotateLogs({ center, error: result?._tag === 'Failure' ? result.failure.message : '' }),
        );
        if (Option.isSome(last))
          bulletins.push(
            ...last.value.bulletins.filter((b) => b.center === center && now - b.issued <= KEEP_MS),
          );
      }
      const data: TsunamiData = { bulletins: bulletins.toSorted((a, b) => b.issued - a.issued) };
      // Bulletins are rare: don't publish a new version of the same (usually empty) list every two minutes.
      if (Option.isSome(last) && JSON.stringify(last.value) === JSON.stringify(data)) return notModified;
      return updated<'tsunamis'>(data, data.bulletins.length);
    }),
});
