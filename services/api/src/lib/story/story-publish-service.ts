import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { Env } from "../../env"
import { resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { parseExpectedEvmAddress } from "../evm-signer"
import { resolveStoryOperatorDirectSigner } from "./story-direct-signer"
import { ensureStoryPublishOperatorAuthorized } from "./story-runtime-authorization"
import {
  DEFAULT_STORY_RPC_URL,
  STORY_DELIVERY_CONTRACTS,
  resolveStoryChainId,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const PURCHASE_ENTITLEMENT_TOKEN_ABI = [
  "function configureEntitlementClass(uint256 tokenId, bytes32 assetVersionId, uint32 cdrVaultUuid, bool active)",
] as const

const ASSET_PUBLISH_COORDINATOR_ABI = [
  "function publishAssetVersion(address publisher, bytes32 assetVersionId, uint32 cdrVaultUuid, bytes32 namespace, bytes32 contentHash, bytes32 storageRefHash, uint256 entitlementTokenId, address readCondition, address writeCondition)",
  "function publishedAssetVersions(bytes32 assetVersionId) view returns (address publisher, uint32 cdrVaultUuid, bytes32 namespace, bytes32 contentHash, bytes32 storageRefHash, uint256 entitlementTokenId, address readCondition, address writeCondition, bool active, bool exists)",
] as const

const ASSET_VERSION_ALREADY_PUBLISHED_SELECTOR = "0xcc747504"

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

function normalizePrivateKey(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim()
  if (!value) return null
  const withPrefix = value.startsWith("0x") ? value : `0x${value}`
  return /^0x[a-fA-F0-9]{64}$/.test(withPrefix) ? withPrefix : null
}

function errorData(error: unknown): string {
  if (!error || typeof error !== "object") return ""
  const direct = (error as { data?: unknown }).data
  if (typeof direct === "string") return direct
  const nested = (error as { error?: { data?: unknown } }).error?.data
  return typeof nested === "string" ? nested : ""
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
  const ownerPrivateKey = normalizePrivateKey(input.env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
  if (!ownerPrivateKey) {
    throw new Error("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  }
  const operatorConfig = resolveStoryOperatorDirectSigner(input.env)
  if (!operatorConfig.ok) throw new Error(operatorConfig.error)
  if (!operatorConfig.value) {
    throw new Error("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
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
  const ownerSigner = new Wallet(ownerPrivateKey, provider)
  const operatorSigner = new Wallet(operatorConfig.value.privateKey, provider)

  await ensureStoryPublishOperatorAuthorized({
    env: input.env,
    provider,
    operatorAddress: operatorSigner.address,
  })

  const configureTx = await sendContractTxWithPolicy({
    provider,
    signer: ownerSigner,
    contractAddress: STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
    abi: PURCHASE_ENTITLEMENT_TOKEN_ABI,
    functionName: "configureEntitlementClass",
    args: [
      input.entitlementTokenId,
      input.assetVersionId,
      input.cdrVaultUuid,
      true,
    ],
    gasPolicy: gasPolicy.value,
  })
  const configureReceipt = await configureTx.wait()
  if (!configureReceipt || configureReceipt.status !== 1) {
    throw new Error("story_entitlement_class_configure_failed")
  }

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
      contractAddress: STORY_DELIVERY_CONTRACTS.assetPublishCoordinatorV1,
      abi: ASSET_PUBLISH_COORDINATOR_ABI,
      functionName: "publishAssetVersion",
      args: publishArgs,
      gasPolicy: gasPolicy.value,
      signer: operatorSigner,
    })
    const publishReceipt = await provider.waitForTransaction(String(publishTx.hash || ""), 1, txWaitTimeoutMs)
    if (!publishReceipt || publishReceipt.status !== 1) {
      throw new Error("story_publish_asset_version_failed")
    }
  } catch (error) {
    if (!errorData(error).startsWith(ASSET_VERSION_ALREADY_PUBLISHED_SELECTOR)) {
      throw error
    }
    const coordinator = new Contract(
      STORY_DELIVERY_CONTRACTS.assetPublishCoordinatorV1,
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
    const matches = existing.exists === true
      && getAddress(existing.publisher) === getAddress(publishArgs[0])
      && Number(existing.cdrVaultUuid) === input.cdrVaultUuid
      && String(existing.namespace).toLowerCase() === input.namespace.toLowerCase()
      && String(existing.contentHash).toLowerCase() === input.contentHash.toLowerCase()
      && String(existing.storageRefHash).toLowerCase() === input.storageRefHash.toLowerCase()
      && BigInt(existing.entitlementTokenId) === input.entitlementTokenId
      && getAddress(existing.readCondition) === getAddress(readConditionAddress)
      && getAddress(existing.writeCondition) === getAddress(writeConditionAddress)
    if (!matches) {
      throw error
    }
  }

  return {
    entitlementConfiguredTxHash: String(configureTx.hash || ""),
    publishTxHash: publishTx ? String(publishTx.hash || "") : `already-published:${input.assetVersionId}`,
  }
}
