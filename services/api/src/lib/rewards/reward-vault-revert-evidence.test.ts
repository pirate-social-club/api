import { describe, expect, it } from "bun:test"
import { Transaction, Wallet, id } from "ethers"

import {
  gatherRewardVaultRevertEvidence,
  type RewardVaultRevertReplayer,
} from "./reward-vault-revert-evidence"
import {
  encodeRewardVaultCalldata,
  rewardVaultActionRequest,
  type RewardVaultTransactionInput,
} from "./reward-vault-transaction"

const SIGNER = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
const VAULT = "0x000000000000000000000000000000000000beef"
const EPOCH_LIMIT_EXCEEDED = id("EpochLimitExceeded()").slice(0, 10)

const baseInput: RewardVaultTransactionInput = {
  effectKind: "reward_cashout",
  effectId: "rpe_capacity_deferral_fixture",
  recipient: "0x000000000000000000000000000000000000dEaD",
  amount: 10_000n,
  deadline: 4_000_000_000n,
  policyVersion: 1n,
  vaultAddress: VAULT,
  signerAddress: SIGNER.address,
  chainId: 84532,
  nonce: 7,
  gas: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, gasLimit: 200_000n },
}

async function signFor(input: RewardVaultTransactionInput): Promise<string> {
  const request = rewardVaultActionRequest(input)
  const tx = Transaction.from({
    type: 2,
    to: request.vaultAddress,
    data: encodeRewardVaultCalldata(request),
    value: 0n,
    chainId: input.chainId,
    nonce: input.nonce,
    maxFeePerGas: input.gas.maxFeePerGas,
    maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas,
    gasLimit: input.gas.gasLimit,
  })
  return await SIGNER.signTransaction(tx)
}

const replayerReturning = (data: string | null): RewardVaultRevertReplayer => ({
  callAtBlock: async () => ({ reverted: true, data }),
})

const args = async (overrides: Partial<Parameters<typeof gatherRewardVaultRevertEvidence>[0]> = {}) => ({
  pinnedVaultAddress: VAULT,
  operatorKind: "rewards",
  effectKind: "reward_cashout",
  signedTx: await signFor(baseInput),
  transactionInput: baseInput,
  receiptStatus: 0,
  receiptBlockNumber: 1_234_567,
  replayer: replayerReturning(EPOCH_LIMIT_EXCEEDED),
  ...overrides,
})

describe("gatherRewardVaultRevertEvidence", () => {
  it("defers when every gate passes", async () => {
    const result = await gatherRewardVaultRevertEvidence(await args())
    expect(result.disposition).toBe("capacity_deferred")
    expect(result.errorName).toBe("EpochLimitExceeded")
    expect(result.replayedAtBlock).toBe(1_234_567)
  })

  it("replays against the receipt block, never latest", async () => {
    const seen: number[] = []
    await gatherRewardVaultRevertEvidence(
      await args({
        replayer: {
          callAtBlock: async (_call, blockNumber) => {
            seen.push(blockNumber)
            return { reverted: true, data: EPOCH_LIMIT_EXCEEDED }
          },
        },
      }),
    )
    expect(seen).toEqual([1_234_567])
  })

  it("replays the exact mined call: pinned vault, signer, calldata, zero value", async () => {
    let captured: { to: string; from: string; data: string; value: bigint } | null = null
    await gatherRewardVaultRevertEvidence(
      await args({
        replayer: {
          callAtBlock: async (call) => {
            captured = call
            return { reverted: true, data: EPOCH_LIMIT_EXCEEDED }
          },
        },
      }),
    )
    const request = rewardVaultActionRequest(baseInput)
    expect(captured!.to.toLowerCase()).toBe(request.vaultAddress.toLowerCase())
    expect(captured!.from.toLowerCase()).toBe(SIGNER.address.toLowerCase())
    expect(captured!.data).toBe(encodeRewardVaultCalldata(request))
    expect(captured!.value).toBe(0n)
  })

  it("fails closed when the archive cannot execute at that block", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({
        replayer: {
          callAtBlock: async () => {
            throw new Error("missing trie node / block not available")
          },
        },
      }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("failing closed")
  })

  it("fails closed when the replay does not revert at all", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({ replayer: { callAtBlock: async () => ({ reverted: false }) } }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("inconsistent")
  })

  it.each([
    ["TransferLimitExceeded()", "TransferLimitExceeded"],
    ["PayoutsPaused()", "PayoutsPaused"],
    ["StalePolicy()", "StalePolicy"],
    ["OperationAlreadyUsed()", "OperationAlreadyUsed"],
  ])("does not defer when the replay reverts with %s", async (signature, name) => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({ replayer: replayerReturning(id(signature).slice(0, 10)) }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.errorName).toBe(name)
  })

  it.each([null, "0x", "0xdeadbeef"])(
    "does not defer on absent/unknown revert data (%p)",
    async (data) => {
      const result = await gatherRewardVaultRevertEvidence(
        await args({ replayer: replayerReturning(data) }),
      )
      expect(result.disposition).toBe("reconciliation_required")
    },
  )

  it("leaves booking effects entirely alone", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({ operatorKind: "bookings" }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("booking semantics unchanged")
  })

  it("rejects a non-rewards-vault effect kind", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({ effectKind: "booking_payout" }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("not a rewards vault payout or refund")
  })

  it("refuses a transaction that fails byte-exact verification", async () => {
    // Signed for a different recipient than the effect claims.
    const tampered = await signFor({ ...baseInput, recipient: SIGNER.address })
    const result = await gatherRewardVaultRevertEvidence(await args({ signedTx: tampered }))
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("byte-exact vault verification")
  })

  it("refuses when the call target is not the pinned vault", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({ pinnedVaultAddress: "0x000000000000000000000000000000000000cafe" }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("not the pinned rewards vault")
  })

  it.each([1, 2])("ignores receipts that are not status 0 (status %i)", async (status) => {
    const result = await gatherRewardVaultRevertEvidence(await args({ receiptStatus: status }))
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("not a reverted transaction")
  })

  it("refuses when the receipt carries no block number to pin to", async () => {
    const result = await gatherRewardVaultRevertEvidence(await args({ receiptBlockNumber: null }))
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("cannot pin replay")
  })

  it("defers refunds too, not just payouts", async () => {
    const refundInput: RewardVaultTransactionInput = {
      ...baseInput,
      effectKind: "reward_funding_refund",
      effectId: "rcf_capacity_deferral_fixture",
    }
    const result = await gatherRewardVaultRevertEvidence(
      await args({
        effectKind: "reward_funding_refund",
        transactionInput: refundInput,
        signedTx: await signFor(refundInput),
      }),
    )
    expect(result.disposition).toBe("capacity_deferred")
  })
})
