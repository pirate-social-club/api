import type { CommunityHandleClaimRequest, Env } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { badRequestError, eligibilityFailed } from "../../errors"
import { nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import {
  claimVerifiedBuyerFundingReceipt,
  verifyPirateCheckoutUsdcFunding,
} from "../commerce/funding-proof-service"

export async function verifyPaymentForPaidHandleClaim(input: {
  env: Env
  body: CommunityHandleClaimRequest
  communityId: string
  quoteId: string
  priceCents: number
  userWalletAttachments: Awaited<ReturnType<UserRepository["getWalletAttachmentsByUserId"]>>
}): Promise<void> {
  if (input.priceCents <= 0) {
    return
  }
  const walletAttachment = input.body.settlement_wallet_attachment?.trim()
  if (!walletAttachment) {
    throw badRequestError("settlement_wallet_attachment is required for paid handle claims")
  }
  const wallet = input.userWalletAttachments.find((attachment) => attachment.wallet_attachment === walletAttachment)
  if (!wallet) {
    throw eligibilityFailed("settlement_wallet_attachment is not available for this user")
  }
  if (!wallet.chain_namespace.startsWith("eip155:")) {
    throw eligibilityFailed("settlement_wallet_attachment must be an EVM wallet")
  }
  if (!input.body.funding_tx_ref?.trim()) {
    throw badRequestError("funding_tx_ref is required for paid handle claims")
  }
  const fundingReceipt = await verifyPirateCheckoutUsdcFunding({
    env: input.env,
    quoteId: input.quoteId,
    amountUsd: input.priceCents / 100,
    buyerAddress: wallet.wallet_address,
    fundingTxRef: input.body.funding_tx_ref,
  })
  await claimVerifiedBuyerFundingReceipt({
    client: getControlPlaneClient(input.env),
    receipt: fundingReceipt,
    fallbackSenderAddress: wallet.wallet_address,
    consumerRail: "community_handle",
    consumerId: `${input.communityId}:${input.quoteId}`,
    quoteId: input.quoteId,
    now: nowIso(),
  })
}
