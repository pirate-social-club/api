import { afterEach, describe, expect, test } from "bun:test"
import { Interface, hexlify } from "ethers"
import { __storyCdrTestHooks } from "../src/lib/story/story-cdr"

const DKG_ADDRESS = "0xcccccc0000000000000000000000000000000004"
const DKG_ABI = [
  "event Finalized(uint32 round,address indexed validatorAddr,bytes32 enclaveType,bytes32 codeCommitment,bytes32 participantsRoot,bytes globalPubKey,bytes[] publicCoeffs,bytes pubKeyShare,bytes signature)",
] as const

function buildFinalizedLog(globalPubKey: `0x${string}`): { topics: string[]; data: string } {
  const iface = new Interface(DKG_ABI)
  const event = iface.getEvent("Finalized")
  if (!event) {
    throw new Error("Finalized event missing from test ABI")
  }
  return iface.encodeEventLog(event, [
    14,
    "0x1111111111111111111111111111111111111111",
    `0x${"22".repeat(32)}`,
    `0x${"33".repeat(32)}`,
    `0x${"44".repeat(32)}`,
    globalPubKey,
    [],
    "0x",
    "0x",
  ])
}

function installCdrCryptoLoaderForTests(options: { throwOnLoad?: boolean } = {}): void {
  __storyCdrTestHooks.setCdrCryptoLoaderForTests(async () => {
    if (options.throwOnLoad) {
      throw new Error("cdr crypto unavailable")
    }
    return {
      CURVE_ED25519: 1087,
      initWasm: async () => {},
      tdh2Encrypt: async () => ({ raw: new Uint8Array() }),
    }
  })
}

afterEach(() => {
  __storyCdrTestHooks.setCdrCryptoLoaderForTests(null)
  __storyCdrTestHooks.setStoryJsonRpcProviderFactoryForTests(null)
})

describe("story CDR DKG observer", () => {
  test("finds a Finalized DKG event outside the first lookback window", async () => {
    installCdrCryptoLoaderForTests()
    const globalPubKey = `0x${"ab".repeat(32)}` as `0x${string}`
    const finalizedLog = buildFinalizedLog(globalPubKey)
    const finalizedTopic = finalizedLog.topics[0]
    const eventBlock = 80_000
    const calls: Array<{
      fromBlock: number
      toBlock: number
      topics?: readonly string[]
    }> = []
    const provider = {
      async getBlockNumber() {
        return 200_000
      },
      async getLogs(filter: {
        address: string
        fromBlock: number
        toBlock: number
        topics?: readonly string[]
      }) {
        calls.push({
          fromBlock: filter.fromBlock,
          toBlock: filter.toBlock,
          topics: filter.topics,
        })
        if (filter.address === DKG_ADDRESS && filter.fromBlock <= eventBlock && filter.toBlock >= eventBlock) {
          return [finalizedLog]
        }
        return []
      },
    }

    const resolved = await __storyCdrTestHooks.readLatestDkgGlobalPubKey({
      provider: provider as never,
      dkgAddress: DKG_ADDRESS,
    })

    expect(hexlify(resolved)).toBe(`0x043f${"ab".repeat(32)}`)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[0]).toEqual({
      fromBlock: 150_000,
      toBlock: 200_000,
      topics: [finalizedTopic],
    })
    expect(calls.some((call) => call.fromBlock <= eventBlock && call.toBlock >= eventBlock)).toBe(true)
    expect(calls.every((call) => call.topics?.[0] === finalizedTopic)).toBe(true)
  })

  test("surfaces CDR crypto loader errors instead of reporting missing DKG finalization", async () => {
    installCdrCryptoLoaderForTests({ throwOnLoad: true })
    const finalizedLog = buildFinalizedLog(`0x${"cd".repeat(32)}` as `0x${string}`)
    const provider = {
      async getBlockNumber() {
        return 200_000
      },
      async getLogs() {
        return [finalizedLog]
      },
    }

    await expect(__storyCdrTestHooks.readLatestDkgGlobalPubKey({
      provider: provider as never,
      dkgAddress: DKG_ADDRESS,
    })).rejects.toThrow("cdr crypto unavailable")
  })

  test("uses configured fallback RPCs for DKG lookup when the primary provider fails", async () => {
    installCdrCryptoLoaderForTests()
    const globalPubKey = `0x${"ef".repeat(32)}` as `0x${string}`
    const finalizedLog = buildFinalizedLog(globalPubKey)
    const createdFallbackProviders: string[] = []
    const destroyedFallbackProviders: string[] = []
    const primaryProvider = {
      async getBlockNumber() {
        throw new Error("primary rpc unavailable")
      },
      async getLogs() {
        throw new Error("primary rpc unavailable")
      },
    }
    __storyCdrTestHooks.setStoryJsonRpcProviderFactoryForTests((rpcUrl) => {
      createdFallbackProviders.push(rpcUrl)
      return {
        async getBlockNumber() {
          return 200_000
        },
        async getLogs() {
          return [finalizedLog]
        },
        destroy() {
          destroyedFallbackProviders.push(rpcUrl)
        },
      } as never
    })

    const resolved = await __storyCdrTestHooks.readLatestDkgGlobalPubKeyWithFallback({
      env: {
        STORY_RPC_URL: "https://primary.story.test",
        STORY_RPC_FALLBACK_URLS: "https://fallback.story.test",
      },
      chainId: 1315,
      dkgAddress: DKG_ADDRESS,
      primaryProvider: primaryProvider as never,
    })

    expect(hexlify(resolved)).toBe(`0x043f${"ef".repeat(32)}`)
    expect(createdFallbackProviders).toEqual(["https://fallback.story.test"])
    expect(destroyedFallbackProviders).toEqual(["https://fallback.story.test"])
  })
})
