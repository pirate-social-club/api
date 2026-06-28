// Value codecs for the global bookings.* Postgres schema. These are the load-bearing correctness layer
// of the bounded repository: every Postgres value crosses the TS boundary through exactly one of these,
// so conversions stay lossless and locale-independent.
//
//   NUMERIC(78,0) amount_atomic  <-> decimal STRING (never a JS number — would lose uint256 precision)
//   TIMESTAMPTZ                  <-> canonical ISO-8601 UTC string
//   TIME                         <-> "HH:MM[:SS]" string (no locale transform)
//   SMALLINT[]                   <-> number[]
//   INTEGER cents/bps            <-> number (safe: fits in a JS number)
//
// Read helpers are tolerant of how a given driver materializes a type (node-postgres returns NUMERIC as
// a string and TIMESTAMPTZ as a Date; libSQL returns strings); write helpers emit a canonical wire form.

const DIGITS_ONLY = /^\d+$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

/** NUMERIC(78,0) from a row — returns the exact decimal string, never converting through a JS number. */
export function atomicFromRow(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && DIGITS_ONLY.test(value)) return value;
  // A JS number here means precision may already be lost; reject rather than silently corrupt.
  throw new TypeError(`atomicFromRow: expected a non-negative integer string, got ${typeof value}`);
}

/** NUMERIC(78,0) to a query arg — validates a non-negative integer string and passes it through verbatim. */
export function atomicToArg(value: string): string {
  if (typeof value !== "string" || !DIGITS_ONLY.test(value)) {
    throw new TypeError(`atomicToArg: expected a non-negative integer string, got ${String(value)}`);
  }
  return value;
}

/** TIMESTAMPTZ from a row -> canonical ISO-8601 UTC string (always UTC, locale-independent). */
export function isoUtcFromRow(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    // Postgres may render "2026-07-01 09:00:00+00"; normalize the space and a minutes-less offset
    // ("+00" -> "+00:00") so Date parses it, then re-emit canonical ...Z form.
    const normalized = (value.includes("T") ? value : value.replace(" ", "T")).replace(/([+-]\d{2})$/u, "$1:00");
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) throw new TypeError(`isoUtcFromRow: unparseable timestamp ${value}`);
    return d.toISOString();
  }
  throw new TypeError(`isoUtcFromRow: expected Date or string, got ${typeof value}`);
}

/** Nullable TIMESTAMPTZ from a row. */
export function isoUtcFromRowNullable(value: unknown): string | null {
  return value === null || value === undefined ? null : isoUtcFromRow(value);
}

/** TIMESTAMPTZ to a query arg — requires a canonical ISO-8601 UTC string (the API's wire form). */
export function isoUtcToArg(value: string): string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new TypeError(`isoUtcToArg: expected canonical ISO-8601 UTC (…Z), got ${String(value)}`);
  }
  return value;
}

/** TIME from a row -> "HH:MM:SS" / "HH:MM" string, unchanged (no locale interpretation). */
export function timeFromRow(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`timeFromRow: expected a time string, got ${typeof value}`);
  }
  return value;
}

/** TIME to a query arg — accepts "HH:MM" or "HH:MM:SS". */
export function timeToArg(value: string): string {
  if (!/^\d{2}:\d{2}(?::\d{2})?$/u.test(value)) {
    throw new TypeError(`timeToArg: expected HH:MM[:SS], got ${String(value)}`);
  }
  return value;
}

/** SMALLINT[] from a row -> number[] (handles a JS array or a Postgres array literal string "{1,5}"). */
export function weekdayArrayFromRow(value: unknown): number[] {
  const arr = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.replace(/^\{|\}$/gu, "").split(",").filter((s) => s.length > 0)
      : null;
  if (!arr) throw new TypeError(`weekdayArrayFromRow: expected array or '{…}' literal, got ${typeof value}`);
  return arr.map((d) => {
    const n = typeof d === "number" ? d : Number(String(d).trim());
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new RangeError(`weekdayArrayFromRow: bad weekday ${String(d)}`);
    return n;
  });
}

/** number[] -> a Postgres SMALLINT[] array literal arg "{1,5}" (validated 0..6, non-empty when required upstream). */
export function weekdayArrayToArg(values: number[]): string {
  for (const n of values) {
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new RangeError(`weekdayArrayToArg: bad weekday ${String(n)}`);
  }
  return `{${values.join(",")}}`;
}

/** INTEGER cents/bps from a row -> number (safe; these fit well within Number range). */
export function intFromRow(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`intFromRow: expected an integer, got ${String(value)}`);
  return n;
}

/** Nullable INTEGER from a row. */
export function intFromRowNullable(value: unknown): number | null {
  return value === null || value === undefined ? null : intFromRow(value);
}

/** boolean from a row (Postgres boolean materializes as a JS boolean; tolerate t/f/1/0 just in case). */
export function boolFromRow(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true" || value === "1";
}

/** Required text from a row. */
export function textFromRow(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`textFromRow: expected string, got ${typeof value}`);
  return value;
}

/** Nullable text from a row. */
export function textFromRowNullable(value: unknown): string | null {
  return value === null || value === undefined ? null : textFromRow(value);
}
