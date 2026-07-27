import { describe, expect, it } from "bun:test"
import { id } from "ethers"

import {
  VAULT_EVENT_SIGNATURES,
  VAULT_EVENT_TOPICS,
  VAULT_OPERATION_KIND,
  classifyRewardVaultSettlement,
  nextEpochRetryAtSeconds,
  type RewardVaultReceiptLog,
} from "./reward-vault-settlement-outcome"

const VAULT = "0x000000000000000000000000000000000000bEEF"
const OTHER_CONTRACT = "0x000000000000000000000000000000000000cafe"
const OPERATION_ID = `0x${"11".repeat(32)}`
const OTHER_OPERATION_ID = `0x${"22".repeat(32)}`
const TX = `0x${"ab".repeat(32)}`
const OTHER_TX = `0x${"cd".repeat(32)}`

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`

const deferralLog = (overrides: Partial<RewardVaultReceiptLog> = {}, kind = 0n, epoch = 42n) => ({
  address: VAULT,
  transactionHash: TX,
  topics: [VAULT_EVENT_TOPICS.operationCapacityDeferred, OPERATION_ID, word(kind), word(epoch)],
  ...overrides,
})

const paidLog = (overrides: Partial<RewardVaultReceiptLog> = {}) => ({
  address: VAULT,
  transactionHash: TX,
  topics: [VAULT_EVENT_TOPICS.rewardPaid, OPERATION_ID, VAULT, word(1n)],
  ...overrides,
})

const refundedLog = (overrides: Partial<RewardVaultReceiptLog> = {}) => ({
  address: VAULT,
  transactionHash: TX,
  topics: [VAULT_EVENT_TOPICS.rewardRefunded, OPERATION_ID, VAULT, word(1n)],
  ...overrides,
})

const classify = (
  logs: RewardVaultReceiptLog[],
  overrides: Partial<Parameters<typeof classifyRewardVaultSettlement>[0]> = {},
) =>
  classifyRewardVaultSettlement({
    receiptStatus: 1,
    receiptTransactionHash: TX,
    logs,
    pinnedVaultAddress: VAULT,
    operationId: OPERATION_ID,
    expectedKind: "payout",
    ...overrides,
  })

describe("event topics are derived, never transcribed", () => {
  it.each(Object.entries(VAULT_EVENT_SIGNATURES))(
    "%s matches keccak of its Solidity signature",
    (name, signature) => {
      expect(VAULT_EVENT_TOPICS[name as keyof typeof VAULT_EVENT_TOPICS]).toBe(id(signature))
    },
  )

  it("encodes OperationKind as uint8, matching the enum's ABI encoding", () => {
    expect(VAULT_EVENT_SIGNATURES.operationCapacityDeferred).toContain("uint8")
    expect(VAULT_OPERATION_KIND).toEqual({ payout: 0n, refund: 1n })
  })
})

describe("classifyRewardVaultSettlement", () => {
  it("confirms on a matching RewardPaid", () => {
    expect(classify([paidLog()]).disposition).toBe("confirmed")
  })

  it("confirms on a matching RewardRefunded when a refund is expected", () => {
    expect(classify([refundedLog()], { expectedKind: "refund" }).disposition).toBe("confirmed")
  })

  it("defers on a matching OperationCapacityDeferred and reports the epoch", () => {
    const result = classify([deferralLog({}, 0n, 4242n)])
    expect(result.disposition).toBe("capacity_deferred")
    expect(result.disposition === "capacity_deferred" && result.deferredEpoch).toBe(4242n)
  })

  it("defers a refund with the refund kind", () => {
    const result = classify([deferralLog({}, 1n, 7n)], { expectedKind: "refund" })
    expect(result.disposition).toBe("capacity_deferred")
  })

  describe("a successful receipt is never presumed successful", () => {
    it("does NOT confirm an empty log set", () => {
      // status === 1 alone would confirm a payout that never happened.
      const result = classify([])
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("no recognized vault event")
    })

    it("does not confirm when only unrelated contracts emitted", () => {
      expect(
        classify([paidLog({ address: OTHER_CONTRACT })]).disposition,
      ).toBe("reconciliation_required")
    })

    it("does not confirm an event for a different operation id", () => {
      expect(
        classify([paidLog({ topics: [VAULT_EVENT_TOPICS.rewardPaid, OTHER_OPERATION_ID] })])
          .disposition,
      ).toBe("reconciliation_required")
    })

    it("does not confirm an event from a different transaction in the same block", () => {
      expect(
        classify([paidLog({ transactionHash: OTHER_TX })]).disposition,
      ).toBe("reconciliation_required")
    })
  })

  describe("contradictions never resolve", () => {
    it("rejects a receipt carrying both settlement and deferral", () => {
      const result = classify([paidLog(), deferralLog()])
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("both a settlement and a deferral")
    })

    it("rejects the opposite settlement event for this operation id", () => {
      const result = classify([refundedLog()], { expectedKind: "payout" })
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("opposite settlement event")
    })

    it("rejects duplicate settlement events", () => {
      expect(classify([paidLog(), paidLog()]).reason).toContain("duplicate settlement")
    })

    it("rejects duplicate deferral events", () => {
      expect(classify([deferralLog(), deferralLog()]).reason).toContain("duplicate deferral")
    })

    it("rejects a deferral whose kind disagrees with the expected operation", () => {
      const result = classify([deferralLog({}, 1n)], { expectedKind: "payout" })
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("does not match the expected payout")
    })
  })

  describe("malformed input", () => {
    it.each([0, 2])("never classifies a receipt with status %i", (receiptStatus) => {
      expect(classify([paidLog()], { receiptStatus }).disposition).toBe("reconciliation_required")
    })

    it("rejects a non-canonical operation id", () => {
      expect(classify([paidLog()], { operationId: "0xnope" }).disposition).toBe(
        "reconciliation_required",
      )
    })

    it("rejects a deferral missing its epoch topic", () => {
      const result = classify([
        deferralLog({
          topics: [VAULT_EVENT_TOPICS.operationCapacityDeferred, OPERATION_ID, word(0n)],
        }),
      ])
      expect(result.reason).toContain("missing its kind or epoch topic")
    })

    it("tolerates a log with no topics at all", () => {
      expect(classify([{ address: VAULT, transactionHash: TX, topics: [] }]).disposition).toBe(
        "reconciliation_required",
      )
    })

    it("matches the vault address case-insensitively", () => {
      expect(classify([paidLog({ address: VAULT.toLowerCase() })]).disposition).toBe("confirmed")
    })

    it("accepts logs that omit a transaction hash", () => {
      const { transactionHash: _omitted, ...withoutHash } = paidLog()
      expect(classify([withoutHash]).disposition).toBe("confirmed")
    })
  })
})

describe("nextEpochRetryAtSeconds", () => {
  it("schedules just after the next epoch boundary", () => {
    expect(
      nextEpochRetryAtSeconds({
        deferredEpoch: 10n,
        epochDurationSeconds: 3600n,
        confirmationAllowanceSeconds: 30n,
        jitterSeconds: 7n,
      }),
    ).toBe(11n * 3600n + 30n + 7n)
  })

  it("never schedules inside the exhausted epoch", () => {
    const epochDuration = 3600n
    const deferredEpoch = 5n
    const at = nextEpochRetryAtSeconds({
      deferredEpoch,
      epochDurationSeconds: epochDuration,
      confirmationAllowanceSeconds: 0n,
      jitterSeconds: 0n,
    })
    // Retrying inside the exhausted epoch burns signer ETH on no-ops.
    expect(at / epochDuration).toBeGreaterThan(deferredEpoch)
  })

  it.each([
    ["zero epoch duration", { epochDurationSeconds: 0n }],
    ["negative epoch", { deferredEpoch: -1n }],
    ["negative jitter", { jitterSeconds: -1n }],
    ["negative confirmation allowance", { confirmationAllowanceSeconds: -1n }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      nextEpochRetryAtSeconds({
        deferredEpoch: 1n,
        epochDurationSeconds: 3600n,
        confirmationAllowanceSeconds: 30n,
        jitterSeconds: 0n,
        ...patch,
      }),
    ).toThrow()
  })
})
