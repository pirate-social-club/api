import { describe, expect, test } from "bun:test"

import type { Client } from "../sql-client"
import { getRewardPoolRefundPolicyReadiness } from "./reward-pool-refund-readiness"

function clientReturningLargestRemainder(cents: number): Client {
  return {
    execute: async () => ({
      columns: ["largest_remainder_cents"],
      columnTypes: ["INTEGER"],
      rows: [{ largest_remainder_cents: cents }],
      rowsAffected: 0,
      lastInsertRowid: undefined,
      toJSON: () => ({}),
    }),
  } as unknown as Client
}

describe("reward pool refund policy readiness", () => {
  test("reports the exact largest lot remainder and blocks a lower proposal", async () => {
    const readiness = await getRewardPoolRefundPolicyReadiness({
      client: clientReturningLargestRemainder(12_345),
      proposedMaxRefundAtomic: 123_449_999n,
    })
    expect(readiness).toEqual({
      largest_outstanding_lot_remainder_cents: 12_345,
      largest_outstanding_lot_remainder_atomic: "123450000",
      proposed_max_refund_atomic: "123449999",
      proposal_safe: false,
    })
  })

  test("accepts an equal proposal and leaves an observation-only call undecided", async () => {
    const client = clientReturningLargestRemainder(25)
    expect((await getRewardPoolRefundPolicyReadiness({
      client,
      proposedMaxRefundAtomic: 250_000n,
    })).proposal_safe).toBe(true)
    expect((await getRewardPoolRefundPolicyReadiness({ client })).proposal_safe).toBeNull()
  })
})
