import { afterEach, describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import type { Env } from "../../env"
import {
  parseSignedStoryCoordinatorTransaction,
  setStorySettlementProviderFactoryForTests,
  storySettlementRealChain,
  type StorySettlementProvider,
} from "./story-settlement-chain-real"

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const ADDRESS = new Wallet(PRIVATE_KEY).address as `0x${string}`
const TARGET = "0x1111111111111111111111111111111111111111" as const
const TX_HASH = `0x${"22".repeat(32)}` as `0x${string}`
const BLOCK_HASH = `0x${"33".repeat(32)}`

function env(overrides: Partial<Env> = {}): Env {
  return {
    STORY_CHAIN_ID: "1315",
    STORY_COORDINATOR_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
    STORY_COORDINATOR_SIGNER_ADDRESS: ADDRESS,
    STORY_SETTLEMENT_FEE_POLICY_VERSION: "aeneid-fees-v1",
    STORY_SETTLEMENT_FINALITY_POLICY_VERSION: "aeneid-finality-v1",
    STORY_COORDINATOR_MAX_FEE_PER_GAS_WEI: "5000000000",
    STORY_COORDINATOR_MAX_PRIORITY_FEE_PER_GAS_WEI: "2000000000",
    STORY_COORDINATOR_GAS_LIMIT_MAX: "1500000",
    STORY_COORDINATOR_GAS_ESTIMATE_BUFFER_BPS: "12000",
    STORY_COORDINATOR_FINALITY_CONFIRMATIONS: "3",
    STORY_COORDINATOR_FINALITY_PREFER_SAFE_BLOCK: "true",
    ...overrides,
  } as Env
}

function fakeProvider(overrides: Partial<StorySettlementProvider> = {}): StorySettlementProvider {
  return {
    broadcastTransaction: async () => ({}),
    estimateGas: async () => 100_000n,
    getBlock: async (tag) => tag === "safe"
      ? { hash: `0x${"44".repeat(32)}`, number: 101 }
      : { hash: BLOCK_HASH, number: Number(tag) },
    getBlockNumber: async () => 101,
    getFeeData: async () => ({
      gasPrice: null,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getTransaction: async () => null,
    getTransactionCount: async (_address, blockTag) => blockTag === "pending" ? 8 : 7,
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 100, blockHash: BLOCK_HASH }),
    send: async (method) => method === "eth_chainId" ? "0x523" : null,
    ...overrides,
  }
}

afterEach(() => setStorySettlementProviderFactoryForTests(null))

describe("Story settlement production chain primitives", () => {
  test("keeps the ordinary no-override path on the configured Story RPC", async () => {
    const urls: string[] = []
    setStorySettlementProviderFactoryForTests((rpcUrl) => {
      urls.push(rpcUrl)
      return fakeProvider()
    })
    await storySettlementRealChain.pendingNonce(env({
      ENVIRONMENT: "production",
      STORY_RPC_URL: "https://ordinary-story.example",
    }), {
      chainId: 1315,
      signerAddress: ADDRESS,
    })
    expect(urls).toEqual(["https://ordinary-story.example"])
  })

  test("uses the coordinator-only RPC override without changing the Story runtime RPC", async () => {
    const urls: string[] = []
    setStorySettlementProviderFactoryForTests((rpcUrl) => {
      urls.push(rpcUrl)
      return fakeProvider()
    })
    await storySettlementRealChain.pendingNonce(env({
      STORY_RPC_URL: "https://registration.example",
      STORY_COORDINATOR_RPC_URL: "https://coordinator.example",
      STORY_COORDINATOR_RPC_AUTH_TOKEN: "test-only-token",
    }), {
      chainId: 1315,
      signerAddress: ADDRESS,
    })
    expect(urls).toEqual(["https://coordinator.example"])
  })

  test("fails closed on a partial coordinator RPC override", async () => {
    await expect(storySettlementRealChain.pendingNonce(env({
      STORY_COORDINATOR_RPC_URL: "https://coordinator.example",
    }), {
      chainId: 1315,
      signerAddress: ADDRESS,
    })).rejects.toThrow("story_coordinator_rpc_override_incomplete")
  })

  test("forbids every coordinator RPC override in production", async () => {
    await expect(storySettlementRealChain.pendingNonce(env({
      ENVIRONMENT: "production",
      STORY_COORDINATOR_RPC_URL: "https://coordinator.example",
      STORY_COORDINATOR_RPC_AUTH_TOKEN: "test-only-token",
    }), {
      chainId: 1315,
      signerAddress: ADDRESS,
    })).rejects.toThrow("story_coordinator_rpc_override_forbidden_in_production")
  })

  test("signs the exact coordinator domain with the exclusive key", async () => {
    setStorySettlementProviderFactoryForTests(() => fakeProvider())
    const signed = await storySettlementRealChain.signTransaction(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      nonce: 8,
      target: TARGET,
      value: 123n,
      calldata: "0x1234",
      gas: { maxFeePerGas: 3n, maxPriorityFeePerGas: 2n, gasLimit: 50_000n },
    })
    const parsed = parseSignedStoryCoordinatorTransaction(signed)
    expect(parsed.from).toBe(ADDRESS)
    expect(parsed.chainId).toBe(1315n)
    expect(parsed.nonce).toBe(8)
    expect(parsed.to).toBe(TARGET)
    expect(parsed.value).toBe(123n)
    expect(parsed.data).toBe("0x1234")
  })

  test("derives capped gas only for the configured immutable policy version", async () => {
    setStorySettlementProviderFactoryForTests(() => fakeProvider())
    expect(await storySettlementRealChain.gasParameters(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      feePolicyVersion: "aeneid-fees-v1",
      target: TARGET,
      value: 1n,
      calldata: "0x",
    })).toEqual({
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 135_000n,
    })
    await expect(storySettlementRealChain.gasParameters(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      feePolicyVersion: "unreviewed",
      target: TARGET,
      value: 1n,
      calldata: "0x",
    })).rejects.toThrow("story_coordinator_fee_policy_version_unsupported")
  })

  test("fails closed when the configured RPC serves another chain", async () => {
    setStorySettlementProviderFactoryForTests(() => fakeProvider({
      send: async () => "0x1",
    }))
    await expect(storySettlementRealChain.pendingNonce(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
    })).rejects.toThrow("story_coordinator_rpc_chain_id_mismatch")
  })

  test("reads native IP and WIP balances without a write method", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = []
    setStorySettlementProviderFactoryForTests(() => fakeProvider({
      send: async (method, params) => {
        calls.push({ method, params })
        if (method === "eth_chainId") return "0x523"
        if (method === "eth_getBalance") return "0x64"
        if (method === "eth_call") return "0xc8"
        throw new Error(`unexpected RPC method: ${method}`)
      },
    }))
    const domain = { chainId: 1315, signerAddress: ADDRESS }
    expect(await storySettlementRealChain.nativeBalance(env(), domain)).toBe(100n)
    expect(await storySettlementRealChain.wipBalance(env(), domain)).toBe(200n)
    expect(calls.map((call) => call.method)).toEqual([
      "eth_chainId", "eth_getBalance", "eth_chainId", "eth_call",
    ])
    expect(calls[1]!.params).toEqual([ADDRESS, "latest"])
    expect(calls[3]!.params).toEqual([
      expect.objectContaining({ to: "0x1514000000000000000000000000000000000000" }),
      "latest",
    ])
  })

  test("requires canonical receipt evidence and finality before confirmation", async () => {
    setStorySettlementProviderFactoryForTests(() => fakeProvider())
    expect(await storySettlementRealChain.observeTransaction(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      transactionHash: TX_HASH,
      finalityPolicyVersion: "aeneid-finality-v1",
    })).toEqual({
      kind: "mined",
      status: "success",
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      final: true,
    })

    setStorySettlementProviderFactoryForTests(() => fakeProvider({
      getBlock: async (tag) => tag === "safe"
        ? { hash: `0x${"44".repeat(32)}`, number: 99 }
        : { hash: BLOCK_HASH, number: Number(tag) },
    }))
    expect(await storySettlementRealChain.observeTransaction(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      transactionHash: TX_HASH,
      finalityPolicyVersion: "aeneid-finality-v1",
    })).toMatchObject({ kind: "mined", final: false })

    setStorySettlementProviderFactoryForTests(() => fakeProvider({
      getBlock: async (tag) => tag === "safe"
        ? { hash: `0x${"44".repeat(32)}`, number: 101 }
        : { hash: `0x${"55".repeat(32)}`, number: Number(tag) },
    }))
    expect(await storySettlementRealChain.observeTransaction(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      transactionHash: TX_HASH,
      finalityPolicyVersion: "aeneid-finality-v1",
    })).toEqual({ kind: "absent" })
  })

  test("accepts an ambiguous exact-byte rebroadcast only when the hash is observable", async () => {
    let observable = true
    setStorySettlementProviderFactoryForTests(() => fakeProvider({
      broadcastTransaction: async () => { throw new Error("rpc timeout") },
      getTransaction: async () => observable ? { hash: TX_HASH } : null,
    }))
    const signed = await storySettlementRealChain.signTransaction(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      nonce: 8,
      target: TARGET,
      value: 0n,
      calldata: "0x",
      gas: { maxFeePerGas: 3n, maxPriorityFeePerGas: 2n, gasLimit: 21_000n },
    })
    await expect(storySettlementRealChain.broadcastExactTransaction(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      signedTransaction: signed,
    })).resolves.toBeUndefined()
    observable = false
    await expect(storySettlementRealChain.broadcastExactTransaction(env(), {
      chainId: 1315,
      signerAddress: ADDRESS,
      signedTransaction: signed,
    })).rejects.toThrow("rpc timeout")
  })
})
