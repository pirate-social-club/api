import type {
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementFailure,
  CommunityPurchaseSettlementFailureRequest,
  CommunityPurchaseSettlementRequest,
  Env,
} from "../../types"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import type { UserRepository } from "../auth/repositories"
import { badRequestError, conflictError, notFoundError } from "../errors"
import { normalizeAddress, nowIso } from "../helpers"
import { assertNonEmptyString, isRecord } from "../validation"
import { openCommunityDb } from "./community-db-factory"
import type { CommunityRepository } from "./control-plane-community-repository"
import {
  getCommunityPurchaseQuoteById,
  insertCommunityPurchaseAndConsumeQuote,
  markCommunityPurchaseQuoteExpired,
  markCommunityPurchaseQuoteFailed,
} from "./community-purchase-quote-store"
import { getCommunityListingById } from "./community-listing-store"
import { getCommunityAssetById } from "../posts/community-asset-store"
import {
  buildStoryPurchaseRef,
  hasStorySettlementDirectKeyConfigured,
  isStoryPurchaseSettled,
  settleCommunityPurchaseViaDirectKey,
  settleCommunityPurchaseViaLit,
} from "./story-settlement-runtime"

async function hasOpenRightsReviewCase(client: { execute: Function }, assetId: string): Promise<boolean> {
  const result = await client.execute({
    sql: `
      SELECT 1
      FROM rights_review_cases
      WHERE subject_type = 'asset'
        AND subject_id = ?1
        AND status IN ('open', 'under_review')
      LIMIT 1
    `,
    args: [assetId],
  })
  return result.rows.length > 0
}

function assertCommunityPurchaseSettlementRequest(value: unknown): asserts value is CommunityPurchaseSettlementRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community purchase settlement payload")
  }
  assertNonEmptyString(value.quote_id, "quote_id")
  assertNonEmptyString(value.settlement_wallet_attachment_id, "settlement_wallet_attachment_id")
  if (value.settlement_tx_ref != null) {
    assertNonEmptyString(value.settlement_tx_ref, "settlement_tx_ref")
  }
}

function assertCommunityPurchaseSettlementFailureRequest(
  value: unknown,
): asserts value is CommunityPurchaseSettlementFailureRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community purchase settlement failure payload")
  }
  assertNonEmptyString(value.quote_id, "quote_id")
}

function toSettlementChainRef(chain: CommunityPurchaseSettlement["settlement_chain"]): string {
  if (chain.chain_id == null) {
    return chain.chain_namespace
  }
  return `${chain.chain_namespace}:${chain.chain_id}`
}

export async function confirmCommunityPurchaseSettlement(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseSettlement> {
  const session = await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  assertCommunityPurchaseSettlementRequest(input.body)
  const body = input.body

  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(session.userId)
  const walletAttachment = walletAttachments.find(
    (attachment) => attachment.wallet_attachment_id === body.settlement_wallet_attachment_id.trim(),
  )
  if (!walletAttachment) {
    throw notFoundError("Settlement wallet attachment not found")
  }
  const buyerWalletAddress = normalizeAddress(walletAttachment.wallet_address)
  if (!buyerWalletAddress) {
    throw badRequestError("Settlement wallet attachment must be an EVM address")
  }

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const quote = await getCommunityPurchaseQuoteById({
      client: db.client,
      communityId: input.communityId,
      quoteId: body.quote_id.trim(),
    })
    if (!quote || quote.buyer_user_id !== session.userId) {
      throw notFoundError("Purchase quote not found")
    }
    if (quote.status === "consumed") {
      throw conflictError("Purchase quote has already been consumed")
    }
    if (quote.status === "failed") {
      throw conflictError("Purchase quote has already failed")
    }
    if (quote.status === "expired") {
      throw conflictError("Purchase quote has expired")
    }

    const now = nowIso()
    if (Date.parse(quote.expires_at) <= Date.parse(now)) {
      await markCommunityPurchaseQuoteExpired({
        client: db.client,
        communityId: input.communityId,
        quoteId: quote.quote_id,
        now,
      })
      throw conflictError("Purchase quote has expired")
    }

    if (quote.asset_id) {
      const rightsReviewHold = await hasOpenRightsReviewCase(db.client, quote.asset_id)
      if (rightsReviewHold) {
        throw conflictError("Settlement is on hold pending rights review resolution")
      }
    }

    const useRealStorySettlement = (
      Boolean(String(input.env.LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY || "").trim())
      || hasStorySettlementDirectKeyConfigured(input.env)
    ) && quote.asset_id != null
    let settlementTxRef = body.settlement_tx_ref?.trim() || null

    if (useRealStorySettlement) {
      if (!quote.destination_settlement_amount_atomic) {
        throw badRequestError("Purchase quote is missing destination settlement amount")
      }
      const listing = await getCommunityListingById({
        client: db.client,
        communityId: input.communityId,
        listingId: quote.listing_id,
      })
      const sellerWalletAttachments = await input.userRepository.getWalletAttachmentsByUserId(listing.created_by_user_id)
      const payoutAttachment = sellerWalletAttachments.find((attachment) => attachment.is_primary && normalizeAddress(attachment.wallet_address))
        ?? sellerWalletAttachments.find((attachment) => normalizeAddress(attachment.wallet_address))
      const payoutRecipient = normalizeAddress(payoutAttachment?.wallet_address)
      if (!payoutRecipient) {
        throw badRequestError("Listing creator does not have a settlement payout wallet configured")
      }

      const asset = await getCommunityAssetById({
        client: db.client,
        assetId: quote.asset_id!,
      })
      if (!asset) {
        throw notFoundError("Quoted asset not found")
      }

      const purchaseRef = buildStoryPurchaseRef({
        communityId: input.communityId,
        quoteId: quote.quote_id,
      })
      const alreadySettled = await isStoryPurchaseSettled({
        env: input.env,
        purchaseRef,
      })
      if (alreadySettled) {
        settlementTxRef = settlementTxRef || `story:settled:${purchaseRef}`
      } else {
        const settlement = Boolean(String(input.env.LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY || "").trim())
          ? await settleCommunityPurchaseViaLit({
            env: input.env,
            communityId: input.communityId,
            quoteId: quote.quote_id,
            asset,
            buyerAddress: buyerWalletAddress,
            payoutRecipient,
            amountAtomic: quote.destination_settlement_amount_atomic,
          })
          : await settleCommunityPurchaseViaDirectKey({
            env: input.env,
            communityId: input.communityId,
            quoteId: quote.quote_id,
            asset,
            buyerAddress: buyerWalletAddress,
            payoutRecipient,
            amountAtomic: quote.destination_settlement_amount_atomic,
          })
        settlementTxRef = settlement.storySettlementTxRef
      }
    }

    if (!settlementTxRef) {
      throw badRequestError("settlement_tx_ref is required when onchain settlement is not configured")
    }

    const tx = await db.client.transaction("write")
    try {
      const purchase = await insertCommunityPurchaseAndConsumeQuote({
        client: tx,
        quote,
        settlementWalletAttachmentId: walletAttachment.wallet_attachment_id,
        settlementTxRef,
        now,
      })
      await tx.commit()

      return {
        purchase_id: purchase.purchase_id,
        quote_id: quote.quote_id,
        community_id: quote.community_id,
        listing_id: quote.listing_id,
        buyer_user_id: quote.buyer_user_id,
        asset_id: quote.asset_id,
        live_room_id: quote.live_room_id,
        settlement_wallet_attachment_id: walletAttachment.wallet_attachment_id,
        purchase_price_usd: quote.final_price_usd,
        pricing_tier: quote.pricing_tier,
        settlement_chain: quote.destination_settlement_chain,
        settlement_chain_ref: toSettlementChainRef(quote.destination_settlement_chain),
        settlement_token: quote.destination_settlement_token,
        settlement_tx_ref: settlementTxRef,
        entitlement_kind: purchase.entitlement_kind,
        entitlement_target_ref: purchase.entitlement_target_ref,
        purchase_entitlement_id: purchase.purchase_entitlement_id,
        settled_at: now,
      }
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function failCommunityPurchaseSettlement(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityPurchaseSettlementFailure> {
  const session = await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  assertCommunityPurchaseSettlementFailureRequest(input.body)
  const body = input.body

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const quote = await getCommunityPurchaseQuoteById({
      client: db.client,
      communityId: input.communityId,
      quoteId: body.quote_id.trim(),
    })
    if (!quote || quote.buyer_user_id !== session.userId) {
      throw notFoundError("Purchase quote not found")
    }
    if (quote.status === "consumed") {
      throw conflictError("Purchase quote has already been consumed")
    }
    if (quote.status === "failed") {
      throw conflictError("Purchase quote has already failed")
    }

    const now = nowIso()
    if (quote.status === "active" && Date.parse(quote.expires_at) <= Date.parse(now)) {
      await markCommunityPurchaseQuoteExpired({
        client: db.client,
        communityId: input.communityId,
        quoteId: quote.quote_id,
        now,
      })
      return {
        quote_id: quote.quote_id,
        community_id: quote.community_id,
        status: "expired",
        failed_at: null,
        expires_at: quote.expires_at,
      }
    }

    await markCommunityPurchaseQuoteFailed({
      client: db.client,
      communityId: input.communityId,
      quoteId: quote.quote_id,
      now,
    })

    return {
      quote_id: quote.quote_id,
      community_id: quote.community_id,
      status: "failed",
      failed_at: now,
      expires_at: quote.expires_at,
    }
  } finally {
    db.close()
  }
}
