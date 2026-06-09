import { Contract, getAddress, JsonRpcProvider, Wallet } from "ethers"
import type { Env } from "../../env"
import { type DirectTxGasPolicy, resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { parseExpectedEvmAddress } from "../evm-signer"
import {
  resolveStoryEntitlementClassConfigurerDirectSigner,
  resolveStoryOperatorDirectSigner,
} from "./story-direct-signer"
import { ensureStoryPublishOperatorAuthorized } from "./story-runtime-authorization"
import {
  DEFAULT_STORY_RPC_URL,
  resolveStoryDeliveryContracts,
  resolveStoryChainId,
  resolveStoryEntitlementClassConfigurerContract,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const PURCHASE_ENTITLEMENT_TOKEN_ABI = [
  "function entitlementClasses(uint256 tokenId) view returns (bytes32 assetVersionId, uint32 cdrVaultUuid, bool active)",
  "function configureEntitlementClass(uint256 tokenId, bytes32 assetVersionId, uint32 cdrVaultUuid, bool active)",
] as const

const ENTITLEMENT_CLASS_CONFIGURER_ABI = [
  "function configureEntitlementClass(uint256 tokenId, bytes32 assetVersionId, uint32 cdrVaultUuid, bool active)",
] as const

const ASSET_PUBLISH_COORDINATOR_ABI = [
  "function publishedAssetVersions(bytes32 assetVersionId) view returns (bool)",
  "function publishAssetVersion(address publisher, bytes32 assetVersionId, uint32 cdrVaultUuid, bytes32 namespace, bytes32 contentHash, bytes32 storageRefHash, uint256 entitlementTokenId, address readCondition, address writeCondition)",
] as const

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

function normalizeBytes32(value: unknown): string {
  return String(value || "").trim().toLowerCase()
}

async function configureEntitlementClassForPublish(input: {
  env: Env
  provider: JsonRpcProvider
  purchaseEntitlementTokenAddress: string
  entitlementTokenId: bigint
  assetVersionId: `0x${string}`
  cdrVaultUuid: number
  gasPolicy: DirectTxGasPolicy
}): Promise<string> {
  const entitlementClassConfigurerContract = resolveStoryEntitlementClassConfigurerContract(input.env)
  if (entitlementClassConfigurerContract) {
    const configurerConfig = resolveStoryEntitlementClassConfigurerDirectSigner(input.env)
    if (!configurerConfig.ok) throw new Error(configurerConfig.error)
    if (!configurerConfig.value) {
      throw new Error("STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY missing/invalid")
    }
    const configurerSigner = new Wallet(configurerConfig.value.privateKey, input.provider)
    const configureTx = await sendContractTxWithPolicy({
      provider: input.provider,
      signer: configurerSigner,
      contractAddress: entitlementClassConfigurerContract,
      abi: ENTITLEMENT_CLASS_CONFIGURER_ABI,
      functionName: "configureEntitlementClass",
      args: [
        input.entitlementTokenId,
        input.assetVersionId,
        input.cdrVaultUuid,
        true,
      ],
      gasPolicy: input.gasPolicy,
    })
    const configureReceipt = await configureTx.wait()
    if (!configureReceipt || configureReceipt.status !== 1) {
      throw new Error("story_entitlement_class_configure_failed")
    }
    return String(configureTx.hash || "")
  }

  const ownerPrivateKey = normalizePrivateKey(input.env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
  if (!ownerPrivateKey) {
    throw new Error("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  }
  const ownerSigner = new Wallet(ownerPrivateKey, input.provider)
  const configureTx = await sendContractTxWithPolicy({
    provider: input.provider,
    signer: ownerSigner,
    contractAddress: input.purchaseEntitlementTokenAddress,
    abi: PURCHASE_ENTITLEMENT_TOKEN_ABI,
    functionName: "configureEntitlementClass",
    args: [
      input.entitlementTokenId,
      input.assetVersionId,
      input.cdrVaultUuid,
      true,
    ],
    gasPolicy: input.gasPolicy,
  })
  const configureReceipt = await configureTx.wait()
  if (!configureReceipt || configureReceipt.status !== 1) {
    throw new Error("story_entitlement_class_configure_failed")
  }
  return String(configureTx.hash || "")
}

export function classifyExistingEntitlementClassForPublish(input: {
  existingAssetVersionId: unknown
  existingCdrVaultUuid: unknown
  existingActive: unknown
  assetVersionId: `0x${string}`
  cdrVaultUuid: number
}): "missing" | "matching" {
  const existingAssetVersionId = normalizeBytes32(input.existingAssetVersionId)
  const existingCdrVaultUuid = Number(input.existingCdrVaultUuid ?? 0)
  const existingActive = Boolean(input.existingActive)
  if (!existingActive && /^0x0{64}$/.test(existingAssetVersionId)) {
    return "missing"
  }
  if (
    existingActive
    && existingAssetVersionId === input.assetVersionId.toLowerCase()
    && existingCdrVaultUuid === input.cdrVaultUuid
  ) {
    return "matching"
  }
  throw new Error(
    `story_entitlement_class_mismatch:${JSON.stringify({
      expectedAssetVersionId: input.assetVersionId,
      expectedCdrVaultUuid: input.cdrVaultUuid,
      existingAssetVersionId,
      existingCdrVaultUuid,
      existingActive,
    })}`,
  )
}

async function resolveEntitlementClassStatus(input: {
  contract: Contract
  entitlementTokenId: bigint
  assetVersionId: `0x${string}`
  cdrVaultUuid: number
}): Promise<"missing" | "matching"> {
  const existing = await input.contract.entitlementClasses(input.entitlementTokenId)
  return classifyExistingEntitlementClassForPublish({
    existingAssetVersionId: existing?.assetVersionId ?? existing?.[0],
    existingCdrVaultUuid: existing?.cdrVaultUuid ?? existing?.[1] ?? 0,
    existingActive: existing?.active ?? existing?.[2],
    assetVersionId: input.assetVersionId,
    cdrVaultUuid: input.cdrVaultUuid,
  })
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
  const operatorSigner = new Wallet(operatorConfig.value.privateKey, provider)
  const deliveryContracts = resolveStoryDeliveryContracts(input.env)

  const entitlementContract = new Contract(
    deliveryContracts.purchaseEntitlementToken,
    PURCHASE_ENTITLEMENT_TOKEN_ABI,
    provider,
  )
  let entitlementConfiguredTxHash = "already_configured"
  const entitlementClassStatus = await resolveEntitlementClassStatus({
    contract: entitlementContract,
    entitlementTokenId: input.entitlementTokenId,
    assetVersionId: input.assetVersionId,
    cdrVaultUuid: input.cdrVaultUuid,
  })
  if (entitlementClassStatus === "missing") {
    entitlementConfiguredTxHash = await configureEntitlementClassForPublish({
      env: input.env,
      provider,
      purchaseEntitlementTokenAddress: deliveryContracts.purchaseEntitlementToken,
      entitlementTokenId: input.entitlementTokenId,
      assetVersionId: input.assetVersionId,
      cdrVaultUuid: input.cdrVaultUuid,
      gasPolicy: gasPolicy.value,
    })
  }

  const publishCoordinator = new Contract(
    deliveryContracts.assetPublishCoordinatorV1,
    ASSET_PUBLISH_COORDINATOR_ABI,
    provider,
  )
  let publishTxHash = "already_published"
  const alreadyPublished = Boolean(await publishCoordinator.publishedAssetVersions(input.assetVersionId))
  if (!alreadyPublished) {
    await ensureStoryPublishOperatorAuthorized({
      env: input.env,
      provider,
      operatorAddress: operatorSigner.address,
    })

    const publishTx = await sendContractTxWithPolicy({
      provider,
      contractAddress: deliveryContracts.assetPublishCoordinatorV1,
      abi: ASSET_PUBLISH_COORDINATOR_ABI,
      functionName: "publishAssetVersion",
      args: [
        getAddress(publisherAddress),
        input.assetVersionId,
        input.cdrVaultUuid,
        input.namespace,
        input.contentHash,
        input.storageRefHash,
        input.entitlementTokenId,
        getAddress(readConditionAddress),
        getAddress(writeConditionAddress),
      ],
      gasPolicy: gasPolicy.value,
      signer: operatorSigner,
    })
    const publishReceipt = await provider.waitForTransaction(String(publishTx.hash || ""), 1, txWaitTimeoutMs)
    if (!publishReceipt || publishReceipt.status !== 1) {
      throw new Error("story_publish_asset_version_failed")
    }
    publishTxHash = String(publishTx.hash || "")
  }

  return {
    entitlementConfiguredTxHash,
    publishTxHash,
  }
}
