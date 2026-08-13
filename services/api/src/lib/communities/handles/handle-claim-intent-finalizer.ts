import { conflictError, internalError } from "../../errors"
import { makeId } from "../../helpers"
import type { Client, QueryResultRow } from "../../sql-client"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../../sql-row"
import {
  consumeHandleLabelReservationForIntent,
  extendFundedHandleLabelReservation,
} from "./handle-label-reservation"
import { createProtocolIssuanceForHandle } from "./handle-protocol-issuance"

export type FundedHandleClaimFinalization = {
  actorUserId: string
  communityId: string
  fundingTxHash: string
  intentId: string
  labelDisplay: string
  labelNormalized: string
  latestQuoteId: string
  namespaceId: string
  namespaceNormalizedLabel: string
  priceCents: number
  pricingModel: string | null
  pricingTier: string | null
  protocolIssuanceRequired: boolean
  protocolOwnerScriptPubkeyHex: string | null
  protocolOwnerWalletAttachmentId: string | null
  settlementWalletAttachmentId: string | null
}

export function decodeFundedHandleClaimFinalization(row: QueryResultRow): FundedHandleClaimFinalization {
  return {
    actorUserId: requiredString(row, "actor_user_id"),
    communityId: requiredString(row, "community_id"),
    fundingTxHash: requiredString(row, "funding_tx_hash"),
    intentId: requiredString(row, "community_handle_claim_intent_id"),
    labelDisplay: requiredString(row, "label_display"),
    labelNormalized: requiredString(row, "label_normalized"),
    latestQuoteId: requiredString(row, "latest_quote_id"),
    namespaceId: requiredString(row, "namespace_id"),
    namespaceNormalizedLabel: requiredString(row, "namespace_normalized_label"),
    priceCents: numberOrNull(rowValue(row, "price_cents")) ?? 0,
    pricingModel: stringOrNull(rowValue(row, "pricing_model")),
    pricingTier: stringOrNull(rowValue(row, "pricing_tier")),
    protocolIssuanceRequired: Boolean(rowValue(row, "protocol_issuance_required")),
    protocolOwnerScriptPubkeyHex: stringOrNull(rowValue(row, "protocol_owner_script_pubkey_hex")),
    protocolOwnerWalletAttachmentId: stringOrNull(rowValue(row, "protocol_owner_wallet_attachment_id")),
    settlementWalletAttachmentId: stringOrNull(rowValue(row, "settlement_wallet_attachment_id")),
  }
}

export async function finalizeFundedHandleClaimOnShard(input: {
  client: Client
  finalization: FundedHandleClaimFinalization
  now: string
  reservationHoldUntil: string
}): Promise<QueryResultRow> {
  const existing = await findHandleForIntent(input.client, input.finalization.intentId)
  if (existing) return existing
  const reservationExtended = await extendFundedHandleLabelReservation({
    executor: input.client,
    intentId: input.finalization.intentId,
    expiresAt: input.reservationHoldUntil,
    now: input.now,
  })
  if (!reservationExtended) {
    throw conflictError("Funded handle claim intent has no active shard reservation")
  }
  const handleId = makeId("ch")
  const tx = await input.client.transaction("write")
  try {
    await consumeHandleLabelReservationForIntent({
      executor: tx,
      intentId: input.finalization.intentId,
      now: input.now,
    })
    await tx.execute({
      sql: `
        INSERT INTO community_handles (
          community_handle_id, community_id, user_id, namespace_id, handle_claim_quote_id,
          handle_claim_intent_id, label_normalized, label_display, status, issuance_source,
          price_cents, currency, pricing_model, pricing_tier,
          settlement_wallet_attachment_id, protocol_owner_wallet_attachment_id,
          funding_tx_ref, settlement_tx_ref, lease_started_at, lease_expires_at,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, 'active', 'claim',
          ?9, 'USD', ?10, ?11,
          ?12, ?13, ?14, ?14, ?15, NULL,
          ?15, ?15
        )
      `,
      args: [
        handleId,
        input.finalization.communityId,
        input.finalization.actorUserId,
        input.finalization.namespaceId,
        input.finalization.latestQuoteId,
        input.finalization.intentId,
        input.finalization.labelNormalized,
        input.finalization.labelDisplay,
        input.finalization.priceCents,
        input.finalization.pricingModel,
        input.finalization.pricingTier,
        input.finalization.settlementWalletAttachmentId,
        input.finalization.protocolOwnerWalletAttachmentId,
        input.finalization.fundingTxHash,
        input.now,
      ],
    })
    if (input.finalization.protocolIssuanceRequired) {
      await createProtocolIssuanceForHandle({
        executor: tx,
        communityId: input.finalization.communityId,
        namespaceId: input.finalization.namespaceId,
        namespaceNormalizedLabel: input.finalization.namespaceNormalizedLabel,
        communityHandleId: handleId,
        labelNormalized: input.finalization.labelNormalized,
        scriptPubkeyHex: requiredValue(
          input.finalization.protocolOwnerScriptPubkeyHex,
          "Funded handle claim intent is missing its protocol owner script",
        ),
        now: input.now,
      })
    }
    await tx.execute({
      sql: `
        UPDATE community_handle_claim_quotes
        SET status = 'claimed', claimed_at = ?2, updated_at = ?2
        WHERE handle_claim_quote_id = ?1 AND status = 'quoted'
      `,
      args: [input.finalization.latestQuoteId, input.now],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    const raced = await findHandleForIntent(input.client, input.finalization.intentId)
    if (raced) return raced
    throw error
  } finally {
    tx.close()
  }
  const created = await findHandleForIntent(input.client, input.finalization.intentId)
  if (!created) throw internalError("Finalized community handle row is missing")
  return created
}

async function findHandleForIntent(client: Client, intentId: string): Promise<QueryResultRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM community_handles WHERE handle_claim_intent_id = ?1 LIMIT 1",
    args: [intentId],
  })
  return result.rows[0] ?? null
}

function requiredValue(value: string | null, message: string): string {
  if (!value) throw conflictError(message)
  return value
}

export function finalizedHandleId(row: QueryResultRow): string {
  return requiredString(row, "community_handle_id")
}
