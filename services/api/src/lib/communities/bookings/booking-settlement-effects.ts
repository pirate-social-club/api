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
  if (existing?.status === "confirmed") return { action: "existing_confirmed", row: existing }
  if (existing?.status === "submitted") return { action: "existing_submitted", row: existing }
  if (existing?.status === "failed") {
    if (existing.settlement_ref) {
      throw conflictError("Booking settlement effect has a broadcast transaction and requires reconciliation")
    }
    await input.client.execute({
      sql: `
        UPDATE booking_settlement_effects
        SET status = 'submitted',
            amount_cents = ?2,
            recipient_address = ?3,
            failure_reason = NULL,
            submitted_at = ?4,
            failed_at = NULL,
            attempt_count = attempt_count + 1,
            updated_at = ?4
        WHERE booking_settlement_effect_id = ?1
      `,
      args: [existing.booking_settlement_effect_id, input.amountCents, input.recipientAddress, input.now],
    })
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
    if (existingAfterConflict?.status === "confirmed") return { action: "existing_confirmed", row: existingAfterConflict }
    if (existingAfterConflict?.status === "submitted") return { action: "existing_submitted", row: existingAfterConflict }
    if (existingAfterConflict?.status === "failed") {
      return beginBookingSettlementEffectAttempt(input)
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
  await input.client.execute({
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
  return row
}

export async function confirmBookingSettlementEffect(input: {
  client: DbExecutor
  idempotencyKey: string
  settlementRef: string
  now: string
}): Promise<BookingSettlementEffectRow> {
  await input.client.execute({
    sql: `
      UPDATE booking_settlement_effects
      SET status = 'confirmed',
          settlement_ref = ?2,
          failure_reason = NULL,
          confirmed_at = ?3,
          failed_at = NULL,
          updated_at = ?3
      WHERE idempotency_key = ?1
    `,
    args: [input.idempotencyKey, input.settlementRef, input.now],
  })
  const row = await getBookingSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!row) throw new Error("booking_settlement_effect_missing_after_confirm")
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
