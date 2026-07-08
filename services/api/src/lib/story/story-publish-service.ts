import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { TransactionResponse } from "ethers"
import type { Env } from "../../env"
import { resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { parseExpectedEvmAddress } from "../evm-signer"
import {
  resolveStoryEntitlementClassConfigurerDirectSigner,
  resolveStoryOperatorDirectSigner,
} from "./story-direct-signer"
import { ensureStoryPublishOperatorAuthorized } from "./story-runtime-authorization"
import {
  DEFAULT_STORY_RPC_URL,
  resolveStoryChainId,
  resolveStoryDeliveryContracts,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const PURCHASE_ENTITLEMENT_CLASS_CONFIGURER_ABI = [
  "function configureEntitlementClass(uint256 tokenId, bytes32 assetVersionId, uint32 cdrVaultUuid, bool active)",
] as const

const ASSET_PUBLISH_COORDINATOR_ABI = [
  "function publishAssetVersion(address publisher, bytes32 assetVersionId, uint32 cdrVaultUuid, bytes32 namespace, bytes32 contentHash, bytes32 storageRefHash, uint256 entitlementTokenId, address readCondition, address writeCondition)",
  "function publishedAssetVersions(bytes32 assetVersionId) view returns (address publisher, uint32 cdrVaultUuid, bytes32 namespace, bytes32 contentHash, bytes32 storageRefHash, uint256 entitlementTokenId, address readCondition, address writeCondition, bool active, bool exists)",
] as const

const ASSET_VERSION_ALREADY_PUBLISHED_SELECTOR = "0xcc747504"

export type PublishedAssetVersionSnapshot = {
  publisher: string
  cdrVaultUuid: bigint | number
  namespace: string
  contentHash: string
  storageRefHash: string
  entitlementTokenId: bigint
  readCondition: string
  writeCondition: string
  active: boolean
  exists: boolean
}

export type StoryAssetPublishResult = {
  entitlementConfiguredTxHash: string
  publishTxHash: string
  storyIpId?: string | null
  storyRoyaltyPolicyId?: string | null
  storyDerivativeParentIpIds?: string[] | null
  storyRoyaltyRegistrationStatus?: "none" | "pending" | "registered" | "failed" | null
}

let testPublisher: ((input: {
  env: Env
  publisherAddress: string
  assetVersionId: `0x${string}`
  cdrVaultUuid: number
  namespace: `0x${string}`
  contentHash: `0x${string}`
  storageRefHash: `0x${string}`
  entitlementTokenId: bigint
  readConditionAddress: string
  writeConditionAddress: string
  rightsBasis: "none" | "original" | "derivative"
  upstreamAssetRefs: string[] | null
}) => Promise<StoryAssetPublishResult>) | null = null

export function setStoryAssetPublisherForTests(
  publisher: ((input: {
    env: Env
    publisherAddress: string
    assetVersionId: `0x${string}`
    cdrVaultUuid: number
    namespace: `0x${string}`
    contentHash: `0x${string}`
    storageRefHash: `0x${string}`
    entitlementTokenId: bigint
    readConditionAddress: string
    writeConditionAddress: string
    rightsBasis: "none" | "original" | "derivative"
    upstreamAssetRefs: string[] | null
  }) => Promise<StoryAssetPublishResult>) | null,
): void {
  testPublisher = publisher
}

function errorData(error: unknown): string {
  if (!error || typeof error !== "object") return ""
  const direct = (error as { data?: unknown }).data
  if (typeof direct === "string") return direct
  const nested = (error as { error?: { data?: unknown } }).error?.data
  return typeof nested === "string" ? nested : ""
}

async function waitForStoryTxReceipt(input: {
  provider: JsonRpcProvider
  tx: TransactionResponse
  timeoutMs: number
  failureCode: string
}): Promise<void> {
  const receipt = await input.provider.waitForTransaction(String(input.tx.hash || ""), 1, input.timeoutMs)
  if (!receipt || receipt.status !== 1) {
    throw new Error(input.failureCode)
  }
}

export async function configureStoryEntitlementClass(input: {
  provider: JsonRpcProvider
  signer: Wallet
  configurerContractAddress: string
  entitlementTokenId: bigint
  assetVersionId: `0x${string}`
  cdrVaultUuid: number
  gasPolicy: Parameters<typeof sendContractTxWithPolicy>[0]["gasPolicy"]
  txWaitTimeoutMs: number
}): Promise<TransactionResponse> {
  const configureTx = await sendContractTxWithPolicy({
    provider: input.provider,
    signer: input.signer,
    contractAddress: input.configurerContractAddress,
    abi: PURCHASE_ENTITLEMENT_CLASS_CONFIGURER_ABI,
    functionName: "configureEntitlementClass",
    args: [
      input.entitlementTokenId,
      input.assetVersionId,
      input.cdrVaultUuid,
      true,
    ],
    gasPolicy: input.gasPolicy,
    defaultWaitTimeoutMs: input.txWaitTimeoutMs,
  })
  await waitForStoryTxReceipt({
    provider: input.provider,
    tx: configureTx,
    timeoutMs: input.txWaitTimeoutMs,
    failureCode: "story_entitlement_class_configure_failed",
  })
  return configureTx
}

export function publishedAssetVersionMatches(input: {
  existing: PublishedAssetVersionSnapshot
  expected: {
    publisherAddress: string
    cdrVaultUuid: number
    namespace: string
    contentHash: string
    storageRefHash: string
    entitlementTokenId: bigint
    readConditionAddress: string
    writeConditionAddress: string
  }
}): boolean {
  const { existing, expected } = input
  return existing.exists === true
    && getAddress(existing.publisher) === getAddress(expected.publisherAddress)
    && Number(existing.cdrVaultUuid) === expected.cdrVaultUuid
    && String(existing.namespace).toLowerCase() === expected.namespace.toLowerCase()
    && String(existing.contentHash).toLowerCase() === expected.contentHash.toLowerCase()
    && String(existing.storageRefHash).toLowerCase() === expected.storageRefHash.toLowerCase()
    && BigInt(existing.entitlementTokenId) === expected.entitlementTokenId
    && getAddress(existing.readCondition) === getAddress(expected.readConditionAddress)
    && getAddress(existing.writeCondition) === getAddress(expected.writeConditionAddress)
}

export async function publishLockedAssetVersionToStory(input: {
  env: Env
  publisherAddress: string
  assetVersionId: `0x${string}`
  cdrVaultUuid: number
  namespace: `0x${string}`
  contentHash: `0x${string}`
  storageRefHash: `0x${string}`
  entitlementTokenId: bigint
  readConditionAddress: string
  writeConditionAddress: string
  rightsBasis: "none" | "original" | "derivative"
  upstreamAssetRefs: string[] | null
}): Promise<StoryAssetPublishResult> {
  if (testPublisher) {
    return await testPublisher(input)
  }
  const operatorConfig = resolveStoryOperatorDirectSigner(input.env)
  if (!operatorConfig.ok) throw new Error(operatorConfig.error)
  if (!operatorConfig.value) {
    throw new Error("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
  }
  const classConfigurerConfig = resolveStoryEntitlementClassConfigurerDirectSigner(input.env)
  if (!classConfigurerConfig.ok) throw new Error(classConfigurerConfig.error)
  if (!classConfigurerConfig.value) {
    throw new Error("STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY missing/invalid")
  }

  const publisherAddress = parseExpectedEvmAddress(input.publisherAddress)
  if (!publisherAddress) {
    throw new Error("publisherAddress missing/invalid")
  }
  const readConditionAddress = parseExpectedEvmAddress(input.readConditionAddress)
  if (!readConditionAddress) {
    throw new Error("readConditionAddress missing/invalid")
  }
  const writeConditionAddress = parseExpectedEvmAddress(input.writeConditionAddress)
  if (!writeConditionAddress) {
    throw new Error("writeConditionAddress missing/invalid")
  }

  const chainId = resolveStoryChainId(input.env)
  const rpcUrl = resolveStoryRpcUrl(input.env) || DEFAULT_STORY_RPC_URL
  const txWaitTimeoutMs = resolveStoryTxWaitTimeoutMs(input.env)
  const deliveryContracts = resolveStoryDeliveryContracts(input.env)
  const gasPolicy = resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: input.env.STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: input.env.STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: input.env.STORY_DIRECT_TX_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: input.env.STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_DIRECT_TX_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS",
  })
  if (!gasPolicy.ok) throw new Error(gasPolicy.error)

  const provider = new JsonRpcProvider(rpcUrl, chainId)
  const operatorSigner = new Wallet(operatorConfig.value.privateKey, provider)
  const classConfigurerSigner = new Wallet(classConfigurerConfig.value.privateKey, provider)

  await ensureStoryPublishOperatorAuthorized({
    env: input.env,
    provider,
    operatorAddress: operatorSigner.address,
  })

  const configureTx = await configureStoryEntitlementClass({
    provider,
    signer: classConfigurerSigner,
    configurerContractAddress: deliveryContracts.purchaseEntitlementClassConfigurer,
    entitlementTokenId: input.entitlementTokenId,
    assetVersionId: input.assetVersionId,
    cdrVaultUuid: input.cdrVaultUuid,
    gasPolicy: gasPolicy.value,
    txWaitTimeoutMs,
  })

  const publishArgs = [
    getAddress(publisherAddress),
    input.assetVersionId,
    input.cdrVaultUuid,
    input.namespace,
    input.contentHash,
    input.storageRefHash,
    input.entitlementTokenId,
    getAddress(readConditionAddress),
    getAddress(writeConditionAddress),
  ] as const
  let publishTx: Awaited<ReturnType<typeof sendContractTxWithPolicy>> | null = null
  try {
    publishTx = await sendContractTxWithPolicy({
      provider,
      contractAddress: deliveryContracts.assetPublishCoordinatorV1,
      abi: ASSET_PUBLISH_COORDINATOR_ABI,
      functionName: "publishAssetVersion",
      args: publishArgs,
      gasPolicy: gasPolicy.value,
      defaultWaitTimeoutMs: txWaitTimeoutMs,
      signer: operatorSigner,
    })
    await waitForStoryTxReceipt({
      provider,
      tx: publishTx,
      timeoutMs: txWaitTimeoutMs,
      failureCode: "story_publish_asset_version_failed",
    })
  } catch (error) {
    if (!errorData(error).startsWith(ASSET_VERSION_ALREADY_PUBLISHED_SELECTOR)) {
      throw error
    }
    const coordinator = new Contract(
      deliveryContracts.assetPublishCoordinatorV1,
      ASSET_PUBLISH_COORDINATOR_ABI,
      provider,
    )
    const existing = await coordinator.publishedAssetVersions(input.assetVersionId) as {
      publisher: string
      cdrVaultUuid: bigint | number
      namespace: string
      contentHash: string
      storageRefHash: string
      entitlementTokenId: bigint
      readCondition: string
      writeCondition: string
      active: boolean
      exists: boolean
    }
    const matches = publishedAssetVersionMatches({
      existing,
      expected: {
        publisherAddress: publishArgs[0],
        cdrVaultUuid: input.cdrVaultUuid,
        namespace: input.namespace,
        contentHash: input.contentHash,
        storageRefHash: input.storageRefHash,
        entitlementTokenId: input.entitlementTokenId,
        readConditionAddress,
        writeConditionAddress,
      },
    })
    if (!matches) {
      throw error
    }
  }

  return {
    entitlementConfiguredTxHash: String(configureTx.hash || ""),
    publishTxHash: publishTx ? String(publishTx.hash || "") : `already-published:${input.assetVersionId}`,
  }
}
