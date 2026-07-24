import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import {
  encodeRewardVaultCalldata,
  executeAndVerifyRewardVaultTransaction,
  rewardVaultActionRequest,
  verifySignedRewardVaultTransaction,
  type RewardVaultTransactionInput,
} from "./reward-vault-transaction"

const SIGNER = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
const OTHER_SIGNER = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a")
const VAULT = "0x1000000000000000000000000000000000000001"
const OTHER_VAULT = "0x2000000000000000000000000000000000000002"
const RECIPIENT = "0x3000000000000000000000000000000000000003"

function input(overrides: Partial<RewardVaultTransactionInput> = {}): RewardVaultTransactionInput {
  return {
    effectKind: "reward_cashout",
    effectId: "rpe_0123456789abcdef0123456789abcdef",
    recipient: RECIPIENT,
    amount: 12_340_000n,
    deadline: 2_000_000_000n,
    policyVersion: 7n,
    vaultAddress: VAULT,
    signerAddress: SIGNER.address,
    chainId: 8453,
    nonce: 11,
    gas: {
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 140_000n,
    },
    ...overrides,
  }
}

async function sign(
  expected: RewardVaultTransactionInput,
  overrides: {
    wallet?: Wallet
    to?: string
    data?: string
    chainId?: number
    nonce?: number
    value?: bigint
    maxFeePerGas?: bigint
    type?: 0 | 2
  } = {},
): Promise<string> {
  const request = rewardVaultActionRequest(expected)
  const transaction = {
    to: overrides.to ?? expected.vaultAddress,
    data: overrides.data ?? encodeRewardVaultCalldata(request),
    chainId: overrides.chainId ?? expected.chainId,
    nonce: overrides.nonce ?? expected.nonce,
    type: overrides.type ?? 2,
    value: overrides.value ?? 0n,
    gasLimit: expected.gas.gasLimit,
    ...((overrides.type ?? 2) === 2
      ? {
          maxFeePerGas: overrides.maxFeePerGas ?? expected.gas.maxFeePerGas,
          maxPriorityFeePerGas: expected.gas.maxPriorityFeePerGas,
        }
      : { gasPrice: expected.gas.maxFeePerGas }),
  }
  return (overrides.wallet ?? SIGNER).signTransaction(transaction)
}

describe("executeAndVerifyRewardVaultTransaction", () => {
  test("rejects booking effects before calling Lit", async () => {
    let calls = 0
    const execute = async () => {
      calls += 1
      return { signedTx: "0x" }
    }

    await expect(executeAndVerifyRewardVaultTransaction(
      execute,
      input({ effectKind: "booking_payout" }),
    )).rejects.toThrow("only accepts rewards effect kinds")
    expect(calls).toBe(0)
  })

  test.each([
    ["reward_cashout", "pay"],
    ["reward_funding_refund", "refund"],
  ] as const)("binds %s to the %s method and verifies the signed transaction", async (effectKind, method) => {
    const expected = input({ effectKind })
    const result = await executeAndVerifyRewardVaultTransaction(async (request) => {
      expect(request.method).toBe(method)
      return { signedTx: await sign(expected) }
    }, expected)
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe("verifySignedRewardVaultTransaction", () => {
  test.each([
    ["signer", async (expected: RewardVaultTransactionInput) => sign(expected, { wallet: OTHER_SIGNER }), "signer mismatch"],
    ["chainId", async (expected: RewardVaultTransactionInput) => sign(expected, { chainId: 84532 }), "chainId mismatch"],
    ["transaction type", async (expected: RewardVaultTransactionInput) => sign(expected, { type: 0 }), "must be EIP-1559"],
    ["native value", async (expected: RewardVaultTransactionInput) => sign(expected, { value: 1n }), "must not transfer native value"],
    ["gas fields", async (expected: RewardVaultTransactionInput) => sign(expected, { maxFeePerGas: 3_000_000_000n }), "gas fields mismatch"],
    ["vault", async (expected: RewardVaultTransactionInput) => sign(expected, { to: OTHER_VAULT }), "vault mismatch"],
    ["nonce", async (expected: RewardVaultTransactionInput) => sign(expected, { nonce: 12 }), "nonce mismatch"],
  ])("rejects a %s mismatch", async (_field, mutate, expectedError) => {
    const expected = input()
    const signedTx = await mutate(expected)
    expect(() => verifySignedRewardVaultTransaction(signedTx, expected)).toThrow(expectedError)
  })

  test.each([
    ["operation ID", { effectId: "rpe_other" }],
    ["recipient", { recipient: OTHER_VAULT }],
    ["amount", { amount: 12_340_001n }],
    ["deadline", { deadline: 2_000_000_001n }],
    ["policy version", { policyVersion: 8n }],
    ["method", { effectKind: "reward_funding_refund" as const }],
  ])("rejects a %s calldata mismatch", async (_field, overrides) => {
    const signedFor = input()
    const expected = input(overrides)
    const signedTx = await sign(signedFor)
    expect(() => verifySignedRewardVaultTransaction(signedTx, expected)).toThrow("calldata mismatch")
  })
})
