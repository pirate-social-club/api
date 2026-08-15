import { Interface, encodeBytes32String } from "ethers"

import { REWARD_TICKET_PURCHASE_ESCROW_ABI } from "./megapot-abi"
import type { MegapotRuntimeConfig } from "./megapot-config"
import { assertMegapotReferralScheme, type MegapotReferralScheme } from "./megapot-referrals"
import { normalizeMegapotOperationId } from "./megapot-operation-id"

const PURCHASE_ESCROW = new Interface(REWARD_TICKET_PURCHASE_ESCROW_ABI)

export function rewardTicketPurchaseReservationCents(input: {
  ticketCount: number
  maxTicketCents: bigint
}): bigint {
  if (!Number.isSafeInteger(input.ticketCount) || input.ticketCount < 1 || input.ticketCount > 10) {
    throw new Error("reward_ticket_purchase_count_invalid")
  }
  if (input.maxTicketCents <= 0n) throw new Error("reward_ticket_max_ticket_cents_invalid")
  return BigInt(input.ticketCount) * input.maxTicketCents
}

export function buildMegapotPurchaseCall(input: Readonly<{
  config: MegapotRuntimeConfig
  operationId: string
  ticketCount: number
  intendedDrawingId: bigint
  expectedTicketPriceAtomic: bigint
  referralScheme: MegapotReferralScheme
  source: string
}>): Readonly<{ to: string; data: string; value: 0n }> {
  rewardTicketPurchaseReservationCents({
    ticketCount: input.ticketCount,
    maxTicketCents: 1n,
  })
  assertMegapotReferralScheme(input.referralScheme)
  const operationId = normalizeMegapotOperationId(input.operationId)
  if (
    input.referralScheme.referrers.length !== 1
    || input.referralScheme.referrers[0]?.toLowerCase() !== input.config.platformRevenueAddress.toLowerCase()
    || input.referralScheme.referralSplitWeights[0] !== 10n ** 18n
  ) {
    throw new Error("reward_ticket_purchase_referral_policy_invalid")
  }
  if (input.intendedDrawingId < 0n || input.expectedTicketPriceAtomic <= 0n) {
    throw new Error("reward_ticket_purchase_terms_invalid")
  }
  if (new TextEncoder().encode(input.source).length > 31) {
    throw new Error("reward_ticket_purchase_source_too_long")
  }
  return {
    to: input.config.purchaseEscrowAddress,
    data: PURCHASE_ESCROW.encodeFunctionData("purchase", [
      operationId,
      input.ticketCount,
      input.intendedDrawingId,
      input.expectedTicketPriceAtomic,
      encodeBytes32String(input.source),
    ]),
    value: 0n,
  }
}
