import {
  evaluateRewardTicketDrawingAssociation,
  type RewardTicketDrawingAssociation,
} from "./reward-ticket-drawing-guard"

export type RewardTicketPriceQuote = {
  drawingId: string | bigint
  ticketPriceCents: string | bigint
  ticketPriceAtomic: string
  observedAtMs: number
  expiresAtMs: number
}

export type RewardTicketPurchaseAdmission =
  | {
      status: "admitted"
      drawingId: string
      quotedTicketPriceCents: string
      quotedTicketPriceAtomic: string
      reserveCents: string
    }
  | {
      status: "blocked"
      reason: "price_unavailable" | "price_above_ceiling" | "drawing_rolled_over" | "invalid_quote"
      drawingCheck?: RewardTicketDrawingAssociation
    }

function positiveInteger(value: string | bigint): bigint | null {
  try {
    const result = typeof value === "bigint" ? value : BigInt(value)
    return result > 0n ? result : null
  } catch {
    return null
  }
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Admission is deliberately separate from reservation and submission.
 *
 * The live quote answers only whether the campaign may buy for this drawing.
 * The reserved amount is always ticketCount times the accepted max-ticket
 * ceiling, never the quoted price; a later confirmation can release the
 * unused delta.
 */
export function evaluateRewardTicketPurchaseAdmission(input: {
  expectedDrawingId: string | bigint
  currentDrawingId: string | bigint
  quote: RewardTicketPriceQuote | null
  maxTicketCents: string | bigint
  ticketCount: number
  nowMs: number
}): RewardTicketPurchaseAdmission {
  const maxTicketCents = positiveInteger(input.maxTicketCents)
  if (
    maxTicketCents === null
    || !Number.isSafeInteger(input.ticketCount)
    || input.ticketCount <= 0
    || !validTimestamp(input.nowMs)
  ) {
    return { status: "blocked", reason: "invalid_quote" }
  }

  const drawingCheck = evaluateRewardTicketDrawingAssociation({
    expectedDrawingId: input.expectedDrawingId,
    observedDrawingId: input.currentDrawingId,
    stage: "before_submit",
  })
  if (drawingCheck.status === "needs_review") {
    return {
      status: "blocked",
      reason: "drawing_rolled_over",
      drawingCheck,
    }
  }

  const quote = input.quote
  if (
    quote === null
    || !validTimestamp(quote.observedAtMs)
    || !validTimestamp(quote.expiresAtMs)
    || quote.observedAtMs > input.nowMs
    || quote.expiresAtMs <= input.nowMs
  ) {
    return { status: "blocked", reason: "price_unavailable" }
  }

  const quoteDrawingCheck = evaluateRewardTicketDrawingAssociation({
    expectedDrawingId: input.expectedDrawingId,
    observedDrawingId: quote.drawingId,
    stage: "before_submit",
  })
  if (quoteDrawingCheck.status === "needs_review") {
    return {
      status: "blocked",
      reason: "drawing_rolled_over",
      drawingCheck: quoteDrawingCheck,
    }
  }

  const ticketPriceCents = positiveInteger(quote.ticketPriceCents)
  if (ticketPriceCents === null || !/^\d+$/u.test(quote.ticketPriceAtomic)) {
    return { status: "blocked", reason: "invalid_quote" }
  }
  const ticketPriceAtomic = BigInt(quote.ticketPriceAtomic)
  if (ticketPriceAtomic <= 0n) return { status: "blocked", reason: "invalid_quote" }
  if (ticketPriceCents > maxTicketCents) {
    return { status: "blocked", reason: "price_above_ceiling" }
  }

  return {
    status: "admitted",
    drawingId: drawingCheck.drawingId,
    quotedTicketPriceCents: ticketPriceCents.toString(),
    quotedTicketPriceAtomic: ticketPriceAtomic.toString(),
    reserveCents: (maxTicketCents * BigInt(input.ticketCount)).toString(),
  }
}
