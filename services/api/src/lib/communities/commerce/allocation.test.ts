import { describe, expect, test } from "bun:test"

import {
  assertSettlementModeCanExecuteAllocations,
} from "./allocation"
import type { QuoteAllocationSnapshot } from "./row-types"

function performerLeg(overrides: Partial<QuoteAllocationSnapshot> = {}): QuoteAllocationSnapshot {
  return {
    recipient_type: "performer",
    recipient_ref: "usr_performer",
    waterfall_position: 70,
    share_bps: 10_000,
    amount_usd: 10,
    settlement_strategy: "story_payout",
    ...overrides,
  } as QuoteAllocationSnapshot
}

describe("assertSettlementModeCanExecuteAllocations", () => {
  test("rejects a payable story_payout leg under delivery-only settlement", () => {
    // Live-room tickets and paid replays run in delivery-only mode, which never executes a payout;
    // settlement would still mark this leg confirmed from the buyer funding tx. Fail closed.
    expect(() => assertSettlementModeCanExecuteAllocations(
      [performerLeg()],
      "delivery_only_story_settlement",
    )).toThrow(/not available yet/)
  })

  test("allows story_payout legs under royalty-native settlement", () => {
    // Asset purchases execute the on-chain Story vault distribution, so the buyer tx is a valid
    // settlement reference here.
    const snapshot = [performerLeg({ recipient_type: "creator", recipient_ref: "usr_creator" })]
    expect(assertSettlementModeCanExecuteAllocations(snapshot, "royalty_native_story_payment"))
      .toBe(snapshot)
  })

  test("allows a free ($0) delivery-only quote", () => {
    // A $0 story_payout leg pays out nothing, so recording it confirmed is harmless — free
    // live rooms and free replays must keep working.
    const snapshot = [performerLeg({ amount_usd: 0 })]
    expect(assertSettlementModeCanExecuteAllocations(snapshot, "delivery_only_story_settlement"))
      .toBe(snapshot)
  })

  test("allows delivery-only quotes with no story_payout legs", () => {
    const snapshot = [performerLeg({ settlement_strategy: "provider_payout" })]
    expect(assertSettlementModeCanExecuteAllocations(snapshot, "delivery_only_story_settlement"))
      .toBe(snapshot)
  })

  test("rejects when only one of several legs is an unbacked story_payout", () => {
    const snapshot = [
      performerLeg({ settlement_strategy: "provider_payout", share_bps: 5_000, amount_usd: 5 }),
      performerLeg({ share_bps: 5_000, amount_usd: 5 }),
    ]
    expect(() => assertSettlementModeCanExecuteAllocations(snapshot, "delivery_only_story_settlement"))
      .toThrow(/not available yet/)
  })
})
