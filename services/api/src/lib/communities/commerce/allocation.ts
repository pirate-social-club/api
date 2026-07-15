import { badRequestError, eligibilityFailed } from "../../errors"
import type {
  PurchaseAllocationLeg,
  PurchaseAllocationLegRow,
  PurchaseSettlementMode,
  QuoteAllocationSnapshot,
} from "./row-types"
import { parseJsonValue } from "./row-types"

const TOTAL_SHARE_BPS = 10_000

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100
}

function usdToCents(value: number): number {
  return Math.round(value * 100)
}

export function resolveQuoteAllocationSnapshot(input: {
  finalPriceUsd: number
  listingPolicy: {
    donationPartnerId: string | null
    donationSharePct: number | null
  }
}): QuoteAllocationSnapshot[] {
  const charitySharePct = Number.isInteger(input.listingPolicy.donationSharePct)
    ? Math.max(0, Math.min(100, input.listingPolicy.donationSharePct ?? 0))
    : 0
  const charityShareBps = charitySharePct * 100
  const charityRecipientRef = input.listingPolicy.donationPartnerId?.trim() || null
  const charityAmountUsd = charityShareBps > 0 && charityRecipientRef
    ? roundUsd(input.finalPriceUsd * (charityShareBps / 10_000))
    : 0
  const creatorAmountUsd = roundUsd(input.finalPriceUsd - charityAmountUsd)

  const allocations: QuoteAllocationSnapshot[] = []
  if (charityAmountUsd > 0 && charityRecipientRef) {
    allocations.push({
      recipient_type: "charity",
      recipient_ref: charityRecipientRef,
      waterfall_position: 60,
      share_bps: charityShareBps,
      amount_usd: charityAmountUsd,
      settlement_strategy: "provider_payout",
    })
  }
  allocations.push({
    recipient_type: "creator",
    recipient_ref: null,
    waterfall_position: 70,
    share_bps: Math.max(0, TOTAL_SHARE_BPS - charityShareBps),
    amount_usd: creatorAmountUsd,
    settlement_strategy: "story_payout",
  })
  return allocations
}

export function parseQuoteAllocationSnapshot(value: string | null): QuoteAllocationSnapshot[] {
  return parseJsonValue<QuoteAllocationSnapshot[]>(value, [])
}

export function serializePurchaseAllocationLeg(row: PurchaseAllocationLegRow): PurchaseAllocationLeg {
  return {
    recipient_type: row.recipient_type,
    recipient_ref: row.recipient_ref,
    waterfall_position: row.waterfall_position,
    share_bps: row.share_bps,
    amount_cents: usdToCents(row.amount_usd),
    settlement_strategy: row.settlement_strategy,
    status: row.status,
    settlement_ref: row.settlement_ref,
    failure_reason: row.failure_reason,
  }
}

export function assertExecutableQuoteAllocationSnapshot(
  snapshot: QuoteAllocationSnapshot[],
): QuoteAllocationSnapshot[] {
  if (snapshot.length === 0) {
    throw badRequestError("Purchase quote allocation snapshot is missing")
  }

  let totalShareBps = 0
  let payableLegCount = 0

  for (const allocation of snapshot) {
    if (!Number.isInteger(allocation.waterfall_position)) {
      throw badRequestError("Purchase quote allocation snapshot is invalid")
    }
    if (!Number.isInteger(allocation.share_bps) || allocation.share_bps < 0) {
      throw badRequestError("Purchase quote allocation snapshot is invalid")
    }
    if (!Number.isFinite(allocation.amount_usd) || allocation.amount_usd < 0) {
      throw badRequestError("Purchase quote allocation snapshot is invalid")
    }
    if (allocation.recipient_type === "creator" || allocation.recipient_type === "performer") {
      payableLegCount += 1
    }
    totalShareBps += allocation.share_bps
  }

  if (payableLegCount < 1 || totalShareBps !== TOTAL_SHARE_BPS) {
    throw badRequestError("Purchase quote allocation snapshot is invalid")
  }

  return snapshot
}

/**
 * Fail closed when a quote would create a `story_payout` leg that settlement cannot actually pay.
 *
 * At finalization the asset path (settlement-service.ts) requires a confirmed `story_royalty_payment`
 * effect and adopts THAT on-chain transaction as the leg's settlement_ref — returning `pending`
 * until the payout has executed. The non-asset path has no such gate: under
 * `delivery_only_story_settlement` (live-room tickets and paid replays) a `story_payout` leg is
 * marked `confirmed` using the buyer's funding transaction, so the recipient (host/performer) is
 * never paid while the ledger records the leg as settled.
 *
 * Until non-asset payout execution exists, refuse to create such a quote rather than issue a
 * checkout that looks successful while funds stay in platform custody. Free targets ($0 legs) and
 * asset purchases (royalty-native mode) are unaffected.
 */
export function assertSettlementModeCanExecuteAllocations(
  snapshot: QuoteAllocationSnapshot[],
  settlementMode: PurchaseSettlementMode,
): QuoteAllocationSnapshot[] {
  if (settlementMode === "royalty_native_story_payment") {
    return snapshot
  }

  const unbackedStoryPayout = snapshot.some((allocation) => (
    allocation.settlement_strategy === "story_payout" && allocation.amount_usd > 0
  ))
  if (unbackedStoryPayout) {
    throw eligibilityFailed(
      "This paid purchase is unavailable because recipient payout is not configured",
    )
  }

  return snapshot
}

export function extractDonationCompatibilityFields(input: {
  allocationSnapshot: QuoteAllocationSnapshot[]
}): {
  donationPartnerId: string | null
  donationSharePct: number | null
  donationAmountUsd: number | null
} {
  const charityLeg = input.allocationSnapshot.find((allocation) => allocation.recipient_type === "charity") ?? null
  if (!charityLeg || !charityLeg.recipient_ref || charityLeg.amount_usd <= 0 || charityLeg.share_bps <= 0) {
    return {
      donationPartnerId: null,
      donationSharePct: null,
      donationAmountUsd: null,
    }
  }
  return {
    donationPartnerId: charityLeg.recipient_ref,
    donationSharePct: charityLeg.share_bps / 100,
    donationAmountUsd: charityLeg.amount_usd,
  }
}
