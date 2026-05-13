import { executeFirst, type DbExecutor } from "../../db-helpers"
import { conflictError } from "../../errors"
import { makeId } from "../../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"

export type PurchaseSettlementEffectKind =
  | "buyer_funding_receipt"
  | "charity_payout"
  | "story_royalty_payment"
  | "story_parent_royalty_vault_transfer"
  | "story_entitlement_mint"

export type PurchaseSettlementEffectStatus = "submitted" | "confirmed" | "failed"

export type PurchaseSettlementEffectRow = {
  purchase_settlement_effect_id: string
  community_id: string
  quote_id: string
  purchase_id: string
  effect_kind: PurchaseSettlementEffectKind
  effect_key: string
  idempotency_key: string
  status: PurchaseSettlementEffectStatus
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

export async function getPurchaseSettlementEffectByIdempotencyKey(input: {
  client: DbExecutor
  idempotencyKey: string
}): Promise<PurchaseSettlementEffectRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
             effect_key, idempotency_key, status, settlement_ref, provider_receipt_ref,
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

export async function listPurchaseSettlementEffectsByQuote(input: {
  client: DbExecutor
  communityId: string
  quoteId: string
  purchaseId: string
}): Promise<PurchaseSettlementEffectRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT purchase_settlement_effect_id, community_id, quote_id, purchase_id, effect_kind,
             effect_key, idempotency_key, status, settlement_ref, provider_receipt_ref,
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
    await input.client.execute({
      sql: `
        UPDATE purchase_settlement_effects
        SET status = 'submitted',
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
          effect_key, idempotency_key, status, settlement_ref, provider_receipt_ref,
          tax_receipt_ref, metadata_json, failure_reason, attempt_count, submitted_at, confirmed_at,
          failed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, 'submitted', NULL, NULL,
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
    if (existingAfterConflict?.status === "failed") {
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

export async function failPurchaseSettlementEffect(input: {
  client: DbExecutor
  idempotencyKey: string
  failureReason: string
  now: string
}): Promise<PurchaseSettlementEffectRow> {
  await input.client.execute({
    sql: `
      UPDATE purchase_settlement_effects
      SET status = 'failed',
          failure_reason = ?2,
          failed_at = ?3,
          updated_at = ?3
      WHERE idempotency_key = ?1
    `,
    args: [input.idempotencyKey, input.failureReason, input.now],
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
