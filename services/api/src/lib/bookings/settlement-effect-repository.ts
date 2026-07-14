// Bounded repository for global booking settlement effects in the bookings.* Postgres schema.
//
// The repository owns the idempotency ledger only. Coordinator calls, signing, broadcast,
// confirmation polling, and payout/refund policy stay in higher layers.
import type { InStatement, QueryResult, QueryResultRow } from "../sql-client";
import { intFromRow, intFromRowNullable, isoUtcFromRow, isoUtcFromRowNullable, isoUtcToArg, textFromRow, textFromRowNullable } from "./codecs";
import type { BookingSettlementEffect, BookingSettlementEffectKind, BookingSettlementEffectStatus } from "./types";

export interface SettlementEffectSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

interface BeginSettlementEffectAttemptInput {
  bookingSettlementEffectId?: string;
  bookingId: string;
  effectKind: BookingSettlementEffectKind;
  idempotencyKey: string;
  amountCents: number;
  recipientAddress: string;
  nowUtc: string;
}

type BeginSettlementEffectAttemptResult =
  | { ok: true; action: "created" | "retry" | "existing-submitted" | "existing-confirmed"; effect: BookingSettlementEffect }
  | { ok: false; reason: "replay-conflict" | "effect-conflict" | "broadcast-reconciliation-required" };

interface MirrorSettlementCoordinatorInput {
  idempotencyKey: string;
  coordinatorRef: string;
  coordinatorState: string;
  settlementRef?: string | null;
  broadcastNonce?: number | null;
  nowUtc: string;
}

type MirrorSettlementCoordinatorResult =
  | { ok: true; effect: BookingSettlementEffect }
  | { ok: false; reason: "not-found" | "mirror-conflict" | "unknown-coordinator-state" };

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

function nullableIntToArg(label: string, value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return intToArg(label, value);
}

function effectKindToArg(value: BookingSettlementEffectKind): BookingSettlementEffectKind {
  if (value !== "booking_payout" && value !== "booking_refund") throw new TypeError(`effectKindToArg: bad kind ${String(value)}`);
  return value;
}

function decodeEffectKind(value: unknown): BookingSettlementEffectKind {
  return effectKindToArg(textFromRow(value) as BookingSettlementEffectKind);
}

function decodeEffectStatus(value: unknown): BookingSettlementEffectStatus {
  const status = textFromRow(value);
  if (status !== "submitted" && status !== "confirmed" && status !== "failed") {
    throw new TypeError(`decodeEffectStatus: bad status ${status}`);
  }
  return status;
}

function isUniqueConflict(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = "code" in current ? String((current as { code?: unknown }).code) : "";
    if (code === "23505") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return message.includes("unique") || message.includes("duplicate key");
}

function settlementEffectIdForIdempotencyKey(idempotencyKey: string): string {
  return `bse_${idempotencyKey.replace(/[^a-zA-Z0-9_]/gu, "_").slice(0, 48)}`;
}

function decodeSettlementEffect(row: QueryResultRow): BookingSettlementEffect {
  return {
    bookingSettlementEffectId: textFromRow(row.booking_settlement_effect_id),
    bookingId: textFromRow(row.booking_id),
    effectKind: decodeEffectKind(row.effect_kind),
    idempotencyKey: textFromRow(row.idempotency_key),
    status: decodeEffectStatus(row.status),
    amountCents: intFromRow(row.amount_cents),
    recipientAddress: textFromRow(row.recipient_address),
    settlementRef: textFromRowNullable(row.settlement_ref),
    failureReason: textFromRowNullable(row.failure_reason),
    attemptCount: intFromRow(row.attempt_count),
    signedTx: textFromRowNullable(row.signed_tx),
    broadcastNonce: intFromRowNullable(row.broadcast_nonce),
    coordinatorRef: textFromRowNullable(row.coordinator_ref),
    coordinatorState: textFromRowNullable(row.coordinator_state),
    submittedAt: isoUtcFromRowNullable(row.submitted_at),
    confirmedAt: isoUtcFromRowNullable(row.confirmed_at),
    failedAt: isoUtcFromRowNullable(row.failed_at),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

const COLUMNS =
  "booking_settlement_effect_id, booking_id, effect_kind, idempotency_key, status, amount_cents, " +
  "recipient_address, settlement_ref, failure_reason, attempt_count, signed_tx, broadcast_nonce, " +
  "coordinator_ref, coordinator_state, submitted_at, confirmed_at, failed_at, created_at, updated_at";

const VALID_COORDINATOR_STATES = new Set([
  "reserving",
  "prepared",
  "broadcast",
  "confirmed",
  "failed_preparation",
  "reconciliation_required",
  "replaced",
  "failed_onchain",
]);

function immutableEffectMatches(input: BeginSettlementEffectAttemptInput, effect: BookingSettlementEffect): boolean {
  return (
    effect.bookingId === input.bookingId &&
    effect.effectKind === input.effectKind &&
    effect.amountCents === input.amountCents &&
    effect.recipientAddress === input.recipientAddress
  );
}

async function getSettlementEffectByIdempotencyKey(
  exec: SettlementEffectSqlExecutor,
  idempotencyKey: string,
): Promise<BookingSettlementEffect | null> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS} FROM bookings.settlement_effects WHERE idempotency_key = ?1 LIMIT 1`,
    args: [textToArg("idempotencyKey", idempotencyKey)],
  });
  return res.rows[0] ? decodeSettlementEffect(res.rows[0]) : null;
}

async function listSettlementEffectsByBooking(
  exec: SettlementEffectSqlExecutor,
  bookingId: string,
): Promise<BookingSettlementEffect[]> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS}
          FROM bookings.settlement_effects
          WHERE booking_id = ?1
          ORDER BY created_at ASC, effect_kind ASC, booking_settlement_effect_id ASC`,
    args: [textToArg("bookingId", bookingId)],
  });
  return res.rows.map(decodeSettlementEffect);
}

async function listSubmittedSettlementEffects(
  exec: SettlementEffectSqlExecutor,
  limit: number,
): Promise<BookingSettlementEffect[]> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS}
          FROM bookings.settlement_effects
          WHERE status = 'submitted'
          ORDER BY updated_at ASC, booking_settlement_effect_id ASC
          LIMIT ?1`,
    args: [intToArg("limit", limit)],
  });
  return res.rows.map(decodeSettlementEffect);
}

async function beginSettlementEffectAttempt(
  exec: SettlementEffectSqlExecutor,
  input: BeginSettlementEffectAttemptInput,
): Promise<BeginSettlementEffectAttemptResult> {
  const existing = await getSettlementEffectByIdempotencyKey(exec, input.idempotencyKey);
  if (existing) {
    if (!immutableEffectMatches(input, existing)) return { ok: false, reason: "replay-conflict" };
    if (existing.status === "confirmed") return { ok: true, action: "existing-confirmed", effect: existing };
    if (existing.status === "submitted") return { ok: true, action: "existing-submitted", effect: existing };
    if (existing.settlementRef) return { ok: false, reason: "broadcast-reconciliation-required" };
    const res = await exec.execute({
      sql: `UPDATE bookings.settlement_effects
            SET status = 'submitted',
                failure_reason = NULL,
                submitted_at = ?2::timestamptz,
                failed_at = NULL,
                attempt_count = attempt_count + 1,
                updated_at = ?2::timestamptz
            WHERE booking_settlement_effect_id = ?1
              AND status = 'failed'
              AND settlement_ref IS NULL
            RETURNING ${COLUMNS}`,
      args: [textToArg("bookingSettlementEffectId", existing.bookingSettlementEffectId), isoUtcToArg(input.nowUtc)],
    });
    const claimed = res.rows[0] ? decodeSettlementEffect(res.rows[0]) : await getSettlementEffectByIdempotencyKey(exec, input.idempotencyKey);
    if (!claimed) throw new Error("settlement_effect_missing_after_retry_claim");
    if (!immutableEffectMatches(input, claimed)) return { ok: false, reason: "replay-conflict" };
    if (claimed.status === "confirmed") return { ok: true, action: "existing-confirmed", effect: claimed };
    if (claimed.status === "submitted" && claimed.attemptCount === existing.attemptCount + 1) {
      return { ok: true, action: "retry", effect: claimed };
    }
    return { ok: true, action: "existing-submitted", effect: claimed };
  }

  try {
    const res = await exec.execute({
      sql: `INSERT INTO bookings.settlement_effects (
              booking_settlement_effect_id, booking_id, effect_kind, idempotency_key, status,
              amount_cents, recipient_address, settlement_ref, failure_reason, attempt_count,
              signed_tx, broadcast_nonce, coordinator_ref, coordinator_state,
              submitted_at, confirmed_at, failed_at, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, 'submitted',
              ?5, ?6, NULL, NULL, 1,
              NULL, NULL, NULL, NULL,
              ?7::timestamptz, NULL, NULL, ?7::timestamptz, ?7::timestamptz
            )
            RETURNING ${COLUMNS}`,
      args: [
        textToArg("bookingSettlementEffectId", input.bookingSettlementEffectId ?? settlementEffectIdForIdempotencyKey(input.idempotencyKey)),
        textToArg("bookingId", input.bookingId),
        effectKindToArg(input.effectKind),
        textToArg("idempotencyKey", input.idempotencyKey),
        intToArg("amountCents", input.amountCents),
        textToArg("recipientAddress", input.recipientAddress),
        isoUtcToArg(input.nowUtc),
      ],
    });
    return { ok: true, action: "created", effect: decodeSettlementEffect(res.rows[0]) };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const current = await getSettlementEffectByIdempotencyKey(exec, input.idempotencyKey);
    if (current) {
      if (!immutableEffectMatches(input, current)) return { ok: false, reason: "replay-conflict" };
      if (current.status === "confirmed") return { ok: true, action: "existing-confirmed", effect: current };
      if (current.status === "submitted") return { ok: true, action: "existing-submitted", effect: current };
      return beginSettlementEffectAttempt(exec, input);
    }
    return { ok: false, reason: "effect-conflict" };
  }
}

async function mirrorSettlementCoordinatorEffect(
  exec: SettlementEffectSqlExecutor,
  input: MirrorSettlementCoordinatorInput,
): Promise<MirrorSettlementCoordinatorResult> {
  if (!VALID_COORDINATOR_STATES.has(input.coordinatorState)) return { ok: false, reason: "unknown-coordinator-state" };
  await exec.execute({
    sql: `UPDATE bookings.settlement_effects
          SET coordinator_ref = COALESCE(coordinator_ref, ?2),
              coordinator_state = ?3,
              settlement_ref = COALESCE(?4::text, settlement_ref),
              broadcast_nonce = COALESCE(?5::integer, broadcast_nonce),
              updated_at = ?6::timestamptz
          WHERE idempotency_key = ?1
            AND status != 'confirmed'
            AND (coordinator_ref IS NULL OR coordinator_ref = ?2)
            AND (?4::text IS NULL OR settlement_ref IS NULL OR settlement_ref = ?4::text)
            AND (?5::integer IS NULL OR broadcast_nonce IS NULL OR broadcast_nonce = ?5::integer)
            AND (
              coordinator_state IS NULL
              OR coordinator_state = ?3
              OR (coordinator_state = 'reserving' AND ?3 IN ('prepared', 'failed_preparation'))
              OR (coordinator_state = 'failed_preparation' AND ?3 = 'prepared')
              OR (coordinator_state = 'prepared' AND ?3 IN ('broadcast', 'reconciliation_required'))
              OR (coordinator_state = 'reconciliation_required' AND ?3 IN ('broadcast', 'replaced', 'failed_onchain', 'confirmed'))
              OR (coordinator_state = 'broadcast' AND ?3 IN ('reconciliation_required', 'replaced', 'failed_onchain', 'confirmed'))
            )
          RETURNING ${COLUMNS}`,
    args: [
      textToArg("idempotencyKey", input.idempotencyKey),
      textToArg("coordinatorRef", input.coordinatorRef),
      textToArg("coordinatorState", input.coordinatorState),
      nullableTextToArg("settlementRef", input.settlementRef),
      nullableIntToArg("broadcastNonce", input.broadcastNonce),
      isoUtcToArg(input.nowUtc),
    ],
  });
  const row = await getSettlementEffectByIdempotencyKey(exec, input.idempotencyKey);
  if (!row) return { ok: false, reason: "not-found" };
  if (row.coordinatorRef && row.coordinatorRef !== input.coordinatorRef) return { ok: false, reason: "mirror-conflict" };
  if (input.settlementRef && row.settlementRef && row.settlementRef !== input.settlementRef) return { ok: false, reason: "mirror-conflict" };
  if (input.broadcastNonce != null && row.broadcastNonce != null && row.broadcastNonce !== input.broadcastNonce) {
    return { ok: false, reason: "mirror-conflict" };
  }
  return { ok: true, effect: row };
}

async function confirmSettlementEffect(
  exec: SettlementEffectSqlExecutor,
  idempotencyKey: string,
  settlementRef: string,
  nowUtc: string,
): Promise<BookingSettlementEffect | null> {
  await exec.execute({
    sql: `UPDATE bookings.settlement_effects
          SET status = 'confirmed',
              failure_reason = NULL,
              confirmed_at = ?3::timestamptz,
              failed_at = NULL,
              updated_at = ?3::timestamptz
          WHERE idempotency_key = ?1
            AND settlement_ref = ?2
          RETURNING ${COLUMNS}`,
    args: [textToArg("idempotencyKey", idempotencyKey), textToArg("settlementRef", settlementRef), isoUtcToArg(nowUtc)],
  });
  const row = await getSettlementEffectByIdempotencyKey(exec, idempotencyKey);
  if (!row) return null;
  return row.status === "confirmed" && row.settlementRef === settlementRef ? row : null;
}

async function failSettlementEffect(
  exec: SettlementEffectSqlExecutor,
  idempotencyKey: string,
  failureReason: string,
  nowUtc: string,
): Promise<BookingSettlementEffect | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.settlement_effects
          SET status = 'failed',
              failure_reason = ?2,
              failed_at = ?3::timestamptz,
              updated_at = ?3::timestamptz
          WHERE idempotency_key = ?1
            AND status = 'submitted'
            AND settlement_ref IS NULL
          RETURNING ${COLUMNS}`,
    args: [textToArg("idempotencyKey", idempotencyKey), textToArg("failureReason", failureReason), isoUtcToArg(nowUtc)],
  });
  return res.rows[0] ? decodeSettlementEffect(res.rows[0]) : null;
}

export interface SettlementEffectRepository {
  getSettlementEffectByIdempotencyKey(idempotencyKey: string): Promise<BookingSettlementEffect | null>;
  listSettlementEffectsByBooking(bookingId: string): Promise<BookingSettlementEffect[]>;
  listSubmittedSettlementEffects(limit: number): Promise<BookingSettlementEffect[]>;
}

export interface SettlementEffectWriteRepository extends SettlementEffectRepository {
  beginSettlementEffectAttempt(input: BeginSettlementEffectAttemptInput): Promise<BeginSettlementEffectAttemptResult>;
  mirrorSettlementCoordinatorEffect(input: MirrorSettlementCoordinatorInput): Promise<MirrorSettlementCoordinatorResult>;
  confirmSettlementEffect(idempotencyKey: string, settlementRef: string, nowUtc: string): Promise<BookingSettlementEffect | null>;
  failSettlementEffect(idempotencyKey: string, failureReason: string, nowUtc: string): Promise<BookingSettlementEffect | null>;
}

function buildRepository(executor: SettlementEffectSqlExecutor): SettlementEffectRepository {
  return {
    getSettlementEffectByIdempotencyKey: (idempotencyKey) => getSettlementEffectByIdempotencyKey(executor, idempotencyKey),
    listSettlementEffectsByBooking: (bookingId) => listSettlementEffectsByBooking(executor, bookingId),
    listSubmittedSettlementEffects: (limit) => listSubmittedSettlementEffects(executor, limit),
  };
}

function buildWriteRepository(executor: SettlementEffectSqlExecutor): SettlementEffectWriteRepository {
  return {
    ...buildRepository(executor),
    beginSettlementEffectAttempt: (input) => beginSettlementEffectAttempt(executor, input),
    mirrorSettlementCoordinatorEffect: (input) => mirrorSettlementCoordinatorEffect(executor, input),
    confirmSettlementEffect: (idempotencyKey, settlementRef, nowUtc) => confirmSettlementEffect(executor, idempotencyKey, settlementRef, nowUtc),
    failSettlementEffect: (idempotencyKey, failureReason, nowUtc) => failSettlementEffect(executor, idempotencyKey, failureReason, nowUtc),
  };
}

export function createSettlementEffectRepository(executor: SettlementEffectSqlExecutor): SettlementEffectRepository {
  return buildRepository(executor);
}

export function createSettlementEffectWriteRepository(executor: SettlementEffectSqlExecutor): SettlementEffectWriteRepository {
  return buildWriteRepository(executor);
}

export function createSettlementEffectTxWriteRepository(tx: SettlementEffectSqlExecutor): SettlementEffectWriteRepository {
  return buildWriteRepository(tx);
}
