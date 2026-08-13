import type { CommunityHandle, CommunityHandleClaimRequest, Env } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { badRequestError, conflictError, eligibilityFailed, HttpError, retryableConflictError } from "../../errors"
import { nowIso } from "../../helpers"
import { withStandaloneControlPlaneClient } from "../../runtime-deps"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { classifyPirateCheckoutUsdcFunding } from "../commerce/funding-proof-service"
import { openCommunityWriteClient } from "../community-read-access"
import { serializeHandle } from "./handle-row-store"
import {
  resolveFundedHandleReservationSeconds,
  resolveHandleClaimPaymentClockSkewSeconds,
} from "./handle-claim-intent-config"
import {
  completeFundedHandleClaimIntent,
  fundAuthorizedHandleClaimIntent,
  markFundedHandleClaimIntentRefundPending,
  requireHandleClaimIntentBinding,
} from "./handle-claim-intent-ledger"
import {
  decodeFundedHandleClaimFinalization,
  finalizeFundedHandleClaimOnShard,
} from "./handle-claim-intent-finalizer"
import type { HandleCommunityRepository } from "./handle-policy-service"

export async function claimCommunityHandleWithFundedIntent(input: {
  body: CommunityHandleClaimRequest
  communityId: string
  communityRepository: HandleCommunityRepository
  env: Env
  quoteId: string
  userId: string
  userRepository: UserRepository
}): Promise<CommunityHandle> {
  const intentId = input.body.claim_intent?.trim()
  const authorizationId = input.body.action_authorization?.trim()
  const fundingTxRef = input.body.funding_tx_ref?.trim()
  if (!intentId || !authorizationId) {
    throw badRequestError("claim_intent and action_authorization are required for funded handle claims")
  }
  if (!fundingTxRef) throw badRequestError("funding_tx_ref is required for funded handle claims")

  const initialIntent = await withStandaloneControlPlaneClient(input.env, async (client) => {
    return await requireHandleClaimIntentBinding({
      actorUserId: input.userId,
      client,
      communityId: input.communityId,
      intentId,
    })
  })
  if (requiredString(initialIntent, "latest_quote_id") !== input.quoteId) {
    throw conflictError("Handle claim intent does not belong to this quote")
  }
  if (requiredString(initialIntent, "action_authorization_id") !== authorizationId) {
    throw conflictError("Handle claim authorization does not belong to this intent")
  }
  const priceCents = numberOrNull(rowValue(initialIntent, "price_cents")) ?? 0
  if (priceCents <= 0) throw conflictError("Funded handle claim intent has no payable amount")
  const chainId = numberOrNull(rowValue(initialIntent, "chain_id"))
  if (!chainId || chainId <= 0) throw conflictError("Funded handle claim intent has no valid source chain")

  const walletAttachmentId = input.body.settlement_wallet_attachment?.trim()
  if (!walletAttachmentId) {
    throw badRequestError("settlement_wallet_attachment is required for paid handle claims")
  }
  const wallets = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const wallet = wallets.find((candidate) => candidate.wallet_attachment === walletAttachmentId)
  if (!wallet) throw eligibilityFailed("settlement_wallet_attachment is not available for this user")
  if (!wallet.chain_namespace.startsWith("eip155:")) {
    throw eligibilityFailed("settlement_wallet_attachment must be an EVM wallet")
  }

  const initialStatus = requiredString(initialIntent, "status")
  let fundingStatus: "funded_pending_finalization" | "refund_pending" = "funded_pending_finalization"
  let refundReason: string | null = null
  if (initialStatus === "authorized") {
    const verification = await classifyPirateCheckoutUsdcFunding({
      env: input.env,
      quoteId: input.quoteId,
      amountCents: priceCents,
      buyerAddress: wallet.wallet_address,
      fundingTxRef,
      fundingDestinationAddress: requiredString(initialIntent, "funding_destination_address"),
      sourceChainJson: JSON.stringify({
        chain_namespace: "eip155",
        chain_id: chainId,
        display_name: "Intent snapshot",
      }),
      tokenAddress: requiredString(initialIntent, "token_address"),
      finality: { expectedChainId: chainId, fallbackConfirmations: 30, preferSafeBlock: true },
    })
    if (verification.kind === "pending") {
      throw retryableConflictError("Funding transaction is not final", {
        funding_tx_ref: fundingTxRef,
        reason: verification.reason,
      })
    }
    if (verification.kind === "rejected") {
      throw badRequestError(`Funding transaction could not be classified: ${verification.reason}`)
    }
    const receipt = verification.kind === "verified" ? verification.receipt : verification.receipts[0]
    if (!receipt) throw badRequestError("Funding transaction has no custody evidence")
    const custodyDisposition = verification.kind === "verified"
      ? undefined
      : verification.kind === "custody_mismatch"
      ? {
          reason: verification.receipts.length > 1
            ? "custody_operator_review_duplicate_transfers"
            : verification.reason,
          review: verification.receipts.length > 1,
          additionalReceipts: verification.receipts.slice(1),
        }
      : {
          reason: "custody_operator_review_multiple_senders",
          review: true,
          additionalReceipts: verification.receipts.slice(1),
        }
    const result = await withStandaloneControlPlaneClient(input.env, async (client) => {
      return await fundAuthorizedHandleClaimIntent({
        authorizationId,
        client,
        env: input.env,
        fallbackSenderAddress: wallet.wallet_address,
        intentId,
        now: nowIso(),
        paymentClockSkewSeconds: resolveHandleClaimPaymentClockSkewSeconds(input.env),
        quoteId: input.quoteId,
        receipt,
        custodyDisposition,
        settlementWalletAttachmentId: walletAttachmentId,
      })
    })
    fundingStatus = result.status
    refundReason = result.status === "refund_pending" ? result.reason : null
  } else if (initialStatus === "funded_pending_finalization" || initialStatus === "completed") {
    if (requiredString(initialIntent, "funding_tx_hash").toLowerCase() !== fundingTxRef.toLowerCase()) {
      throw conflictError("Handle claim intent is already funded by a different transaction")
    }
  } else if (initialStatus === "refund_pending") {
    if (requiredString(initialIntent, "funding_tx_hash").toLowerCase() !== fundingTxRef.toLowerCase()) {
      throw conflictError("Handle claim intent is already funded by a different transaction")
    }
    fundingStatus = "refund_pending"
    refundReason = stringOrNull(rowValue(initialIntent, "refund_reason"))
  } else {
    throw conflictError("Handle claim intent is not authorized for funding")
  }

  // Custody is now durably bound. Only after that bind may shard state
  // classify the outcome. In particular, an expired/released payment
  // reservation must become a refund obligation, not an upstream rejection.
  if (fundingStatus === "funded_pending_finalization") {
    let shardBindingFailure: string | null = null
    const preflightDb = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
    try {
      const preflight = await preflightDb.client.execute({
        sql: `
          SELECT q.handle_claim_quote_id, q.price_cents
          FROM community_handle_claim_quotes q
          WHERE q.handle_claim_quote_id = ?1
            AND q.community_id = ?2 AND q.user_id = ?3
            AND q.handle_claim_intent_id = ?4
          LIMIT 1
        `,
        args: [input.quoteId, input.communityId, input.userId, intentId],
      })
      const row = preflight.rows[0]
      if (!row) {
        shardBindingFailure = "handle_claim_finalization_unavailable"
      } else if (numberOrNull(rowValue(row, "price_cents")) !== priceCents) {
        shardBindingFailure = "handle_claim_finalization_unavailable"
      }
    } finally {
      preflightDb.close()
    }
    if (shardBindingFailure) {
      await withStandaloneControlPlaneClient(input.env, async (client) => {
        await markFundedHandleClaimIntentRefundPending({
          client,
          intentId,
          now: nowIso(),
          reason: shardBindingFailure,
        })
      })
      fundingStatus = "refund_pending"
      refundReason = shardBindingFailure
    }
  }

  if (fundingStatus === "refund_pending") {
    throw conflictError("Payment was verified but cannot finalize this name. A refund is pending.", {
      claim_intent: intentId,
      funding_tx_ref: fundingTxRef,
      reason: refundReason,
    })
  }

  const fundedIntent = await withStandaloneControlPlaneClient(input.env, async (client) => {
    return await requireHandleClaimIntentBinding({
      actorUserId: input.userId,
      client,
      communityId: input.communityId,
      intentId,
    })
  })
  const finalization = decodeFundedHandleClaimFinalization(fundedIntent)
  const writeDb = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  let handleRow
  let finalizationError: unknown = null
  try {
    const now = nowIso()
    handleRow = await finalizeFundedHandleClaimOnShard({
      client: writeDb.client,
      finalization,
      now,
      reservationHoldUntil: new Date(
        Date.parse(now) + resolveFundedHandleReservationSeconds(input.env) * 1000,
      ).toISOString(),
    })
  } catch (error) {
    finalizationError = error
  } finally {
    writeDb.close()
  }

  if (finalizationError) {
    const refundReason = deterministicFinalizationRefundReason(finalizationError)
    if (refundReason) {
      await withStandaloneControlPlaneClient(input.env, async (client) => {
        await markFundedHandleClaimIntentRefundPending({
          client,
          intentId,
          now: nowIso(),
          reason: refundReason,
        })
      })
      throw conflictError("Payment was verified but cannot finalize this name. A refund is pending.", {
        claim_intent: intentId,
        funding_tx_ref: fundingTxRef,
        reason: refundReason,
      })
    }
    throw conflictError(
      "Payment was verified and this name is pending finalization. Retry the same claim and transaction.",
      { claim_intent: intentId, funding_tx_ref: fundingTxRef },
    )
  }

  if (!handleRow) {
    throw conflictError(
      "Payment was verified and this name is pending finalization. Retry the same claim and transaction.",
      { claim_intent: intentId, funding_tx_ref: fundingTxRef },
    )
  }

  await withStandaloneControlPlaneClient(input.env, async (client) => {
    await completeFundedHandleClaimIntent({ client, intentId, now: nowIso() })
  })
  return serializeHandle(handleRow)
}

function deterministicFinalizationRefundReason(error: unknown): string | null {
  if (error instanceof HttpError && !error.retryable && error.status >= 400 && error.status < 500) {
    return error.message.toLowerCase().includes("active shard reservation")
      ? "handle_label_reservation_expired"
      : "handle_claim_finalization_unavailable"
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes("unique constraint") || message.includes("constraint failed")) {
    return "handle_claim_finalization_unavailable"
  }
  return null
}
