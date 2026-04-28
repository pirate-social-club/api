import { badRequestError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityRepository } from "../db-community-repository"
import { derivePurchaseRef } from "../../story/story-identifiers"
import {
  mintStoryRoyaltyPurchaseEntitlement,
  payStoryRoyaltyOnBehalfForPurchase,
} from "../../story/story-royalty-settlement-service"
import type { UserRepository } from "../../auth/repositories"
import {
  getActiveEntitlementForBuyer,
  getAssetRow,
  getEntitlementRowByPurchase,
  getPurchaseQuoteRow,
  getPurchaseRow,
  listPurchaseAllocationLegRows,
  listPurchaseRows,
} from "./queries"
import {
  parseJsonValue,
} from "./row-types"
import {
  requireCommunityMember,
  resolveWalletAttachmentAddress,
} from "./access"
import {
  serializePurchase,
} from "./serialization"
import {
  resolveAllocationSettlementAmountAtomic,
  serializeSettlement,
} from "./quote-helpers"
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
  beginPurchaseSettlementEffectAttempt,
  confirmPurchaseSettlementEffect,
  failPurchaseSettlementEffect,
} from "./settlement-effects"
import type {
  CommunityPurchase,
  CommunityPurchaseListResponse,
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementRequest,
  Env,
} from "../../../types"

function derivePurchaseIdForQuote(quoteId: string): string {
  return `pur_${quoteId.replace(/^quo_/, "")}`
}

export async function settleCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseSettlementRequest
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseSettlement> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, input.body.quote_id)
    if (!quote || quote.buyer_user_id !== input.userId) {
      throw notFoundError("Purchase quote not found")
    }
    if (quote.status !== "active") {
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
        args: [input.communityId, input.body.quote_id, nowIso()],
      })
      throw badRequestError("Purchase quote has expired")
    }
    const purchaseId = derivePurchaseIdForQuote(quote.quote_id)
    const createdAt = nowIso()
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
      const buyerWalletAddress = await resolveWalletAttachmentAddress({
        userRepository: input.userRepository,
        userId: input.userId,
        walletAttachmentId: input.body.settlement_wallet_attachment_id,
      })
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
      if (storyPaymentEffect.status === "confirmed") {
        const settlementRef = storyPaymentEffect.settlement_ref?.trim()
        if (!settlementRef) {
          throw badRequestError("Story royalty settlement reference is missing")
        }
        canonicalSettlementTxRef = settlementRef
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
          entitlementHandledByRoyaltyExecutor = storySettlement.entitlementHandled
          entitlementTxHash = storySettlement.entitlementTxHash
          await confirmPurchaseSettlementEffect({
            client: db.client,
            idempotencyKey: storyPaymentIdempotencyKey,
            settlementRef: storySettlement.settlementTxHash,
            providerReceiptRef: storySettlement.royaltyTxHash,
            taxReceiptRef: null,
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
    const donationSettlementRef = Array.from(charityPayouts.values())[0]?.settlementRef ?? null
    await db.client.execute({
      sql: `
        INSERT INTO purchases (
          purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_user_id,
          settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
          settlement_mode, settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
          donation_amount_usd, donation_settlement_ref, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, NULL, ?5,
          ?6, ?7, ?8, ?9,
          ?10, ?11, ?12, ?13,
          ?14, ?15, ?16, ?17
        )
      `,
      args: [
        purchaseId,
        input.communityId,
        quote.listing_id,
        quote.asset_id,
        input.userId,
        input.body.settlement_wallet_attachment_id,
        quote.final_price_usd,
        quote.pricing_tier,
        JSON.stringify(settlementChain),
        quote.settlement_mode,
        quote.destination_settlement_token,
        canonicalSettlementTxRef,
        donationPartnerId,
        donationPartnerId ? donationSharePct : null,
        donationPartnerId ? donationAmountUsd : null,
        donationSettlementRef,
        createdAt,
      ],
    })
    for (const allocation of allocationSnapshot) {
      const charityPayout = charityPayouts.get(getAllocationExecutionKey(allocation)) ?? null
      const allocationStatus = allocation.settlement_strategy === "story_payout" || charityPayout ? "confirmed" : "pending"
      const allocationSettlementRef = allocation.settlement_strategy === "story_payout"
        ? canonicalSettlementTxRef
        : charityPayout?.settlementRef ?? null
      const allocationSubmittedAt = allocationStatus === "confirmed" ? createdAt : null
      const allocationConfirmedAt = allocationStatus === "confirmed" ? createdAt : null
      const allocationAttemptCount = allocationStatus === "confirmed" ? 1 : 0
      await db.client.execute({
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
        `,
        args: [
          makeId("pal"),
          purchaseId,
          quote.quote_id,
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
          createdAt,
        ],
      })
    }
    let entitlement = quote.asset_id
      ? await getActiveEntitlementForBuyer(db.client, input.communityId, input.userId, quote.asset_id)
      : null
    if (!entitlement) {
      entitlement = {
        purchase_entitlement_id: makeId("ent"),
        purchase_id: purchaseId,
        community_id: input.communityId,
        buyer_user_id: input.userId,
        entitlement_kind: "asset_access",
        target_ref: quote.asset_id || quote.listing_id,
        status: "active",
        granted_at: createdAt,
        revoked_at: null,
        created_at: createdAt,
        updated_at: createdAt,
      }
      await db.client.execute({
        sql: `
          INSERT INTO purchase_entitlements (
            purchase_entitlement_id, purchase_id, community_id, buyer_user_id, entitlement_kind,
            target_ref, status, granted_at, revoked_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, NULL, ?8, ?8
          )
        `,
        args: [
          entitlement.purchase_entitlement_id,
          entitlement.purchase_id,
          entitlement.community_id,
          entitlement.buyer_user_id,
          entitlement.entitlement_kind,
          entitlement.target_ref,
          entitlement.status,
          entitlement.granted_at,
        ],
      })
    }
    await db.client.execute({
      sql: `
        UPDATE purchase_quotes
        SET status = 'consumed',
            consumed_at = ?3,
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
      `,
      args: [input.communityId, input.body.quote_id, createdAt],
    })
    const purchase = await getPurchaseRow(db.client, input.communityId, purchaseId)
    if (!purchase) {
      throw notFoundError("Purchase not found")
    }
    const allocations = await listPurchaseAllocationLegRows(db.client, purchaseId)
    return serializeSettlement(purchase, entitlement, quote, allocations)
  } finally {
    db.close()
  }
}

export async function listCommunityPurchases(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityPurchaseListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const purchases = await listPurchaseRows(db.client, input.communityId, input.userId)
    const items: CommunityPurchase[] = []
    for (const purchase of purchases) {
      const entitlement = await getEntitlementRowByPurchase(db.client, purchase.purchase_id)
      if (entitlement) {
        const allocations = await listPurchaseAllocationLegRows(db.client, purchase.purchase_id)
        items.push(serializePurchase(purchase, entitlement, allocations))
      }
    }
    return { items }
  } finally {
    db.close()
  }
}

export async function getCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  purchaseId: string
  communityRepository: CommunityRepository
}): Promise<CommunityPurchase> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const purchase = await getPurchaseRow(db.client, input.communityId, input.purchaseId)
    if (!purchase || purchase.buyer_user_id !== input.userId) {
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
