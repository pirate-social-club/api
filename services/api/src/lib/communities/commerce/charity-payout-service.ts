import type { Client } from "../../sql-client"
import { badRequestError } from "../../errors"
import type { Env } from "../../../types"
import type { QuoteAllocationSnapshot } from "./row-types"
import { requiredString, stringOrNull } from "./row-types"
import { resolveSettlementAmountSnapshot } from "./quote-helpers"
import {
  beginPurchaseSettlementEffectAttempt,
  confirmPurchaseSettlementEffect,
  failPurchaseSettlementEffect,
} from "./settlement-effects"
import { executeEndaomentUsdcDonation } from "./endaoment-payout-service"

export type CharityPayoutExecutionInput = {
  env: Env
  idempotencyKey: string
  communityId: string
  quoteId: string
  donationPartnerId: string
  provider: "endaoment"
  providerPartnerRef: string | null
  payoutDestinationRef: string
  amountUsd: number
  amountAtomic: string
  settlementDecimals: number
  shareBps: number
  settlementToken: string
}

export type CharityPayoutExecutionResult = {
  settlementRef: string
  providerReceiptRef: string | null
  taxReceiptRef: string | null
}

export type ResolvedCharityPayout = CharityPayoutExecutionResult & {
  allocationKey: string
}

let testCharityPayoutExecutor:
  | ((input: CharityPayoutExecutionInput) => Promise<CharityPayoutExecutionResult>)
  | null = null

export function setCommunityCommerceCharityPayoutExecutorForTests(
  executor: ((input: CharityPayoutExecutionInput) => Promise<CharityPayoutExecutionResult>) | null,
): void {
  testCharityPayoutExecutor = executor
}

export function getAllocationExecutionKey(allocation: Pick<
  QuoteAllocationSnapshot,
  "recipient_type" | "recipient_ref" | "waterfall_position"
>): string {
  return `${allocation.recipient_type}:${allocation.recipient_ref ?? ""}:${allocation.waterfall_position}`
}

async function executeCharityPayout(input: CharityPayoutExecutionInput): Promise<CharityPayoutExecutionResult> {
  if (testCharityPayoutExecutor) {
    return await testCharityPayoutExecutor(input)
  }
  return await executeEndaomentUsdcDonation(input)
}

export async function executeCharityPayoutsForSettlement(input: {
  env: Env
  client: Client
  communityId: string
  quoteId: string
  purchaseId: string
  settlementToken: string
  allocations: QuoteAllocationSnapshot[]
  now: string
}): Promise<Map<string, ResolvedCharityPayout>> {
  const results = new Map<string, ResolvedCharityPayout>()
  const charityAllocations = input.allocations.filter((allocation) =>
    allocation.recipient_type === "charity"
    && allocation.settlement_strategy === "provider_payout"
    && allocation.amount_usd > 0
    && allocation.recipient_ref?.trim())

  for (const allocation of charityAllocations) {
    const partnerResult = await input.client.execute({
      sql: `
        SELECT donation_partner_id, provider, provider_partner_ref, payout_destination_ref,
               review_status, status
        FROM donation_partners
        WHERE donation_partner_id = ?1
        LIMIT 1
      `,
      args: [allocation.recipient_ref],
    })
    const partner = partnerResult.rows[0]
    if (!partner) {
      throw badRequestError("Donation partner is not configured")
    }
    const provider = requiredString(partner, "provider")
    if (provider !== "endaoment") {
      throw badRequestError("Donation partner provider is not supported")
    }
    if (requiredString(partner, "review_status") !== "approved" || requiredString(partner, "status") !== "active") {
      throw badRequestError("Donation partner is not available")
    }
    const payoutDestinationRef = stringOrNull(partner, "payout_destination_ref")?.trim()
    if (!payoutDestinationRef) {
      throw badRequestError("Donation partner payout destination is not configured")
    }

    const allocationKey = getAllocationExecutionKey(allocation)
    const idempotencyKey = `${input.quoteId}:${allocationKey}`
    const existingEffect = await beginPurchaseSettlementEffectAttempt({
      client: input.client,
      communityId: input.communityId,
      quoteId: input.quoteId,
      purchaseId: input.purchaseId,
      effectKind: "charity_payout",
      effectKey: allocationKey,
      idempotencyKey,
      now: input.now,
    })
    if (existingEffect.status === "confirmed") {
      const settlementRef = existingEffect.settlement_ref?.trim()
      if (!settlementRef) {
        throw badRequestError("Donation payout settlement reference is missing")
      }
      results.set(allocationKey, {
        allocationKey,
        settlementRef,
        providerReceiptRef: existingEffect.provider_receipt_ref,
        taxReceiptRef: existingEffect.tax_receipt_ref,
      })
      continue
    }

    const settlementAmount = resolveSettlementAmountSnapshot(allocation.amount_usd)
    let payout: CharityPayoutExecutionResult
    try {
      payout = await executeCharityPayout({
        env: input.env,
        idempotencyKey,
        communityId: input.communityId,
        quoteId: input.quoteId,
        donationPartnerId: requiredString(partner, "donation_partner_id"),
        provider: "endaoment",
        providerPartnerRef: stringOrNull(partner, "provider_partner_ref"),
        payoutDestinationRef,
        amountUsd: allocation.amount_usd,
        amountAtomic: settlementAmount.amountAtomic,
        settlementDecimals: settlementAmount.decimals,
        shareBps: allocation.share_bps,
        settlementToken: input.settlementToken,
      })
      if (!payout.settlementRef.trim()) {
        throw badRequestError("Donation payout did not return a settlement reference")
      }
    } catch (error) {
      await failPurchaseSettlementEffect({
        client: input.client,
        idempotencyKey,
        failureReason: error instanceof Error ? error.message : String(error),
        now: input.now,
      })
      throw error
    }
    await confirmPurchaseSettlementEffect({
      client: input.client,
      idempotencyKey,
      settlementRef: payout.settlementRef,
      providerReceiptRef: payout.providerReceiptRef,
      taxReceiptRef: payout.taxReceiptRef,
      now: input.now,
    })
    results.set(allocationKey, {
      allocationKey,
      settlementRef: payout.settlementRef,
      providerReceiptRef: payout.providerReceiptRef,
      taxReceiptRef: payout.taxReceiptRef,
    })
  }

  return results
}
