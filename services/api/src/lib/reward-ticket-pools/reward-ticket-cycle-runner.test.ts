import { describe, expect, test } from "bun:test"

import { hashRewardTicketCycleEvidence } from "./reward-ticket-cycle-runner"

describe("reward ticket cycle runner evidence", () => {
  test("hashes canonical evidence independent of object key order", () => {
    const first = hashRewardTicketCycleEvidence({
      cycleId: "cycle_a",
      sequenceNumber: 2,
      kind: "drawing_observed",
      evidence: { drawingId: "7", block: { hash: "0xabc", number: 12 } },
      observedAt: "2026-08-15T00:00:00.000Z",
    })
    const second = hashRewardTicketCycleEvidence({
      cycleId: "cycle_a",
      sequenceNumber: 2,
      kind: "drawing_observed",
      evidence: { block: { number: 12, hash: "0xabc" }, drawingId: "7" },
      observedAt: "2026-08-15T00:00:00.000Z",
    })
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toBe(first)
  })

  test("changes the hash when sequence or evidence changes", () => {
    const input = {
      cycleId: "cycle_a",
      sequenceNumber: 0,
      kind: "cycle_started" as const,
      evidence: { status: "planned" },
      observedAt: "2026-08-15T00:00:00.000Z",
    }
    const first = hashRewardTicketCycleEvidence(input)
    expect(hashRewardTicketCycleEvidence({ ...input, sequenceNumber: 1 })).not.toBe(first)
    expect(hashRewardTicketCycleEvidence({ ...input, evidence: { status: "recovery_required" } })).not.toBe(first)
  })
})
