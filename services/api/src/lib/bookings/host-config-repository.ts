// Bounded repository for the global bookings HOST CONFIGURATION (read side): profiles, availability
// rules/exceptions, and price rules in the bookings.* Postgres schema.
//
// Boundary rules (Phase 1):
//   - Methods accept an EXPLICIT request-scoped SQL executor (a ReadClient or a Transaction). The
//     repository NEVER calls getControlPlaneClient itself and NEVER opens an implicit transaction —
//     the caller owns connection and transaction lifecycle.
//   - Every query is schema-qualified (bookings.*) with an explicit column list (no SELECT *).
//   - Every Postgres value is decoded through ./codecs; raw row shapes stay private to this module.
//   - "Published / bookable" policy lives OUTSIDE the repository; reads return rows as stored.
import type { InStatement, QueryResult, QueryResultRow } from "../sql-client";
import {
  boolFromRow, intFromRow, intFromRowNullable, isoUtcFromRow, isoUtcFromRowNullable, textFromRow,
  textFromRowNullable, timeFromRow, weekdayArrayFromRow,
} from "./codecs";
import type {
  AvailabilityException, AvailabilityRule, BookingProfile, HostConfiguration, PriceRule,
} from "./types";

/** A request-scoped SQL executor — satisfied by both ReadClient and Transaction. */
export interface BookingSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

// --- private raw-row decoders ------------------------------------------------------------------------

/** Strict JSONB decode for profiles.topics -> string[] | null (rejects non-array / non-string elements). */
function decodeTopics(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  // node-postgres returns JSONB pre-parsed; a libSQL backend may hand back a JSON string.
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
    throw new TypeError("decodeTopics: expected a JSON array of strings");
  }
  return parsed as string[];
}

function decodeProfile(row: QueryResultRow): BookingProfile {
  return {
    hostUserId: textFromRow(row.host_user_id),
    displayHeadline: textFromRowNullable(row.display_headline),
    bio: textFromRowNullable(row.bio),
    topics: decodeTopics(row.topics),
    introVideoRef: textFromRowNullable(row.intro_video_ref),
    hostTimezone: textFromRow(row.host_timezone),
    basePriceCents: intFromRow(row.base_price_cents),
    defaultSlotDurationSeconds: intFromRow(row.default_slot_duration_seconds),
    platformFeeBps: intFromRow(row.platform_fee_bps),
    payoutWalletAddress: textFromRowNullable(row.payout_wallet_address),
    isPublished: boolFromRow(row.is_published),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

function decodeAvailabilityRule(row: QueryResultRow): AvailabilityRule {
  return {
    ruleId: textFromRow(row.rule_id),
    hostUserId: textFromRow(row.host_user_id),
    byWeekday: weekdayArrayFromRow(row.by_weekday),
    startLocal: timeFromRow(row.start_local),
    endLocal: timeFromRow(row.end_local),
    slotDurationSeconds: intFromRow(row.slot_duration_seconds),
    effectiveFromUtc: isoUtcFromRowNullable(row.effective_from_utc),
    effectiveUntilUtc: isoUtcFromRowNullable(row.effective_until_utc),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

function decodeAvailabilityException(row: QueryResultRow): AvailabilityException {
  const kind = textFromRow(row.kind);
  if (kind !== "block" && kind !== "open") throw new TypeError(`decodeAvailabilityException: bad kind ${kind}`);
  return {
    exceptionId: textFromRow(row.exception_id),
    hostUserId: textFromRow(row.host_user_id),
    kind,
    startUtc: isoUtcFromRow(row.start_utc),
    endUtc: isoUtcFromRow(row.end_utc),
    createdAt: isoUtcFromRow(row.created_at),
  };
}

function decodePriceRule(row: QueryResultRow): PriceRule {
  return {
    priceRuleId: textFromRow(row.price_rule_id),
    hostUserId: textFromRow(row.host_user_id),
    matchWeekday: row.match_weekday === null || row.match_weekday === undefined ? null : weekdayArrayFromRow(row.match_weekday),
    matchLocalStart: row.match_local_start === null || row.match_local_start === undefined ? null : timeFromRow(row.match_local_start),
    matchLocalEnd: row.match_local_end === null || row.match_local_end === undefined ? null : timeFromRow(row.match_local_end),
    matchDurationSeconds: intFromRowNullable(row.match_duration_seconds),
    priceCents: intFromRow(row.price_cents),
    priority: intFromRow(row.priority),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

// --- explicit column lists (no SELECT *) -------------------------------------------------------------

const PROFILE_COLUMNS =
  "host_user_id, display_headline, bio, topics, intro_video_ref, host_timezone, base_price_cents, " +
  "default_slot_duration_seconds, platform_fee_bps, payout_wallet_address, is_published, created_at, updated_at";
// TIME columns are cast to ::text for a portable "HH:MM:SS" representation: node-postgres returns TIME as
// a string, but some drivers hand back an unparsed binary value, so we pin the wire form explicitly.
const RULE_COLUMNS =
  "rule_id, host_user_id, by_weekday, start_local::text AS start_local, end_local::text AS end_local, " +
  "slot_duration_seconds, effective_from_utc, effective_until_utc, created_at, updated_at";
const EXCEPTION_COLUMNS = "exception_id, host_user_id, kind, start_utc, end_utc, created_at";
const PRICE_RULE_COLUMNS =
  "price_rule_id, host_user_id, match_weekday, match_local_start::text AS match_local_start, " +
  "match_local_end::text AS match_local_end, match_duration_seconds, price_cents, priority, created_at, updated_at";

// --- read methods (deterministic ordering) -----------------------------------------------------------

async function getProfile(exec: BookingSqlExecutor, hostUserId: string): Promise<BookingProfile | null> {
  const res = await exec.execute({
    sql: `SELECT ${PROFILE_COLUMNS} FROM bookings.profiles WHERE host_user_id = ?1`,
    args: [hostUserId],
  });
  const row = res.rows[0];
  return row ? decodeProfile(row) : null;
}

async function listAvailabilityRules(exec: BookingSqlExecutor, hostUserId: string): Promise<AvailabilityRule[]> {
  const res = await exec.execute({
    sql: `SELECT ${RULE_COLUMNS} FROM bookings.availability_rules WHERE host_user_id = ?1 ORDER BY created_at ASC, rule_id ASC`,
    args: [hostUserId],
  });
  return res.rows.map(decodeAvailabilityRule);
}

async function listAvailabilityExceptions(exec: BookingSqlExecutor, hostUserId: string): Promise<AvailabilityException[]> {
  const res = await exec.execute({
    sql: `SELECT ${EXCEPTION_COLUMNS} FROM bookings.availability_exceptions WHERE host_user_id = ?1 ORDER BY start_utc ASC, exception_id ASC`,
    args: [hostUserId],
  });
  return res.rows.map(decodeAvailabilityException);
}

async function listPriceRules(exec: BookingSqlExecutor, hostUserId: string): Promise<PriceRule[]> {
  const res = await exec.execute({
    sql: `SELECT ${PRICE_RULE_COLUMNS} FROM bookings.price_rules WHERE host_user_id = ?1 ORDER BY priority DESC, price_rule_id ASC`,
    args: [hostUserId],
  });
  return res.rows.map(decodePriceRule);
}

async function getHostConfiguration(exec: BookingSqlExecutor, hostUserId: string): Promise<HostConfiguration | null> {
  const profile = await getProfile(exec, hostUserId);
  if (!profile) return null;
  // Sequential on purpose: the request-scoped pool is max:1, so concurrent queries on one executor
  // would contend on a single connection.
  const availabilityRules = await listAvailabilityRules(exec, hostUserId);
  const availabilityExceptions = await listAvailabilityExceptions(exec, hostUserId);
  const priceRules = await listPriceRules(exec, hostUserId);
  return { profile, availabilityRules, availabilityExceptions, priceRules };
}

// --- factories ---------------------------------------------------------------------------------------

export interface BookingHostConfigReadRepository {
  getProfile(hostUserId: string): Promise<BookingProfile | null>;
  listAvailabilityRules(hostUserId: string): Promise<AvailabilityRule[]>;
  listAvailabilityExceptions(hostUserId: string): Promise<AvailabilityException[]>;
  listPriceRules(hostUserId: string): Promise<PriceRule[]>;
  getHostConfiguration(hostUserId: string): Promise<HostConfiguration | null>;
}

function buildRepository(executor: BookingSqlExecutor): BookingHostConfigReadRepository {
  return {
    getProfile: (hostUserId) => getProfile(executor, hostUserId),
    listAvailabilityRules: (hostUserId) => listAvailabilityRules(executor, hostUserId),
    listAvailabilityExceptions: (hostUserId) => listAvailabilityExceptions(executor, hostUserId),
    listPriceRules: (hostUserId) => listPriceRules(executor, hostUserId),
    getHostConfiguration: (hostUserId) => getHostConfiguration(executor, hostUserId),
  };
}

/**
 * Request-scoped read repository. The caller passes an executor obtained for THIS request (e.g.
 * `getControlPlaneClient(env)` inside withRequestControlPlaneClients); the repository never fetches one.
 */
export function createBookingHostConfigRepository(executor: BookingSqlExecutor): BookingHostConfigReadRepository {
  return buildRepository(executor);
}

/**
 * Transaction-bound read repository: the same reads bound to an open Transaction, for reading host
 * configuration consistently inside a write transaction the CALLER opened and owns.
 */
export function createBookingHostConfigTxRepository(tx: BookingSqlExecutor): BookingHostConfigReadRepository {
  return buildRepository(tx);
}
