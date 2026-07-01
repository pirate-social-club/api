import { describe, expect, mock, test } from "bun:test"
import { enforceGateAndEnrollParticipant } from "./comment-service"

// (C) — verify-then-persist sequencing, unit-tested with a throwing/resolving
// enforceGate mock. No shard, no ALTCHA: we assert the ordering/side-effects
// around proof verification, not ALTCHA correctness. Covers the data-hygiene
// invariant (no phantom participant row on a failed verify) that the staging
// smoke's spam-prevention invariant (d) does NOT catch.

describe("enforceGateAndEnrollParticipant", () => {
  test("failed verify (thrown) → participant is NEVER enrolled (no phantom row)", async () => {
    const enrollParticipant = mock(async () => {})
    const enforceGate = mock(async () => { throw new Error("gate_failed") })

    await expect(enforceGateAndEnrollParticipant({
      provisionalParticipant: true,
      enforceGate,
      enrollParticipant,
    })).rejects.toThrow("gate_failed")

    expect(enforceGate).toHaveBeenCalledTimes(1)
    expect(enrollParticipant).not.toHaveBeenCalled()
  })

  test("verify passes + provisional → enrolls exactly once as 'comment_pow', AFTER verify", async () => {
    const order: string[] = []
    const enforceGate = mock(async () => { order.push("verify") })
    const enrollParticipant = mock(async (_source: "join" | "comment_pow") => { order.push("enroll") })

    await enforceGateAndEnrollParticipant({
      provisionalParticipant: true,
      enforceGate,
      enrollParticipant,
    })

    expect(enrollParticipant).toHaveBeenCalledTimes(1)
    expect(enrollParticipant).toHaveBeenCalledWith("comment_pow")
    expect(order).toEqual(["verify", "enroll"]) // persist strictly after verify
  })

  test("verify passes + NOT provisional (real member) → no enrollment", async () => {
    const enrollParticipant = mock(async () => {})
    const enforceGate = mock(async () => {})

    await enforceGateAndEnrollParticipant({
      provisionalParticipant: false,
      enforceGate,
      enrollParticipant,
    })

    expect(enforceGate).toHaveBeenCalledTimes(1)
    expect(enrollParticipant).not.toHaveBeenCalled()
  })
})
