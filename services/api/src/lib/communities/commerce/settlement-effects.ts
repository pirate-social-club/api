import { executeFirst, type DbExecutor } from "../../db-helpers"
import { conflictError } from "../../errors"
import { makeId } from "../../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import type { Client } from "../../sql-client"
import { withTransaction } from "../../transactions"

export type PurchaseSettlementEffectKind =
  | "buyer_funding_receipt"
  | "charity_payout"
  | "story_royalty_payment"
  | "story_parent_royalty_vault_transfer"
  | "story_entitlement_mint"

type PurchaseSettlementEffectStatus = "submitted" | "confirmed" | "failed"
export type PurchaseSettlementFailureDisposition = "failed_prebroadcast" | "reconciliation_required"

export type PurchaseSettlementEffectRow = {
  purchase_settlement_effect_id: string
  community_id: string
  quote_id: string
  purchase_id: string
  effect_kind: PurchaseSettlementEffectKind
  effect_key: string
  idempotency_key: string
  status: PurchaseSettlementEffectStatus
  failure_disposition: PurchaseSettlementFailureDisposition | null
  broadcast_tx_ref: string | null
  settlement_ref: string | null
  provider_receipt_ref: string | null
  tax_receipt_ref: string | null
  metadata_json: string | null
  failure_reason: string | null
  attempt_count: number
  submitted_at: string | null
  confirmed_at: string | null
  failed_at: string | null
  created_at: string
  updated_at: string
}

function toSettlementEffectRow(row: unknown): PurchaseSettlementEffectRow {
  return {
    purchase_settlement_effect_id: requiredString(row, "purchase_settlement_effect_id"),
    community_id: requiredString(row, "community_id"),
    quote_id: requiredString(row, "quote_id"),
    purchase_id: requiredString(row, "purchase_id"),
    effect_kind: requiredString(row, "effect_kind") as PurchaseSettlementEffectKind,
    effect_key: requiredString(row, "effect_key"),
    idempotency_key: requiredString(row, "idempotency_key"),
    status: requiredString(row, "status") as PurchaseSettlementEffectStatus,
    failure_disposition: stringOrNull(rowValue(row, "failure_disposition")) as PurchaseSettlementFailureDisposition | null,
    broadcast_tx_ref: stringOrNull(rowValue(row, "broadcast_tx_ref")),
    settlement_ref: stringOrNull(rowValue(row, "settlement_ref")),
    provider_receipt_ref: stringOrNull(rowValue(row, "provider_receipt_ref")),
    tax_receipt_ref: stringOrNull(rowValue(row, "tax_receipt_ref")),
    metadata_json: stringOrNull(rowValue(row, "metadata_json")),
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
    attempt_count: requiredNumber(row, "attempt_count"),
    submitted_at: stringOrNull(rowValue(row, "submitted_at")),
    confirmed_at: stringOrNull(rowValue(row, "confirmed_at")),
    failed_at: stringOrNull(rowValue(row, "failed_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

async function getPurchaseSettlementEffectByIdempotencyKey(input: {
  client: DbExecutor
  idempotencyKey: string
}): Promise<PurchaseSettlementEffectRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
             effect_key, idempotency_key, status, failure_disposition, broadcast_tx_ref, settlement_ref, provider_receipt_ref,
             tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at, confirmed_at,
             failed_at, created_at, updated_at
      FROM purchase_settlement_effects
      WHERE idempotency_key = ?1
      LIMIT 1
    `,
    args: [input.idempotencyKey],
  })
  return row ? toSettlementEffectRow(row) : null
}

// Global single-use lookup for a buyer funding tx within a community, regardless of
// quote. Used to reject replay of the same on-chain payment across different quotes
// (the DB partial-unique index is the race-safe backstop; this gives a clean error).
export async function findConfirmedBuyerFundingEffectByTx(input: {
  client: DbExecutor
  communityId: string
  txRef: string
}): Promise<PurchaseSettlementEffectRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
             effect_key, idempotency_key, status, failure_disposition, broadcast_tx_ref, settlement_ref, provider_receipt_ref,
             tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at, confirmed_at,
             failed_at, created_at, updated_at
      FROM purchase_settlement_effects
      WHERE community_id = ?1
        AND effect_kind = 'buyer_funding_receipt'
        AND effect_key = ?2
        AND status = 'confirmed'
      LIMIT 1
    `,
    args: [input.communityId, input.txRef],
  })
  return row ? toSettlementEffectRow(row) : null
}

export async function listPurchaseSettlementEffectsByQuote(input: {
  client: DbExecutor
  communityId: string
  quoteId: string
  purchaseId: string
}): Promise<PurchaseSettlementEffectRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
             effect_key, idempotency_key, status, failure_disposition, broadcast_tx_ref, settlement_ref, provider_receipt_ref,
             tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at, confirmed_at,
             failed_at, created_at, updated_at
      FROM purchase_settlement_effects
      WHERE community_id = ?1
        AND quote_id = ?2
        AND purchase_id = ?3
      ORDER BY created_at ASC
    `,
    args: [input.communityId, input.quoteId, input.purchaseId],
  })
  return result.rows.map((row) => toSettlementEffectRow(row))
}

export async function listPurchaseSettlementEffectsByPurchase(input: {
  client: DbExecutor
  communityId: string
  purchaseId: string
}): Promise<PurchaseSettlementEffectRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
             effect_key, idempotency_key, status, failure_disposition, broadcast_tx_ref, settlement_ref, provider_receipt_ref,
             tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at, confirmed_at,
             failed_at, created_at, updated_at
      FROM purchase_settlement_effects
      WHERE community_id = ?1
        AND purchase_id = ?2
      ORDER BY created_at ASC, effect_kind ASC, effect_key ASC
    `,
    args: [input.communityId, input.purchaseId],
  })
  return result.rows.map((row) => toSettlementEffectRow(row))
}

export async function beginPurchaseSettlementEffectAttempt(input: {
  client: DbExecutor
  communityId: string
  quoteId: string
  purchaseId: string
  effectKind: PurchaseSettlementEffectKind
  effectKey: string
  idempotencyKey: string
  now: string
}): Promise<PurchaseSettlementEffectRow> {
  const existing = await getPurchaseSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (existing?.status === "confirmed") {
    return existing
  }
  if (existing?.status === "submitted") {
    throw conflictError("Purchase settlement effect is already in progress")
  }
  if (existing) {
    if (existing.failure_disposition !== "failed_prebroadcast") {
      throw conflictError("Purchase settlement effect requires reconciliation")
    }
    await input.client.execute({
      sql: `
        UPDATE purchase_settlement_effects
        SET status = 'submitted',
            failure_disposition = NULL,
            broadcast_tx_ref = NULL,
            failure_reason = NULL,
            failed_at = NULL,
            submitted_at = ?2,
            attempt_count = attempt_count + 1,
            updated_at = ?2
        WHERE purchase_settlement_effect_id = ?1
      `,
      args: [existing.purchase_settlement_effect_id, input.now],
    })
    const updated = await getPurchaseSettlementEffectByIdempotencyKey({
      client: input.client,
      idempotencyKey: input.idempotencyKey,
    })
    if (!updated) {
      throw new Error("purchase_settlement_effect_missing_after_update")
    }
    return updated
  }

  const effectId = makeId("pse")
  try {
    await input.client.execute({
      sql: `
        INSERT INTO purchase_settlement_effects (
          purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
          effect_key, idempotency_key, status, failure_disposition, broadcast_tx_ref, settlement_ref, provider_receipt_ref,
          tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at, confirmed_at,
          failed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, 'submitted', NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, 1, ?8, NULL,
          NULL, ?8, ?8
        )
      `,
      args: [
        effectId,
        input.communityId,
        input.quoteId,
        input.purchaseId,
        input.effectKind,
        input.effectKey,
        input.idempotencyKey,
        input.now,
      ],
    })
  } catch (error) {
    const existingAfterConflict = await getPurchaseSettlementEffectByIdempotencyKey({
      client: input.client,
      idempotencyKey: input.idempotencyKey,
    })
    if (existingAfterConflict?.status === "confirmed") {
      return existingAfterConflict
    }
    if (existingAfterConflict?.status === "submitted") {
      throw conflictError("Purchase settlement effect is already in progress")
    }
    if (
      existingAfterConflict?.status === "failed"
      && existingAfterConflict.failure_disposition === "failed_prebroadcast"
    ) {
      return await beginPurchaseSettlementEffectAttempt(input)
    }
    throw error
  }
  const created = await getPurchaseSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!created) {
    throw new Error("purchase_settlement_effect_missing_after_insert")
  }
  return created
}

export async function confirmPurchaseSettlementEffect(input: {
  client: DbExecutor
  idempotencyKey: string
  settlementRef: string
  providerReceiptRef?: string | null
  taxReceiptRef?: string | null
  metadataJson?: string | null
  now: string
}): Promise<PurchaseSettlementEffectRow> {
  await input.client.execute({
    sql: `
      UPDATE purchase_settlement_effects
      SET status = 'confirmed',
          failure_disposition = NULL,
          broadcast_tx_ref = COALESCE(broadcast_tx_ref, ?2),
          settlement_ref = ?2,
          provider_receipt_ref = ?3,
          tax_receipt_ref = ?4,
          metadata_json = ?5,
          failure_reason = NULL,
          confirmed_at = ?6,
          failed_at = NULL,
          updated_at = ?6
      WHERE idempotency_key = ?1
    `,
    args: [
      input.idempotencyKey,
      input.settlementRef,
      input.providerReceiptRef ?? null,
      input.taxReceiptRef ?? null,
      input.metadataJson ?? null,
      input.now,
    ],
  })
  const confirmed = await getPurchaseSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!confirmed) {
    throw new Error("purchase_settlement_effect_missing_after_confirm")
  }
  return confirmed
}

export async function confirmBuyerFundingEffectAndLockQuote(input: {
  client: Client
  communityId: string
  quoteId: string
  idempotencyKey: string
  settlementRef: string
  metadataJson: string
  now: string
}): Promise<void> {
  // D1 write transactions are buffered: keep this transaction write-only. In
  // particular, do not call confirmPurchaseSettlementEffect here because its
  // post-update SELECT cannot observe buffered writes reliably.
  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
      sql: `
        UPDATE purchase_settlement_effects
        SET status = 'confirmed',
            failure_disposition = NULL,
            broadcast_tx_ref = COALESCE(broadcast_tx_ref, ?2),
            settlement_ref = ?2,
            metadata_json = ?3,
            failure_reason = NULL,
            confirmed_at = ?4,
            failed_at = NULL,
            updated_at = ?4
        WHERE idempotency_key = ?1
      `,
      args: [input.idempotencyKey, input.settlementRef, input.metadataJson, input.now],
    })
    await tx.execute({
      sql: `
        UPDATE purchase_quotes
        SET funding_locked_at = COALESCE(funding_locked_at, ?3),
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
          AND status = 'active'
      `,
      args: [input.communityId, input.quoteId, input.now],
    })
  })
}

export async function failPurchaseSettlementEffect(input: {
  client: DbExecutor
  idempotencyKey: string
  failureReason: string
  disposition?: PurchaseSettlementFailureDisposition
  broadcastTxRef?: string | null
  now: string
}): Promise<PurchaseSettlementEffectRow> {
  await input.client.execute({
    sql: `
      UPDATE purchase_settlement_effects
      SET status = 'failed',
          failure_disposition = ?4,
          broadcast_tx_ref = ?5,
          failure_reason = ?2,
          failed_at = ?3,
          updated_at = ?3
      WHERE idempotency_key = ?1
    `,
    args: [
      input.idempotencyKey,
      input.failureReason,
      input.now,
      input.disposition ?? "reconciliation_required",
      input.broadcastTxRef ?? null,
    ],
  })
  const failed = await getPurchaseSettlementEffectByIdempotencyKey({
    client: input.client,
    idempotencyKey: input.idempotencyKey,
  })
  if (!failed) {
    throw new Error("purchase_settlement_effect_missing_after_fail")
  }
  return failed
}
