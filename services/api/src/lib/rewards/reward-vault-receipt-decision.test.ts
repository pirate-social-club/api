import { describe, expect, it } from "bun:test"
import { Transaction, Wallet, id } from "ethers"

import { rewardOperationId } from "./reward-operation-id"
import {
  decideRewardVaultReceipt,
  type RewardVaultReceiptSnapshot,
} from "./reward-vault-receipt-decision"
import { VAULT_EVENT_TOPICS } from "./reward-vault-settlement-outcome"
import {
  encodeRewardVaultCalldata,
  rewardVaultActionRequest,
  type RewardVaultTransactionInput,
} from "./reward-vault-transaction"

const SIGNER = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
const VAULT = "0x000000000000000000000000000000000000beef"
const RECIPIENT = "0x000000000000000000000000000000000000dEaD"
const EFFECT_ID = "rpe_0123456789abcdef0123456789abcdef"
const AMOUNT = 500_000n
const POLICY_VERSION = 1n
const CHAIN_ID = 84532
const NONCE = 7
const HOUR = 3600n
const EPOCH = 10n
/** Inside epoch 10 for a one-hour epoch. */
const BLOCK_TS = EPOCH * HOUR + 120n
const BLOCK_HASH = `0x${"ab".repeat(32)}`

const pinned = {
  vaultAddress: VAULT,
  signerAddress: SIGNER.address,
  chainId: CHAIN_ID,
  policyVersion: POLICY_VERSION,
  epochDurationSeconds: HOUR,
  maxFeePerGasWei: 2_000_000_000n,
  maxPriorityFeePerGasWei: 1_000_000_000n,
  maxGasLimit: 200_000n,
}

const txInput = (overrides: Partial<RewardVaultTransactionInput> = {}): RewardVaultTransactionInput => ({
  effectKind: "reward_cashout",
  effectId: EFFECT_ID,
  recipient: RECIPIENT,
  amount: AMOUNT,
  deadline: 4_000_000_000n,
  policyVersion: POLICY_VERSION,
  vaultAddress: VAULT,
  signerAddress: SIGNER.address,
  chainId: CHAIN_ID,
  nonce: NONCE,
  gas: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, gasLimit: 200_000n },
  ...overrides,
})

async function sign(input: RewardVaultTransactionInput): Promise<string> {
  const request = rewardVaultActionRequest(input)
  return await SIGNER.signTransaction(
    Transaction.from({
      type: 2,
      to: request.vaultAddress,
      data: encodeRewardVaultCalldata(request),
      value: 0n,
      chainId: input.chainId,
      nonce: input.nonce,
      maxFeePerGas: input.gas.maxFeePerGas,
      maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas,
      gasLimit: input.gas.gasLimit,
    }),
  )
}

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`
const addressWord = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`

const paidLog = (txHash: string, overrides: Record<string, unknown> = {}) => ({
  address: VAULT,
  transactionHash: txHash,
  topics: [
    VAULT_EVENT_TOPICS.rewardPaid,
    rewardOperationId(EFFECT_ID),
    addressWord(RECIPIENT),
    word(POLICY_VERSION),
  ],
  data: `0x${AMOUNT.toString(16).padStart(64, "0")}${EPOCH.toString(16).padStart(64, "0")}`,
  ...overrides,
})

const deferralLog = (txHash: string, epoch = EPOCH, kind = 0n) => ({
  address: VAULT,
  transactionHash: txHash,
  topics: [
    VAULT_EVENT_TOPICS.operationCapacityDeferred,
    rewardOperationId(EFFECT_ID),
    word(kind),
    word(epoch),
  ],
  data: "0x",
})

async function decide(options: {
  logs?: (txHash: string) => RewardVaultReceiptSnapshot["logs"]
  signedInput?: RewardVaultTransactionInput
  snapshot?: Partial<RewardVaultReceiptSnapshot>
  durable?: Record<string, unknown>
  pinnedOverrides?: Record<string, unknown>
} = {}) {
  const input = options.signedInput ?? txInput()
  const signedTx = await sign(input)
  const txHash = Transaction.from(signedTx).hash!
  return decideRewardVaultReceipt({
    snapshot: {
      status: 1,
      transactionHash: txHash,
      blockHash: BLOCK_HASH,
      blockTimestampSeconds: BLOCK_TS,
      logs: (options.logs ?? ((h: string) => [paidLog(h)]))(txHash),
      ...options.snapshot,
    },
    durable: {
      effectKind: "reward_cashout",
      effectId: EFFECT_ID,
      recipient: RECIPIENT,
      amountAtomic: AMOUNT,
      nonce: NONCE,
      signedTx,
      txHash,
      ...options.durable,
    } as never,
    pinned: { ...pinned, ...options.pinnedOverrides },
  })
}

describe("decideRewardVaultReceipt", () => {
  it("confirms a settled payout", async () => {
    const result = await decide()
    expect(result.disposition).toBe("confirmed")
  })

  it("defers on a capacity event and schedules the next epoch", async () => {
    const result = await decide({ logs: (h) => [deferralLog(h)] })
    expect(result.disposition).toBe("capacity_deferred")
    if (result.disposition !== "capacity_deferred") throw new Error("unreachable")
    expect(result.deferredEpoch).toBe(EPOCH)
    // Lands inside epoch 11, never inside the exhausted epoch 10.
    expect(BigInt(result.retryAtMs) / 1000n / HOUR).toBe(EPOCH + 1n)
  })

  it("is idempotent: the same receipt yields the same retry time", async () => {
    const a = await decide({ logs: (h) => [deferralLog(h)] })
    const b = await decide({ logs: (h) => [deferralLog(h)] })
    expect(a).toEqual(b)
  })

  describe("policy version is never accepted because the transaction says so", () => {
    it("rejects a transaction signed under a different policy version", async () => {
      // Signed for version 2 while the pinned configuration says 1. The old
      // self-verifying builder would have decoded 2 and compared it to itself.
      const result = await decide({ signedInput: txInput({ policyVersion: 2n }) })
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("byte-exact verification")
    })
  })

  describe("fields are bound to the durable row, not the transaction", () => {
    it("rejects when the row's recipient disagrees with the signed calldata", async () => {
      const result = await decide({ durable: { recipient: SIGNER.address } })
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("byte-exact verification")
    })

    it("rejects when the row's amount disagrees", async () => {
      const result = await decide({ durable: { amountAtomic: AMOUNT + 1n } })
      expect(result.disposition).toBe("reconciliation_required")
    })

    it("rejects when the row's nonce disagrees", async () => {
      const result = await decide({ durable: { nonce: NONCE + 1 } })
      expect(result.disposition).toBe("reconciliation_required")
    })

    it("rejects when the row's effect id disagrees", async () => {
      const result = await decide({ durable: { effectId: "rpe_other" } })
      expect(result.disposition).toBe("reconciliation_required")
    })
  })

  describe("receipt binding", () => {
    it("rejects a receipt for a different transaction", async () => {
      const result = await decide({ snapshot: { transactionHash: `0x${"cd".repeat(32)}` } })
      expect(result.reason).toContain("does not match the durable effect")
    })

    it("rejects when the stored signed transaction does not hash to the row's tx hash", async () => {
      const other = await sign(txInput({ nonce: NONCE + 5 }))
      const result = await decide({ durable: { signedTx: other } })
      expect(result.reason).toContain("does not hash to the durable transaction hash")
    })

    it("never classifies a reverted receipt", async () => {
      const result = await decide({ snapshot: { status: 0 } })
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("reverted")
    })
  })

  describe("gas is bounded by pinned ceilings", () => {
    it("rejects fees above the ceiling", async () => {
      const result = await decide({
        signedInput: txInput({
          gas: { maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 1n, gasLimit: 200_000n },
        }),
      })
      expect(result.reason).toContain("exceeds the pinned ceilings")
    })

    it("rejects a gas limit above the ceiling", async () => {
      const result = await decide({
        signedInput: txInput({
          gas: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 900_000n },
        }),
      })
      expect(result.reason).toContain("exceeds the pinned ceilings")
    })

    it("cannot even be signed with a priority fee above the max fee", async () => {
      // ethers refuses to serialize such a transaction, so the module's own
      // priority-fee check is defence in depth against a hand-crafted payload
      // rather than something reachable through normal signing. Asserted so a
      // future reader does not mistake the check for dead code.
      await expect(
        sign(
          txInput({
            gas: {
              maxFeePerGas: 1_000_000_000n,
              maxPriorityFeePerGas: 2_000_000_000n,
              gasLimit: 100n,
            },
          }),
        ),
      ).rejects.toThrow()
    })
  })

  describe("epoch cross-check uses the receipt's own block", () => {
    it("rejects a deferral whose epoch disagrees with the receipt block", async () => {
      const result = await decide({ logs: (h) => [deferralLog(h, EPOCH + 5n)] })
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("configuration is wrong")
    })

    it("catches a locally-misconfigured epoch duration", async () => {
      const result = await decide({
        logs: (h) => [deferralLog(h)],
        pinnedOverrides: { epochDurationSeconds: 86_400n },
      })
      expect(result.disposition).toBe("reconciliation_required")
    })
  })

  describe("event evidence", () => {
    it("does not confirm a successful receipt carrying no vault event", async () => {
      const result = await decide({ logs: () => [] })
      expect(result.disposition).toBe("reconciliation_required")
      expect(result.reason).toContain("no recognized vault event")
    })

    it("does not resolve a receipt carrying both settlement and deferral", async () => {
      const result = await decide({ logs: (h) => [paidLog(h), deferralLog(h)] })
      expect(result.disposition).toBe("reconciliation_required")
    })

    it("ignores a log emitted by another contract", async () => {
      const result = await decide({
        logs: (h) => [paidLog(h, { address: "0x000000000000000000000000000000000000cafe" })],
      })
      expect(result.disposition).toBe("reconciliation_required")
    })

    it("ignores a log from a different transaction in the same block", async () => {
      const result = await decide({ logs: () => [paidLog(`0x${"ef".repeat(32)}`)] })
      expect(result.disposition).toBe("reconciliation_required")
    })
  })

  it("derives the operation id from the exact effect id", async () => {
    // Guards the keccak binding the whole join rests on.
    expect(rewardOperationId(EFFECT_ID)).toBe(id(EFFECT_ID))
  })
})
