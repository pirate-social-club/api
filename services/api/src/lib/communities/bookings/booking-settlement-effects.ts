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
             status, amount_cents, recipient_address, settlement_ref, failure_reason, attempt_count,
             submitted_at, confirmed_at, failed_at, created_at, updated_at
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

export async function recordBookingSettlementEffectBroadcast(input: {
  client: DbExecutor
  idempotencyKey: string
  settlementRef: string
  now: string
}): Promise<BookingSettlementEffectRow> {
  const result = await input.client.execute({
    sql: `
      UPDATE booking_settlement_effects
      SET settlement_ref = ?2,
          updated_at = ?3
      WHERE idempotency_key = ?1
        AND status = 'submitted'
        AND settlement_ref IS NULL
    `,
    args: [input.idempotencyKey, input.settlementRef, input.now],
  })
  const row = await getBookingSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!row) throw new Error("booking_settlement_effect_missing_after_broadcast")
  // The write must land exactly once. If it didn't, the only safe state is that the SAME ref is
  // already recorded (idempotent re-record); a different/absent ref means a conflicting broadcast.
  if ((result.rowsAffected ?? 0) !== 1 && row.settlement_ref !== input.settlementRef) {
    throw conflictError("Booking settlement broadcast could not be recorded (conflicting transaction reference)")
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
