import { describe, expect, it } from "bun:test"
import { Transaction, Wallet, id } from "ethers"

import {
  gatherRewardVaultRevertEvidence,
  type RewardVaultTransactionTracer,
} from "./reward-vault-revert-evidence"
import {
  encodeRewardVaultCalldata,
  rewardVaultActionRequest,
  type RewardVaultTransactionInput,
} from "./reward-vault-transaction"

const SIGNER = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
const VAULT = "0x000000000000000000000000000000000000beef"
const EPOCH_LIMIT_EXCEEDED = id("EpochLimitExceeded()").slice(0, 10)
const BLOCK_HASH = `0x${"ab".repeat(32)}`

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

const tracerReturning = (output: string | null): RewardVaultTransactionTracer => ({
  traceTransaction: async () => ({ to: VAULT, reverted: true, output }),
})

const args = async (overrides: Partial<Parameters<typeof gatherRewardVaultRevertEvidence>[0]> = {}) => {
  const signedTx = await signFor(baseInput)
  return {
    pinnedVaultAddress: VAULT,
    operatorKind: "rewards",
    effectKind: "reward_cashout",
    signedTx,
    transactionInput: baseInput,
    receiptStatus: 0,
    receiptTransactionHash: Transaction.from(signedTx).hash!,
    receiptBlockHash: BLOCK_HASH,
    tracer: tracerReturning(EPOCH_LIMIT_EXCEEDED),
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    ...overrides,
  }
}

describe("gatherRewardVaultRevertEvidence", () => {
  it("defers when every gate passes", async () => {
    const result = await gatherRewardVaultRevertEvidence(await args())
    expect(result.disposition).toBe("capacity_deferred")
    expect(result.errorName).toBe("EpochLimitExceeded")
    expect(result.evidence).toEqual({
      method: "debug_traceTransaction",
      transactionHash: result.evidence?.transactionHash,
      blockHash: BLOCK_HASH,
      selector: EPOCH_LIMIT_EXCEEDED,
      classifiedAt: "2026-07-26T12:00:00.000Z",
    })
  })

  it("traces the exact receipt transaction hash", async () => {
    const seen: string[] = []
    const input = await args()
    await gatherRewardVaultRevertEvidence(
      {
        ...input,
        tracer: {
          traceTransaction: async (txHash) => {
            seen.push(txHash)
            return { to: VAULT, reverted: true, output: EPOCH_LIMIT_EXCEEDED }
          },
        },
      },
    )
    expect(seen).toEqual([input.receiptTransactionHash])
  })

  it("rejects a receipt hash that does not match the verified signed transaction", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({ receiptTransactionHash: `0x${"cd".repeat(32)}` }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("does not match")
  })

  it("fails closed when exact tracing is unsupported or unavailable", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({
        tracer: {
          traceTransaction: async () => {
            throw new Error("method not supported")
          },
        },
      }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("failing closed")
  })

  it("fails closed when the trace does not report a root revert", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({ tracer: { traceTransaction: async () => ({ to: VAULT, reverted: false, output: null }) } }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("root revert")
  })

  it("fails closed when only a nested call targets the vault", async () => {
    const result = await gatherRewardVaultRevertEvidence(
      await args({
        tracer: {
          traceTransaction: async () => ({
            to: "0x000000000000000000000000000000000000cafe",
            reverted: true,
            output: EPOCH_LIMIT_EXCEEDED,
          }),
        },
      }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("trace root target")
  })

  it.each([
    ["TransferLimitExceeded()", "TransferLimitExceeded"],
    ["PayoutsPaused()", "PayoutsPaused"],
    ["StalePolicy()", "StalePolicy"],
    ["OperationAlreadyUsed()", "OperationAlreadyUsed"],
  ])("does not defer when the replay reverts with %s", async (signature, name) => {
      const result = await gatherRewardVaultRevertEvidence(
      await args({ tracer: tracerReturning(id(signature).slice(0, 10)) }),
    )
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.errorName).toBe(name)
  })

  it.each([null, "0x", "0xdeadbeef"])(
    "does not defer on absent/unknown revert data (%p)",
    async (data) => {
      const result = await gatherRewardVaultRevertEvidence(
        await args({ tracer: tracerReturning(data) }),
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

  it("refuses non-canonical receipt block identity", async () => {
    const result = await gatherRewardVaultRevertEvidence(await args({ receiptBlockHash: "latest" }))
    expect(result.disposition).toBe("reconciliation_required")
    expect(result.reason).toContain("canonical transaction/block identity")
  })

  it("defers refunds too, not just payouts", async () => {
    const refundInput: RewardVaultTransactionInput = {
      ...baseInput,
      effectKind: "reward_funding_refund",
      effectId: "rcf_capacity_deferral_fixture",
    }
    const signedTx = await signFor(refundInput)
    const result = await gatherRewardVaultRevertEvidence(
      await args({
        effectKind: "reward_funding_refund",
        transactionInput: refundInput,
        signedTx,
        receiptTransactionHash: Transaction.from(signedTx).hash!,
      }),
    )
    expect(result.disposition).toBe("capacity_deferred")
  })
})
