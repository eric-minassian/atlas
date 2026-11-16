import { parse } from 'csv-parse/sync';
import { IngestError } from './source.ts';

export interface Table<C extends string, O extends string = never> {
  /** Data rows, header excluded. */
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** Each column's position; -1 for an optional column that isn't there. */
  readonly column: Readonly<Record<C | O, number>>;
}

/**
 * Parses CSV (RFC 4180: quoted fields may hold commas and line breaks) with a
 * header row, checking the columns a parser relies on are there. Columns are
 * found by name, so sources can add or reorder them.
 */
export const readCsv = <const C extends string, const O extends string = never>(
  text: string,
  required: ReadonlyArray<C>,
  source: string,
  optional: ReadonlyArray<O> = [],
): Table<C, O> | IngestError => {
  let records: string[][];
  try {
    records = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: true });
  } catch (cause) {
    return new IngestError({
      message: `${source} CSV: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  const header = (records[0] ?? []).map((name) => name.trim());
  const column = Object.fromEntries(
    [...required, ...optional].map((name) => [name, header.indexOf(name)]),
  ) as Record<C | O, number>;
  const missing = required.filter((name) => column[name] < 0);
  if (missing.length > 0)
    return new IngestError({ message: `${source} CSV is missing ${missing.join(', ')}` });
  return { rows: records.slice(1), column };
};

/** A field as a finite number, or undefined when empty or not a number. */
export const numberField = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
