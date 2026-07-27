import { describe, expect, test } from "bun:test"
import { Interface } from "ethers"

import { matchRewardVaultEvent } from "./operator-chain-real"

const VAULT = "0x1000000000000000000000000000000000000001"
const OTHER_VAULT = "0x1000000000000000000000000000000000000002"
const RECIPIENT = "0x2000000000000000000000000000000000000002"
const OTHER_RECIPIENT = "0x2000000000000000000000000000000000000003"
const OPERATION_ID = `0x${"11".repeat(32)}`
const OTHER_OPERATION_ID = `0x${"22".repeat(32)}`
const EVENTS = new Interface([
  "event RewardPaid(bytes32 indexed operationId,address indexed recipient,uint256 amount,uint64 indexed policyVersion,uint256 epoch)",
  "event RewardRefunded(bytes32 indexed operationId,address indexed recipient,uint256 amount,uint64 indexed policyVersion,uint256 epoch)",
])

function event(
  name: "RewardPaid" | "RewardRefunded",
  overrides: {
    address?: string
    operationId?: string
    recipient?: string
    amount?: bigint
  } = {},
) {
  const encoded = EVENTS.encodeEventLog(EVENTS.getEvent(name)!, [
    overrides.operationId ?? OPERATION_ID,
    overrides.recipient ?? RECIPIENT,
    overrides.amount ?? 1_000_000n,
    7,
    42,
  ])
  return {
    address: overrides.address ?? VAULT,
    topics: encoded.topics,
    data: encoded.data,
  }
}

function observe(
  logs: ReturnType<typeof event>[],
  overrides: Partial<Parameters<typeof matchRewardVaultEvent>[0]> = {},
) {
  return matchRewardVaultEvent({
    logs,
    vaultAddress: VAULT,
    effectKind: "reward_cashout",
    operationId: OPERATION_ID,
    recipient: RECIPIENT,
    amount: 1_000_000n,
    ...overrides,
  })
}

describe("reward vault event matching", () => {
  test("joins the exact vault event to the durable operation tuple", () => {
    expect(observe([event("RewardPaid")])).toEqual({ status: "matched" })
  })

  test("excludes unrelated vaults and operation IDs from the join", () => {
    expect(observe([event("RewardPaid", { address: OTHER_VAULT })]).status).toBe("missing")
    expect(observe([event("RewardPaid", { operationId: OTHER_OPERATION_ID })]).status).toBe("missing")
  })

  test("fails closed on event kind, recipient, or amount mismatches", () => {
    expect(observe([event("RewardRefunded")])).toEqual({
      status: "mismatch",
      reason: "event kind does not match the durable effect",
    })
    expect(observe([event("RewardPaid", { recipient: OTHER_RECIPIENT })]).status).toBe("mismatch")
    expect(observe([event("RewardPaid", { amount: 2_000_000n })]).status).toBe("mismatch")
  })

  test("matches refunds only against RewardRefunded", () => {
    expect(observe([event("RewardRefunded")], {
      effectKind: "reward_funding_refund",
    })).toEqual({ status: "matched" })
  })
})

const DEFERRAL_EVENTS = new Interface([
  "event OperationCapacityDeferred(bytes32 indexed operationId,uint8 indexed kind,uint256 indexed epoch)",
])

function deferral(kind: number, epoch: bigint, operationId = OPERATION_ID) {
  const encoded = DEFERRAL_EVENTS.encodeEventLog(
    DEFERRAL_EVENTS.getEvent("OperationCapacityDeferred")!,
    [operationId, kind, epoch],
  )
  return { address: VAULT, topics: encoded.topics, data: encoded.data }
}

describe("capacity deferral observation", () => {
  test("observes a payout deferral and reports the exhausted epoch", () => {
    const result = observe([deferral(0, 4242n)])
    expect(result.status).toBe("capacity_deferred")
    expect(result.status === "capacity_deferred" && result.deferredEpoch).toBe(4242n)
  })

  test("observes a refund deferral", () => {
    const result = observe([deferral(1, 7n)], { effectKind: "reward_funding_refund" })
    expect(result.status).toBe("capacity_deferred")
  })

  test("treats a deferral of the other kind as a mismatch", () => {
    // A refund deferral is not evidence about a payout effect.
    expect(observe([deferral(1, 7n)]).status).toBe("mismatch")
  })

  test("refuses a receipt carrying both a settlement and a deferral", () => {
    const result = observe([event("RewardPaid"), deferral(0, 1n)])
    expect(result.status).toBe("mismatch")
    expect(result.status === "mismatch" && result.reason).toContain(
      "both a settlement and a deferral",
    )
  })

  test("ignores a deferral for a different operation id", () => {
    expect(observe([deferral(0, 1n, OTHER_OPERATION_ID)]).status).toBe("missing")
  })

  test("still reports missing when the vault emitted nothing", () => {
    expect(observe([]).status).toBe("missing")
  })
})

describe("exactly one recognized outcome, independent of log order", () => {
  test.each([
    ["settlement before deferral", () => [event("RewardPaid"), deferral(0, 1n)]],
    ["deferral before settlement", () => [deferral(0, 1n), event("RewardPaid")]],
  ])("%s is a mismatch", (_label, build) => {
    const result = observe(build())
    expect(result.status).toBe("mismatch")
    expect(result.status === "mismatch" && result.reason).toContain(
      "both a settlement and a deferral",
    )
  })

  test.each([
    ["opposite settlement before deferral", () => [event("RewardRefunded"), deferral(0, 1n)]],
    ["deferral before opposite settlement", () => [deferral(0, 1n), event("RewardRefunded")]],
  ])("%s is a mismatch, never a deferral", (_label, build) => {
    // The deferral branch must not win over an opposite settlement event.
    const result = observe(build())
    expect(result.status).toBe("mismatch")
    expect(result.status === "mismatch" && result.reason).toContain("event kind does not match")
  })

  test("duplicate settlements with differing payloads are a mismatch", () => {
    // Latching would let the LAST event decide whether the tuple matched.
    const result = observe([event("RewardPaid"), event("RewardPaid", { amount: 999n })])
    expect(result.status).toBe("mismatch")
    expect(result.status === "mismatch" && result.reason).toContain("duplicate settlement")
  })

  test("duplicate settlements are a mismatch even when both are valid", () => {
    const result = observe([event("RewardPaid"), event("RewardPaid")])
    expect(result.status).toBe("mismatch")
  })

  test("duplicate deferrals carrying different epochs are a mismatch", () => {
    const result = observe([deferral(0, 1n), deferral(0, 2n)])
    expect(result.status).toBe("mismatch")
    expect(result.status === "mismatch" && result.reason).toContain("duplicate deferral")
  })

  test("a bad-payload settlement plus a deferral is a mismatch, not a deferral", () => {
    const result = observe([event("RewardPaid", { amount: 999n }), deferral(0, 1n)])
    expect(result.status).toBe("mismatch")
  })
})
