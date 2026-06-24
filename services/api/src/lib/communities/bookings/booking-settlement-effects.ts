import { executeFirst, type DbExecutor } from "../../db-helpers"
import { conflictError } from "../../errors"
import { makeId } from "../../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"

export type BookingSettlementEffectKind = "booking_payout" | "booking_refund"
export type BookingSettlementEffectStatus = "submitted" | "confirmed" | "failed"

export interface BookingSettlementEffectRow {
  booking_settlement_effect_id: string
  community_id: string
  booking_id: string
  effect_kind: BookingSettlementEffectKind
  idempotency_key: string
  status: BookingSettlementEffectStatus
  amount_cents: number
  recipient_address: string
  settlement_ref: string | null
  signed_tx: string | null
  broadcast_nonce: number | null
  coordinator_ref: string | null
  coordinator_state: string | null
  failure_reason: string | null
  attempt_count: number
  submitted_at: string | null
  confirmed_at: string | null
  failed_at: string | null
  created_at: string
  updated_at: string
}

function toBookingSettlementEffectRow(row: unknown): BookingSettlementEffectRow {
  return {
    booking_settlement_effect_id: requiredString(row, "booking_settlement_effect_id"),
    community_id: requiredString(row, "community_id"),
    booking_id: requiredString(row, "booking_id"),
    effect_kind: requiredString(row, "effect_kind") as BookingSettlementEffectKind,
    idempotency_key: requiredString(row, "idempotency_key"),
    status: requiredString(row, "status") as BookingSettlementEffectStatus,
    amount_cents: requiredNumber(row, "amount_cents"),
    recipient_address: requiredString(row, "recipient_address"),
    settlement_ref: stringOrNull(rowValue(row, "settlement_ref")),
    signed_tx: stringOrNull(rowValue(row, "signed_tx")),
    coordinator_ref: stringOrNull(rowValue(row, "coordinator_ref")),
    coordinator_state: stringOrNull(rowValue(row, "coordinator_state")),
    broadcast_nonce: rowValue(row, "broadcast_nonce") != null ? requiredNumber(row, "broadcast_nonce") : null,
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
    attempt_count: requiredNumber(row, "attempt_count"),
    submitted_at: stringOrNull(rowValue(row, "submitted_at")),
    confirmed_at: stringOrNull(rowValue(row, "confirmed_at")),
    failed_at: stringOrNull(rowValue(row, "failed_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

// An idempotency key is bound to exactly one effect. Reject reuse with different immutable data so
// a confirmed key can never return an unrelated transaction as "success".
function assertImmutableEffectMatch(existing: BookingSettlementEffectRow, input: {
  communityId: string
  bookingId: string
  effectKind: BookingSettlementEffectKind
  amountCents: number
  recipientAddress: string
}): void {
  if (
    existing.community_id !== input.communityId ||
    existing.booking_id !== input.bookingId ||
    existing.effect_kind !== input.effectKind ||
    existing.amount_cents !== input.amountCents ||
    existing.recipient_address !== input.recipientAddress
  ) {
    throw conflictError("Booking settlement idempotency key reused with different effect data")
  }
}

export async function getBookingSettlementEffectByIdempotencyKey(input: {
  client: DbExecutor
  idempotencyKey: string
}): Promise<BookingSettlementEffectRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT booking_settlement_effect_id, community_id, booking_id, effect_kind, idempotency_key,
             status, amount_cents, recipient_address, settlement_ref, signed_tx, broadcast_nonce,
             coordinator_ref, coordinator_state,
             failure_reason, attempt_count, submitted_at, confirmed_at, failed_at, created_at, updated_at
      FROM booking_settlement_effects
      WHERE idempotency_key = ?1
      LIMIT 1
    `,
    args: [input.idempotencyKey],
  })
  return row ? toBookingSettlementEffectRow(row) : null
}

export type BeginBookingSettlementEffectResult =
  | { action: "created" | "retry"; row: BookingSettlementEffectRow }
  | { action: "existing_confirmed" | "existing_submitted"; row: BookingSettlementEffectRow }

export async function beginBookingSettlementEffectAttempt(input: {
  client: DbExecutor
  communityId: string
  bookingId: string
  effectKind: BookingSettlementEffectKind
  idempotencyKey: string
  amountCents: number
  recipientAddress: string
  now: string
}): Promise<BeginBookingSettlementEffectResult> {
  const existing = await getBookingSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (existing) {
    assertImmutableEffectMatch(existing, input)
    if (existing.status === "confirmed") return { action: "existing_confirmed", row: existing }
    if (existing.status === "submitted") return { action: "existing_submitted", row: existing }
    // failed → retry, but ONLY if this worker wins the atomic compare-and-swap claim. Without the
    // status/ref guard two workers could both read 'failed' and both broadcast (double-pay).
    if (existing.settlement_ref) {
      throw conflictError("Booking settlement effect has a broadcast transaction and requires reconciliation")
    }
    const claim = await input.client.execute({
      sql: `
        UPDATE booking_settlement_effects
        SET status = 'submitted',
            failure_reason = NULL,
            submitted_at = ?2,
            failed_at = NULL,
            attempt_count = attempt_count + 1,
            updated_at = ?2
        WHERE booking_settlement_effect_id = ?1
          AND status = 'failed'
          AND settlement_ref IS NULL
      `,
      args: [existing.booking_settlement_effect_id, input.now],
    })
    if ((claim.rowsAffected ?? 0) !== 1) {
      // Lost the race: another worker already claimed the retry. Return the current state so this
      // caller backs off instead of broadcasting a second transfer.
      const current = await getBookingSettlementEffectByIdempotencyKey({ client: input.client, idempotencyKey: input.idempotencyKey })
      if (!current) throw new Error("booking_settlement_effect_missing_after_failed_claim_race")
      assertImmutableEffectMatch(current, input)
      if (current.status === "confirmed") return { action: "existing_confirmed", row: current }
      return { action: "existing_submitted", row: current }
    }
    const updated = await getBookingSettlementEffectByIdempotencyKey({
      client: input.client,
      idempotencyKey: input.idempotencyKey,
    })
    if (!updated) throw new Error("booking_settlement_effect_missing_after_retry_update")
    return { action: "retry", row: updated }
  }

  const effectId = makeId("bse")
  try {
    await input.client.execute({
      sql: `
        INSERT INTO booking_settlement_effects (
          booking_settlement_effect_id, community_id, booking_id, effect_kind, idempotency_key,
          status, amount_cents, recipient_address, settlement_ref, failure_reason, attempt_count,
          submitted_at, confirmed_at, failed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          'submitted', ?6, ?7, NULL, NULL, 1,
          ?8, NULL, NULL, ?8, ?8
        )
      `,
      args: [
        effectId,
        input.communityId,
        input.bookingId,
        input.effectKind,
        input.idempotencyKey,
        input.amountCents,
        input.recipientAddress,
        input.now,
      ],
    })
  } catch (error) {
    const existingAfterConflict = await getBookingSettlementEffectByIdempotencyKey({
      client: input.client,
      idempotencyKey: input.idempotencyKey,
    })
    if (existingAfterConflict) {
      assertImmutableEffectMatch(existingAfterConflict, input)
      if (existingAfterConflict.status === "confirmed") return { action: "existing_confirmed", row: existingAfterConflict }
      if (existingAfterConflict.status === "submitted") return { action: "existing_submitted", row: existingAfterConflict }
      if (existingAfterConflict.status === "failed") return beginBookingSettlementEffectAttempt(input)
    }
    throw error
  }
  const created = await getBookingSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!created) throw new Error("booking_settlement_effect_missing_after_insert")
  return { action: "created", row: created }
}

const VALID_COORDINATOR_STATES = new Set([
  "reserving", "prepared", "broadcast", "confirmed", "failed_preparation", "reconciliation_required", "replaced", "failed_onchain",
])

// Mirror the wallet-scoped coordinator (DO) outcome onto the booking-scoped ledger row. The DO
// owns the authoritative signed tx; here we only record the coordinator pointer + tx hash + nonce +
// coordinator state. Status is NOT changed (confirm does that) and signed_tx stays NULL (DO-owned),
// so terminal coordinator failures never become eligible for the failed -> retry path.
export async function mirrorBookingSettlementCoordinatorEffect(input: {
  client: DbExecutor
  idempotencyKey: string
  coordinatorRef: string
  coordinatorState: string
  settlementRef: string | null
  nonce: number | null
  now: string
}): Promise<BookingSettlementEffectRow> {
  // Validate the incoming coordinator state — an unknown value must never reach storage (the
  // transition predicate's `coordinator_state IS NULL` branch would otherwise admit anything).
  if (!VALID_COORDINATOR_STATES.has(input.coordinatorState)) {
    throw conflictError(`Unknown coordinator state: ${input.coordinatorState}`)
  }
  // Concurrency-safe mirror. The WHERE enforces the invariants atomically:
  //  - never touch a confirmed ledger row;
  //  - coordinator_ref is immutable once set;
  //  - never null-out / replace a recorded hash or nonce (COALESCE + equality guard);
  //  - apply ONLY explicit allowed coordinator-state transitions (not a numeric rank, so the valid
  //    reconciliation_required -> broadcast recovery is permitted while regressions are rejected);
  //  - terminal states (replaced / failed_onchain / confirmed) have no outgoing transitions.
  await input.client.execute({
    sql: `
      UPDATE booking_settlement_effects
      SET coordinator_ref = COALESCE(coordinator_ref, ?2),
          coordinator_state = ?3,
          settlement_ref = COALESCE(?4, settlement_ref),
          broadcast_nonce = COALESCE(?5, broadcast_nonce),
          updated_at = ?6
      WHERE idempotency_key = ?1
        AND status != 'confirmed'
        AND (coordinator_ref IS NULL OR coordinator_ref = ?2)
        AND (?4 IS NULL OR settlement_ref IS NULL OR settlement_ref = ?4)
        AND (?5 IS NULL OR broadcast_nonce IS NULL OR broadcast_nonce = ?5)
        AND (
          coordinator_state IS NULL
          OR coordinator_state = ?3
          OR (coordinator_state = 'reserving' AND ?3 IN ('prepared', 'failed_preparation'))
          OR (coordinator_state = 'failed_preparation' AND ?3 = 'prepared')
          OR (coordinator_state = 'prepared' AND ?3 IN ('broadcast', 'reconciliation_required'))
          OR (coordinator_state = 'reconciliation_required' AND ?3 IN ('broadcast', 'replaced', 'failed_onchain', 'confirmed'))
          OR (coordinator_state = 'broadcast' AND ?3 IN ('reconciliation_required', 'replaced', 'failed_onchain', 'confirmed'))
        )
    `,
    args: [input.idempotencyKey, input.coordinatorRef, input.coordinatorState, input.settlementRef, input.nonce, input.now],
  })
  const row = await getBookingSettlementEffectByIdempotencyKey({ client: input.client, idempotencyKey: input.idempotencyKey })
  if (!row) throw new Error("booking_settlement_effect_missing_after_coordinator_mirror")
  // Hard conflicts are rejected even on a confirmed row: a DIFFERENT non-null coordinator ref, hash,
  // or nonce means a stale/incorrect caller reused this ledger key for a different transaction.
  if (row.coordinator_ref && row.coordinator_ref !== input.coordinatorRef) {
    throw conflictError("Booking settlement mirror coordinator reference conflict")
  }
  if (input.settlementRef && row.settlement_ref && row.settlement_ref !== input.settlementRef) {
    throw conflictError("Booking settlement mirror transaction hash conflict")
  }
  if (input.nonce != null && row.broadcast_nonce != null && row.broadcast_nonce !== input.nonce) {
    throw conflictError("Booking settlement mirror nonce conflict")
  }
  return row
}

export async function confirmBookingSettlementEffect(input: {
  client: DbExecutor
  idempotencyKey: string
  settlementRef: string
  now: string
}): Promise<BookingSettlementEffectRow> {
  // Confirm only the EXACT recorded transaction — never overwrite an existing ref with a different
  // one. The ref must already be recorded (recordBroadcast) before confirmation.
  const result = await input.client.execute({
    sql: `
      UPDATE booking_settlement_effects
      SET status = 'confirmed',
          failure_reason = NULL,
          confirmed_at = ?3,
          failed_at = NULL,
          updated_at = ?3
      WHERE idempotency_key = ?1
        AND settlement_ref = ?2
    `,
    args: [input.idempotencyKey, input.settlementRef, input.now],
  })
  const row = await getBookingSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!row) throw new Error("booking_settlement_effect_missing_after_confirm")
  // Idempotent only if already confirmed with this exact ref; otherwise the ref does not match.
  if ((result.rowsAffected ?? 0) !== 1 && !(row.status === "confirmed" && row.settlement_ref === input.settlementRef)) {
    throw conflictError("Booking settlement confirmation transaction reference mismatch")
  }
  return row
}

export async function failBookingSettlementEffect(input: {
  client: DbExecutor
  idempotencyKey: string
  failureReason: string
  now: string
}): Promise<BookingSettlementEffectRow> {
  await input.client.execute({
    sql: `
      UPDATE booking_settlement_effects
      SET status = 'failed',
          failure_reason = ?2,
          failed_at = ?3,
          updated_at = ?3
      WHERE idempotency_key = ?1
        AND settlement_ref IS NULL
    `,
    args: [input.idempotencyKey, input.failureReason, input.now],
  })
  const row = await getBookingSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!row) throw new Error("booking_settlement_effect_missing_after_fail")
  return row
}
