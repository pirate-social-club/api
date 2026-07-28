import { afterEach, describe, expect, test } from "bun:test"
import { Interface, Wallet } from "ethers"

import type { Env } from "../../../env"
import { realChain, settlementGasLimit } from "./operator-chain-real"

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
    // Mirror the ceilings pinned into the reviewed action source.
    LIT_REWARDS_MAX_FEE_PER_GAS_WEI: "50000000000",
    LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI: "25000000000",
    LIT_REWARDS_MAX_GAS_LIMIT: "300000",
    LIT_REWARDS_SIGNING_DEADLINE_SECONDS: "300",
  } as Env
}

describe("real rewards Lit vault signer wiring", () => {
  test("uses the reviewed Lit vault gas ceiling instead of the local-transfer default", () => {
    expect(settlementGasLimit(env(), "lit_vault")).toBe(300_000n)
    expect(settlementGasLimit(env(), "local")).toBe(100_000n)
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

    const clocks = [2_000_000_000_000, 2_000_100_000_000]
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
})
