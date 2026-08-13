import { makeId } from "../../helpers"
import type { Client, QueryResultRow, Transaction } from "../../sql-client"

export type HandleLabelReservationPurpose = "payment" | "claim" | "admin_reserve"

export async function expireStaleHandleLabelReservations(input: {
  executor: Client | Transaction
  now: string
  communityId?: string | null
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE community_handle_label_reservations
      SET status = 'released',
          released_at = ?1,
          updated_at = ?1
      WHERE status = 'active'
        AND expires_at <= ?1
        AND (?2 IS NULL OR community_id = ?2)
    `,
    args: [input.now, input.communityId ?? null],
  })
}

export async function getActiveHandleLabelReservation(input: {
  executor: Client | Transaction
  namespaceId: string
  labelNormalized: string
  now: string
}): Promise<QueryResultRow | null> {
  const result = await input.executor.execute({
    sql: `
      SELECT *
      FROM community_handle_label_reservations
      WHERE namespace_id = ?1
        AND label_normalized = ?2
        AND status = 'active'
        AND expires_at > ?3
      LIMIT 1
    `,
    args: [input.namespaceId, input.labelNormalized, input.now],
  })
  return result.rows[0] ?? null
}

export async function getActiveHandleLabelReservationForQuote(input: {
  executor: Client | Transaction
  quoteId: string
}): Promise<QueryResultRow | null> {
  const result = await input.executor.execute({
    sql: `
      SELECT *
      FROM community_handle_label_reservations
      WHERE handle_claim_quote_id = ?1
        AND purpose = 'payment'
        AND status = 'active'
      LIMIT 1
    `,
    args: [input.quoteId],
  })
  return result.rows[0] ?? null
}

export async function getActiveHandleLabelReservationForIntent(input: {
  executor: Client | Transaction
  intentId: string
}): Promise<QueryResultRow | null> {
  const result = await input.executor.execute({
    sql: `
      SELECT *
      FROM community_handle_label_reservations
      WHERE handle_claim_intent_id = ?1
        AND purpose = 'payment'
        AND status = 'active'
      LIMIT 1
    `,
    args: [input.intentId],
  })
  return result.rows[0] ?? null
}

export async function getActivePaymentHandleLabelReservationForUser(input: {
  executor: Client | Transaction
  userId: string
  now: string
}): Promise<QueryResultRow | null> {
  const result = await input.executor.execute({
    sql: `
      SELECT *
      FROM community_handle_label_reservations
      WHERE user_id = ?1
        AND purpose = 'payment'
        AND status = 'active'
        AND expires_at > ?2
      LIMIT 1
    `,
    args: [input.userId, input.now],
  })
  return result.rows[0] ?? null
}

export async function acquireHandleLabelReservation(input: {
  executor: Client | Transaction
  communityId: string
  namespaceId: string
  labelNormalized: string
  userId: string
  quoteId?: string | null
  purpose: HandleLabelReservationPurpose
  reservedAt: string
  expiresAt: string
  reservationId?: string
}): Promise<string> {
  const reservationId = input.reservationId ?? makeId("hlr")
  await input.executor.execute({
    sql: `
      INSERT INTO community_handle_label_reservations (
        handle_label_reservation_id, community_id, namespace_id, label_normalized, user_id,
        handle_claim_quote_id, purpose, status, reserved_at, expires_at,
        consumed_at, released_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, 'active', ?8, ?9,
        NULL, NULL, ?8, ?8
      )
    `,
    args: [
      reservationId,
      input.communityId,
      input.namespaceId,
      input.labelNormalized,
      input.userId,
      input.quoteId ?? null,
      input.purpose,
      input.reservedAt,
      input.expiresAt,
    ],
  })
  return reservationId
}

export async function consumeHandleLabelReservation(input: {
  executor: Client | Transaction
  reservationId?: string | null
  quoteId?: string | null
  now: string
}): Promise<void> {
  if (!input.reservationId && !input.quoteId) {
    throw new Error("reservationId or quoteId is required")
  }
  await input.executor.execute({
    sql: `
      UPDATE community_handle_label_reservations
      SET status = 'consumed',
          consumed_at = ?3,
          updated_at = ?3
      WHERE status = 'active'
        AND (?1 IS NULL OR handle_label_reservation_id = ?1)
        AND (?2 IS NULL OR handle_claim_quote_id = ?2)
    `,
    args: [input.reservationId ?? null, input.quoteId ?? null, input.now],
  })
}

export async function consumeHandleLabelReservationForIntent(input: {
  executor: Client | Transaction
  intentId: string
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE community_handle_label_reservations
      SET status = 'consumed', consumed_at = ?2, updated_at = ?2
      WHERE handle_claim_intent_id = ?1
        AND purpose = 'payment'
        AND status = 'active'
    `,
    args: [input.intentId, input.now],
  })
}

export async function extendFundedHandleLabelReservation(input: {
  executor: Client | Transaction
  intentId: string
  expiresAt: string
  now: string
}): Promise<boolean> {
  const result = await input.executor.execute({
    sql: `
      UPDATE community_handle_label_reservations
      SET expires_at = CASE WHEN expires_at < ?2 THEN ?2 ELSE expires_at END,
          updated_at = ?3
      WHERE handle_claim_intent_id = ?1
        AND purpose = 'payment'
        AND status = 'active'
      RETURNING handle_label_reservation_id
    `,
    args: [input.intentId, input.expiresAt, input.now],
  })
  return result.rows[0] != null
}

export async function bindHandleQuoteToClaimIntent(input: {
  client: Client
  communityId: string
  expiresAt: string
  intentId: string
  labelNormalized: string
  namespaceId: string
  now: string
  quoteId: string
  reserveForPayment: boolean
  userId: string
}): Promise<void> {
  const tx = await input.client.transaction("write")
  try {
    await tx.execute({
      sql: `
        UPDATE community_handle_claim_quotes
        SET handle_claim_intent_id = ?2, updated_at = ?3
        WHERE handle_claim_quote_id = ?1
          AND (handle_claim_intent_id IS NULL OR handle_claim_intent_id = ?2)
      `,
      args: [input.quoteId, input.intentId, input.now],
    })
    if (input.reserveForPayment) {
      await tx.execute({
        sql: `
          UPDATE community_handle_label_reservations
          SET handle_claim_intent_id = ?2, status = 'active', released_at = NULL,
              expires_at = ?3, updated_at = ?4
          WHERE handle_claim_quote_id = ?1
            AND community_id = ?5 AND namespace_id = ?6
            AND label_normalized = ?7 AND user_id = ?8
            AND status != 'consumed'
        `,
        args: [
          input.quoteId, input.intentId, input.expiresAt, input.now,
          input.communityId, input.namespaceId, input.labelNormalized, input.userId,
        ],
      })
      await tx.execute({
        sql: `
          INSERT OR IGNORE INTO community_handle_label_reservations (
            handle_label_reservation_id, community_id, namespace_id,
            label_normalized, user_id, handle_claim_quote_id,
            handle_claim_intent_id, purpose, status, reserved_at, expires_at,
            consumed_at, released_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, 'payment', 'active', ?8, ?9,
            NULL, NULL, ?8, ?8
          )
        `,
        args: [
          makeId("hlr"), input.communityId, input.namespaceId,
          input.labelNormalized, input.userId, input.quoteId,
          input.intentId, input.now, input.expiresAt,
        ],
      })
    }
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}
