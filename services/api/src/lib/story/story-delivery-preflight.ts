import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { Env } from "../../env"
import { isLocalEnvironment } from "../helpers"
import { parseExpectedEvmAddress } from "../evm-signer"
import {
  normalizeDirectSignerPrivateKey,
  resolveStoryAccessControllerDirectSigner,
  resolveStoryEntitlementClassConfigurerDirectSigner,
  resolveStoryOperatorDirectSigner,
  resolveStorySettlementDirectSigner,
} from "./story-direct-signer"
import {
  type StoryDeliveryContracts,
  resolveStoryChainId,
  resolveStoryDeliveryContracts,
  resolveStoryEntitlementClassConfigurerContract,
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

const ENTITLEMENT_CLASS_CONFIGURER_ABI = [
  "function isClassConfigurer(address configurer) view returns (bool)",
] as const

export type StoryDeliveryPreflightConfig = {
  chainId: number
  rpcUrl: string
  ownerAddress: string
  operatorAddress: string
  accessSignerAddress: string
  settlementAddress: string
  entitlementClassConfigurerContract: string | null
  entitlementClassConfigurerAddress: string | null
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

function resolveOwnerAddress(
  env: Pick<Env, "STORY_DELIVERY_OWNER_ADDRESS" | "STORY_CONTRACT_OWNER_PRIVATE_KEY">,
  options: { allowConfiguredOwnerOnly: boolean },
): string {
  const configuredOwner = parseExpectedEvmAddress(env.STORY_DELIVERY_OWNER_ADDRESS)
  if (String(env.STORY_DELIVERY_OWNER_ADDRESS || "").trim()) {
    if (!configuredOwner) {
      throw new Error("STORY_DELIVERY_OWNER_ADDRESS missing/invalid")
    }
  }

  const privateKey = normalizeDirectSignerPrivateKey(env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
  if (privateKey) {
    const derivedOwner = getAddress(new Wallet(privateKey).address)
    if (configuredOwner && configuredOwner !== derivedOwner) {
      throw new Error(`STORY_DELIVERY_OWNER_ADDRESS mismatch: expected ${configuredOwner}, derived ${derivedOwner}`)
    }
    return derivedOwner
  }
  if (configuredOwner && options.allowConfiguredOwnerOnly) {
    return configuredOwner
  }
  throw new Error("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
}

export function resolveStoryDeliveryPreflightConfig(env: Env): StoryDeliveryPreflightConfig {
  const entitlementClassConfigurerContract = resolveStoryEntitlementClassConfigurerContract(env)
  const ownerAddress = resolveOwnerAddress(env, {
    allowConfiguredOwnerOnly: Boolean(entitlementClassConfigurerContract),
  })
  const operatorConfig = resolveStoryOperatorDirectSigner(env)
  if (!operatorConfig.ok) throw new Error(operatorConfig.error)
  if (!operatorConfig.value) throw new Error("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
  const accessConfig = resolveStoryAccessControllerDirectSigner(env)
  if (!accessConfig.ok) throw new Error(accessConfig.error)
  if (!accessConfig.value) throw new Error("STORY_ACCESS_CONTROLLER_PRIVATE_KEY missing/invalid")
  const settlementConfig = resolveStorySettlementDirectSigner(env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")

  let entitlementClassConfigurerAddress: string | null = null
  if (entitlementClassConfigurerContract) {
    const configurerConfig = resolveStoryEntitlementClassConfigurerDirectSigner(env)
    if (!configurerConfig.ok) throw new Error(configurerConfig.error)
    if (!configurerConfig.value) throw new Error("STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY missing/invalid")
    entitlementClassConfigurerAddress = configurerConfig.value.address
  }

  const config = {
    chainId: resolveStoryChainId(env),
    rpcUrl: resolveStoryRpcUrl(env),
    ownerAddress,
    operatorAddress: operatorConfig.value.address,
    accessSignerAddress: accessConfig.value.address,
    settlementAddress: settlementConfig.value.address,
    entitlementClassConfigurerContract,
    entitlementClassConfigurerAddress,
    contracts: resolveStoryDeliveryContracts(env),
  }

  return {
    ...config,
    fingerprint: JSON.stringify(config),
  }
}

async function assertAddressHasCode(input: {
  provider: JsonRpcProvider
  name: keyof StoryDeliveryContracts | "entitlementClassConfigurer"
  address: string
}): Promise<void> {
  const code = await input.provider.getCode(input.address)
  if (code === "0x") {
    throw new Error(`story_delivery_preflight_no_code:${input.name}:${input.address}`)
  }
}

async function assertOwner(input: {
  provider: JsonRpcProvider
  name:
    | keyof Pick<
      StoryDeliveryContracts,
      "purchaseEntitlementToken" | "pirateSignerRegistry" | "assetPublishCoordinatorV1" | "marketplaceSettlementV1"
    >
    | "entitlementClassConfigurer"
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

  const codeChecks = (Object.entries(config.contracts) as [keyof StoryDeliveryContracts, string][])
    .map(([name, address]) => assertAddressHasCode({ provider, name, address }))
  if (config.entitlementClassConfigurerContract) {
    codeChecks.push(assertAddressHasCode({
      provider,
      name: "entitlementClassConfigurer",
      address: config.entitlementClassConfigurerContract,
    }))
  }
  await Promise.all(codeChecks)

  await Promise.all([
    assertOwner({
      provider,
      name: "purchaseEntitlementToken",
      address: config.contracts.purchaseEntitlementToken,
      ownerAddress: config.entitlementClassConfigurerContract ?? config.ownerAddress,
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
    ...(config.entitlementClassConfigurerContract
      ? [
          assertOwner({
            provider,
            name: "entitlementClassConfigurer" as const,
            address: config.entitlementClassConfigurerContract,
            ownerAddress: config.ownerAddress,
          }),
        ]
      : []),
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
  const entitlementClassConfigurer = config.entitlementClassConfigurerContract
    ? new Contract(
        config.entitlementClassConfigurerContract,
        ENTITLEMENT_CLASS_CONFIGURER_ABI,
        provider,
      )
    : null

  const [
    publishOperatorActive,
    settlementOperatorActive,
    settlementMinterActive,
    accessSignerActive,
    classConfigurerActive,
  ] = await Promise.all([
    publishCoordinator.isPublishOperator(config.operatorAddress),
    marketplaceSettlement.isSettlementOperator(config.settlementAddress),
    purchaseEntitlementToken.isSettlementMinter(config.settlementAddress),
    signerRegistry.isActiveSigner(config.accessSignerAddress),
    entitlementClassConfigurer && config.entitlementClassConfigurerAddress
      ? entitlementClassConfigurer.isClassConfigurer(config.entitlementClassConfigurerAddress)
      : true,
  ])

  assertGrant(Boolean(publishOperatorActive), "publish_operator", config.operatorAddress)
  assertGrant(Boolean(settlementOperatorActive), "settlement_operator", config.settlementAddress)
  assertGrant(Boolean(settlementMinterActive), "settlement_minter", config.settlementAddress)
  assertGrant(Boolean(accessSignerActive), "access_signer", config.accessSignerAddress)
  if (config.entitlementClassConfigurerAddress) {
    assertGrant(Boolean(classConfigurerActive), "entitlement_class_configurer", config.entitlementClassConfigurerAddress)
  }

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
