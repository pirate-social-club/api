import { badRequestError } from "../../errors"
import type {
  PurchaseAllocationLeg,
  PurchaseAllocationLegRow,
  QuoteAllocationSnapshot,
} from "./row-types"
import { parseJsonValue } from "./row-types"

const TOTAL_SHARE_BPS = 10_000

export function resolveQuoteAllocationSnapshot(input: {
  finalPriceCents: number
  listingPolicy: {
    donationPartnerId: string | null
    donationShareBps: number | null
  }
}): QuoteAllocationSnapshot[] {
  const charityShareBps = Number.isInteger(input.listingPolicy.donationShareBps)
    ? Math.max(0, Math.min(TOTAL_SHARE_BPS, input.listingPolicy.donationShareBps ?? 0))
    : 0
  const charityRecipientRef = input.listingPolicy.donationPartnerId?.trim() || null
  const charityAmountCents = charityShareBps > 0 && charityRecipientRef
    ? Math.round(input.finalPriceCents * (charityShareBps / TOTAL_SHARE_BPS))
    : 0
  const creatorAmountCents = input.finalPriceCents - charityAmountCents

  const allocations: QuoteAllocationSnapshot[] = []
  if (charityAmountCents > 0 && charityRecipientRef) {
    allocations.push({
      recipient_type: "charity",
      recipient_ref: charityRecipientRef,
      waterfall_position: 60,
      share_bps: charityShareBps,
      amount_cents: charityAmountCents,
      settlement_strategy: "provider_payout",
    })
  }
  allocations.push({
    recipient_type: "creator",
    recipient_ref: null,
    waterfall_position: 70,
    share_bps: Math.max(0, TOTAL_SHARE_BPS - charityShareBps),
    amount_cents: creatorAmountCents,
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
    amount_cents: row.amount_cents,
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
    if (!Number.isInteger(allocation.amount_cents) || allocation.amount_cents < 0) {
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

export function extractDonationFields(input: {
  allocationSnapshot: QuoteAllocationSnapshot[]
}): {
  donationPartnerId: string | null
  donationShareBps: number | null
  donationAmountCents: number | null
} {
  const charityLeg = input.allocationSnapshot.find((allocation) => allocation.recipient_type === "charity") ?? null
  if (!charityLeg || !charityLeg.recipient_ref || charityLeg.amount_cents <= 0 || charityLeg.share_bps <= 0) {
    return {
      donationPartnerId: null,
      donationShareBps: null,
      donationAmountCents: null,
    }
  }
  return {
    donationPartnerId: charityLeg.recipient_ref,
    donationShareBps: charityLeg.share_bps,
    donationAmountCents: charityLeg.amount_cents,
  }
}
