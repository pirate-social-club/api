import type { CommunityHandle, CommunityHandleClaimRequest, Env } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { badRequestError, conflictError, eligibilityFailed } from "../../errors"
import { nowIso } from "../../helpers"
import { withStandaloneControlPlaneClient } from "../../runtime-deps"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { verifyPirateCheckoutUsdcFunding } from "../commerce/funding-proof-service"
import { openCommunityWriteClient } from "../community-read-access"
import { serializeHandle } from "./handle-row-store"
import {
  resolveFundedHandleReservationSeconds,
  resolveHandleClaimPaymentClockSkewSeconds,
} from "./handle-claim-intent-config"
import {
  completeFundedHandleClaimIntent,
  fundAuthorizedHandleClaimIntent,
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

  const preflightDb = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const preflight = await preflightDb.client.execute({
      sql: `
        SELECT q.handle_claim_quote_id, q.price_cents, q.status,
          r.handle_label_reservation_id
        FROM community_handle_claim_quotes q
        LEFT JOIN community_handle_label_reservations r
          ON r.handle_claim_intent_id = q.handle_claim_intent_id
          AND r.purpose = 'payment' AND r.status = 'active'
        WHERE q.handle_claim_quote_id = ?1
          AND q.community_id = ?2 AND q.user_id = ?3
          AND q.handle_claim_intent_id = ?4
        LIMIT 1
      `,
      args: [input.quoteId, input.communityId, input.userId, intentId],
    })
    const row = preflight.rows[0]
    if (!row) throw conflictError("Funded handle claim quote is not bound on its community shard")
    if (numberOrNull(rowValue(row, "price_cents")) !== priceCents) {
      throw conflictError("Funded handle claim price snapshot does not match its quote")
    }
    const status = requiredString(initialIntent, "status")
    if (status === "authorized" && !stringOrNull(rowValue(row, "handle_label_reservation_id"))) {
      throw conflictError("Funded handle claim has no active label reservation")
    }
  } finally {
    preflightDb.close()
  }

  const initialStatus = requiredString(initialIntent, "status")
  let fundingStatus: "funded_pending_finalization" | "refund_pending" = "funded_pending_finalization"
  let refundReason: string | null = null
  if (initialStatus === "authorized") {
    const receipt = await verifyPirateCheckoutUsdcFunding({
      env: input.env,
      quoteId: input.quoteId,
      amountCents: priceCents,
      buyerAddress: wallet.wallet_address,
      fundingTxRef,
      fundingDestinationAddress: requiredString(initialIntent, "funding_destination_address"),
      sourceChainJson: JSON.stringify({
        chain_namespace: "eip155",
        chain_id: numberOrNull(rowValue(initialIntent, "chain_id")),
        display_name: "Intent snapshot",
      }),
      tokenAddress: requiredString(initialIntent, "token_address"),
    })
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
    throw conflictError(
      "Payment was verified and this name is pending finalization. Retry the same claim and transaction.",
      { claim_intent: intentId, funding_tx_ref: fundingTxRef },
    )
  } finally {
    writeDb.close()
  }

  await withStandaloneControlPlaneClient(input.env, async (client) => {
    await completeFundedHandleClaimIntent({ client, intentId, now: nowIso() })
  })
  return serializeHandle(handleRow)
}
