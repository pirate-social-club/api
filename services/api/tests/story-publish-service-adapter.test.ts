import { beforeEach, describe, expect, test } from "bun:test"
import type { Env } from "../src/types"

const ownerPrivateKey = "0x1000000000000000000000000000000000000000000000000000000000000001"
const operatorPrivateKey = "0x2000000000000000000000000000000000000000000000000000000000000002"
const ownerAddress = "0x1000000000000000000000000000000000000001"
const operatorAddress = "0x2000000000000000000000000000000000000002"
const publisherAddress = "0xAAa0000000000000000000000000000000000000"
const readConditionAddress = "0xbBb0000000000000000000000000000000000000"
const writeConditionAddress = "0xCcc0000000000000000000000000000000000000"
const purchaseEntitlementToken = "0x6952c089fE7b270268306313cF6E4CC7f566921c"
const assetPublishCoordinator = "0xAD6919367E72F3D2390E837bEbf042368c2acfDf"

const defaultGasPolicy = {
  maxFeePerGasCapWei: 5_000_000_000n,
  maxPriorityFeePerGasCapWei: 2_000_000_000n,
  gasLimitCap: 1_500_000n,
  gasEstimateBufferBps: 12_000n,
}

const captured = {
  providerConstructorArgs: null as unknown,
  sendContractTxCalls: [] as unknown[],
  ensureStoryPublishOperatorAuthorized: null as unknown,
  waitForTransactionArgs: null as unknown,
  configureTxHash: "0xconfiguretx",
  publishTxHash: "0xpublishtx",
  configureReceiptResult: { status: 1 } as unknown,
  publishReceiptResult: { status: 1 } as unknown,
  events: [] as string[],
}

function resetCaptured(): void {
  captured.providerConstructorArgs = null
  captured.sendContractTxCalls = []
  captured.ensureStoryPublishOperatorAuthorized = null
  captured.waitForTransactionArgs = null
  captured.configureTxHash = "0xconfiguretx"
  captured.publishTxHash = "0xpublishtx"
  captured.configureReceiptResult = { status: 1 }
  captured.publishReceiptResult = { status: 1 }
  captured.events = []
}

function addressForPrivateKey(privateKey: string): string {
  if (privateKey === ownerPrivateKey) return ownerAddress
  if (privateKey === operatorPrivateKey) return operatorAddress
  return "0x9999999999999999999999999999999999999999"
}

import {
  publishLockedAssetVersionToStory,
  setStoryAssetPublishAdapterDepsForTests,
  setStoryAssetPublisherForTests,
} from "../src/lib/story/story-publish-service"

function installAdapterDeps(): void {
  setStoryAssetPublishAdapterDepsForTests({
    createJsonRpcProvider: (rpcUrl, chainId) => {
      captured.providerConstructorArgs = [rpcUrl, chainId]
      return {
        waitForTransaction: async (...args: unknown[]) => {
          captured.waitForTransactionArgs = args
          return captured.publishReceiptResult
        },
      } as never
    },
    createWallet: (privateKey, provider) => ({
      privateKey,
      provider,
      address: addressForPrivateKey(privateKey),
    } as never),
    sendContractTxWithPolicy: async (params: { functionName?: string }) => {
      captured.sendContractTxCalls.push(params)
      if (params.functionName === "configureEntitlementClass") {
        captured.events.push("configure")
        return {
          hash: captured.configureTxHash,
          wait: async () => captured.configureReceiptResult,
        } as never
      }
      if (params.functionName === "publishAssetVersion") {
        captured.events.push("publish")
        return {
          hash: captured.publishTxHash,
          wait: async () => captured.publishReceiptResult,
        } as never
      }
      throw new Error(`unexpected functionName ${String(params.functionName)}`)
    },
    ensureStoryPublishOperatorAuthorized: async (params: unknown) => {
      captured.events.push("authorize")
      captured.ensureStoryPublishOperatorAuthorized = params
    },
  })
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    STORY_CONTRACT_OWNER_PRIVATE_KEY: ownerPrivateKey,
    STORY_OPERATOR_PRIVATE_KEY: operatorPrivateKey,
    STORY_CHAIN_ID: "1315",
    STORY_RPC_URL: "https://story-rpc.test",
    STORY_TX_WAIT_TIMEOUT_MS: "12000",
    ...overrides,
  } as Env
}

function buildPublishInput(overrides: Partial<Parameters<typeof publishLockedAssetVersionToStory>[0]> = {}): Parameters<typeof publishLockedAssetVersionToStory>[0] {
  return {
    env: buildEnv(),
    publisherAddress: "0xaaa0000000000000000000000000000000000000",
    assetVersionId: `0x${"11".repeat(32)}`,
    cdrVaultUuid: 4242,
    namespace: `0x${"22".repeat(32)}`,
    contentHash: `0x${"33".repeat(32)}`,
    storageRefHash: `0x${"44".repeat(32)}`,
    entitlementTokenId: 99n,
    readConditionAddress: "0xbbb0000000000000000000000000000000000000",
    writeConditionAddress: "0xccc0000000000000000000000000000000000000",
    rightsBasis: "original",
    upstreamAssetRefs: null,
    ...overrides,
  }
}

beforeEach(() => {
  resetCaptured()
  setStoryAssetPublisherForTests(null)
  installAdapterDeps()
})

describe("publishLockedAssetVersionToStory adapter", () => {
  test("throws when owner private key is missing", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      env: buildEnv({ STORY_CONTRACT_OWNER_PRIVATE_KEY: undefined }),
    }))).rejects.toThrow("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  })

  test("throws when owner private key is invalid", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      env: buildEnv({ STORY_CONTRACT_OWNER_PRIVATE_KEY: "not-a-key" }),
    }))).rejects.toThrow("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  })

  test("throws when operator private key is missing", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      env: buildEnv({ STORY_OPERATOR_PRIVATE_KEY: undefined }),
    }))).rejects.toThrow("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
  })

  test("throws when operator private key is invalid", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      env: buildEnv({ STORY_OPERATOR_PRIVATE_KEY: "not-a-key" }),
    }))).rejects.toThrow("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
  })

  test("throws when publisher address is invalid", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      publisherAddress: "",
    }))).rejects.toThrow("publisherAddress missing/invalid")
  })

  test("throws when read condition address is invalid", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      readConditionAddress: "not-an-address",
    }))).rejects.toThrow("readConditionAddress missing/invalid")
  })

  test("throws when write condition address is invalid", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      writeConditionAddress: "not-an-address",
    }))).rejects.toThrow("writeConditionAddress missing/invalid")
  })

  test("propagates gas policy errors before sending txs", async () => {
    await expect(publishLockedAssetVersionToStory(buildPublishInput({
      env: buildEnv({ STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI: "not-a-number" }),
    })))
      .rejects.toThrow("Invalid STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI")

    expect(captured.sendContractTxCalls).toHaveLength(0)
    expect(captured.events).toEqual([])
  })

  test("configures entitlement, authorizes operator, publishes asset, and returns tx hashes", async () => {
    const result = await publishLockedAssetVersionToStory(buildPublishInput())

    expect(result).toEqual({
      entitlementConfiguredTxHash: "0xconfiguretx",
      publishTxHash: "0xpublishtx",
    })
    expect(captured.providerConstructorArgs).toEqual(["https://story-rpc.test", 1315])
    expect(captured.events).toEqual(["configure", "authorize", "publish"])

    expect(captured.sendContractTxCalls).toHaveLength(2)
    expect(captured.sendContractTxCalls[0]).toMatchObject({
      contractAddress: purchaseEntitlementToken,
      functionName: "configureEntitlementClass",
      args: [
        99n,
        `0x${"11".repeat(32)}`,
        4242,
        true,
      ],
      gasPolicy: defaultGasPolicy,
    })
    expect((captured.sendContractTxCalls[0] as { signer?: { address?: string } }).signer?.address)
      .toBe(ownerAddress)

    expect(captured.ensureStoryPublishOperatorAuthorized).toMatchObject({
      operatorAddress,
    })

    expect(captured.sendContractTxCalls[1]).toMatchObject({
      contractAddress: assetPublishCoordinator,
      functionName: "publishAssetVersion",
      args: [
        publisherAddress,
        `0x${"11".repeat(32)}`,
        4242,
        `0x${"22".repeat(32)}`,
        `0x${"33".repeat(32)}`,
        `0x${"44".repeat(32)}`,
        99n,
        readConditionAddress,
        writeConditionAddress,
      ],
      gasPolicy: defaultGasPolicy,
    })
    expect((captured.sendContractTxCalls[1] as { signer?: { address?: string } }).signer?.address)
      .toBe(operatorAddress)
    expect(captured.waitForTransactionArgs).toEqual(["0xpublishtx", 1, 12000])
  })

  test("throws story_entitlement_class_configure_failed when configure receipt status is 0", async () => {
    captured.configureReceiptResult = { status: 0 }

    await expect(publishLockedAssetVersionToStory(buildPublishInput()))
      .rejects.toThrow("story_entitlement_class_configure_failed")

    expect(captured.events).toEqual(["configure"])
  })

  test("throws story_entitlement_class_configure_failed when configure receipt is null", async () => {
    captured.configureReceiptResult = null

    await expect(publishLockedAssetVersionToStory(buildPublishInput()))
      .rejects.toThrow("story_entitlement_class_configure_failed")

    expect(captured.events).toEqual(["configure"])
  })

  test("throws story_publish_asset_version_failed when publish receipt status is 0", async () => {
    captured.publishReceiptResult = { status: 0 }

    await expect(publishLockedAssetVersionToStory(buildPublishInput()))
      .rejects.toThrow("story_publish_asset_version_failed")

    expect(captured.events).toEqual(["configure", "authorize", "publish"])
  })

  test("throws story_publish_asset_version_failed when publish receipt is null", async () => {
    captured.publishReceiptResult = null

    await expect(publishLockedAssetVersionToStory(buildPublishInput()))
      .rejects.toThrow("story_publish_asset_version_failed")

    expect(captured.events).toEqual(["configure", "authorize", "publish"])
  })
})
