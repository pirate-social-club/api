import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { encodeAbiParameters, encodeEventTopics } from "viem"
import { buildTestEnv } from "./helpers"
import type { Asset, Env } from "../src/types"

const sdkClientModulePath = new URL("../src/lib/posts/story-cdr-sdk-client.ts", import.meta.url).pathname

const sdkState = {
  initWasmCalls: 0,
  clientConfigs: [] as Array<Record<string, unknown>>,
  storageUploads: [] as Array<Uint8Array>,
}

const rpcState = {
  methods: [] as string[],
  rawTxs: [] as string[],
}

const originalFetch = globalThis.fetch

async function expectErrorMessage(
  promise: Promise<unknown>,
  pattern: string,
): Promise<void> {
  try {
    await promise
    throw new Error("expected_promise_to_reject")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(new RegExp(pattern))
  }
}

mock.module(sdkClientModulePath, () => ({
  initWasm: async () => {
    sdkState.initWasmCalls += 1
  },
  CDRClient: class MockCDRClient {
    observer = {
      getGlobalPubKey: async () => new Uint8Array(34).fill(4),
    }

    uploader = {
      encryptDataKey: async () => ({
        raw: new Uint8Array([1, 2, 3]),
        label: new Uint8Array([4]),
      }),
    }

    constructor(config: Record<string, unknown>) {
      sdkState.clientConfigs.push(config)
    }
  },
}))

describe("story-cdr-sdk-runtime", () => {
  let communityDbRoot: string

  beforeEach(async () => {
    communityDbRoot = await mkdtemp(join(tmpdir(), "pirate-v2-cdr-sdk-runtime-"))
    sdkState.initWasmCalls = 0
    sdkState.clientConfigs.length = 0
    sdkState.storageUploads.length = 0
    rpcState.methods.length = 0
    rpcState.rawTxs.length = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}")) as {
        method?: string
        params?: Array<Record<string, unknown>>
      }
      const method = String(payload.method || "")
      rpcState.methods.push(method)
      if (method === "eth_call") {
        const data = String((payload.params?.[0] as { data?: unknown } | undefined)?.data || "")
        if (data.startsWith("0xf8b5ac35")) {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: encodeAbiParameters(
              [{
                name: "vault",
                type: "tuple",
                components: [
                  { name: "updatable", type: "bool" },
                  { name: "writeConditionAddr", type: "address" },
                  { name: "readConditionAddr", type: "address" },
                  { name: "writeConditionData", type: "bytes" },
                  { name: "readConditionData", type: "bytes" },
                  { name: "encryptedData", type: "bytes" },
                ],
              }],
              [{
                updatable: false,
                writeConditionAddr: "0x3333333333333333333333333333333333333333",
                readConditionAddr: "0x2222222222222222222222222222222222222222",
                writeConditionData: encodeAbiParameters(
                  [{ name: "owner", type: "address" }],
                  ["0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"],
                ),
                readConditionData: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                encryptedData: "0x1234",
              }],
            ),
          })
        }
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: "0x0000000000000000000000000000000000000000000000000000000000000001",
        })
      }
      if (method === "eth_sendRawTransaction") {
        const txHash = rpcState.rawTxs.length === 0
          ? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          : "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        rpcState.rawTxs.push(String(payload.params?.[0] || ""))
        return Response.json({ jsonrpc: "2.0", id: 1, result: txHash })
      }
      if (method === "eth_getTransactionReceipt") {
        const txHash = String(payload.params?.[0] || "")
        if (txHash === "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
          const writeConditionAddr = "0x3333333333333333333333333333333333333333"
          const readConditionAddr = "0x2222222222222222222222222222222222222222"
          const writeConditionData = encodeAbiParameters(
            [{ name: "owner", type: "address" }],
            ["0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"],
          )
          const readConditionData = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              status: "0x1",
              blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
              blockNumber: "0x1",
              contractAddress: null,
              cumulativeGasUsed: "0x1",
              effectiveGasPrice: "0x1",
              from: "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
              gasUsed: "0x1",
              logs: [{
                address: "0xcccccc0000000000000000000000000000000005",
                topics: encodeEventTopics({
                  abi: [{
                    type: "event",
                    name: "VaultAllocated",
                    anonymous: false,
                    inputs: [
                      { indexed: false, name: "uuid", type: "uint32" },
                      { indexed: false, name: "updatable", type: "bool" },
                      { indexed: false, name: "writeConditionAddr", type: "address" },
                      { indexed: false, name: "readConditionAddr", type: "address" },
                      { indexed: false, name: "writeConditionData", type: "bytes" },
                      { indexed: false, name: "readConditionData", type: "bytes" },
                    ],
                  }],
                  eventName: "VaultAllocated",
                }),
                data: encodeAbiParameters(
                  [
                    { name: "uuid", type: "uint32" },
                    { name: "updatable", type: "bool" },
                    { name: "writeConditionAddr", type: "address" },
                    { name: "readConditionAddr", type: "address" },
                    { name: "writeConditionData", type: "bytes" },
                    { name: "readConditionData", type: "bytes" },
                  ],
                  [77, false, writeConditionAddr, readConditionAddr, writeConditionData, readConditionData],
                ),
                blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
                blockNumber: "0x1",
                transactionHash: txHash,
                transactionIndex: "0x0",
                logIndex: "0x0",
                removed: false,
              }],
              logsBloom: `0x${"0".repeat(512)}`,
              to: "0xcccccc0000000000000000000000000000000005",
              transactionHash: txHash,
              transactionIndex: "0x0",
              type: "0x2",
            },
          })
        }
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "0x1",
            blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
            blockNumber: "0x2",
            contractAddress: null,
            cumulativeGasUsed: "0x1",
            effectiveGasPrice: "0x1",
            from: "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
            gasUsed: "0x1",
            logs: [{
              address: "0xcccccc0000000000000000000000000000000005",
              topics: encodeEventTopics({
                abi: [{
                  type: "event",
                  name: "VaultWritten",
                  anonymous: false,
                  inputs: [
                    { indexed: false, name: "uuid", type: "uint32" },
                    { indexed: false, name: "encryptedData", type: "bytes" },
                  ],
                }],
                eventName: "VaultWritten",
              }),
              data: encodeAbiParameters(
                [
                  { name: "uuid", type: "uint32" },
                  { name: "encryptedData", type: "bytes" },
                ],
                [77, "0x1234"],
              ),
              blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
              blockNumber: "0x2",
              transactionHash: txHash,
              transactionIndex: "0x0",
              logIndex: "0x0",
              removed: false,
            }],
            logsBloom: `0x${"0".repeat(512)}`,
            to: "0xcccccc0000000000000000000000000000000005",
            transactionHash: txHash,
            transactionIndex: "0x0",
            type: "0x2",
          },
        })
      }
      if (method === "eth_blockNumber") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x2" })
      }
      if (method === "eth_getTransactionCount") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x0" })
      }
      if (method === "eth_chainId") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x523" })
      }
      throw new Error(`unexpected_rpc_method:${method}`)
    }) as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(communityDbRoot, { recursive: true, force: true })
  })

  test("uploadSongAssetToCdrViaSdk uploads the primary content through the SDK and persists the encrypted blob", async () => {
    const env = buildTestEnv({
      LOCAL_COMMUNITY_DB_ROOT: communityDbRoot,
      STORY_CDR_WRITER_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
      STORY_AENEID_RPC_URL: "https://story-rpc.test",
      STORY_CDR_READ_CONDITION_ADDRESS: "0x2222222222222222222222222222222222222222",
      STORY_CDR_WRITE_CONDITION_ADDRESS: "0x3333333333333333333333333333333333333333",
    })

    const [{ persistSongArtifactUpload }, runtimeModule, { readStoredSongArtifactBytes }] = await Promise.all([
      import("../src/lib/posts/local-song-artifact-upload-storage"),
      import("../src/lib/posts/story-cdr-sdk-runtime"),
      import("../src/lib/posts/song-artifact-storage"),
    ])

    const sourceBytes = new TextEncoder().encode("locked-song-source-audio")
    const persistedPrimary = await persistSongArtifactUpload({
      env,
      uploadId: "sdk_primary_audio_test",
      bytes: sourceBytes,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
    })

    const asset = {
      asset_id: "ast_sdk_locked_song",
      story_namespace: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      primary_content_ref: persistedPrimary.storageRef,
      primary_content_hash: persistedPrimary.contentHash,
    } as Partial<Asset> as Asset

    const result = await runtimeModule.uploadSongAssetToCdrViaSdk({
      env,
      asset,
      storyEntitlementTokenId: "12345",
    })

    expect(runtimeModule.hasStoryCdrSdkWriterConfigured(env)).toBe(true)
    expect(sdkState.initWasmCalls).toBe(1)
    expect(sdkState.clientConfigs).toHaveLength(1)
    expect(rpcState.methods).toContain("eth_call")
    expect(rpcState.methods.filter((value) => value === "eth_sendRawTransaction")).toHaveLength(2)

    expect(result.lockedDeliveryRef).toBe("cdr://vault/77")
    expect(result.lockedDeliveryPayload).toBeNull()
    expect(result.storyCdrVaultUuid).toBe(77)
    expect(result.storyEntitlementTokenId).toBe("12345")
    expect(result.storyCdrAllocateTxRef).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    expect(result.storyCdrWriteTxRef).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    expect(result.storyReadCondition).toBe("0x2222222222222222222222222222222222222222")
    expect(result.storyWriteCondition).toBe("0x3333333333333333333333333333333333333333")
    expect(result.storyCdrEncryptedCid).toMatch(/^local-song-artifact-upload\//)

    const encryptedBytes = await readStoredSongArtifactBytes(env, `ipfs://${result.storyCdrEncryptedCid}`)
    expect(encryptedBytes.byteLength).toBeGreaterThan(0)
    expect(Array.from(encryptedBytes)).not.toEqual(Array.from(sourceBytes))
  })

  test("uploadSongAssetToCdrViaSdk fails closed when the primary content ref is missing", async () => {
    const env = buildTestEnv({
      LOCAL_COMMUNITY_DB_ROOT: communityDbRoot,
      STORY_CDR_WRITER_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
      STORY_CDR_READ_CONDITION_ADDRESS: "0x2222222222222222222222222222222222222222",
    })
    const runtimeModule = await import("../src/lib/posts/story-cdr-sdk-runtime")

    const asset = {
      asset_id: "ast_sdk_missing_source",
      story_namespace: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      primary_content_ref: null,
      primary_content_hash: null,
    } as Partial<Asset> as Asset

    await expectErrorMessage(runtimeModule.uploadSongAssetToCdrViaSdk({
      env,
      asset,
      storyEntitlementTokenId: "12345",
    }), "primary_content_ref_missing")
  })

  test("uploadSongAssetToCdrViaSdk treats zero-length primary content as invalid", async () => {
    const env = buildTestEnv({
      LOCAL_COMMUNITY_DB_ROOT: communityDbRoot,
      STORY_CDR_WRITER_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
      STORY_CDR_READ_CONDITION_ADDRESS: "0x2222222222222222222222222222222222222222",
    })

    const [{ persistSongArtifactUpload }, runtimeModule] = await Promise.all([
      import("../src/lib/posts/local-song-artifact-upload-storage"),
      import("../src/lib/posts/story-cdr-sdk-runtime"),
    ])

    const persistedPrimary = await persistSongArtifactUpload({
      env,
      uploadId: "sdk_primary_audio_empty_test",
      bytes: new Uint8Array(),
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
    })

    const asset = {
      asset_id: "ast_sdk_empty_source",
      story_namespace: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      primary_content_ref: persistedPrimary.storageRef,
      primary_content_hash: persistedPrimary.contentHash,
    } as Partial<Asset> as Asset

    await expectErrorMessage(runtimeModule.uploadSongAssetToCdrViaSdk({
      env,
      asset,
      storyEntitlementTokenId: "12345",
    }), "locked_delivery_source_empty")
  })
})
