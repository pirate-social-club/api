import { describe, expect, test } from "bun:test"

import {
  capStoryRoyaltyRpcFeeResponseForTests,
  capStoryRoyaltyWriteContractRequestForTests,
} from "./story-royalty-registration-service"
import type { DirectTxGasPolicy } from "../evm-direct-tx"

// 100 gwei fee cap, 1 gwei priority cap, 2M gas limit cap, 1.2x estimate buffer.
const GAS_POLICY: DirectTxGasPolicy = {
  maxFeePerGasCapWei: 100_000_000_000n,
  maxPriorityFeePerGasCapWei: 1_000_000_000n,
  gasLimitCap: 2_000_000n,
  gasEstimateBufferBps: 12_000n,
}

const GAS_LIMIT_PADDING = 15_000n

function rpcResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

function rpcRequest(method: string, params: unknown[] = []): string {
  return JSON.stringify({ id: 1, jsonrpc: "2.0", method, params })
}

async function capped(method: string, result: unknown): Promise<any> {
  const response = await capStoryRoyaltyRpcFeeResponseForTests(
    rpcResponse({ id: 1, jsonrpc: "2.0", result }),
    rpcRequest(method),
    GAS_POLICY,
  )
  return await response.json()
}

describe("capStoryRoyaltyWriteContractRequestForTests", () => {
  test("caps over-cap fees to the policy and strips legacy gasPrice", () => {
    const out = capStoryRoyaltyWriteContractRequestForTests(
      {
        gasPrice: 500_000_000_000n,
        maxFeePerGas: 500_000_000_000n,
        maxPriorityFeePerGas: 50_000_000_000n,
        data: "0xdead",
      },
      GAS_POLICY,
    ) as Record<string, unknown>
    expect(out.gasPrice).toBeUndefined()
    expect(out.maxFeePerGas).toBe(GAS_POLICY.maxFeePerGasCapWei)
    expect(out.maxPriorityFeePerGas).toBe(GAS_POLICY.maxPriorityFeePerGasCapWei)
    expect(out.data).toBe("0xdead") // untouched passthrough
  })

  test("preserves under-cap fees", () => {
    const out = capStoryRoyaltyWriteContractRequestForTests(
      { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 500_000_000n },
      GAS_POLICY,
    ) as Record<string, unknown>
    expect(out.maxFeePerGas).toBe(10_000_000_000n)
    expect(out.maxPriorityFeePerGas).toBe(500_000_000n)
  })

  test("rejects a caller-supplied over-cap gas limit (parity with the estimate path)", () => {
    expect(() => capStoryRoyaltyWriteContractRequestForTests({ gas: 9_000_000n }, GAS_POLICY)).toThrow(
      /story_royalty_gas_limit_exceeds_policy/,
    )
  })

  test("passes an under-cap gas limit through and leaves an absent one undefined", () => {
    const under = capStoryRoyaltyWriteContractRequestForTests(
      { gas: 1_000_000n },
      GAS_POLICY,
    ) as Record<string, unknown>
    expect(under.gas).toBe(1_000_000n)

    const absent = capStoryRoyaltyWriteContractRequestForTests({}, GAS_POLICY) as Record<string, unknown>
    expect(absent.gas).toBeUndefined() // must stay undefined so viem still estimates (revert detection)
  })
})

describe("capStoryRoyaltyRpcFeeResponseForTests — fee caps", () => {
  test("caps eth_gasPrice above the fee cap", async () => {
    const out = await capped("eth_gasPrice", "0x74a5220700") // 500 gwei
    expect(BigInt(out.result)).toBe(GAS_POLICY.maxFeePerGasCapWei)
  })

  test("caps eth_maxPriorityFeePerGas above the priority cap", async () => {
    const out = await capped("eth_maxPriorityFeePerGas", "0xba43b7400") // 50 gwei
    expect(BigInt(out.result)).toBe(GAS_POLICY.maxPriorityFeePerGasCapWei)
  })

  test("caps eth_feeHistory base fees and rewards", async () => {
    const out = await capped("eth_feeHistory", {
      oldestBlock: "0x1",
      baseFeePerGas: ["0x74a5220700", "0x1"], // 500 gwei, 1 wei
      reward: [["0xba43b7400", "0x1"]], // 50 gwei, 1 wei
    })
    expect(BigInt(out.result.baseFeePerGas[0])).toBe(GAS_POLICY.maxFeePerGasCapWei)
    expect(BigInt(out.result.baseFeePerGas[1])).toBe(1n) // under cap untouched
    expect(BigInt(out.result.reward[0][0])).toBe(GAS_POLICY.maxPriorityFeePerGasCapWei)
  })

  test("passes non-fee methods through unchanged", async () => {
    const out = await capped("eth_call", "0xabcdef")
    expect(out.result).toBe("0xabcdef")
  })
})

describe("capStoryRoyaltyRpcFeeResponseForTests — gas-limit enforcement", () => {
  test("buffers the estimate and returns it when under the cap", async () => {
    const estimate = 1_000_000n
    const out = await capped("eth_estimateGas", `0x${estimate.toString(16)}`)
    const expected = (estimate * GAS_POLICY.gasEstimateBufferBps) / 10_000n + GAS_LIMIT_PADDING
    expect(BigInt(out.result)).toBe(expected) // 1,215,000
    expect(out.error).toBeUndefined()
  })

  test("rejects with a policy error when the buffered estimate exceeds the cap", async () => {
    const estimate = 2_000_000n // buffered = 2,415,000 > 2,000,000 cap
    const out = await capped("eth_estimateGas", `0x${estimate.toString(16)}`)
    expect(out.result).toBeUndefined()
    expect(out.error?.code).toBe(-32000)
    expect(out.error?.message).toContain("story_royalty_gas_limit_exceeds_policy")
    expect(out.error?.message).toContain(GAS_POLICY.gasLimitCap.toString())
  })
})

describe("capStoryRoyaltyRpcFeeResponseForTests — passthrough guards", () => {
  test("returns the original response for non-JSON-RPC bodies", async () => {
    const response = await capStoryRoyaltyRpcFeeResponseForTests(rpcResponse({ result: "0x1" }), "not json", GAS_POLICY)
    const body = (await response.json()) as any
    expect(body.result).toBe("0x1")
  })

  test("caps entries positionally in a batch response", async () => {
    const requestBody = JSON.stringify([
      { id: 1, jsonrpc: "2.0", method: "eth_gasPrice", params: [] },
      { id: 2, jsonrpc: "2.0", method: "eth_call", params: [] },
    ])
    const response = await capStoryRoyaltyRpcFeeResponseForTests(
      rpcResponse([
        { id: 1, jsonrpc: "2.0", result: "0x74a5220700" }, // 500 gwei -> capped
        { id: 2, jsonrpc: "2.0", result: "0xabcdef" }, // eth_call -> untouched
      ]),
      requestBody,
      GAS_POLICY,
    )
    const body = (await response.json()) as any
    expect(BigInt(body[0].result)).toBe(GAS_POLICY.maxFeePerGasCapWei)
    expect(body[1].result).toBe("0xabcdef")
  })
})
