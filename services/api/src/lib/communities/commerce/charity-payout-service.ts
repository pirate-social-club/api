import type { Client } from "../../sql-client"
import { badRequestError, HttpError } from "../../errors"
import type { Env } from "../../../env"
import type { QuoteAllocationSnapshot } from "./row-types"
import { requiredString, stringOrNull } from "./row-types"
import { resolveSettlementAmountSnapshot } from "./quote-helpers"
import {
  beginPurchaseSettlementEffectAttempt,
  confirmPurchaseSettlementEffect,
  failPurchaseSettlementEffect,
  recordSubmittedPurchaseSettlementEffectTx,
  type PurchaseSettlementEffectRow,
} from "./settlement-effects"
import { executeEndaomentUsdcDonation, reconcileEndaomentSubmittedDonation } from "./endaoment-payout-service"

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
  recordSubmittedTxHash?: (input: {
    txHash: string
    providerReceiptRef?: string | null
    metadata?: Record<string, unknown> | null
  }) => Promise<void>
}

export type CharityPayoutExecutionResult = {
  settlementRef: string
  providerReceiptRef: string | null
  taxReceiptRef: string | null
}

export type ResolvedCharityPayout = CharityPayoutExecutionResult & {
  allocationKey: string
}

type SubmittedCharityPayoutReconciliationOutcome = "confirmed" | "failed" | "pending"

const DEFAULT_SUBMITTED_STALE_ALERT_MS = 15 * 60 * 1000

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

function parseEffectMetadata(value: string | null): Record<string, unknown> {
  if (!value) {
    return {}
  }
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function emitCharityPayoutMetric(input: {
  metric:
    | "charity_payout_submitted"
    | "charity_payout_confirmed"
    | "charity_payout_failed"
    | "charity_payout_reused"
    | "charity_payout_submitted_stale"
  communityId: string
  quoteId: string
  purchaseId: string
  donationPartnerId: string
  allocationKey: string
  ageSeconds?: number
  reason?: string
}): void {
  const fields = {
    metric: input.metric,
    community_id: input.communityId,
    quote_id: input.quoteId,
    purchase_id: input.purchaseId,
    donation_partner_id: input.donationPartnerId,
    allocation_key: input.allocationKey,
    age_seconds: input.ageSeconds,
    reason: input.reason,
  }
  const payload = JSON.stringify(fields)
  if (input.metric === "charity_payout_failed" || input.metric === "charity_payout_submitted_stale") {
    console.warn(payload)
  } else {
    console.info(payload)
  }
}

function submittedStaleAlertMs(env: Env): number {
  const configured = Number(String(env.ENDAOMENT_SUBMITTED_STALE_ALERT_MS || "").trim())
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.trunc(configured)
  }
  return DEFAULT_SUBMITTED_STALE_ALERT_MS
}

function submittedAgeMs(effect: PurchaseSettlementEffectRow, now: string): number | null {
  const submittedAt = Date.parse(effect.submitted_at || effect.updated_at || effect.created_at)
  const nowMs = Date.parse(now)
  if (!Number.isFinite(submittedAt) || !Number.isFinite(nowMs)) {
    return null
  }
  return Math.max(0, nowMs - submittedAt)
}

function emitSubmittedStaleMetricIfNeeded(input: {
  env: Env
  effect: PurchaseSettlementEffectRow
  metadata: Record<string, unknown>
  now: string
  reason: string
}): void {
  const ageMs = submittedAgeMs(input.effect, input.now)
  if (ageMs == null || ageMs < submittedStaleAlertMs(input.env)) {
    return
  }
  emitCharityPayoutMetric({
    metric: "charity_payout_submitted_stale",
    communityId: input.effect.community_id,
    quoteId: input.effect.quote_id,
    purchaseId: input.effect.purchase_id,
    donationPartnerId: String(input.metadata.donation_partner_id ?? input.effect.effect_key.split(":")[1] ?? "unknown"),
    allocationKey: input.effect.effect_key,
    ageSeconds: Math.floor(ageMs / 1000),
    reason: input.reason,
  })
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

    const donationPartnerId = requiredString(partner, "donation_partner_id")
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
      emitCharityPayoutMetric({
        metric: "charity_payout_reused",
        communityId: input.communityId,
        quoteId: input.quoteId,
        purchaseId: input.purchaseId,
        donationPartnerId,
        allocationKey,
      })
      continue
    }
    emitCharityPayoutMetric({
      metric: "charity_payout_submitted",
      communityId: input.communityId,
      quoteId: input.quoteId,
      purchaseId: input.purchaseId,
      donationPartnerId,
      allocationKey,
    })

    const settlementAmount = resolveSettlementAmountSnapshot(allocation.amount_usd)
    let payout: CharityPayoutExecutionResult
    try {
      payout = await executeCharityPayout({
        env: input.env,
        idempotencyKey,
        communityId: input.communityId,
        quoteId: input.quoteId,
        donationPartnerId,
        provider: "endaoment",
        providerPartnerRef: stringOrNull(partner, "provider_partner_ref"),
        payoutDestinationRef,
        amountUsd: allocation.amount_usd,
        amountAtomic: settlementAmount.amountAtomic,
        settlementDecimals: settlementAmount.decimals,
        shareBps: allocation.share_bps,
        settlementToken: input.settlementToken,
        recordSubmittedTxHash: async (submitted) => {
          const metadata = {
            provider: "endaoment",
            donation_partner_id: donationPartnerId,
            allocation_key: allocationKey,
            ...(submitted.metadata ?? {}),
          }
          await recordSubmittedPurchaseSettlementEffectTx({
            client: input.client,
            idempotencyKey,
            settlementRef: submitted.txHash,
            providerReceiptRef: submitted.providerReceiptRef ?? null,
            metadataJson: JSON.stringify(metadata),
            now: input.now,
          })
        },
      })
      if (!payout.settlementRef.trim()) {
        throw badRequestError("Donation payout did not return a settlement reference")
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        throw error
      }
      await failPurchaseSettlementEffect({
        client: input.client,
        idempotencyKey,
        failureReason: error instanceof Error ? error.message : String(error),
        now: input.now,
      })
      emitCharityPayoutMetric({
        metric: "charity_payout_failed",
        communityId: input.communityId,
        quoteId: input.quoteId,
        purchaseId: input.purchaseId,
        donationPartnerId,
        allocationKey,
        reason: "executor_error",
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
    emitCharityPayoutMetric({
      metric: "charity_payout_confirmed",
      communityId: input.communityId,
      quoteId: input.quoteId,
      purchaseId: input.purchaseId,
      donationPartnerId,
      allocationKey,
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

export async function reconcileSubmittedCharityPayoutEffect(input: {
  env: Env
  client: Client
  effect: PurchaseSettlementEffectRow
  now: string
}): Promise<SubmittedCharityPayoutReconciliationOutcome> {
  if (input.effect.effect_kind !== "charity_payout" || input.effect.status !== "submitted") {
    return "pending"
  }
  const txHash = input.effect.settlement_ref?.trim()
  if (!txHash) {
    emitCharityPayoutMetric({
      metric: "charity_payout_failed",
      communityId: input.effect.community_id,
      quoteId: input.effect.quote_id,
      purchaseId: input.effect.purchase_id,
      donationPartnerId: input.effect.effect_key.split(":")[1] || "unknown",
      allocationKey: input.effect.effect_key,
      reason: "submitted_missing_tx_hash",
    })
    return "pending"
  }
  const metadata = parseEffectMetadata(input.effect.metadata_json)
  const provider = typeof metadata.provider === "string" ? metadata.provider : "endaoment"
  if (provider !== "endaoment") {
    return "pending"
  }
  const outcome = await reconcileEndaomentSubmittedDonation({
    env: input.env,
    txHash,
    metadata,
  })
  if (outcome.status === "pending") {
    emitSubmittedStaleMetricIfNeeded({
      env: input.env,
      effect: input.effect,
      metadata,
      now: input.now,
      reason: "receipt_pending",
    })
    return "pending"
  }
  if (outcome.status === "failed") {
    await failPurchaseSettlementEffect({
      client: input.client,
      idempotencyKey: input.effect.idempotency_key,
      failureReason: outcome.reason,
      now: input.now,
    })
    emitCharityPayoutMetric({
      metric: "charity_payout_failed",
      communityId: input.effect.community_id,
      quoteId: input.effect.quote_id,
      purchaseId: input.effect.purchase_id,
      donationPartnerId: String(metadata.donation_partner_id ?? input.effect.effect_key.split(":")[1] ?? "unknown"),
      allocationKey: input.effect.effect_key,
      reason: "submitted_tx_failed",
    })
    return "failed"
  }
  await confirmPurchaseSettlementEffect({
    client: input.client,
    idempotencyKey: input.effect.idempotency_key,
    settlementRef: outcome.settlementRef,
    providerReceiptRef: outcome.providerReceiptRef,
    taxReceiptRef: null,
    metadataJson: input.effect.metadata_json,
    now: input.now,
  })
  emitCharityPayoutMetric({
    metric: "charity_payout_confirmed",
    communityId: input.effect.community_id,
    quoteId: input.effect.quote_id,
    purchaseId: input.effect.purchase_id,
    donationPartnerId: String(metadata.donation_partner_id ?? input.effect.effect_key.split(":")[1] ?? "unknown"),
    allocationKey: input.effect.effect_key,
  })
  return "confirmed"
}
