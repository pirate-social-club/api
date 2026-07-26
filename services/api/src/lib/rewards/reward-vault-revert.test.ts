import { describe, expect, it } from "bun:test"
import { id } from "ethers"

import {
  classifyRewardVaultRevert,
  isRewardVaultCapacityDeferral,
} from "./reward-vault-revert"

/** Derives a selector the same way the chain does, so the table cannot drift silently. */
const selectorOf = (signature: string): string => id(signature).slice(0, 10)

describe("classifyRewardVaultRevert", () => {
  it("defers only on the epoch capacity ceiling", () => {
    const result = classifyRewardVaultRevert(selectorOf("EpochLimitExceeded()"))
    expect(result.disposition).toBe("capacity_deferred")
    expect(result.errorName).toBe("EpochLimitExceeded")
  })

  it("does NOT defer on the per-transfer limit, which would retry forever", () => {
    // TransferLimitExceeded reads like a capacity condition but is a policy
    // violation: an unchanged retry fails identically in every future epoch.
    const result = classifyRewardVaultRevert(selectorOf("TransferLimitExceeded()"))
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.errorName).toBe("TransferLimitExceeded")
  })

  it.each([
    "StalePolicy()",
    "DeadlineExpired()",
    "OperationAlreadyUsed()",
    "PayoutsPaused()",
    "RefundsPaused()",
    "Unauthorized()",
    "ZeroAmount()",
    "ZeroAddress()",
    "TokenTransferFailed()",
    "Reentrancy()",
    "InvalidPolicy()",
  ])("never defers on %s", (signature) => {
    const result = classifyRewardVaultRevert(selectorOf(signature))
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.errorName).toBe(signature.replace("()", ""))
  })

  it("does not defer on an unrecognized selector", () => {
    const result = classifyRewardVaultRevert("0xdeadbeef")
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.errorName).toBeNull()
    expect(result.selector).toBe("0xdeadbeef")
  })

  it.each([null, undefined, "", "0x"])(
    "does not defer when there is no revert data (%p)",
    (revertData) => {
      const result = classifyRewardVaultRevert(revertData)
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.errorName).toBeNull()
      expect(result.selector).toBeNull()
    },
  )

  it.each(["0x123", "notbytes", "0xzzzzzzzz"])(
    "does not defer on malformed revert data (%p)",
    (revertData) => {
      expect(classifyRewardVaultRevert(revertData).disposition).toBe("reconciliation_required")
    },
  )

  it("recognizes Solidity built-in reverts without deferring", () => {
    expect(classifyRewardVaultRevert("0x08c379a0").errorName).toBe("Error(string)")
    expect(classifyRewardVaultRevert("0x08c379a0").disposition).toBe("reconciliation_required")
    expect(classifyRewardVaultRevert("0x4e487b71").errorName).toBe("Panic(uint256)")
    expect(classifyRewardVaultRevert("0x4e487b71").disposition).toBe("reconciliation_required")
  })

  it("matches the selector case-insensitively and ignores trailing ABI data", () => {
    const upper = selectorOf("EpochLimitExceeded()").toUpperCase().replace("0X", "0x")
    expect(classifyRewardVaultRevert(upper).disposition).toBe("capacity_deferred")

    const withPayload = `${selectorOf("EpochLimitExceeded()")}${"00".repeat(32)}`
    expect(classifyRewardVaultRevert(withPayload).disposition).toBe("capacity_deferred")
  })

  it("keeps every table selector consistent with its on-chain signature", () => {
    // Guards against a hand-typed selector drifting from the contract.
    expect(selectorOf("EpochLimitExceeded()")).toBe("0x2b579c17")
    expect(selectorOf("TransferLimitExceeded()")).toBe("0x3525bb0b")
    expect(selectorOf("StalePolicy()")).toBe("0xe5c91771")
    expect(selectorOf("OperationAlreadyUsed()")).toBe("0x01828959")
    expect(selectorOf("PayoutsPaused()")).toBe("0x373a363f")
  })

  it("exposes the capacity decision through the boolean helper", () => {
    expect(isRewardVaultCapacityDeferral(selectorOf("EpochLimitExceeded()"))).toBe(true)
    expect(isRewardVaultCapacityDeferral(selectorOf("PayoutsPaused()"))).toBe(false)
    expect(isRewardVaultCapacityDeferral(null)).toBe(false)
  })
})
