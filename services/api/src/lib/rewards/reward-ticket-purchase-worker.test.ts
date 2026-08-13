import { describe, expect, test } from "bun:test"

import { executeRewardTicketPurchase } from "./reward-ticket-purchase-worker"

const config = {
  randomTicketBuyerAddress: "0x1000000000000000000000000000000000000001",
  custodyAddress: "0x2000000000000000000000000000000000000002",
  referrerAddress: "0x3000000000000000000000000000000000000003",
  sourceTag: "pirate-song-pools",
} as const
const txHash = `0x${"a".repeat(64)}`

describe("reward ticket purchase worker", () => {
  test("does not submit when Megapot has rolled over", async () => {
    let submitted = false
    const result = await executeRewardTicketPurchase({
      config,
      expectedDrawingId: "141",
      ticketCount: 1,
      dependencies: {
        readCurrentDrawingId: async () => "142",
        submitPurchase: async () => {
          submitted = true
          return { txHash }
        },
        readReceipt: async () => ({ status: 1, drawingId: "142" }),
      },
    })
    expect(submitted).toBe(false)
    expect(result).toMatchObject({ status: "needs_review", reason: "drawing_rolled_over" })
  })

  test("confirms only when the receipt is tied to the committed drawing", async () => {
    const result = await executeRewardTicketPurchase({
      config,
      expectedDrawingId: 141n,
      ticketCount: 1,
      dependencies: {
        readCurrentDrawingId: async () => "141",
        submitPurchase: async () => ({ txHash }),
        readReceipt: async () => ({ status: 1, drawingId: 141n }),
      },
    })
    expect(result).toMatchObject({ status: "confirmed", txHash, drawingId: "141" })
  })

  test("routes a successful transaction with another drawing to review", async () => {
    const result = await executeRewardTicketPurchase({
      config,
      expectedDrawingId: "141",
      ticketCount: 1,
      dependencies: {
        readCurrentDrawingId: async () => "141",
        submitPurchase: async () => ({ txHash }),
        readReceipt: async () => ({ status: 1, drawingId: "142" }),
      },
    })
    expect(result).toMatchObject({
      status: "needs_review",
      reason: "receipt_drawing_id_mismatch",
      txHash,
      drawingCheck: { reason: "receipt_drawing_id_mismatch" },
    })
  })

  test("keeps a broadcast with no receipt in review rather than releasing it", async () => {
    const result = await executeRewardTicketPurchase({
      config,
      expectedDrawingId: "141",
      ticketCount: 1,
      dependencies: {
        readCurrentDrawingId: async () => "141",
        submitPurchase: async () => ({ txHash }),
        readReceipt: async () => null,
      },
    })
    expect(result).toMatchObject({ status: "needs_review", reason: "receipt_unavailable", txHash })
  })
})
