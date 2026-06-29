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
// amount_atomic is a POSITIVE uint256 token amount (schema CHECK: amount_atomic > 0).
const UINT256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

// Shared validator: a positive integer in [1, 2^256-1], represented losslessly as a decimal string.
// Rejects JS numbers, signs, decimals, zero, and overflow. Canonicalizes (strips leading zeros).
function positiveUint256(label: string, raw: unknown): string {
  let s: string;
  if (typeof raw === "bigint") s = raw.toString();
  else if (typeof raw === "string") s = raw;
  else throw new TypeError(`${label}: expected a positive integer string/bigint, got ${typeof raw}`);
  if (!DIGITS_ONLY.test(s)) throw new TypeError(`${label}: digits only, no sign/decimal — got ${s}`);
  // uint256 max is 78 digits; reject clearly-oversized input before BigInt parses it.
  if (s.length > 78) throw new RangeError(`${label}: amount exceeds uint256 max (>${78} digits)`);
  const n = BigInt(s);
  if (n <= 0n) throw new RangeError(`${label}: amount must be positive, got ${s}`);
  if (n > UINT256_MAX) throw new RangeError(`${label}: amount exceeds uint256 max, got ${s}`);
  return n.toString();
}

/** NUMERIC(78,0) from a row — exact positive decimal string, never via a JS number. */
export function atomicFromRow(value: unknown): string {
  return positiveUint256("atomicFromRow", value);
}

/** NUMERIC(78,0) to a query arg — validates a positive uint256 decimal string. */
export function atomicToArg(value: string): string {
  return positiveUint256("atomicToArg", value);
}

// Shared SEMANTIC validator for an ISO-ish "YYYY-MM-DD[T ]HH:MM:SS…" string: checks calendar date and
// clock ranges BEFORE any Date parsing, because new Date() rolls over invalid values (Feb 30 -> Mar 2,
// 24:00:00 -> next day) instead of returning NaN. Used by both isoUtcFromRow and isoUtcToArg.
function assertValidTimestamp(label: string, value: string): void {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/u);
  if (!m) throw new TypeError(`${label}: malformed timestamp ${value}`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), s = Number(m[6]);
  if (mo < 1 || mo > 12) throw new TypeError(`${label}: month out of range in ${value}`);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) throw new TypeError(`${label}: day out of range in ${value}`);
  if (h > 23 || mi > 59 || s > 59) throw new TypeError(`${label}: time out of range in ${value}`);
}

/** TIMESTAMPTZ from a row -> canonical ISO-8601 UTC string (always UTC, locale-independent). */
export function isoUtcFromRow(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    // Require an explicit UTC designator or offset. A timezone-less string ("2026-07-01 09:00:00")
    // would be parsed in the process locale — reject it rather than silently shift the instant.
    if (!/(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value)) {
      throw new TypeError(`isoUtcFromRow: timezone-less timestamp rejected (no Z/offset): ${value}`);
    }
    assertValidTimestamp("isoUtcFromRow", value);
    // Normalize the space separator and a minutes-less offset ("+00" -> "+00:00"), then re-emit ...Z.
    const normalized = (value.includes("T") ? value : value.replace(" ", "T")).replace(/([+-]\d{2})$/u, "$1:00");
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) throw new TypeError(`isoUtcFromRow: unparseable/invalid timestamp ${value}`);
    return d.toISOString();
  }
  throw new TypeError(`isoUtcFromRow: expected Date or string, got ${typeof value}`);
}

/** Nullable TIMESTAMPTZ from a row. */
export function isoUtcFromRowNullable(value: unknown): string | null {
  return value === null || value === undefined ? null : isoUtcFromRow(value);
}

/** TIMESTAMPTZ to a query arg — requires a canonical ISO-8601 UTC string that is also semantically valid. */
export function isoUtcToArg(value: string): string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new TypeError(`isoUtcToArg: expected canonical ISO-8601 UTC (…Z), got ${String(value)}`);
  }
  assertValidTimestamp("isoUtcToArg", value);
  return value;
}

// "HH:MM[:SS]" with hour 0..23, minute 0..59, second 0..59 — not merely two-digit groups.
function isValidTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/u);
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59 && (m[3] ? Number(m[3]) <= 59 : true);
}

/** TIME from a row -> "HH:MM[:SS]" string, range-validated (no locale interpretation). */
export function timeFromRow(value: unknown): string {
  if (!isValidTime(value)) throw new TypeError(`timeFromRow: invalid time ${String(value)}`);
  return value;
}

/** TIME to a query arg — accepts a valid "HH:MM" or "HH:MM:SS". */
export function timeToArg(value: string): string {
  if (!isValidTime(value)) throw new TypeError(`timeToArg: expected HH:MM[:SS] in range, got ${String(value)}`);
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
    // Only a real number or a non-empty digit string is a weekday. Reject null/empty/whitespace/booleans
    // so they cannot coerce to weekday 0 (Number("") === 0).
    let n: number;
    if (typeof d === "number") n = d;
    else if (typeof d === "string" && /^\d+$/u.test(d.trim())) n = Number(d.trim());
    else throw new TypeError(`weekdayArrayFromRow: non-numeric weekday element ${JSON.stringify(d)}`);
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

/** INTEGER cents/bps from a row -> number. Rejects null/boolean/empty/non-canonical and unsafe integers. */
export function intFromRow(value: unknown): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "bigint") n = Number(value);
  else if (typeof value === "string" && /^-?\d+$/u.test(value)) n = Number(value);
  else throw new TypeError(`intFromRow: expected an integer, got ${value === null ? "null" : typeof value}`);
  if (!Number.isSafeInteger(n)) throw new RangeError(`intFromRow: not a safe integer: ${String(value)}`);
  return n;
}

/** Nullable INTEGER from a row. */
export function intFromRowNullable(value: unknown): number | null {
  return value === null || value === undefined ? null : intFromRow(value);
}

/** boolean from a row — accepts only explicit true/false representations; throws on anything else. */
export function boolFromRow(value: unknown): boolean {
  if (value === true || value === 1 || value === "t" || value === "true" || value === "1") return true;
  if (value === false || value === 0 || value === "f" || value === "false" || value === "0") return false;
  throw new TypeError(`boolFromRow: expected a boolean representation, got ${String(value)}`);
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
