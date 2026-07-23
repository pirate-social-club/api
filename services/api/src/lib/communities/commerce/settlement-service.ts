import { badRequestError, conflictError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { withTransaction } from "../../transactions"
import { decodePublicId } from "../../public-ids"
import { openCommunityReadClient, openCommunityWriteClient, type CommunityWriteHandle } from "../community-read-access"
import type { Client } from "../../sql-client"
import type { DbExecutor } from "../../db-helpers"
import type {
  CommunityDatabaseBindingRepository,
  CommunityRepository,
} from "../db-community-repository"
import { derivePurchaseRef } from "../../story/story-identifiers"
import {
  mintStoryRoyaltyPurchaseEntitlement,
  payStoryRoyaltyOnBehalfForPurchase,
  transferStoryRoyaltyToParentVault,
} from "../../story/story-royalty-settlement-service"
import {
  classifyStoryTransactionFailure,
  storyTransactionHashFromError,
} from "../../story/story-transaction-failure"
import type { UserRepository } from "../../auth/repositories"
import {
  getActiveEntitlementForBuyerIdentity,
  getAssetRow,
  getEntitlementRowByPurchase,
  listLatestEntitlementRowsByPurchaseIds,
  getPurchaseQuoteRow,
  getPurchaseRow,
  getListingRowById,
  listPurchaseAllocationLegRowsByPurchaseIds,
  listPurchaseAllocationLegRows,
  listPurchaseRows,
} from "./queries"
import {
  parseJsonValue,
} from "./row-types"
import type { AssetRow } from "./row-types"
import {
  assertAssetNotRightsHeld,
  assertListingNotRightsHeld,
} from "./rights-hold-gates"
import {
  requireCommunityMember,
  resolveWalletAttachmentAddress,
} from "./access"
import {
  serializePurchase,
} from "./serialization"
import {
  resolveAllocationSettlementAmountAtomic,
  resolvePurchaseEntitlementTarget,
} from "./quote-helpers"
import {
  decodeCommerceListCursor,
  encodeCommerceListCursor,
} from "./list-cursors"
import {
  assertExecutableQuoteAllocationSnapshot,
  assertSettlementModeCanExecuteAllocations,
  extractDonationCompatibilityFields,
  parseQuoteAllocationSnapshot,
} from "./allocation"
import {
  executeCharityPayoutsForSettlement,
  getAllocationExecutionKey,
  type ResolvedCharityPayout,
} from "./charity-payout-service"
import { confirmBuyerFundingForSettlement } from "./funding-proof-service"
import { coordinateStorySettlement } from "./story-settlement-coordinator-service"
import { excludeKnownZeroRevenueShareStoryParents } from "./derivative-parent-revenue-share"
import {
  type BuyerIdentity,
  buyerIdentityFields,
  buyerMatchesFields,
  requireUserBuyerId,
  requireWalletBuyerIdentity,
  userBuyer,
} from "./buyer-identity"
import {
  beginPurchaseSettlementEffectAttempt,
  confirmPurchaseSettlementEffect,
  failPurchaseSettlementEffect,
  listPurchaseSettlementEffectsByPurchase,
  listPurchaseSettlementEffectsByQuote,
  type PurchaseSettlementEffectRow,
} from "./settlement-effects"
import {
  getPurchaseSettlementAttempt,
  listStalePurchaseSettlementAttempts,
  markPurchaseSettlementAttemptFailed,
  reservePurchaseSettlementAttempt,
  type PurchaseSettlementAttemptRow,
} from "./settlement-attempts"
import type {
  PurchaseQuoteRow,
  QuoteAllocationSnapshot,
} from "./row-types"
import {
  derivePurchaseAllocationLegId,
  derivePurchaseEntitlementId,
  derivePurchaseIdForQuote,
} from "./purchase-settlement-ids"
import {
  serializeSettlementForBuyer,
  type PublicCommunityPurchaseSettlement,
} from "./purchase-settlement-serialization"
import type {
  CommunityPurchase,
  CommunityPurchaseSettlementEffect,
  CommunityPurchaseSettlementEffectListResponse,
  CommunityPurchaseListResponse,
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementPending,
  CommunityPurchaseSettlementRequest,
  Env,
} from "../../../types"
import { nullableUnixSeconds, unixSeconds } from "../../../serializers/time"

type CommunitySettlementRepository = CommunityDatabaseBindingRepository
  & Pick<CommunityRepository, "listSettlementEligibleCommunities">

type RoyaltyEarningEventForNotification = {
  recipientUserId: string
  communityId: string
  assetId: string
  storyIpId: string
  amountWipWei: string
  buyerWalletAddress: string | null
  txHash: string
  purchaseId: string
  title: string | null
}

export type SettleCommunityPurchaseResult = {
  settlement: CommunityPurchaseSettlement | PublicCommunityPurchaseSettlement | null
  settlementPending?: CommunityPurchaseSettlementPending
  royaltyEarningEvents: RoyaltyEarningEventForNotification[]
}

export type PublicCommunityPurchaseSettlementRequest = {
  quote: string
  funding_tx_ref: string
  settlement_tx_ref?: string | null
}

export type PurchaseSettlementReconciliationSummary = {
  checked: number
  finalized: number
  failed: number
  stillPending: number
  errors: number
  stalledCommunityIds: string[]
}

/**
 * Quote-consumption eligibility, evaluated on the base client BEFORE the settlement
 * write tx. Replaces the former in-tx `rowsAffected === 0` branch (a buffered D1 write
 * tx can't surface rowsAffected mid-flight). 'active' is consumed by the conditional
 * UPDATE; 'consumed' is an idempotent re-settlement (deterministic purchaseId + the
 * purchases PK de-dupe the writes); any terminal state (expired/failed) or a missing
 * quote is not consumable.
 */
export function assertPurchaseQuoteConsumable(status: string | null | undefined): void {
  if (status !== "active" && status !== "consumed") {
    throw conflictError("Purchase quote could not be consumed")
  }
}

function serializePurchaseSettlementEffect(row: PurchaseSettlementEffectRow): CommunityPurchaseSettlementEffect {
  return {
    object: "purchase_settlement_effect",
    community: `com_${row.community_id}`,
    quote: `pq_${row.quote_id}`,
    purchase: `pur_${row.purchase_id}`,
    effect_kind: row.effect_kind,
    effect_ref: row.effect_key,
    status: row.status,
    settlement_ref: row.settlement_ref,
    provider_receipt_ref: row.provider_receipt_ref,
    tax_receipt_ref: row.tax_receipt_ref,
    failure_reason: row.failure_reason,
    attempt_count: row.attempt_count,
    submitted: nullableUnixSeconds(row.submitted_at),
    confirmed: nullableUnixSeconds(row.confirmed_at),
    failed: nullableUnixSeconds(row.failed_at),
    created: unixSeconds(row.created_at),
  }
}

async function finalizeLocalPurchaseSettlement(input: {
  client: Client
  communityId: string
  buyer: BuyerIdentity
  quote: PurchaseQuoteRow
  purchaseId: string
  settlementChain: CommunityPurchaseSettlement["settlement_chain"]
  settlementTxRef: string
  // The on-chain transaction that actually executed the Story payout, or null when none did.
  // A story_payout allocation leg confirms only when this is present — evidence local to the
  // finalizer, so a leg cannot be recorded settled by trusting how the caller resolved
  // settlementTxRef. Populated only on the royalty-native asset path where the Story payment
  // effect is confirmed.
  storyPayoutSettlementRef: string | null
  allocationSnapshot: QuoteAllocationSnapshot[]
  charityPayouts: Map<string, ResolvedCharityPayout>
  donationPartnerId: string | null
  donationSharePct: number | null
  donationAmountUsd: number | null
  settlementWalletAttachmentId: string
  createdAt: string
}): Promise<CommunityPurchaseSettlement | PublicCommunityPurchaseSettlement> {
  const settlementTxRef = input.settlementTxRef.trim()
  if (!settlementTxRef) {
    throw badRequestError("settlement_tx_ref is required")
  }
  const buyerFields = buyerIdentityFields(input.buyer)

  const entitlementTarget = resolvePurchaseEntitlementTarget(input.quote)
  let entitlement = await getActiveEntitlementForBuyerIdentity(
    input.client,
    input.communityId,
    input.buyer,
    entitlementTarget.targetRef,
    entitlementTarget.entitlementKind,
  )
  if (!entitlement) {
    entitlement = {
      purchase_entitlement_id: derivePurchaseEntitlementId(input.purchaseId),
      purchase_id: input.purchaseId,
      community_id: input.communityId,
      buyer_kind: buyerFields.buyer_kind,
      buyer_user_id: buyerFields.buyer_user_id,
      buyer_wallet_address: buyerFields.buyer_wallet_address,
      buyer_wallet_address_normalized: buyerFields.buyer_wallet_address_normalized,
      buyer_chain_ref: buyerFields.buyer_chain_ref,
      entitlement_kind: entitlementTarget.entitlementKind,
      target_ref: entitlementTarget.targetRef,
      status: "active",
      granted_at: input.createdAt,
      revoked_at: null,
      created_at: input.createdAt,
      updated_at: input.createdAt,
    }
  }

  const listing = await getListingRowById(input.client, input.communityId, input.quote.listing_id)
  if (!listing) {
    throw notFoundError("Listing not found")
  }
  await assertListingNotRightsHeld({
    client: input.client,
    communityId: input.communityId,
    listing,
  })

  // Quote-consumption eligibility BEFORE the tx — a buffered D1 write tx can't read
  // the quote's UPDATE rowsAffected back mid-flight. Re-read the authoritative status:
  // 'active' will be consumed by the conditional UPDATE below; 'consumed' is an
  // idempotent re-settlement (purchaseId is deterministic + purchases.purchase_id is
  // the PK, so the writes below de-dupe via ON CONFLICT); any terminal state
  // (expired/failed) is not consumable.
  const liveQuote = await getPurchaseQuoteRow(input.client, input.communityId, input.quote.quote_id)
  assertPurchaseQuoteConsumable(liveQuote?.status ?? null)

  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO purchases (
          purchase_id, community_id, listing_id, asset_id, live_room_id, replay_asset_id, buyer_kind, buyer_user_id,
          buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
          settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
          settlement_mode, settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
          donation_amount_usd, donation_settlement_ref, vinyl_release_provider, vinyl_release_url, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          ?9, ?10, ?11,
          ?12, ?13, ?14, ?15,
          ?16, ?17, ?18, ?19,
          ?20, ?21, ?22, ?23, ?24, ?25
        )
        ON CONFLICT(purchase_id) DO NOTHING
      `,
      args: [
        input.purchaseId,
        input.communityId,
        input.quote.listing_id,
        input.quote.asset_id,
        input.quote.live_room_id,
        input.quote.replay_asset_id,
        buyerFields.buyer_kind,
        buyerFields.buyer_user_id,
        buyerFields.buyer_wallet_address,
        buyerFields.buyer_wallet_address_normalized,
        buyerFields.buyer_chain_ref,
        input.settlementWalletAttachmentId,
        input.quote.final_price_usd,
        input.quote.pricing_tier,
        JSON.stringify(input.settlementChain),
        input.quote.settlement_mode,
        input.quote.destination_settlement_token,
        settlementTxRef,
        input.donationPartnerId,
        input.donationPartnerId ? input.donationSharePct : null,
        input.donationPartnerId ? input.donationAmountUsd : null,
        Array.from(input.charityPayouts.values())[0]?.settlementRef ?? null,
        listing.vinyl_release_provider ?? null,
        listing.vinyl_release_url,
        input.createdAt,
      ],
    })

    for (const allocation of input.allocationSnapshot) {
      const charityPayout = input.charityPayouts.get(getAllocationExecutionKey(allocation)) ?? null
      // A story_payout leg confirms only when an on-chain Story payout actually executed, evidenced
      // by a settlement ref the caller supplies ONLY on the royalty-native asset path (after the
      // story_royalty_payment effect is confirmed). This is checked locally rather than trusting how
      // the caller resolved settlementTxRef, so a delivery-only leg cannot be recorded settled from
      // the buyer funding tx — it stays pending. Defense in depth behind the quote-time guard.
      const storyPayoutExecuted = allocation.settlement_strategy === "story_payout"
        && input.quote.settlement_mode === "royalty_native_story_payment"
        && Boolean(input.storyPayoutSettlementRef)
      const allocationStatus = storyPayoutExecuted || charityPayout ? "confirmed" : "pending"
      const allocationSettlementRef = storyPayoutExecuted
        ? input.storyPayoutSettlementRef
        : charityPayout?.settlementRef ?? null
      const allocationSubmittedAt = allocationStatus === "confirmed" ? input.createdAt : null
      const allocationConfirmedAt = allocationStatus === "confirmed" ? input.createdAt : null
      const allocationAttemptCount = allocationStatus === "confirmed" ? 1 : 0
      await tx.execute({
        sql: `
          INSERT INTO purchase_allocation_legs (
            purchase_allocation_leg_id, purchase_id, quote_id, community_id, recipient_type, recipient_ref,
            waterfall_position, share_bps, amount_usd, settlement_strategy, status, settlement_ref,
            provider_receipt_ref, tax_receipt_ref, submitted_at, confirmed_at, failed_at, attempt_count,
            failure_reason, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, NULL, ?17,
            NULL, ?18, ?18
          )
          ON CONFLICT(purchase_allocation_leg_id) DO UPDATE SET
            status = excluded.status,
            settlement_ref = excluded.settlement_ref,
            provider_receipt_ref = excluded.provider_receipt_ref,
            tax_receipt_ref = excluded.tax_receipt_ref,
            submitted_at = excluded.submitted_at,
            confirmed_at = excluded.confirmed_at,
            attempt_count = excluded.attempt_count,
            updated_at = excluded.updated_at
        `,
        args: [
          derivePurchaseAllocationLegId(input.purchaseId, allocation.waterfall_position),
          input.purchaseId,
          input.quote.quote_id,
          input.communityId,
          allocation.recipient_type,
          allocation.recipient_ref ?? null,
          allocation.waterfall_position,
          allocation.share_bps,
          allocation.amount_usd,
          allocation.settlement_strategy,
          allocationStatus,
          allocationSettlementRef,
          charityPayout?.providerReceiptRef ?? null,
          charityPayout?.taxReceiptRef ?? null,
          allocationSubmittedAt,
          allocationConfirmedAt,
          allocationAttemptCount,
          input.createdAt,
        ],
      })
    }

    await tx.execute({
      sql: `
        INSERT INTO purchase_entitlements (
          purchase_entitlement_id, purchase_id, community_id, buyer_kind, buyer_user_id,
          buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref, entitlement_kind,
          target_ref, status, granted_at, revoked_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9,
          ?10, ?11, ?12, NULL, ?12, ?12
        )
        ON CONFLICT(purchase_entitlement_id) DO UPDATE SET
          status = excluded.status,
          granted_at = excluded.granted_at,
          revoked_at = NULL,
          updated_at = excluded.updated_at
      `,
      args: [
        entitlement.purchase_entitlement_id,
        entitlement.purchase_id,
        entitlement.community_id,
        entitlement.buyer_kind,
        entitlement.buyer_user_id,
        entitlement.buyer_wallet_address,
        entitlement.buyer_wallet_address_normalized,
        entitlement.buyer_chain_ref,
        entitlement.entitlement_kind,
        entitlement.target_ref,
        entitlement.status,
        entitlement.granted_at,
      ],
    })

    // Conditional + idempotent: consumes the quote only if still 'active'. Eligibility
    // was already enforced pre-tx, so we no longer branch on rowsAffected here (a
    // buffered D1 write tx can't surface it mid-flight).
    await tx.execute({
      sql: `
        UPDATE purchase_quotes
        SET status = 'consumed',
            consumed_at = ?3,
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
          AND status = 'active'
      `,
      args: [input.communityId, input.quote.quote_id, input.createdAt],
    })

    await tx.execute({
      sql: `
        UPDATE purchase_settlement_attempts
        SET status = 'finalized',
            failure_reason = NULL,
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
      `,
      args: [input.communityId, input.quote.quote_id, input.createdAt],
    })
  })

  const purchase = await getPurchaseRow(input.client, input.communityId, input.purchaseId)
  if (!purchase) {
    throw notFoundError("Purchase not found")
  }
  const finalizedEntitlement = await getEntitlementRowByPurchase(input.client, purchase.purchase_id)
  if (!finalizedEntitlement) {
    throw notFoundError("Purchase entitlement not found")
  }
  const allocations = await listPurchaseAllocationLegRows(input.client, input.purchaseId)
  return serializeSettlementForBuyer(purchase, finalizedEntitlement, input.quote, allocations)
}

function buildConfirmedCharityPayoutsFromEffects(
  effects: PurchaseSettlementEffectRow[],
): Map<string, ResolvedCharityPayout> {
  const payouts = new Map<string, ResolvedCharityPayout>()
  for (const effect of effects) {
    if (effect.effect_kind !== "charity_payout" || effect.status !== "confirmed") {
      continue
    }
    const settlementRef = effect.settlement_ref?.trim()
    if (!settlementRef) {
      continue
    }
    payouts.set(effect.effect_key, {
      allocationKey: effect.effect_key,
      settlementRef,
      providerReceiptRef: effect.provider_receipt_ref,
      taxReceiptRef: effect.tax_receipt_ref,
    })
  }
  return payouts
}

function getConfirmedEffect(
  effects: PurchaseSettlementEffectRow[],
  kind: PurchaseSettlementEffectRow["effect_kind"],
): PurchaseSettlementEffectRow | null {
  return effects.find((effect) => effect.effect_kind === kind && effect.status === "confirmed") ?? null
}

async function getPayableStoryDerivativeParentIpIds(env: Env, asset: AssetRow): Promise<string[]> {
  const parentIpIds = parseJsonValue<string[]>(asset.story_derivative_parent_ip_ids_json, [])
    .filter((parentIpId) => typeof parentIpId === "string" && parentIpId.trim())
    .map((parentIpId) => parentIpId.trim())
  return excludeKnownZeroRevenueShareStoryParents({ env, parentIpIds })
}

function hasConfirmedParentRoyaltyVaultTransfer(input: {
  effects: PurchaseSettlementEffectRow[]
  asset: AssetRow
  parentIpId: string
}): boolean {
  const effectKey = `${input.asset.asset_id}:${input.parentIpId}`
  return input.effects.some((effect) =>
    effect.effect_kind === "story_parent_royalty_vault_transfer"
    && effect.effect_key === effectKey
    && effect.status === "confirmed"
    && Boolean(effect.settlement_ref?.trim())
  )
}

function settlementFailureDisposition(error: unknown): {
  disposition: "failed_prebroadcast" | "reconciliation_required"
  broadcastTxRef: string | null
} {
  const broadcastTxRef = storyTransactionHashFromError(error)
  const classification = classifyStoryTransactionFailure(error)
  return {
    disposition: classification === "ambiguous" ? "reconciliation_required" : "failed_prebroadcast",
    broadcastTxRef,
  }
}

async function getExistingPurchaseSettlement(input: {
  client: DbExecutor
  communityId: string
  purchaseId: string
  quote: PurchaseQuoteRow
}): Promise<CommunityPurchaseSettlement | PublicCommunityPurchaseSettlement | null> {
  const purchase = await getPurchaseRow(input.client, input.communityId, input.purchaseId)
  const entitlement = purchase
    ? await getEntitlementRowByPurchase(input.client, purchase.purchase_id)
    : null
  if (!purchase || !entitlement) {
    return null
  }
  const allocations = await listPurchaseAllocationLegRows(input.client, purchase.purchase_id)
  return serializeSettlementForBuyer(purchase, entitlement, input.quote, allocations)
}

async function reconcileStaleCommunityPurchaseSettlementAttempt(input: {
  env: Env
  client: Client
  communityId: string
  attempt: PurchaseSettlementAttemptRow
  now: string
}): Promise<"finalized" | "failed" | "pending" | "error"> {
  let quote = await getPurchaseQuoteRow(input.client, input.communityId, input.attempt.quote_id)
  if (!quote) {
    await markPurchaseSettlementAttemptFailed({
      client: input.client,
      quoteId: input.attempt.quote_id,
      failureReason: "Purchase quote not found during reconciliation",
      now: input.now,
    })
    return "failed"
  }

  let effects = await listPurchaseSettlementEffectsByQuote({
    client: input.client,
    communityId: input.communityId,
    quoteId: input.attempt.quote_id,
    purchaseId: input.attempt.purchase_id,
  })
  const confirmedFundingEffect = getConfirmedEffect(effects, "buyer_funding_receipt")
  if (quote.status === "expired" && confirmedFundingEffect) {
    const fundingLockedAt = confirmedFundingEffect.confirmed_at ?? input.now
    await input.client.execute({
      sql: `
        UPDATE purchase_quotes
        SET status = 'active',
            funding_locked_at = COALESCE(funding_locked_at, ?3),
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
          AND status = 'expired'
      `,
      args: [input.communityId, input.attempt.quote_id, fundingLockedAt],
    })
    quote = {
      ...quote,
      status: "active",
      funding_locked_at: quote.funding_locked_at ?? fundingLockedAt,
      updated_at: fundingLockedAt,
    }
  }
  const coordinatorOwned = effects.some((effect) => effect.coordinator_plan_ref)
  if (!coordinatorOwned && effects.some((effect) => effect.status === "submitted")) {
    return "pending"
  }

  if (quote.status === "consumed") {
    await input.client.execute({
      sql: `
        UPDATE purchase_settlement_attempts
        SET status = 'finalized',
            failure_reason = NULL,
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
      `,
      args: [input.communityId, input.attempt.quote_id, input.now],
    })
    return "finalized"
  }

  if (quote.status !== "active") {
    await markPurchaseSettlementAttemptFailed({
      client: input.client,
      quoteId: input.attempt.quote_id,
      failureReason: `Purchase quote is ${quote.status}`,
      now: input.now,
    })
    return "failed"
  }

  const allocationSnapshot = assertExecutableQuoteAllocationSnapshot(
    parseQuoteAllocationSnapshot(quote.allocation_snapshot_json),
  )
  const charityPayouts = buildConfirmedCharityPayoutsFromEffects(effects)
  for (const allocation of allocationSnapshot) {
    if (
      allocation.recipient_type === "charity"
      && allocation.settlement_strategy === "provider_payout"
      && allocation.amount_usd > 0
      && allocation.recipient_ref?.trim()
      && !charityPayouts.has(getAllocationExecutionKey(allocation))
    ) {
      return "pending"
    }
  }

  let settlementTxRef = input.attempt.settlement_tx_ref?.trim() ?? ""
  if (quote.asset_id) {
    const asset = await getAssetRow(input.client, input.communityId, quote.asset_id)
    if (!asset) {
      await markPurchaseSettlementAttemptFailed({
        client: input.client,
        quoteId: input.attempt.quote_id,
        failureReason: "Asset not found during reconciliation",
        now: input.now,
      })
      return "failed"
    }
    if (coordinatorOwned) {
      const storyEffect = effects.find((effect) => effect.effect_kind === "story_royalty_payment")
      const metadata = parseJsonValue<{ buyer_wallet_address?: string }>(storyEffect?.metadata_json ?? null, {})
      if (!metadata.buyer_wallet_address?.trim()) return "pending"
      const coordinated = await coordinateStorySettlement({
        env: input.env,
        client: input.client,
        communityId: input.communityId,
        quoteId: quote.quote_id,
        purchaseId: input.attempt.purchase_id,
        asset,
        buyerAddress: metadata.buyer_wallet_address,
        purchaseRef: derivePurchaseRef({
          communityId: input.communityId,
          purchaseId: input.attempt.purchase_id,
          assetId: asset.asset_id,
        }),
        amount: resolveAllocationSettlementAmountAtomic({
          allocations: allocationSnapshot,
          settlementStrategy: "story_payout",
        }),
        now: input.now,
      })
      if (coordinated.kind !== "confirmed") return "pending"
      effects = await listPurchaseSettlementEffectsByQuote({
        client: input.client,
        communityId: input.communityId,
        quoteId: quote.quote_id,
        purchaseId: input.attempt.purchase_id,
      })
    }
    if (effects.some((effect) => effect.status === "submitted" || effect.status === "failed")) {
      return "pending"
    }
    const storyRoyaltyEffect = getConfirmedEffect(effects, "story_royalty_payment")
    settlementTxRef = storyRoyaltyEffect?.settlement_ref?.trim() ?? ""
    if (!settlementTxRef) {
      return "pending"
    }
    for (const parentIpId of await getPayableStoryDerivativeParentIpIds(input.env, asset)) {
      if (!hasConfirmedParentRoyaltyVaultTransfer({ effects, asset, parentIpId })) {
        return "pending"
      }
    }
    if (asset.access_mode === "locked" && !getConfirmedEffect(effects, "story_entitlement_mint")) {
      return "pending"
    }
  }

  if (!settlementTxRef) {
    await markPurchaseSettlementAttemptFailed({
      client: input.client,
      quoteId: input.attempt.quote_id,
      failureReason: "Settlement reference is missing during reconciliation",
      now: input.now,
    })
    return "failed"
  }

  const {
    donationAmountUsd,
    donationPartnerId,
    donationSharePct,
  } = extractDonationCompatibilityFields({ allocationSnapshot })
  const settlementChain = parseJsonValue<CommunityPurchaseSettlement["settlement_chain"]>(
    quote.destination_settlement_chain_json,
    { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
  )

  try {
    const buyer = quote.buyer_kind === "wallet"
      ? requireWalletBuyerIdentity(quote)
      : userBuyer(requireUserBuyerId(quote))
    await finalizeLocalPurchaseSettlement({
      client: input.client,
      communityId: input.communityId,
      buyer,
      quote,
      purchaseId: input.attempt.purchase_id,
      settlementChain,
      settlementTxRef,
      // Assets reach here only after the confirmed story_royalty_payment effect (line ~587), where
      // settlementTxRef was replaced with that effect's ref. Non-assets never executed a payout.
      storyPayoutSettlementRef: quote.asset_id ? settlementTxRef : null,
      allocationSnapshot,
      charityPayouts,
      donationPartnerId,
      donationSharePct,
      donationAmountUsd,
      settlementWalletAttachmentId: input.attempt.settlement_wallet_attachment_id,
      createdAt: input.now,
    })
    return "finalized"
  } catch {
    return "error"
  }
}

export async function reconcileStaleCommunityPurchaseSettlements(input: {
  env: Env
  communityRepository: CommunitySettlementRepository
  staleMs?: number
  maxCommunities?: number
  maxAttemptsPerCommunity?: number
}): Promise<PurchaseSettlementReconciliationSummary> {
  const staleMs = input.staleMs ?? 10 * 60 * 1000
  const maxCommunities = input.maxCommunities ?? 100
  const maxAttemptsPerCommunity = input.maxAttemptsPerCommunity ?? 10
  const staleBefore = new Date(Date.now() - staleMs).toISOString()
  const summary: PurchaseSettlementReconciliationSummary = {
    checked: 0,
    finalized: 0,
    failed: 0,
    stillPending: 0,
    errors: 0,
    stalledCommunityIds: [],
  }

  const communities = await listPurchaseSettlementReconciliationCommunities(
    input.communityRepository,
    maxCommunities,
    Date.now(),
  )
  for (const community of communities) {
    let db: CommunityWriteHandle | null = null
    try {
      db = await openCommunityWriteClient(input.env, input.communityRepository, community.community_id)
      const attempts = await listStalePurchaseSettlementAttempts({
        client: db.client,
        staleBefore,
        limit: maxAttemptsPerCommunity,
      })
      for (const attempt of attempts) {
        summary.checked += 1
        try {
          const outcome = await reconcileStaleCommunityPurchaseSettlementAttempt({
            env: input.env,
            client: db.client,
            communityId: community.community_id,
            attempt,
            now: new Date().toISOString(),
          })
          if (outcome === "finalized") {
            summary.finalized += 1
          } else if (outcome === "failed") {
            summary.failed += 1
            if (!summary.stalledCommunityIds.includes(community.community_id)) {
              summary.stalledCommunityIds.push(community.community_id)
            }
          } else if (outcome === "pending") {
            summary.stillPending += 1
            if (!summary.stalledCommunityIds.includes(community.community_id)) {
              summary.stalledCommunityIds.push(community.community_id)
            }
          } else {
            summary.errors += 1
            if (!summary.stalledCommunityIds.includes(community.community_id)) {
              summary.stalledCommunityIds.push(community.community_id)
            }
          }
        } catch {
          summary.errors += 1
          if (!summary.stalledCommunityIds.includes(community.community_id)) {
            summary.stalledCommunityIds.push(community.community_id)
          }
        }
      }
    } catch {
      summary.errors += 1
      if (!summary.stalledCommunityIds.includes(community.community_id)) {
        summary.stalledCommunityIds.push(community.community_id)
      }
    } finally {
      db?.close()
    }
  }

  return summary
}

export async function reconcileCommunityPurchaseSettlement(input: {
  env: Env
  communityRepository: CommunitySettlementRepository
  communityId: string
  quoteId: string
}): Promise<"finalized" | "failed" | "pending" | "error"> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const attempt = await getPurchaseSettlementAttempt({ client: db.client, quoteId: input.quoteId })
    if (!attempt || attempt.community_id !== input.communityId) {
      throw notFoundError("Purchase settlement attempt not found")
    }
    return await reconcileStaleCommunityPurchaseSettlementAttempt({
      env: input.env,
      client: db.client,
      communityId: input.communityId,
      attempt,
      now: nowIso(),
    })
  } finally {
    db.close()
  }
}

export function selectRotatingCommunityBatch<T>(items: T[], maxItems: number, nowMs: number): T[] {
  if (items.length <= maxItems) return items
  const epochMinute = Math.floor(nowMs / 60_000)
  const start = (epochMinute * maxItems) % items.length
  return Array.from({ length: maxItems }, (_, offset) => items[(start + offset) % items.length]!)
}

export async function listPurchaseSettlementReconciliationCommunities(
  repository: Pick<CommunityRepository, "listSettlementEligibleCommunities">,
  maxCommunities: number,
  nowMs: number,
): Promise<Array<{ community_id: string; created_at: string }>> {
  const routedCommunities = await repository.listSettlementEligibleCommunities()
  return selectRotatingCommunityBatch(routedCommunities, maxCommunities, nowMs)
}

async function settleCommunityPurchaseForBuyer(input: {
  env: Env
  communityId: string
  buyer: BuyerIdentity
  body: PublicCommunityPurchaseSettlementRequest
  communityRepository: CommunityDatabaseBindingRepository
  settlementWalletAttachmentId: string
  resolveBuyerWalletAddress: () => Promise<string>
}): Promise<SettleCommunityPurchaseResult> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const buyer = input.buyer
    const quoteId = decodePublicId(input.body.quote, "pq")
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, quoteId)
    if (!quote || !buyerMatchesFields(buyer, quote)) {
      throw notFoundError("Purchase quote not found")
    }
    const purchaseId = derivePurchaseIdForQuote(quote.quote_id)
    if (quote.status !== "active") {
      if (quote.status === "consumed") {
        const settlement = await getExistingPurchaseSettlement({
          client: db.client,
          communityId: input.communityId,
          purchaseId,
          quote,
        })
        if (settlement) {
          return {
            settlement,
            royaltyEarningEvents: [],
          }
        }
      }
      throw badRequestError("Purchase quote is not active")
    }
    if (!quote.funding_locked_at && new Date(quote.expires_at).getTime() <= Date.now()) {
      await db.client.execute({
        sql: `
          UPDATE purchase_quotes
          SET status = 'expired',
              updated_at = ?3
          WHERE community_id = ?1
            AND quote_id = ?2
        `,
        args: [input.communityId, quoteId, nowIso()],
      })
      throw badRequestError("Purchase quote has expired")
    }
    const createdAt = nowIso()
    // Re-validate the persisted snapshot against its settlement mode before reserving the attempt or
    // verifying buyer funding, so a delivery-only quote issued before the quote-time guard cannot be
    // settled into a false payout record. A legacy quote may already have been paid by an alternative
    // client, so this is a backstop, not a guarantee the buyer was never charged — the clean
    // deployment action is to expire/delete any active unsafe quotes before rollout.
    const allocationSnapshot = assertSettlementModeCanExecuteAllocations(
      assertExecutableQuoteAllocationSnapshot(
        parseQuoteAllocationSnapshot(quote.allocation_snapshot_json),
      ),
      quote.settlement_mode,
    )
    if (!quote.asset_id && allocationSnapshot.some((allocation) => allocation.recipient_type === "charity")) {
      throw badRequestError("Non-asset purchase donations are not supported until charity payout routing is enabled")
    }
    const {
      donationAmountUsd,
      donationPartnerId,
      donationSharePct,
    } = extractDonationCompatibilityFields({
      allocationSnapshot,
    })
    const coordinatorOwnedAttempt = (await listPurchaseSettlementEffectsByQuote({
      client: db.client,
      communityId: input.communityId,
      quoteId: quote.quote_id,
      purchaseId,
    })).some((effect) => Boolean(effect.coordinator_plan_ref))
    const reservation = await reservePurchaseSettlementAttempt({
      client: db.client,
      communityId: input.communityId,
      quoteId: quote.quote_id,
      purchaseId,
      settlementWalletAttachmentId: input.settlementWalletAttachmentId,
      settlementTxRef: input.body.settlement_tx_ref ?? null,
      coordinatorOwned: coordinatorOwnedAttempt,
      now: createdAt,
    })
    if (reservation === "finalized") {
      const settlement = await getExistingPurchaseSettlement({
        client: db.client,
        communityId: input.communityId,
        purchaseId,
        quote,
      })
      if (settlement) {
        return {
          settlement,
          royaltyEarningEvents: [],
        }
      }
      throw conflictError("Purchase settlement was finalized but local purchase rows are missing")
    }
    const settlementChain = parseJsonValue<CommunityPurchaseSettlement["settlement_chain"]>(
      quote.destination_settlement_chain_json,
      { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
    )
    let canonicalSettlementTxRef = input.body.settlement_tx_ref
    let charityPayouts = new Map<string, ResolvedCharityPayout>()
    const royaltyEarningEvents: RoyaltyEarningEventForNotification[] = []
    // Funding-proof verification runs for ALL paid quotes, not just asset purchases.
    // Previously this was gated behind `if (quote.asset_id)`, which let non-asset purchases
    // (e.g. live-room tickets) finalize entitlement on a client-provided funding_tx_ref
    // without verifying that funds actually moved on-chain — a "free ticket" hole.
    let buyerWalletAddress: string | null = null
    if (quote.final_price_usd > 0) {
      buyerWalletAddress = await input.resolveBuyerWalletAddress()
      const fundingReceipt = await confirmBuyerFundingForSettlement({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        quote,
        purchaseId,
        buyerAddress: buyerWalletAddress,
        fundingTxRef: input.body.funding_tx_ref,
        now: createdAt,
      })
      // For non-asset purchases, use the verified funding tx ref as the canonical
      // settlement tx ref when the client didn't provide one. This ensures the
      // purchase row always carries a server-verified on-chain reference.
      if (!quote.asset_id && !canonicalSettlementTxRef) {
        canonicalSettlementTxRef = fundingReceipt.txRef
      }
    }
    if (quote.asset_id) {
      const asset = await getAssetRow(db.client, input.communityId, quote.asset_id)
      if (!asset) {
        throw notFoundError("Asset not found")
      }
      await assertAssetNotRightsHeld({
        client: db.client,
        communityId: input.communityId,
        asset,
      })
      if (quote.settlement_mode !== "royalty_native_story_payment") {
        throw badRequestError("Asset purchases require Story royalty-native settlement")
      }
      if (asset.access_mode === "locked") {
        if (!asset.story_entitlement_token_id?.trim()) {
          throw badRequestError("Locked asset entitlement token is not configured")
        }
        if (asset.story_status !== "published" || asset.locked_delivery_status !== "ready") {
          throw badRequestError("Locked asset is not ready for purchase settlement")
        }
      }
      // buyerWalletAddress was resolved above during funding-proof verification.
      // For the impossible free-asset edge case (final_price_usd === 0), resolve it here.
      const assetBuyerWalletAddress = buyerWalletAddress ?? await input.resolveBuyerWalletAddress()
      const purchaseRef = derivePurchaseRef({
        communityId: input.communityId,
        purchaseId,
        assetId: asset.asset_id,
      })
      const storyPayoutAmount = resolveAllocationSettlementAmountAtomic({
        allocations: allocationSnapshot,
        settlementStrategy: "story_payout",
      })
      if (quote.destination_settlement_token !== "WIP") {
        throw badRequestError("Story royalty-native purchases require WIP settlement")
      }
      if (asset.story_royalty_registration_status !== "registered" || !asset.story_ip_id?.trim()) {
        throw badRequestError("Story royalty-native asset registration is not configured")
      }
      charityPayouts = await executeCharityPayoutsForSettlement({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        quoteId: quote.quote_id,
        purchaseId,
        settlementToken: quote.destination_settlement_token,
        allocations: allocationSnapshot,
        now: createdAt,
      })
      const coordinated = await coordinateStorySettlement({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        quoteId: quote.quote_id,
        purchaseId,
        asset,
        buyerAddress: assetBuyerWalletAddress,
        purchaseRef,
        amount: storyPayoutAmount,
        now: createdAt,
      })
      if (coordinated.kind === "pending") {
        return {
          settlement: null,
          settlementPending: {
            object: "community_purchase_settlement_pending",
            community: `com_${input.communityId}`,
            quote: `pq_${quote.quote_id}`,
            purchase: `pur_${purchaseId}`,
            coordinator_plan_ref: coordinated.planRef,
            status: "settlement_pending",
          },
          royaltyEarningEvents: [],
        }
      }
      if (coordinated.kind === "confirmed") {
        const coordinatedEffects = await listPurchaseSettlementEffectsByQuote({
          client: db.client,
          communityId: input.communityId,
          quoteId: quote.quote_id,
          purchaseId,
        })
        const storyRoyaltyEffect = getConfirmedEffect(coordinatedEffects, "story_royalty_payment")
        const settlementRef = storyRoyaltyEffect?.settlement_ref?.trim()
        if (!storyRoyaltyEffect || !settlementRef) {
          throw badRequestError("Confirmed Story coordinator plan is missing its royalty settlement reference")
        }
        canonicalSettlementTxRef = settlementRef
        const royaltyTxHash = storyRoyaltyEffect.provider_receipt_ref?.trim() || settlementRef
        royaltyEarningEvents.push({
          recipientUserId: asset.creator_user_id,
          communityId: input.communityId,
          assetId: asset.asset_id,
          storyIpId: asset.story_ip_id,
          amountWipWei: storyPayoutAmount.toString(),
          buyerWalletAddress: assetBuyerWalletAddress,
          txHash: royaltyTxHash,
          purchaseId,
          title: asset.display_title,
        })
        for (const parentIpId of await getPayableStoryDerivativeParentIpIds(input.env, asset)) {
          if (!hasConfirmedParentRoyaltyVaultTransfer({
            effects: coordinatedEffects,
            asset,
            parentIpId,
          })) {
            throw badRequestError("Confirmed Story coordinator plan is missing a parent royalty transfer")
          }
        }
        if (asset.access_mode === "locked" && !getConfirmedEffect(coordinatedEffects, "story_entitlement_mint")) {
          throw badRequestError("Confirmed Story coordinator plan is missing its entitlement mint")
        }
      } else {
        const storyPaymentIdempotencyKey = `${quote.quote_id}:story_royalty:${asset.story_ip_id}:${storyPayoutAmount.toString()}`
        const storyPaymentMetadata = JSON.stringify({
          amount_wip_wei: storyPayoutAmount.toString(),
          buyer_wallet_address: assetBuyerWalletAddress,
          asset: asset.asset_id,
          story_ip_id: asset.story_ip_id,
          creator_user_id: asset.creator_user_id,
          title: asset.display_title,
        })
        const storyPaymentEffect = await beginPurchaseSettlementEffectAttempt({
          client: db.client,
          communityId: input.communityId,
          quoteId: quote.quote_id,
          purchaseId,
          effectKind: "story_royalty_payment",
          effectKey: asset.asset_id,
          idempotencyKey: storyPaymentIdempotencyKey,
          now: createdAt,
        })
        let entitlementHandledByRoyaltyExecutor = false
        let entitlementTxHash: string | null = null
        let royaltyTxHash: string | null = null
        if (storyPaymentEffect.status === "confirmed") {
          const settlementRef = storyPaymentEffect.settlement_ref?.trim()
          if (!settlementRef) {
            throw badRequestError("Story royalty settlement reference is missing")
          }
          canonicalSettlementTxRef = settlementRef
          royaltyTxHash = storyPaymentEffect.provider_receipt_ref?.trim() || settlementRef
        } else {
          try {
            const storySettlement = await payStoryRoyaltyOnBehalfForPurchase({
              env: input.env,
              purchaseRef,
              buyerAddress: assetBuyerWalletAddress,
              receiverIpId: asset.story_ip_id,
              payerIpId: null,
              entitlementTokenId: asset.access_mode === "locked"
                ? BigInt(asset.story_entitlement_token_id!)
                : null,
              amount: storyPayoutAmount,
            })
            canonicalSettlementTxRef = storySettlement.settlementTxHash
            royaltyTxHash = storySettlement.royaltyTxHash
            entitlementHandledByRoyaltyExecutor = storySettlement.entitlementHandled
            entitlementTxHash = storySettlement.entitlementTxHash
            await confirmPurchaseSettlementEffect({
              client: db.client,
              idempotencyKey: storyPaymentIdempotencyKey,
              settlementRef: storySettlement.settlementTxHash,
              providerReceiptRef: storySettlement.royaltyTxHash,
              taxReceiptRef: null,
              metadataJson: storyPaymentMetadata,
              now: createdAt,
            })
          } catch (error) {
            const failure = settlementFailureDisposition(error)
            await failPurchaseSettlementEffect({
              client: db.client,
              idempotencyKey: storyPaymentIdempotencyKey,
              failureReason: error instanceof Error ? error.message : String(error),
              disposition: failure.disposition,
              broadcastTxRef: failure.broadcastTxRef,
              now: createdAt,
            })
            throw error
          }
        }
        if (royaltyTxHash) {
          royaltyEarningEvents.push({
            recipientUserId: asset.creator_user_id,
            communityId: input.communityId,
            assetId: asset.asset_id,
            storyIpId: asset.story_ip_id,
            amountWipWei: storyPayoutAmount.toString(),
            buyerWalletAddress: assetBuyerWalletAddress,
            txHash: royaltyTxHash,
            purchaseId,
            title: asset.display_title,
          })
        }
        const parentIpIds = await getPayableStoryDerivativeParentIpIds(input.env, asset)
        if (parentIpIds.length > 0) {
          for (const parentIpId of parentIpIds) {
            const normalizedParentIpId = parentIpId.trim()
            const transferEffectKey = `${asset.asset_id}:${normalizedParentIpId}`
            const transferIdempotencyKey = `${quote.quote_id}:story_parent_royalty_vault:${asset.story_ip_id}:${normalizedParentIpId}:${storyPayoutAmount.toString()}`
            const transferMetadata = JSON.stringify({
              amount_wip_wei: storyPayoutAmount.toString(),
              asset: asset.asset_id,
              child_story_ip_id: asset.story_ip_id,
              parent_story_ip_id: normalizedParentIpId,
              story_royalty_policy: asset.story_royalty_policy,
              title: asset.display_title,
            })
            const transferEffect = await beginPurchaseSettlementEffectAttempt({
              client: db.client,
              communityId: input.communityId,
              quoteId: quote.quote_id,
              purchaseId,
              effectKind: "story_parent_royalty_vault_transfer",
              effectKey: transferEffectKey,
              idempotencyKey: transferIdempotencyKey,
              now: createdAt,
            })
            if (transferEffect.status !== "confirmed") {
              try {
                const transfer = await transferStoryRoyaltyToParentVault({
                  env: input.env,
                  childIpId: asset.story_ip_id,
                  parentIpId: normalizedParentIpId,
                  royaltyPolicy: asset.story_royalty_policy,
                })
                await confirmPurchaseSettlementEffect({
                  client: db.client,
                  idempotencyKey: transferIdempotencyKey,
                  settlementRef: transfer.transferTxHash,
                  providerReceiptRef: transfer.transferTxHash,
                  taxReceiptRef: null,
                  metadataJson: transferMetadata,
                  now: createdAt,
                })
              } catch (error) {
                const failure = settlementFailureDisposition(error)
                await failPurchaseSettlementEffect({
                  client: db.client,
                  idempotencyKey: transferIdempotencyKey,
                  failureReason: error instanceof Error ? error.message : String(error),
                  disposition: failure.disposition,
                  broadcastTxRef: failure.broadcastTxRef,
                  now: createdAt,
                })
                throw error
              }
            }
          }
        }
        if (asset.access_mode === "locked") {
          const entitlementEffectKey = `${asset.asset_id}:${asset.story_entitlement_token_id}:${assetBuyerWalletAddress.toLowerCase()}`
          const entitlementIdempotencyKey = `${quote.quote_id}:story_entitlement:${entitlementEffectKey}`
          const entitlementEffect = await beginPurchaseSettlementEffectAttempt({
            client: db.client,
            communityId: input.communityId,
            quoteId: quote.quote_id,
            purchaseId,
            effectKind: "story_entitlement_mint",
            effectKey: entitlementEffectKey,
            idempotencyKey: entitlementIdempotencyKey,
            now: createdAt,
          })
          if (entitlementEffect.status !== "confirmed") {
            try {
              const confirmedEntitlementTxHash = entitlementHandledByRoyaltyExecutor
                ? entitlementTxHash ?? canonicalSettlementTxRef
                : await mintStoryRoyaltyPurchaseEntitlement({
                  env: input.env,
                  purchaseRef,
                  buyerAddress: assetBuyerWalletAddress,
                  entitlementTokenId: BigInt(asset.story_entitlement_token_id!),
                })
              await confirmPurchaseSettlementEffect({
                client: db.client,
                idempotencyKey: entitlementIdempotencyKey,
                settlementRef: confirmedEntitlementTxHash,
                now: createdAt,
              })
            } catch (error) {
              const failure = settlementFailureDisposition(error)
              await failPurchaseSettlementEffect({
                client: db.client,
                idempotencyKey: entitlementIdempotencyKey,
                failureReason: error instanceof Error ? error.message : String(error),
                disposition: failure.disposition,
                broadcastTxRef: failure.broadcastTxRef,
                now: createdAt,
              })
              throw error
            }
          }
        }
      }
    }
    try {
      const settlement = await finalizeLocalPurchaseSettlement({
        client: db.client,
        communityId: input.communityId,
        buyer,
        quote,
        purchaseId,
        settlementChain,
        settlementTxRef: canonicalSettlementTxRef ?? "",
        // For assets, canonicalSettlementTxRef was replaced with the executed Story settlement hash
        // (story branch, line ~908/923). Non-assets never executed a payout.
        storyPayoutSettlementRef: quote.asset_id ? (canonicalSettlementTxRef ?? null) : null,
        allocationSnapshot,
        charityPayouts,
        donationPartnerId,
        donationSharePct,
        donationAmountUsd,
        settlementWalletAttachmentId: input.settlementWalletAttachmentId,
        createdAt,
      })
      return {
        settlement,
        royaltyEarningEvents,
      }
    } catch (error) {
      await markPurchaseSettlementAttemptFailed({
        client: db.client,
        quoteId: quote.quote_id,
        failureReason: error instanceof Error ? error.message : String(error),
        now: nowIso(),
      })
      throw error
    }
  } finally {
    db.close()
  }
}

export async function settleCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseSettlementRequest
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<SettleCommunityPurchaseResult> {
  const membershipDb = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(membershipDb.client, input.communityId, input.userId)
  } finally {
    membershipDb.close()
  }

  return settleCommunityPurchaseForBuyer({
    env: input.env,
    communityId: input.communityId,
    buyer: userBuyer(input.userId),
    body: input.body,
    communityRepository: input.communityRepository,
    settlementWalletAttachmentId: input.body.settlement_wallet_attachment,
    resolveBuyerWalletAddress: () => resolveWalletAttachmentAddress({
      userRepository: input.userRepository,
      userId: input.userId,
      walletAttachmentId: input.body.settlement_wallet_attachment,
    }),
  })
}

export async function settlePublicCommunityPurchase(input: {
  env: Env
  communityId: string
  body: PublicCommunityPurchaseSettlementRequest
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<SettleCommunityPurchaseResult> {
  const quoteDb = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const quoteId = decodePublicId(input.body.quote, "pq")
    const quote = await getPurchaseQuoteRow(quoteDb.client, input.communityId, quoteId)
    if (!quote) {
      throw notFoundError("Purchase quote not found")
    }
    const buyer = requireWalletBuyerIdentity(quote)
    // Public settlement intentionally uses the on-chain checkout receipt as the
    // wallet-control gate: funding must come from the wallet bound to the quote.
    // This synthetic attachment id is only a ledger marker, not a user wallet
    // attachment id that can be resolved through the user repository.
    const walletLedgerAttachmentId = `wallet:${buyer.chainRef}:${buyer.walletAddressNormalized}`
    return await settleCommunityPurchaseForBuyer({
      env: input.env,
      communityId: input.communityId,
      buyer,
      body: input.body,
      communityRepository: input.communityRepository,
      settlementWalletAttachmentId: walletLedgerAttachmentId,
      resolveBuyerWalletAddress: async () => buyer.walletAddress,
    })
  } finally {
    quoteDb.close()
  }
}

export async function listCommunityPurchases(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  cursor?: string | null
  limit: number
}): Promise<CommunityPurchaseListResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const rows = await listPurchaseRows(db.client, input.communityId, input.userId, {
      after: decodeCommerceListCursor(input.cursor),
      limit: input.limit + 1,
    })
    const purchases = rows.slice(0, input.limit)
    const purchaseIds = purchases.map((purchase) => purchase.purchase_id)
    const entitlementsByPurchaseId = await listLatestEntitlementRowsByPurchaseIds(db.client, purchaseIds)
    const allocationsByPurchaseId = await listPurchaseAllocationLegRowsByPurchaseIds(db.client, purchaseIds)
    const items: CommunityPurchase[] = []
    for (const purchase of purchases) {
      const entitlement = entitlementsByPurchaseId.get(purchase.purchase_id) ?? null
      if (entitlement) {
        const allocations = allocationsByPurchaseId.get(purchase.purchase_id) ?? []
        items.push(serializePurchase(purchase, entitlement, allocations))
      }
    }
    const lastRow = purchases[purchases.length - 1] ?? null
    return {
      items,
      next_cursor: rows.length > input.limit && lastRow
        ? encodeCommerceListCursor({ created_at: lastRow.created_at, id: lastRow.purchase_id })
        : null,
    }
  } finally {
    db.close()
  }
}

export async function getCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  purchaseId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<CommunityPurchase> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const purchase = await getPurchaseRow(db.client, input.communityId, input.purchaseId)
    if (!purchase || !buyerMatchesFields(userBuyer(input.userId), purchase)) {
      throw notFoundError("Purchase not found")
    }
    const entitlement = await getEntitlementRowByPurchase(db.client, purchase.purchase_id)
    if (!entitlement) {
      throw notFoundError("Purchase not found")
    }
    const allocations = await listPurchaseAllocationLegRows(db.client, purchase.purchase_id)
    return serializePurchase(purchase, entitlement, allocations)
  } finally {
    db.close()
  }
}

export async function listCommunityPurchaseSettlementEffects(input: {
  env: Env
  userId: string
  communityId: string
  purchaseId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<CommunityPurchaseSettlementEffectListResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const purchase = await getPurchaseRow(db.client, input.communityId, input.purchaseId)
    if (!purchase || !buyerMatchesFields(userBuyer(input.userId), purchase)) {
      throw notFoundError("Purchase not found")
    }
    const effects = await listPurchaseSettlementEffectsByPurchase({
      client: db.client,
      communityId: input.communityId,
      purchaseId: purchase.purchase_id,
    })
    return {
      items: effects.map((effect) => serializePurchaseSettlementEffect(effect)),
      next_cursor: null,
    }
  } finally {
    db.close()
  }
}
