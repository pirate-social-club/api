import { describe, expect, test } from "bun:test"

import { buildRewardTicketMegapotPurchasePlan } from "./reward-ticket-megapot-purchase"

const config = {
  randomTicketBuyerAddress: "0x1000000000000000000000000000000000000001",
  custodyAddress: "0x2000000000000000000000000000000000000002",
  referrerAddress: "0x3000000000000000000000000000000000000003",
  sourceTag: "pirate-song-pools",
} as const

describe("Megapot random purchase plan", () => {
  test("builds a custody-recipient call with a full referral split", () => {
    const plan = buildRewardTicketMegapotPurchasePlan({
      config,
      ticketCount: 2,
      expectedDrawingId: 141n,
    })
    expect(plan.contractAddress).toBe(config.randomTicketBuyerAddress)
    expect(plan.recipientAddress).toBe(config.custodyAddress)
    expect(plan.expectedDrawingId).toBe("141")
    expect(plan.args[0]).toBe(2n)
    expect(plan.args[1]).toBe(config.custodyAddress)
    expect(plan.args[2]).toEqual([config.referrerAddress])
    expect(plan.args[3]).toEqual([1_000_000_000_000_000_000n])
    expect(plan.args[4]).toBe("0x7069726174652d736f6e672d706f6f6c73000000000000000000000000000000")
  })

  test("rejects counts above Megapot's immediate-call limit", () => {
    expect(() => buildRewardTicketMegapotPurchasePlan({ config, ticketCount: 11, expectedDrawingId: "141" }))
      .toThrow("between 1 and 10")
  })
})
