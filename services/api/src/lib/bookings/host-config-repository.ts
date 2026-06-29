// Bounded repository for the global bookings HOST CONFIGURATION: profiles, availability rules/exceptions,
// and price rules in the bookings.* Postgres schema.
//
// Boundary rules (Phase 1):
//   - Methods accept an EXPLICIT request-scoped SQL executor (a ReadClient or a Transaction). The
//     repository NEVER calls getControlPlaneClient itself and NEVER opens an implicit transaction —
//     the caller owns connection and transaction lifecycle.
//   - Every query is schema-qualified (bookings.*) with an explicit column list (no SELECT *).
//   - Every Postgres row value is decoded through ./codecs; raw row shapes stay private to this module.
//   - "Published / bookable" policy lives OUTSIDE the repository; reads return rows as stored.
import type { InStatement, QueryResult, QueryResultRow } from "../sql-client";
import {
  boolFromRow, intFromRow, intFromRowNullable, isoUtcFromRow, isoUtcFromRowNullable, isoUtcToArg,
  textFromRow, textFromRowNullable, timeFromRow, timeToArg, weekdayArrayFromRow, weekdayArrayToArg,
} from "./codecs";
import type {
  AvailabilityException, AvailabilityRule, BookingProfile, HostConfiguration, PriceRule,
} from "./types";

/** A request-scoped SQL executor — satisfied by both ReadClient and Transaction. */
export interface BookingSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

export interface CreateBookingProfileInput {
  hostUserId: string;
  displayHeadline?: string | null;
  bio?: string | null;
  topics?: string[] | null;
  introVideoRef?: string | null;
  hostTimezone: string;
  basePriceCents: number;
  defaultSlotDurationSeconds: number;
  platformFeeBps?: number;
  payoutWalletAddress?: string | null;
  isPublished?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface UpdateBookingProfileInput {
  displayHeadline?: string | null;
  bio?: string | null;
  topics?: string[] | null;
  introVideoRef?: string | null;
  hostTimezone?: string;
  basePriceCents?: number;
  defaultSlotDurationSeconds?: number;
  platformFeeBps?: number;
  payoutWalletAddress?: string | null;
  updatedAt: string;
}

export type UpsertBookingProfileInput = CreateBookingProfileInput;

export interface CreateAvailabilityRuleInput {
  ruleId: string;
  hostUserId: string;
  byWeekday: number[];
  startLocal: string;
  endLocal: string;
  slotDurationSeconds: number;
  effectiveFromUtc?: string | null;
  effectiveUntilUtc?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface UpdateAvailabilityRuleInput {
  byWeekday?: number[];
  startLocal?: string;
  endLocal?: string;
  slotDurationSeconds?: number;
  effectiveFromUtc?: string | null;
  effectiveUntilUtc?: string | null;
  updatedAt: string;
}

export interface CreateAvailabilityExceptionInput {
  exceptionId: string;
  hostUserId: string;
  kind: "block" | "open";
  startUtc: string;
  endUtc: string;
  createdAt: string;
}

export interface UpdateAvailabilityExceptionInput {
  kind?: "block" | "open";
  startUtc?: string;
  endUtc?: string;
}

export interface CreatePriceRuleInput {
  priceRuleId: string;
  hostUserId: string;
  matchWeekday?: number[] | null;
  matchLocalStart?: string | null;
  matchLocalEnd?: string | null;
  matchDurationSeconds?: number | null;
  priceCents: number;
  priority?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface UpdatePriceRuleInput {
  matchWeekday?: number[] | null;
  matchLocalStart?: string | null;
  matchLocalEnd?: string | null;
  matchDurationSeconds?: number | null;
  priceCents?: number;
  priority?: number;
  updatedAt: string;
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

// --- private write-arg codecs -----------------------------------------------------------------------

function textToArg(label: string, value: string): string {
  if (typeof value !== "string") throw new TypeError(`${label}: expected string`);
  return value;
}

function nullableTextToArg(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return textToArg(label, value);
}

function intToArg(label: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label}: expected a safe integer`);
  return value;
}

function boolToArg(label: string, value: boolean): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label}: expected boolean`);
  return value;
}

function topicsToArg(value: string[] | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !value.every((topic) => typeof topic === "string")) {
    throw new TypeError("topicsToArg: expected a string array");
  }
  return JSON.stringify(value);
}

function nullableIsoUtcToArg(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : isoUtcToArg(value);
}

function nullableTimeToArg(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : timeToArg(value);
}

function nonEmptyWeekdayArrayToArg(label: string, value: number[]): string {
  if (!Array.isArray(value) || value.length === 0) throw new RangeError(`${label}: expected at least one weekday`);
  return weekdayArrayToArg(value);
}

function nullableWeekdayArrayToArg(label: string, value: number[] | null | undefined): string | null {
  return value === null || value === undefined ? null : nonEmptyWeekdayArrayToArg(label, value);
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

function asJsonObject(value: unknown): QueryResultRow {
  const v = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError("expected a JSON object");
  return v as QueryResultRow;
}
function asJsonArray(value: unknown): QueryResultRow[] {
  const v = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(v)) throw new TypeError("expected a JSON array");
  return v as QueryResultRow[];
}

// Single-statement aggregate: a lone SELECT is snapshot-consistent under READ COMMITTED, so the profile
// and its rules/exceptions/prices are all read at one instant without requiring a caller-owned isolation
// level. to_jsonb renders TIME/TIMESTAMPTZ/SMALLINT[] in decoder-compatible forms, so the same row
// decoders apply. Deterministic ordering matches the per-table list methods.
async function getHostConfiguration(exec: BookingSqlExecutor, hostUserId: string): Promise<HostConfiguration | null> {
  const res = await exec.execute({
    // to_jsonb is applied over EXPLICIT projected subqueries (reusing the per-table column lists), so the
    // aggregate honors the "no SELECT *" rule while staying a single snapshot-consistent statement.
    sql:
      `SELECT
         to_jsonb(p) AS profile,
         COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at ASC, r.rule_id ASC)
                   FROM (SELECT ${RULE_COLUMNS} FROM bookings.availability_rules WHERE host_user_id = p.host_user_id) r), '[]'::jsonb) AS rules,
         COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.start_utc ASC, e.exception_id ASC)
                   FROM (SELECT ${EXCEPTION_COLUMNS} FROM bookings.availability_exceptions WHERE host_user_id = p.host_user_id) e), '[]'::jsonb) AS exceptions,
         COALESCE((SELECT jsonb_agg(to_jsonb(pr) ORDER BY pr.priority DESC, pr.price_rule_id ASC)
                   FROM (SELECT ${PRICE_RULE_COLUMNS} FROM bookings.price_rules WHERE host_user_id = p.host_user_id) pr), '[]'::jsonb) AS prices
       FROM (SELECT ${PROFILE_COLUMNS} FROM bookings.profiles WHERE host_user_id = ?1) p`,
    args: [hostUserId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    profile: decodeProfile(asJsonObject(row.profile)),
    availabilityRules: asJsonArray(row.rules).map(decodeAvailabilityRule),
    availabilityExceptions: asJsonArray(row.exceptions).map(decodeAvailabilityException),
    priceRules: asJsonArray(row.prices).map(decodePriceRule),
  };
}

// --- write methods ----------------------------------------------------------------------------------

function profileInsertArgs(input: CreateBookingProfileInput): unknown[] {
  const createdAt = isoUtcToArg(input.createdAt);
  const updatedAt = isoUtcToArg(input.updatedAt ?? input.createdAt);
  return [
    textToArg("hostUserId", input.hostUserId),
    nullableTextToArg("displayHeadline", input.displayHeadline),
    nullableTextToArg("bio", input.bio),
    topicsToArg(input.topics),
    nullableTextToArg("introVideoRef", input.introVideoRef),
    textToArg("hostTimezone", input.hostTimezone),
    intToArg("basePriceCents", input.basePriceCents),
    intToArg("defaultSlotDurationSeconds", input.defaultSlotDurationSeconds),
    intToArg("platformFeeBps", input.platformFeeBps ?? 1000),
    nullableTextToArg("payoutWalletAddress", input.payoutWalletAddress),
    boolToArg("isPublished", input.isPublished ?? false),
    createdAt,
    updatedAt,
  ];
}

async function createProfile(exec: BookingSqlExecutor, input: CreateBookingProfileInput): Promise<BookingProfile> {
  const res = await exec.execute({
    sql: `INSERT INTO bookings.profiles (
            host_user_id, display_headline, bio, topics, intro_video_ref, host_timezone,
            base_price_cents, default_slot_duration_seconds, platform_fee_bps,
            payout_wallet_address, is_published, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4::text::jsonb, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12::timestamptz, ?13::timestamptz)
          RETURNING ${PROFILE_COLUMNS}`,
    args: profileInsertArgs(input),
  });
  return decodeProfile(res.rows[0]);
}

async function upsertProfile(exec: BookingSqlExecutor, input: UpsertBookingProfileInput): Promise<BookingProfile> {
  const res = await exec.execute({
    sql: `INSERT INTO bookings.profiles AS p (
            host_user_id, display_headline, bio, topics, intro_video_ref, host_timezone,
            base_price_cents, default_slot_duration_seconds, platform_fee_bps,
            payout_wallet_address, is_published, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4::text::jsonb, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12::timestamptz, ?13::timestamptz)
          ON CONFLICT (host_user_id) DO UPDATE SET
            display_headline = CASE WHEN ?14 THEN EXCLUDED.display_headline ELSE p.display_headline END,
            bio = CASE WHEN ?15 THEN EXCLUDED.bio ELSE p.bio END,
            topics = CASE WHEN ?16 THEN EXCLUDED.topics ELSE p.topics END,
            intro_video_ref = CASE WHEN ?17 THEN EXCLUDED.intro_video_ref ELSE p.intro_video_ref END,
            host_timezone = EXCLUDED.host_timezone,
            base_price_cents = EXCLUDED.base_price_cents,
            default_slot_duration_seconds = EXCLUDED.default_slot_duration_seconds,
            platform_fee_bps = CASE WHEN ?18 THEN EXCLUDED.platform_fee_bps ELSE p.platform_fee_bps END,
            payout_wallet_address = CASE WHEN ?19 THEN EXCLUDED.payout_wallet_address ELSE p.payout_wallet_address END,
            is_published = CASE WHEN ?20 THEN EXCLUDED.is_published ELSE p.is_published END,
            updated_at = EXCLUDED.updated_at
          RETURNING ${PROFILE_COLUMNS}`,
    args: [
      ...profileInsertArgs(input),
      input.displayHeadline !== undefined,
      input.bio !== undefined,
      input.topics !== undefined,
      input.introVideoRef !== undefined,
      input.platformFeeBps !== undefined,
      input.payoutWalletAddress !== undefined,
      input.isPublished !== undefined,
    ],
  });
  return decodeProfile(res.rows[0]);
}

async function updateProfile(
  exec: BookingSqlExecutor,
  hostUserId: string,
  input: UpdateBookingProfileInput,
): Promise<BookingProfile | null> {
  const sets: string[] = [];
  const args: unknown[] = [textToArg("hostUserId", hostUserId)];
  let idx = 2;
  if (input.displayHeadline !== undefined) {
    sets.push(`display_headline = ?${idx++}`);
    args.push(nullableTextToArg("displayHeadline", input.displayHeadline));
  }
  if (input.bio !== undefined) {
    sets.push(`bio = ?${idx++}`);
    args.push(nullableTextToArg("bio", input.bio));
  }
  if (input.topics !== undefined) {
    sets.push(`topics = ?${idx++}::text::jsonb`);
    args.push(topicsToArg(input.topics));
  }
  if (input.introVideoRef !== undefined) {
    sets.push(`intro_video_ref = ?${idx++}`);
    args.push(nullableTextToArg("introVideoRef", input.introVideoRef));
  }
  if (input.hostTimezone !== undefined) {
    sets.push(`host_timezone = ?${idx++}`);
    args.push(textToArg("hostTimezone", input.hostTimezone));
  }
  if (input.basePriceCents !== undefined) {
    sets.push(`base_price_cents = ?${idx++}`);
    args.push(intToArg("basePriceCents", input.basePriceCents));
  }
  if (input.defaultSlotDurationSeconds !== undefined) {
    sets.push(`default_slot_duration_seconds = ?${idx++}`);
    args.push(intToArg("defaultSlotDurationSeconds", input.defaultSlotDurationSeconds));
  }
  if (input.platformFeeBps !== undefined) {
    sets.push(`platform_fee_bps = ?${idx++}`);
    args.push(intToArg("platformFeeBps", input.platformFeeBps));
  }
  if (input.payoutWalletAddress !== undefined) {
    sets.push(`payout_wallet_address = ?${idx++}`);
    args.push(nullableTextToArg("payoutWalletAddress", input.payoutWalletAddress));
  }
  sets.push(`updated_at = ?${idx++}::timestamptz`);
  args.push(isoUtcToArg(input.updatedAt));
  const res = await exec.execute({
    sql: `UPDATE bookings.profiles SET ${sets.join(", ")}
          WHERE host_user_id = ?1
          RETURNING ${PROFILE_COLUMNS}`,
    args,
  });
  return res.rows[0] ? decodeProfile(res.rows[0]) : null;
}

async function setProfilePublished(
  exec: BookingSqlExecutor,
  hostUserId: string,
  published: boolean,
  updatedAt: string,
): Promise<BookingProfile | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.profiles SET is_published = ?2, updated_at = ?3::timestamptz
          WHERE host_user_id = ?1
          RETURNING ${PROFILE_COLUMNS}`,
    args: [textToArg("hostUserId", hostUserId), boolToArg("published", published), isoUtcToArg(updatedAt)],
  });
  return res.rows[0] ? decodeProfile(res.rows[0]) : null;
}

async function createAvailabilityRule(
  exec: BookingSqlExecutor,
  input: CreateAvailabilityRuleInput,
): Promise<AvailabilityRule> {
  const createdAt = isoUtcToArg(input.createdAt);
  const updatedAt = isoUtcToArg(input.updatedAt ?? input.createdAt);
  const res = await exec.execute({
    sql: `INSERT INTO bookings.availability_rules (
            rule_id, host_user_id, by_weekday, start_local, end_local, slot_duration_seconds,
            effective_from_utc, effective_until_utc, created_at, updated_at
          ) VALUES (?1, ?2, ?3::smallint[], ?4::time, ?5::time, ?6, ?7::timestamptz, ?8::timestamptz, ?9::timestamptz, ?10::timestamptz)
          RETURNING ${RULE_COLUMNS}`,
    args: [
      textToArg("ruleId", input.ruleId),
      textToArg("hostUserId", input.hostUserId),
      nonEmptyWeekdayArrayToArg("byWeekday", input.byWeekday),
      timeToArg(input.startLocal),
      timeToArg(input.endLocal),
      intToArg("slotDurationSeconds", input.slotDurationSeconds),
      nullableIsoUtcToArg(input.effectiveFromUtc),
      nullableIsoUtcToArg(input.effectiveUntilUtc),
      createdAt,
      updatedAt,
    ],
  });
  return decodeAvailabilityRule(res.rows[0]);
}

async function updateAvailabilityRule(
  exec: BookingSqlExecutor,
  hostUserId: string,
  ruleId: string,
  input: UpdateAvailabilityRuleInput,
): Promise<AvailabilityRule | null> {
  const sets: string[] = [];
  const args: unknown[] = [textToArg("ruleId", ruleId), textToArg("hostUserId", hostUserId)];
  let idx = 3;
  if (input.byWeekday !== undefined) {
    sets.push(`by_weekday = ?${idx++}::smallint[]`);
    args.push(nonEmptyWeekdayArrayToArg("byWeekday", input.byWeekday));
  }
  if (input.startLocal !== undefined) {
    sets.push(`start_local = ?${idx++}::time`);
    args.push(timeToArg(input.startLocal));
  }
  if (input.endLocal !== undefined) {
    sets.push(`end_local = ?${idx++}::time`);
    args.push(timeToArg(input.endLocal));
  }
  if (input.slotDurationSeconds !== undefined) {
    sets.push(`slot_duration_seconds = ?${idx++}`);
    args.push(intToArg("slotDurationSeconds", input.slotDurationSeconds));
  }
  if (input.effectiveFromUtc !== undefined) {
    sets.push(`effective_from_utc = ?${idx++}::timestamptz`);
    args.push(nullableIsoUtcToArg(input.effectiveFromUtc));
  }
  if (input.effectiveUntilUtc !== undefined) {
    sets.push(`effective_until_utc = ?${idx++}::timestamptz`);
    args.push(nullableIsoUtcToArg(input.effectiveUntilUtc));
  }
  sets.push(`updated_at = ?${idx++}::timestamptz`);
  args.push(isoUtcToArg(input.updatedAt));
  const res = await exec.execute({
    sql: `UPDATE bookings.availability_rules SET ${sets.join(", ")}
          WHERE rule_id = ?1 AND host_user_id = ?2
          RETURNING ${RULE_COLUMNS}`,
    args,
  });
  return res.rows[0] ? decodeAvailabilityRule(res.rows[0]) : null;
}

async function deleteAvailabilityRule(exec: BookingSqlExecutor, hostUserId: string, ruleId: string): Promise<boolean> {
  const res = await exec.execute({
    sql: `DELETE FROM bookings.availability_rules WHERE rule_id = ?1 AND host_user_id = ?2 RETURNING rule_id`,
    args: [textToArg("ruleId", ruleId), textToArg("hostUserId", hostUserId)],
  });
  return res.rows.length > 0;
}

async function createAvailabilityException(
  exec: BookingSqlExecutor,
  input: CreateAvailabilityExceptionInput,
): Promise<AvailabilityException> {
  const res = await exec.execute({
    sql: `INSERT INTO bookings.availability_exceptions (
            exception_id, host_user_id, kind, start_utc, end_utc, created_at
          ) VALUES (?1, ?2, ?3, ?4::timestamptz, ?5::timestamptz, ?6::timestamptz)
          RETURNING ${EXCEPTION_COLUMNS}`,
    args: [
      textToArg("exceptionId", input.exceptionId),
      textToArg("hostUserId", input.hostUserId),
      textToArg("kind", input.kind),
      isoUtcToArg(input.startUtc),
      isoUtcToArg(input.endUtc),
      isoUtcToArg(input.createdAt),
    ],
  });
  return decodeAvailabilityException(res.rows[0]);
}

async function updateAvailabilityException(
  exec: BookingSqlExecutor,
  hostUserId: string,
  exceptionId: string,
  input: UpdateAvailabilityExceptionInput,
): Promise<AvailabilityException | null> {
  const sets: string[] = [];
  const args: unknown[] = [textToArg("exceptionId", exceptionId), textToArg("hostUserId", hostUserId)];
  let idx = 3;
  if (input.kind !== undefined) {
    sets.push(`kind = ?${idx++}`);
    args.push(textToArg("kind", input.kind));
  }
  if (input.startUtc !== undefined) {
    sets.push(`start_utc = ?${idx++}::timestamptz`);
    args.push(isoUtcToArg(input.startUtc));
  }
  if (input.endUtc !== undefined) {
    sets.push(`end_utc = ?${idx++}::timestamptz`);
    args.push(isoUtcToArg(input.endUtc));
  }
  if (sets.length === 0) {
    const current = await exec.execute({
      sql: `SELECT ${EXCEPTION_COLUMNS} FROM bookings.availability_exceptions WHERE exception_id = ?1 AND host_user_id = ?2`,
      args,
    });
    return current.rows[0] ? decodeAvailabilityException(current.rows[0]) : null;
  }
  const res = await exec.execute({
    sql: `UPDATE bookings.availability_exceptions SET ${sets.join(", ")}
          WHERE exception_id = ?1 AND host_user_id = ?2
          RETURNING ${EXCEPTION_COLUMNS}`,
    args,
  });
  return res.rows[0] ? decodeAvailabilityException(res.rows[0]) : null;
}

async function deleteAvailabilityException(exec: BookingSqlExecutor, hostUserId: string, exceptionId: string): Promise<boolean> {
  const res = await exec.execute({
    sql: `DELETE FROM bookings.availability_exceptions WHERE exception_id = ?1 AND host_user_id = ?2 RETURNING exception_id`,
    args: [textToArg("exceptionId", exceptionId), textToArg("hostUserId", hostUserId)],
  });
  return res.rows.length > 0;
}

async function createPriceRule(exec: BookingSqlExecutor, input: CreatePriceRuleInput): Promise<PriceRule> {
  const createdAt = isoUtcToArg(input.createdAt);
  const updatedAt = isoUtcToArg(input.updatedAt ?? input.createdAt);
  const res = await exec.execute({
    sql: `INSERT INTO bookings.price_rules (
            price_rule_id, host_user_id, match_weekday, match_local_start, match_local_end,
            match_duration_seconds, price_cents, priority, created_at, updated_at
          ) VALUES (?1, ?2, ?3::smallint[], ?4::time, ?5::time, ?6, ?7, ?8, ?9::timestamptz, ?10::timestamptz)
          RETURNING ${PRICE_RULE_COLUMNS}`,
    args: [
      textToArg("priceRuleId", input.priceRuleId),
      textToArg("hostUserId", input.hostUserId),
      nullableWeekdayArrayToArg("matchWeekday", input.matchWeekday),
      nullableTimeToArg(input.matchLocalStart),
      nullableTimeToArg(input.matchLocalEnd),
      input.matchDurationSeconds === null || input.matchDurationSeconds === undefined
        ? null
        : intToArg("matchDurationSeconds", input.matchDurationSeconds),
      intToArg("priceCents", input.priceCents),
      intToArg("priority", input.priority ?? 0),
      createdAt,
      updatedAt,
    ],
  });
  return decodePriceRule(res.rows[0]);
}

async function updatePriceRule(
  exec: BookingSqlExecutor,
  hostUserId: string,
  priceRuleId: string,
  input: UpdatePriceRuleInput,
): Promise<PriceRule | null> {
  const sets: string[] = [];
  const args: unknown[] = [textToArg("priceRuleId", priceRuleId), textToArg("hostUserId", hostUserId)];
  let idx = 3;
  if (input.matchWeekday !== undefined) {
    sets.push(`match_weekday = ?${idx++}::smallint[]`);
    args.push(nullableWeekdayArrayToArg("matchWeekday", input.matchWeekday));
  }
  if (input.matchLocalStart !== undefined) {
    sets.push(`match_local_start = ?${idx++}::time`);
    args.push(nullableTimeToArg(input.matchLocalStart));
  }
  if (input.matchLocalEnd !== undefined) {
    sets.push(`match_local_end = ?${idx++}::time`);
    args.push(nullableTimeToArg(input.matchLocalEnd));
  }
  if (input.matchDurationSeconds !== undefined) {
    sets.push(`match_duration_seconds = ?${idx++}`);
    args.push(input.matchDurationSeconds === null ? null : intToArg("matchDurationSeconds", input.matchDurationSeconds));
  }
  if (input.priceCents !== undefined) {
    sets.push(`price_cents = ?${idx++}`);
    args.push(intToArg("priceCents", input.priceCents));
  }
  if (input.priority !== undefined) {
    sets.push(`priority = ?${idx++}`);
    args.push(intToArg("priority", input.priority));
  }
  sets.push(`updated_at = ?${idx++}::timestamptz`);
  args.push(isoUtcToArg(input.updatedAt));
  const res = await exec.execute({
    sql: `UPDATE bookings.price_rules SET ${sets.join(", ")}
          WHERE price_rule_id = ?1 AND host_user_id = ?2
          RETURNING ${PRICE_RULE_COLUMNS}`,
    args,
  });
  return res.rows[0] ? decodePriceRule(res.rows[0]) : null;
}

async function deletePriceRule(exec: BookingSqlExecutor, hostUserId: string, priceRuleId: string): Promise<boolean> {
  const res = await exec.execute({
    sql: `DELETE FROM bookings.price_rules WHERE price_rule_id = ?1 AND host_user_id = ?2 RETURNING price_rule_id`,
    args: [textToArg("priceRuleId", priceRuleId), textToArg("hostUserId", hostUserId)],
  });
  return res.rows.length > 0;
}

// --- factories ---------------------------------------------------------------------------------------

export interface BookingHostConfigReadRepository {
  getProfile(hostUserId: string): Promise<BookingProfile | null>;
  listAvailabilityRules(hostUserId: string): Promise<AvailabilityRule[]>;
  listAvailabilityExceptions(hostUserId: string): Promise<AvailabilityException[]>;
  listPriceRules(hostUserId: string): Promise<PriceRule[]>;
  getHostConfiguration(hostUserId: string): Promise<HostConfiguration | null>;
}

export interface BookingHostConfigWriteRepository {
  createProfile(input: CreateBookingProfileInput): Promise<BookingProfile>;
  upsertProfile(input: UpsertBookingProfileInput): Promise<BookingProfile>;
  updateProfile(hostUserId: string, input: UpdateBookingProfileInput): Promise<BookingProfile | null>;
  publishProfile(hostUserId: string, updatedAt: string): Promise<BookingProfile | null>;
  unpublishProfile(hostUserId: string, updatedAt: string): Promise<BookingProfile | null>;
  createAvailabilityRule(input: CreateAvailabilityRuleInput): Promise<AvailabilityRule>;
  updateAvailabilityRule(hostUserId: string, ruleId: string, input: UpdateAvailabilityRuleInput): Promise<AvailabilityRule | null>;
  deleteAvailabilityRule(hostUserId: string, ruleId: string): Promise<boolean>;
  createAvailabilityException(input: CreateAvailabilityExceptionInput): Promise<AvailabilityException>;
  updateAvailabilityException(
    hostUserId: string,
    exceptionId: string,
    input: UpdateAvailabilityExceptionInput,
  ): Promise<AvailabilityException | null>;
  deleteAvailabilityException(hostUserId: string, exceptionId: string): Promise<boolean>;
  createPriceRule(input: CreatePriceRuleInput): Promise<PriceRule>;
  updatePriceRule(hostUserId: string, priceRuleId: string, input: UpdatePriceRuleInput): Promise<PriceRule | null>;
  deletePriceRule(hostUserId: string, priceRuleId: string): Promise<boolean>;
}

function buildReadRepository(executor: BookingSqlExecutor): BookingHostConfigReadRepository {
  return {
    getProfile: (hostUserId) => getProfile(executor, hostUserId),
    listAvailabilityRules: (hostUserId) => listAvailabilityRules(executor, hostUserId),
    listAvailabilityExceptions: (hostUserId) => listAvailabilityExceptions(executor, hostUserId),
    listPriceRules: (hostUserId) => listPriceRules(executor, hostUserId),
    getHostConfiguration: (hostUserId) => getHostConfiguration(executor, hostUserId),
  };
}

function buildWriteRepository(executor: BookingSqlExecutor): BookingHostConfigWriteRepository {
  return {
    createProfile: (input) => createProfile(executor, input),
    upsertProfile: (input) => upsertProfile(executor, input),
    updateProfile: (hostUserId, input) => updateProfile(executor, hostUserId, input),
    publishProfile: (hostUserId, updatedAt) => setProfilePublished(executor, hostUserId, true, updatedAt),
    unpublishProfile: (hostUserId, updatedAt) => setProfilePublished(executor, hostUserId, false, updatedAt),
    createAvailabilityRule: (input) => createAvailabilityRule(executor, input),
    updateAvailabilityRule: (hostUserId, ruleId, input) => updateAvailabilityRule(executor, hostUserId, ruleId, input),
    deleteAvailabilityRule: (hostUserId, ruleId) => deleteAvailabilityRule(executor, hostUserId, ruleId),
    createAvailabilityException: (input) => createAvailabilityException(executor, input),
    updateAvailabilityException: (hostUserId, exceptionId, input) => (
      updateAvailabilityException(executor, hostUserId, exceptionId, input)
    ),
    deleteAvailabilityException: (hostUserId, exceptionId) => deleteAvailabilityException(executor, hostUserId, exceptionId),
    createPriceRule: (input) => createPriceRule(executor, input),
    updatePriceRule: (hostUserId, priceRuleId, input) => updatePriceRule(executor, hostUserId, priceRuleId, input),
    deletePriceRule: (hostUserId, priceRuleId) => deletePriceRule(executor, hostUserId, priceRuleId),
  };
}

/**
 * Request-scoped read repository. The caller passes an executor obtained for THIS request (e.g.
 * `getControlPlaneClient(env)` inside withRequestControlPlaneClients); the repository never fetches one.
 */
export function createBookingHostConfigRepository(executor: BookingSqlExecutor): BookingHostConfigReadRepository {
  return buildReadRepository(executor);
}

/**
 * Transaction-bound read repository: the same reads bound to an open Transaction, for reading host
 * configuration consistently inside a write transaction the CALLER opened and owns.
 */
export function createBookingHostConfigTxRepository(tx: BookingSqlExecutor): BookingHostConfigReadRepository {
  return buildReadRepository(tx);
}

/**
 * Request-scoped write repository. The caller owns the executor lifecycle and supplies IDs/timestamps;
 * the repository only persists decoded global bookings.* host configuration rows.
 */
export function createBookingHostConfigWriteRepository(executor: BookingSqlExecutor): BookingHostConfigWriteRepository {
  return buildWriteRepository(executor);
}

/**
 * Transaction-bound write repository: the same write methods bound to a caller-owned transaction.
 */
export function createBookingHostConfigTxWriteRepository(tx: BookingSqlExecutor): BookingHostConfigWriteRepository {
  return buildWriteRepository(tx);
}
