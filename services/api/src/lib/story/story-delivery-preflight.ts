import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { Env } from "../../env"
import { isLocalEnvironment } from "../helpers"
import {
  normalizeDirectSignerPrivateKey,
  resolveStoryAccessControllerDirectSigner,
  resolveStoryOperatorDirectSigner,
  resolveStorySettlementDirectSigner,
} from "./story-direct-signer"
import {
  type StoryDeliveryContracts,
  resolveStoryChainId,
  resolveStoryDeliveryContracts,
  resolveStoryRpcUrl,
} from "./story-runtime-config"

const OWNABLE_ABI = [
  "function owner() view returns (address)",
] as const

const PUBLISH_COORDINATOR_ABI = [
  "function isPublishOperator(address operator) view returns (bool)",
] as const

const MARKETPLACE_SETTLEMENT_ABI = [
  "function isSettlementOperator(address operator) view returns (bool)",
] as const

const PURCHASE_ENTITLEMENT_TOKEN_ABI = [
  "function isSettlementMinter(address minter) view returns (bool)",
] as const

const PIRATE_SIGNER_REGISTRY_ABI = [
  "function isActiveSigner(address signer) view returns (bool)",
] as const

export type StoryDeliveryPreflightConfig = {
  chainId: number
  rpcUrl: string
  ownerAddress: string
  operatorAddress: string
  accessSignerAddress: string
  settlementAddress: string
  contracts: StoryDeliveryContracts
  fingerprint: string
}

export type StoryDeliveryPreflightSummary = StoryDeliveryPreflightConfig & {
  skipped: false
}

type CachedStoryDeliveryPreflight = {
  fingerprint: string
  promise: Promise<StoryDeliveryPreflightSummary>
}

let cachedStoryDeliveryPreflight: CachedStoryDeliveryPreflight | null = null

export function shouldRunStoryDeliveryRuntimePreflight(env: Pick<Env, "ENVIRONMENT">): boolean {
  return !isLocalEnvironment(env.ENVIRONMENT)
}

function resolveOwnerAddress(env: Pick<Env, "STORY_CONTRACT_OWNER_PRIVATE_KEY">): string {
  const privateKey = normalizeDirectSignerPrivateKey(env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
  if (!privateKey) {
    throw new Error("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  }
  return getAddress(new Wallet(privateKey).address)
}

export function resolveStoryDeliveryPreflightConfig(env: Env): StoryDeliveryPreflightConfig {
  const ownerAddress = resolveOwnerAddress(env)
  const operatorConfig = resolveStoryOperatorDirectSigner(env)
  if (!operatorConfig.ok) throw new Error(operatorConfig.error)
  if (!operatorConfig.value) throw new Error("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
  const accessConfig = resolveStoryAccessControllerDirectSigner(env)
  if (!accessConfig.ok) throw new Error(accessConfig.error)
  if (!accessConfig.value) throw new Error("STORY_ACCESS_CONTROLLER_PRIVATE_KEY missing/invalid")
  const settlementConfig = resolveStorySettlementDirectSigner(env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")

  const config = {
    chainId: resolveStoryChainId(env),
    rpcUrl: resolveStoryRpcUrl(env),
    ownerAddress,
    operatorAddress: operatorConfig.value.address,
    accessSignerAddress: accessConfig.value.address,
    settlementAddress: settlementConfig.value.address,
    contracts: resolveStoryDeliveryContracts(env),
  }

  return {
    ...config,
    fingerprint: JSON.stringify(config),
  }
}

async function assertAddressHasCode(input: {
  provider: JsonRpcProvider
  name: keyof StoryDeliveryContracts
  address: string
}): Promise<void> {
  const code = await input.provider.getCode(input.address)
  if (code === "0x") {
    throw new Error(`story_delivery_preflight_no_code:${input.name}:${input.address}`)
  }
}

async function assertOwner(input: {
  provider: JsonRpcProvider
  name: keyof Pick<
    StoryDeliveryContracts,
    "purchaseEntitlementToken" | "pirateSignerRegistry" | "assetPublishCoordinatorV1" | "marketplaceSettlementV1"
  >
  address: string
  ownerAddress: string
}): Promise<void> {
  const contract = new Contract(input.address, OWNABLE_ABI, input.provider)
  const owner = getAddress(await contract.owner())
  if (owner !== input.ownerAddress) {
    throw new Error(`story_delivery_preflight_owner_mismatch:${input.name}:${owner}:expected:${input.ownerAddress}`)
  }
}

function assertGrant(active: boolean, grant: string, address: string): void {
  if (!active) {
    throw new Error(`story_delivery_preflight_missing_grant:${grant}:${address}`)
  }
}

async function runStoryDeliveryRuntimePreflight(
  config: StoryDeliveryPreflightConfig,
): Promise<StoryDeliveryPreflightSummary> {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)

  await Promise.all((Object.entries(config.contracts) as [keyof StoryDeliveryContracts, string][])
    .map(([name, address]) => assertAddressHasCode({ provider, name, address })))

  await Promise.all([
    assertOwner({
      provider,
      name: "purchaseEntitlementToken",
      address: config.contracts.purchaseEntitlementToken,
      ownerAddress: config.ownerAddress,
    }),
    assertOwner({
      provider,
      name: "pirateSignerRegistry",
      address: config.contracts.pirateSignerRegistry,
      ownerAddress: config.ownerAddress,
    }),
    assertOwner({
      provider,
      name: "assetPublishCoordinatorV1",
      address: config.contracts.assetPublishCoordinatorV1,
      ownerAddress: config.ownerAddress,
    }),
    assertOwner({
      provider,
      name: "marketplaceSettlementV1",
      address: config.contracts.marketplaceSettlementV1,
      ownerAddress: config.ownerAddress,
    }),
  ])

  const publishCoordinator = new Contract(
    config.contracts.assetPublishCoordinatorV1,
    PUBLISH_COORDINATOR_ABI,
    provider,
  )
  const marketplaceSettlement = new Contract(
    config.contracts.marketplaceSettlementV1,
    MARKETPLACE_SETTLEMENT_ABI,
    provider,
  )
  const purchaseEntitlementToken = new Contract(
    config.contracts.purchaseEntitlementToken,
    PURCHASE_ENTITLEMENT_TOKEN_ABI,
    provider,
  )
  const signerRegistry = new Contract(
    config.contracts.pirateSignerRegistry,
    PIRATE_SIGNER_REGISTRY_ABI,
    provider,
  )

  const [
    publishOperatorActive,
    settlementOperatorActive,
    settlementMinterActive,
    accessSignerActive,
  ] = await Promise.all([
    publishCoordinator.isPublishOperator(config.operatorAddress),
    marketplaceSettlement.isSettlementOperator(config.settlementAddress),
    purchaseEntitlementToken.isSettlementMinter(config.settlementAddress),
    signerRegistry.isActiveSigner(config.accessSignerAddress),
  ])

  assertGrant(Boolean(publishOperatorActive), "publish_operator", config.operatorAddress)
  assertGrant(Boolean(settlementOperatorActive), "settlement_operator", config.settlementAddress)
  assertGrant(Boolean(settlementMinterActive), "settlement_minter", config.settlementAddress)
  assertGrant(Boolean(accessSignerActive), "access_signer", config.accessSignerAddress)

  return {
    ...config,
    skipped: false,
  }
}

export async function assertStoryDeliveryRuntimePreflight(
  env: Env,
): Promise<StoryDeliveryPreflightSummary | { skipped: true }> {
  if (!shouldRunStoryDeliveryRuntimePreflight(env)) {
    return { skipped: true }
  }

  const config = resolveStoryDeliveryPreflightConfig(env)
  if (cachedStoryDeliveryPreflight?.fingerprint === config.fingerprint) {
    return cachedStoryDeliveryPreflight.promise
  }

  const promise = runStoryDeliveryRuntimePreflight(config)
  cachedStoryDeliveryPreflight = {
    fingerprint: config.fingerprint,
    promise,
  }

  try {
    return await promise
  } catch (error) {
    if (cachedStoryDeliveryPreflight?.promise === promise) {
      cachedStoryDeliveryPreflight = null
    }
    throw error
  }
}

export function resetStoryDeliveryRuntimePreflightForTests(): void {
  cachedStoryDeliveryPreflight = null
}
