import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { isPostgresControlPlaneUrl } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"

export type RewardTicketPurchaseReservation = {
  purchaseEffectId: string
  poolDrawingId: string
  idempotencyKey: string
  status: "reserved" | "submitted" | "confirmed" | "failed" | "reservation_expired" | "needs_review"
  expectedTicketCount: number
  reservedCents: string
  recipientAddress: string
}

function requiredString(row: unknown, key: string): string {
  const value = stringOrNull(rowValue(row, key))
  if (!value) throw new Error(`reward ticket reservation row is missing ${key}`)
  return value
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`)
}

function positiveDecimal(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${field} must be a canonical positive integer`)
  return BigInt(value)
}

function reservationFromRow(row: unknown): RewardTicketPurchaseReservation {
  const expectedTicketCount = Number(rowValue(row, "expected_ticket_count"))
  positiveInteger(expectedTicketCount, "expected_ticket_count")
  const reservedCents = requiredString(row, "reserved_cents")
  positiveDecimal(reservedCents, "reserved_cents")
  return {
    purchaseEffectId: requiredString(row, "reward_ticket_purchase_effect_id"),
    poolDrawingId: requiredString(row, "reward_ticket_pool_drawing_id"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    status: requiredString(row, "status") as RewardTicketPurchaseReservation["status"],
    expectedTicketCount,
    reservedCents,
    recipientAddress: requiredString(row, "recipient_address"),
  }
}

/**
 * Atomically reserve a drawing's accepted ceiling. This function does no RPC
 * work and must remain safe to retry by idempotency key. The caller performs
 * the fresh quote read before entering this transaction, then submits the
 * chain transaction only after this reservation commits.
 */
export async function reserveRewardTicketPurchase(input: {
  client: Client
  controlPlaneDatabaseUrl?: string
  poolDrawingId: string
  idempotencyKey: string
  expectedTicketCount: number
  reservedCents: string
  recipientAddress: string
  priceQuoteId: string
  now: string
}): Promise<RewardTicketPurchaseReservation> {
  positiveInteger(input.expectedTicketCount, "expected_ticket_count")
  positiveDecimal(input.reservedCents, "reserved_cents")
  if (!input.idempotencyKey.trim()) throw new Error("idempotency_key is required")
  if (!input.recipientAddress.match(/^0x[0-9a-fA-F]{40}$/u)) throw new Error("recipient_address is invalid")

  const rowLocks = isPostgresControlPlaneUrl(String(input.controlPlaneDatabaseUrl ?? ""))
  return withTransaction(input.client, "write", async (tx) => {
    const existing = await executeFirst(tx, {
      sql: `
        SELECT reward_ticket_purchase_effect_id, reward_ticket_pool_drawing_id,
          idempotency_key, status, expected_ticket_count, reserved_cents, recipient_address
        FROM reward_ticket_purchase_effects
        WHERE idempotency_key = ?1
        LIMIT 1
      `,
      args: [input.idempotencyKey],
    })
    if (existing) return reservationFromRow(existing)

    const drawing = await executeFirst(tx, {
      sql: `
        SELECT d.reward_ticket_pool_drawing_id, d.reward_ticket_pool_id, d.status,
          d.commitment_batch_id, d.committed_at, b.status AS commitment_status,
          p.status AS pool_status, p.funded_cents, p.reserved_cents,
          p.fulfilled_cents, p.refunded_cents
        FROM reward_ticket_pool_drawings d
        JOIN reward_ticket_pools p ON p.reward_ticket_pool_id = d.reward_ticket_pool_id
        LEFT JOIN reward_ticket_beneficiary_commitment_batches b
          ON b.reward_ticket_beneficiary_commitment_batch_id = d.commitment_batch_id
        WHERE d.reward_ticket_pool_drawing_id = ?1
        LIMIT 1${rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [input.poolDrawingId],
    })
    if (!drawing) throw new Error("reward ticket pool drawing not found")
    if (requiredString(drawing, "status") !== "commit_pending") {
      throw new Error("reward ticket pool drawing is not ready for purchase")
    }
    if (requiredString(drawing, "commitment_status") !== "published") {
      throw new Error("reward ticket beneficiary commitment is not published")
    }
    if (!requiredString(drawing, "committed_at")) {
      throw new Error("reward ticket beneficiary commitment timestamp is missing")
    }
    if (!["active", "scheduled"].includes(requiredString(drawing, "pool_status"))) {
      throw new Error("reward ticket pool is not payable")
    }

    const funded = positiveDecimal(requiredString(drawing, "funded_cents"), "funded_cents")
    const reserved = BigInt(requiredString(drawing, "reserved_cents"))
    const fulfilled = BigInt(requiredString(drawing, "fulfilled_cents"))
    const refunded = BigInt(requiredString(drawing, "refunded_cents"))
    const ceiling = BigInt(input.reservedCents)
    if (reserved + fulfilled + refunded + ceiling > funded) {
      throw new Error("reward ticket pool cannot cover the purchase ceiling")
    }

    const purchaseEffectId = makeId("rtpe")
    await tx.execute({
      sql: `
        INSERT INTO reward_ticket_purchase_effects (
          reward_ticket_purchase_effect_id, reward_ticket_pool_drawing_id,
          idempotency_key, status, expected_ticket_count, reserved_cents,
          recipient_address, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'reserved', ?4, ?5, ?6, ?7, ?7)
      `,
      args: [
        purchaseEffectId, input.poolDrawingId, input.idempotencyKey,
        input.expectedTicketCount, input.reservedCents, input.recipientAddress, input.now,
      ],
    })
    await tx.execute({
      sql: `
        UPDATE reward_ticket_pool_drawings
        SET status = 'purchase_pending',
            price_quote_id = ?2,
            reserved_cents = reserved_cents + ?3,
            updated_at = ?4
        WHERE reward_ticket_pool_drawing_id = ?1
          AND status = 'commit_pending'
      `,
      args: [input.poolDrawingId, input.priceQuoteId, input.reservedCents, input.now],
    })
    await tx.execute({
      sql: `
        UPDATE reward_ticket_pools
        SET reserved_cents = reserved_cents + ?2, updated_at = ?3
        WHERE reward_ticket_pool_id = ?1
      `,
      args: [requiredString(drawing, "reward_ticket_pool_id"), input.reservedCents, input.now],
    })

    return {
      purchaseEffectId,
      poolDrawingId: input.poolDrawingId,
      idempotencyKey: input.idempotencyKey,
      status: "reserved",
      expectedTicketCount: input.expectedTicketCount,
      reservedCents: input.reservedCents,
      recipientAddress: input.recipientAddress,
    }
  })
}

export type RewardTicketPurchaseReservationExecutor = Pick<Transaction, "execute">
