import { describe, expect, test } from "bun:test"

import { isStorySettlementNonceRepairDrillTarget } from "./story-settlement-nonce-repair-drill"

describe("Story settlement nonce-repair drill target", () => {
  test("requires staging and an exact community plus quote match", () => {
    const request = { communityId: "community_drill", quoteId: "quote_drill" }
    expect(isStorySettlementNonceRepairDrillTarget({
      ENVIRONMENT: "staging",
      STORY_SETTLEMENT_NONCE_REPAIR_DRILL_TARGET: "community_drill:quote_drill",
    }, request)).toBe(true)
    expect(isStorySettlementNonceRepairDrillTarget({
      ENVIRONMENT: "staging",
      STORY_SETTLEMENT_NONCE_REPAIR_DRILL_TARGET: "community_drill:other_quote",
    }, request)).toBe(false)
  })

  test("is structurally disabled outside staging", () => {
    const target = "community_drill:quote_drill"
    const request = { communityId: "community_drill", quoteId: "quote_drill" }
    expect(isStorySettlementNonceRepairDrillTarget({
      ENVIRONMENT: "production",
      STORY_SETTLEMENT_NONCE_REPAIR_DRILL_TARGET: target,
    }, request)).toBe(false)
    expect(isStorySettlementNonceRepairDrillTarget({
      ENVIRONMENT: "development",
      STORY_SETTLEMENT_NONCE_REPAIR_DRILL_TARGET: target,
    }, request)).toBe(false)
  })
})
