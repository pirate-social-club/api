import { describe, expect, test } from "bun:test"

import { evaluateRewardTicketPurchaseAdmission } from "./reward-ticket-purchase-admission"

const freshQuote = {
  drawingId: "141",
  ticketPriceCents: "100",
  ticketPriceAtomic: "1000000",
  observedAtMs: 1_000,
  expiresAtMs: 10_000,
} as const

describe("reward ticket purchase admission", () => {
  test("admits with a fresh quote but reserves the ceiling, not the quote", () => {
    expect(evaluateRewardTicketPurchaseAdmission({
      expectedDrawingId: "141",
      currentDrawingId: "141",
      quote: freshQuote,
      maxTicketCents: "250",
      nowMs: 5_000,
    })).toEqual({
      status: "admitted",
      drawingId: "141",
      quotedTicketPriceCents: "100",
      quotedTicketPriceAtomic: "1000000",
      reserveCents: "250",
    })
  })

  test("blocks an expired or absent quote without creating a reservation", () => {
    for (const quote of [null, { ...freshQuote, expiresAtMs: 5_000 }]) {
      expect(evaluateRewardTicketPurchaseAdmission({
        expectedDrawingId: "141",
        currentDrawingId: "141",
        quote,
        maxTicketCents: "250",
        nowMs: 5_000,
      })).toEqual({ status: "blocked", reason: "price_unavailable" })
    }
  })

  test("blocks a live price above the funder's ceiling", () => {
    expect(evaluateRewardTicketPurchaseAdmission({
      expectedDrawingId: "141",
      currentDrawingId: "141",
      quote: { ...freshQuote, ticketPriceCents: "251" },
      maxTicketCents: "250",
      nowMs: 5_000,
    })).toEqual({ status: "blocked", reason: "price_above_ceiling" })
  })

  test("blocks a drawing rollover before submission", () => {
    const result = evaluateRewardTicketPurchaseAdmission({
      expectedDrawingId: "141",
      currentDrawingId: "142",
      quote: freshQuote,
      maxTicketCents: "250",
      nowMs: 5_000,
    })
    expect(result.status).toBe("blocked")
    expect(result).toMatchObject({
      status: "blocked",
      reason: "drawing_rolled_over",
      drawingCheck: { status: "needs_review", reason: "drawing_rolled_over" },
    })
  })

  test("does not admit a quote captured for another drawing", () => {
    expect(evaluateRewardTicketPurchaseAdmission({
      expectedDrawingId: "141",
      currentDrawingId: "141",
      quote: { ...freshQuote, drawingId: "140" },
      maxTicketCents: "250",
      nowMs: 5_000,
    })).toMatchObject({
      status: "blocked",
      reason: "drawing_rolled_over",
      drawingCheck: { status: "needs_review", reason: "drawing_rolled_over" },
    })
  })
})
