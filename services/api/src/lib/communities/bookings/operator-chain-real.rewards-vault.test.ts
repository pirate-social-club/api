import { afterEach, describe, expect, test } from "bun:test"
import { Interface, Transaction, Wallet } from "ethers"

import type { Env } from "../../../env"
import {
  createStaticSettlementProvider,
  realChain,
  setRewardVaultOperatorReaderForTests,
  settlementGasLimit,
} from "./operator-chain-real"

const VAULT = "0x1000000000000000000000000000000000000001"
const RECIPIENT = "0x2000000000000000000000000000000000000002"
const SIGNER = new Wallet(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)
const VAULT_INTERFACE = new Interface([
  "function pay(bytes32 operationId,address recipient,uint256 amount,uint64 deadline,uint64 expectedPolicyVersion)",
])
const originalFetch = globalThis.fetch
const originalNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalNow
  setRewardVaultOperatorReaderForTests(null)
})

function env(): Env {
  return {
    PIRATE_REWARDS_SETTLEMENT_BACKEND: "lit_vault",
    PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: SIGNER.address,
    PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
    PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://example.invalid",
    REWARDS_TREASURY_VAULT_ADDRESS: VAULT,
    REWARDS_TREASURY_VAULT_POLICY_VERSION: "7",
    LIT_REWARDS_USAGE_API_KEY: "usage-secret",
    LIT_REWARDS_ACTION_IPFS_ID: "QmPinned",
    LIT_REWARDS_ACTION_POLICY_VERSION: "7",
    // Mirror the ceilings pinned into the reviewed action source.
    LIT_REWARDS_MAX_FEE_PER_GAS_WEI: "50000000000",
    LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI: "25000000000",
    LIT_REWARDS_MAX_GAS_LIMIT: "300000",
    LIT_REWARDS_SIGNING_DEADLINE_SECONDS: "300",
  } as Env
}

describe("real rewards Lit vault signer wiring", () => {
  test("trusts the validated settlement chain without an RPC network-detection request", async () => {
    const provider = createStaticSettlementProvider("https://example.invalid", 84532)
    try {
      expect((await provider.getNetwork()).chainId).toBe(84532n)
      expect(provider._getConnection().timeout).toBe(15_000)
    } finally {
      provider.destroy()
    }
  })

  test("uses the reviewed Lit vault gas ceiling instead of the local-transfer default", () => {
    expect(settlementGasLimit(env(), "lit_vault")).toBe(300_000n)
    expect(settlementGasLimit(env(), "eoa_vault")).toBe(300_000n)
    expect(settlementGasLimit(env(), "local")).toBe(100_000n)
  })

  test("signs only verifier-bound vault calldata with the EOA backend", async () => {
    setRewardVaultOperatorReaderForTests(async () => SIGNER.address)
    Date.now = () => 2_000_000_000_000
    const eoaEnv = {
      ...env(),
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: SIGNER.privateKey,
      LIT_REWARDS_USAGE_API_KEY: undefined,
      LIT_REWARDS_ACTION_IPFS_ID: undefined,
    } as Env
    const result = await realChain.signVerifiedTransfer(eoaEnv, {
      operatorKind: "rewards",
      effectKind: "reward_cashout",
      effectId: "cashout_effect_eoa_01",
      to: RECIPIENT,
      amountAtomic: "1000000",
      nonce: 9,
      gas: {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        gasLimit: 300_000n,
      },
    })
    const parsed = Transaction.from(result.signedTx)
    const decoded = VAULT_INTERFACE.decodeFunctionData("pay", parsed.data)

    expect(parsed.from).toBe(SIGNER.address)
    expect(parsed.to).toBe(VAULT)
    expect(parsed.nonce).toBe(9)
    expect(parsed.value).toBe(0n)
    expect(decoded[0]).toBe(result.operationId)
    expect(decoded[1]).toBe(RECIPIENT)
    expect(decoded[2]).toBe(1_000_000n)
    expect(decoded[3]).toBe(2_000_000_300n)
    expect(decoded[4]).toBe(7n)
  })

  test("never includes the EOA private key in configuration failures", async () => {
    const privateKey = SIGNER.privateKey
    const mismatchedAddress = "0x3000000000000000000000000000000000000003"
    let message = ""
    try {
      await realChain.signVerifiedTransfer({
        ...env(),
        PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
        PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: mismatchedAddress,
        PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: privateKey,
      } as Env, {
        operatorKind: "rewards",
        effectKind: "reward_funding_refund",
        effectId: "refund_effect_eoa_secret_safety",
        to: RECIPIENT,
        amountAtomic: "500000",
        nonce: 1,
        gas: {
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
          gasLimit: 300_000n,
        },
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("preparation failed")
    expect(message).not.toContain(privateKey)
    expect(message).not.toContain(privateKey.slice(2))
  })

  test("rejects before signing when the on-chain operator differs", async () => {
    setRewardVaultOperatorReaderForTests(
      async () => "0x3000000000000000000000000000000000000003",
    )
    await expect(realChain.signVerifiedTransfer({
      ...env(),
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: SIGNER.privateKey,
    } as Env, {
      operatorKind: "rewards",
      effectKind: "reward_cashout",
      effectId: "cashout_effect_operator_mismatch",
      to: RECIPIENT,
      amountAtomic: "500000",
      nonce: 1,
      gas: {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        gasLimit: 300_000n,
      },
    })).rejects.toThrow("preparation failed")
  })

  test("creates a fresh deadline at each signing attempt without changing the effect identity", async () => {
    const deadlines: string[] = []
    const operationIds: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        ipfs_id: string
        js_params: Record<string, unknown>
      }
      expect(body.ipfs_id).toBe("QmPinned")
      const params = body.js_params as {
        operationId: string
        recipient: string
        amount: string
        deadline: string
        policyVersion: string
        nonce: number
        chainId: number
        gas: { maxFeePerGas: string; maxPriorityFeePerGas: string; gasLimit: string }
      }
      deadlines.push(params.deadline)
      operationIds.push(params.operationId)
      const signedTx = await SIGNER.signTransaction({
        to: VAULT,
        data: VAULT_INTERFACE.encodeFunctionData("pay", [
          params.operationId,
          params.recipient,
          params.amount,
          params.deadline,
          params.policyVersion,
        ]),
        nonce: params.nonce,
        chainId: params.chainId,
        type: 2,
        value: 0,
        maxFeePerGas: params.gas.maxFeePerGas,
        maxPriorityFeePerGas: params.gas.maxPriorityFeePerGas,
        gasLimit: params.gas.gasLimit,
      })
      return Response.json({
        response: { signedTx },
        logs: "",
        has_error: false,
      })
    }) as typeof fetch

    // Deadline construction and the local preflight independently sample the
    // clock during each attempt; keep both reads inside the same second.
    const clocks = [
      2_000_000_000_000,
      2_000_000_000_000,
      2_000_100_000_000,
      2_000_100_000_000,
    ]
    Date.now = () => clocks.shift()!
    const input = {
      operatorKind: "rewards" as const,
      effectKind: "reward_cashout" as const,
      effectId: "cashout_effect_01",
      to: RECIPIENT,
      amountAtomic: "1000000",
      nonce: 4,
      gas: {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        gasLimit: 100_000n,
      },
    }

    const first = await realChain.signVerifiedTransfer(env(), input)
    const second = await realChain.signVerifiedTransfer(env(), input)

    expect(deadlines).toEqual(["2000000300", "2000100300"])
    expect(operationIds[0]).toBe(operationIds[1])
    expect(first.operationId).toBe(operationIds[0])
    expect(second.operationId).toBe(operationIds[0])
  })

  test("rejects staging deadline and policy rehearsals before calling Lit", async () => {
    const observed: Array<{ deadline: string; policyVersion: string }> = []
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        js_params: { deadline: string; policyVersion: string }
      }
      observed.push({
        deadline: body.js_params.deadline,
        policyVersion: body.js_params.policyVersion,
      })
      return Response.json({
        response: "request does not match pinned policy",
        logs: "",
        has_error: true,
      })
    }) as typeof fetch
    Date.now = () => 2_000_000_000_000
    const base = {
      operatorKind: "rewards" as const,
      effectKind: "reward_cashout" as const,
      effectId: "cashout_effect_02",
      to: RECIPIENT,
      amountAtomic: "500000",
      nonce: 5,
      gas: {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        gasLimit: 100_000n,
      },
    }
    const staging = { ...env(), ENVIRONMENT: "staging" } as Env
    await expect(realChain.signVerifiedTransfer(staging, {
      ...base,
      rehearsalScenario: "deadline_expired",
    })).rejects.toThrow("preparation failed")
    await expect(realChain.signVerifiedTransfer(staging, {
      ...base,
      rehearsalScenario: "stale_policy",
    })).rejects.toThrow("preparation failed")

    expect(observed).toEqual([])
    await expect(realChain.signVerifiedTransfer({ ...env(), ENVIRONMENT: "production" } as Env, {
      ...base,
      rehearsalScenario: "over_limit",
    })).rejects.toThrow("preparation failed")
    expect(observed).toHaveLength(0)
  })
})
