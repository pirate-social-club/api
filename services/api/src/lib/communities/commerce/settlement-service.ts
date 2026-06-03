import { badRequestError, conflictError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { decodePublicId } from "../../public-ids"
import { openCommunityDb } from "../community-db-factory"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import { derivePurchaseRef } from "../../story/story-identifiers"
import {
  mintStoryRoyaltyPurchaseEntitlement,
  payStoryRoyaltyOnBehalfForPurchase,
  transferStoryRoyaltyToParentVault,
} from "../../story/story-royalty-settlement-service"
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
  extractDonationCompatibilityFields,
  parseQuoteAllocationSnapshot,
} from "./allocation"
import {
  executeCharityPayoutsForSettlement,
  getAllocationExecutionKey,
  type ResolvedCharityPayout,
} from "./charity-payout-service"
import { confirmBuyerFundingForSettlement } from "./funding-proof-service"
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
  listPurchaseSettlementEffectsByQuote,
  type PurchaseSettlementEffectRow,
} from "./settlement-effects"
import {
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
  CommunityPurchaseListResponse,
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementRequest,
  Env,
} from "../../../types"

type CommunitySettlementRepository = CommunityDatabaseBindingRepository & Pick<CommunityReadRepository, "listActiveCommunities">

export type RoyaltyEarningEventForNotification = {
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
  settlement: CommunityPurchaseSettlement | PublicCommunityPurchaseSettlement
  royaltyEarningEvents: RoyaltyEarningEventForNotification[]
}

export type { PublicCommunityPurchaseSettlement } from "./purchase-settlement-serialization"

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
}

async function finalizeLocalPurchaseSettlement(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  buyer: BuyerIdentity
  quote: PurchaseQuoteRow
  purchaseId: string
  settlementChain: CommunityPurchaseSettlement["settlement_chain"]
  settlementTxRef: string
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

  const tx = await input.client.transaction("write")
  try {
    await tx.execute({
      sql: `
        INSERT INTO purchases (
          purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_kind, buyer_user_id,
          buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
          settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
          settlement_mode, settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
          donation_amount_usd, donation_settlement_ref, vinyl_release_provider, vinyl_release_url, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7,
          ?8, ?9, ?10,
          ?11, ?12, ?13, ?14,
          ?15, ?16, ?17, ?18,
          ?19, ?20, ?21, ?22, ?23, ?24
        )
        ON CONFLICT(purchase_id) DO NOTHING
      `,
      args: [
        input.purchaseId,
        input.communityId,
        input.quote.listing_id,
        input.quote.asset_id,
        input.quote.live_room_id,
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
      const allocationStatus = allocation.settlement_strategy === "story_payout" || charityPayout ? "confirmed" : "pending"
      const allocationSettlementRef = allocation.settlement_strategy === "story_payout"
        ? settlementTxRef
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

    const quoteUpdate = await tx.execute({
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
    if ((quoteUpdate.rowsAffected ?? 0) === 0 && input.quote.status !== "consumed") {
      throw conflictError("Purchase quote could not be consumed")
    }

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

    await tx.commit()
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[purchase-settlements] rollback failed while recording settlement attempt", rollbackError)
    }
    throw error
  } finally {
    tx.close()
  }

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

function getStoryDerivativeParentIpIds(asset: AssetRow): string[] {
  return parseJsonValue<string[]>(asset.story_derivative_parent_ip_ids_json, [])
    .filter((parentIpId) => typeof parentIpId === "string" && parentIpId.trim())
    .map((parentIpId) => parentIpId.trim())
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

async function getExistingPurchaseSettlement(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
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
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  attempt: PurchaseSettlementAttemptRow
  now: string
}): Promise<"finalized" | "failed" | "pending" | "error"> {
  const quote = await getPurchaseQuoteRow(input.client, input.communityId, input.attempt.quote_id)
  if (!quote) {
    await markPurchaseSettlementAttemptFailed({
      client: input.client,
      quoteId: input.attempt.quote_id,
      failureReason: "Purchase quote not found during reconciliation",
      now: input.now,
    })
    return "failed"
  }

  const effects = await listPurchaseSettlementEffectsByQuote({
    client: input.client,
    communityId: input.communityId,
    quoteId: input.attempt.quote_id,
    purchaseId: input.attempt.purchase_id,
  })
  if (effects.some((effect) => effect.status === "failed")) {
    await markPurchaseSettlementAttemptFailed({
      client: input.client,
      quoteId: input.attempt.quote_id,
      failureReason: "One or more settlement effects failed",
      now: input.now,
    })
    return "failed"
  }
  if (effects.some((effect) => effect.status === "submitted")) {
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
    const storyRoyaltyEffect = getConfirmedEffect(effects, "story_royalty_payment")
    settlementTxRef = storyRoyaltyEffect?.settlement_ref?.trim() ?? ""
    if (!settlementTxRef) {
      return "pending"
    }
    for (const parentIpId of getStoryDerivativeParentIpIds(asset)) {
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
  }

  const communities = (await input.communityRepository.listActiveCommunities()).slice(0, maxCommunities)
  for (const community of communities) {
    let db: Awaited<ReturnType<typeof openCommunityDb>> | null = null
    try {
      db = await openCommunityDb(input.env, input.communityRepository, community.community_id)
      const attempts = await listStalePurchaseSettlementAttempts({
        client: db.client,
        staleBefore,
        limit: maxAttemptsPerCommunity,
      })
      for (const attempt of attempts) {
        summary.checked += 1
        try {
          const outcome = await reconcileStaleCommunityPurchaseSettlementAttempt({
            client: db.client,
            communityId: community.community_id,
            attempt,
            now: new Date().toISOString(),
          })
          if (outcome === "finalized") {
            summary.finalized += 1
          } else if (outcome === "failed") {
            summary.failed += 1
          } else if (outcome === "pending") {
            summary.stillPending += 1
          } else {
            summary.errors += 1
          }
        } catch {
          summary.errors += 1
        }
      }
    } catch {
      summary.errors += 1
    } finally {
      db?.close()
    }
  }

  return summary
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
    if (new Date(quote.expires_at).getTime() <= Date.now()) {
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
    const reservation = await reservePurchaseSettlementAttempt({
      client: db.client,
      communityId: input.communityId,
      quoteId: quote.quote_id,
      purchaseId,
      settlementWalletAttachmentId: input.settlementWalletAttachmentId,
      settlementTxRef: input.body.settlement_tx_ref ?? null,
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
    const allocationSnapshot = assertExecutableQuoteAllocationSnapshot(
      parseQuoteAllocationSnapshot(quote.allocation_snapshot_json),
    )
    const {
      donationAmountUsd,
      donationPartnerId,
      donationSharePct,
    } = extractDonationCompatibilityFields({
      allocationSnapshot,
    })
    const settlementChain = parseJsonValue<CommunityPurchaseSettlement["settlement_chain"]>(
      quote.destination_settlement_chain_json,
      { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
    )
    let canonicalSettlementTxRef = input.body.settlement_tx_ref
    let charityPayouts = new Map<string, ResolvedCharityPayout>()
    const royaltyEarningEvents: RoyaltyEarningEventForNotification[] = []
    if (quote.asset_id) {
      const asset = await getAssetRow(db.client, input.communityId, quote.asset_id)
      if (!asset) {
        throw notFoundError("Asset not found")
      }
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
      const buyerWalletAddress = await input.resolveBuyerWalletAddress()
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
      await confirmBuyerFundingForSettlement({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        quote,
        purchaseId,
        buyerAddress: buyerWalletAddress,
        fundingTxRef: input.body.funding_tx_ref,
        now: createdAt,
      })
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
      const storyPaymentIdempotencyKey = `${quote.quote_id}:story_royalty:${asset.story_ip_id}:${storyPayoutAmount.toString()}`
      const storyPaymentMetadata = JSON.stringify({
        amount_wip_wei: storyPayoutAmount.toString(),
        buyer_wallet_address: buyerWalletAddress,
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
            buyerAddress: buyerWalletAddress,
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
          await failPurchaseSettlementEffect({
            client: db.client,
            idempotencyKey: storyPaymentIdempotencyKey,
            failureReason: error instanceof Error ? error.message : String(error),
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
          buyerWalletAddress,
          txHash: royaltyTxHash,
          purchaseId,
          title: asset.display_title,
        })
      }
      const parentIpIds = parseJsonValue<string[]>(asset.story_derivative_parent_ip_ids_json, [])
        .filter((parentIpId) => typeof parentIpId === "string" && parentIpId.trim())
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
              await failPurchaseSettlementEffect({
                client: db.client,
                idempotencyKey: transferIdempotencyKey,
                failureReason: error instanceof Error ? error.message : String(error),
                now: createdAt,
              })
              throw error
            }
          }
        }
      }
      if (asset.access_mode === "locked") {
        const entitlementEffectKey = `${asset.asset_id}:${asset.story_entitlement_token_id}:${buyerWalletAddress.toLowerCase()}`
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
                buyerAddress: buyerWalletAddress,
                entitlementTokenId: BigInt(asset.story_entitlement_token_id!),
              })
            await confirmPurchaseSettlementEffect({
              client: db.client,
              idempotencyKey: entitlementIdempotencyKey,
              settlementRef: confirmedEntitlementTxHash,
              now: createdAt,
            })
          } catch (error) {
            await failPurchaseSettlementEffect({
              client: db.client,
              idempotencyKey: entitlementIdempotencyKey,
              failureReason: error instanceof Error ? error.message : String(error),
              now: createdAt,
            })
            throw error
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
  const membershipDb = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const quoteDb = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
