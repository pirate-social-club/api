import type { Env } from "../../env"
import { parseExpectedEvmAddress } from "../evm-signer"

export const DEFAULT_STORY_CHAIN_ID = 1315
export const DEFAULT_STORY_RPC_URL = "https://aeneid.storyrpc.io"
export const DEFAULT_STORY_TX_WAIT_TIMEOUT_MS = 45_000
export const DEFAULT_STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI = 250_000_000_000_000_000n
export const DEFAULT_STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI = 500_000_000_000_000_000n

export const STORY_DELIVERY_CONTRACTS = {
  purchaseEntitlementToken: "0x6952c089fE7b270268306313cF6E4CC7f566921c",
  purchaseEntitlementClassConfigurer: "0xB59c3bf6650C8F66B2Ad228cbE55C61B0C6bA9d6",
  pirateSignerRegistry: "0x8e25e5D2B6Fb9B3c5E703D737FE6b0E8b55253f3",
  tokenGateCondition: "0x29a859d9012ffc73443af5e3264c1605d44f6bcc",
  signedAccessConditionV1: "0xa8e49520c4d681d34fde757c41f5a06b87b52e43",
  assetPublishCoordinatorV1: "0xAD6919367E72F3D2390E837bEbf042368c2acfDf",
  marketplaceSettlementV1: "0x71c7ee1B0F108C7AC76AF12D70D8BE6fE13F8847",
} as const

export type StoryDeliveryContracts = {
  purchaseEntitlementToken: string
  purchaseEntitlementClassConfigurer: string
  pirateSignerRegistry: string
  tokenGateCondition: string
  signedAccessConditionV1: string
  assetPublishCoordinatorV1: string
  marketplaceSettlementV1: string
}

export function resolveStoryDeliveryContracts(env: Pick<
  Env,
  | "STORY_ASSET_PUBLISH_COORDINATOR_CONTRACT"
  | "STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT"
  | "STORY_MARKETPLACE_SETTLEMENT_CONTRACT"
  | "STORY_PIRATE_SIGNER_REGISTRY_CONTRACT"
  | "STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT"
>): StoryDeliveryContracts {
  return {
    purchaseEntitlementToken:
      parseExpectedEvmAddress(env.STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT)
      ?? STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
    purchaseEntitlementClassConfigurer:
      parseExpectedEvmAddress(env.STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT)
      ?? STORY_DELIVERY_CONTRACTS.purchaseEntitlementClassConfigurer,
    pirateSignerRegistry:
      parseExpectedEvmAddress(env.STORY_PIRATE_SIGNER_REGISTRY_CONTRACT)
      ?? STORY_DELIVERY_CONTRACTS.pirateSignerRegistry,
    tokenGateCondition: STORY_DELIVERY_CONTRACTS.tokenGateCondition,
    signedAccessConditionV1: STORY_DELIVERY_CONTRACTS.signedAccessConditionV1,
    assetPublishCoordinatorV1:
      parseExpectedEvmAddress(env.STORY_ASSET_PUBLISH_COORDINATOR_CONTRACT)
      ?? STORY_DELIVERY_CONTRACTS.assetPublishCoordinatorV1,
    marketplaceSettlementV1:
      parseExpectedEvmAddress(env.STORY_MARKETPLACE_SETTLEMENT_CONTRACT)
      ?? STORY_DELIVERY_CONTRACTS.marketplaceSettlementV1,
  }
}

export function resolveStoryCompositeReadConditionAddress(
  env: Pick<Env, "STORY_COMPOSITE_READ_CONDITION_ADDRESS">,
): string | null {
  return parseExpectedEvmAddress(env.STORY_COMPOSITE_READ_CONDITION_ADDRESS)
}

export function resolveStoryChainId(env: Pick<Env, "STORY_CHAIN_ID">): number {
  const raw = String(env.STORY_CHAIN_ID || "").trim()
  const parsed = raw ? Number(raw) : DEFAULT_STORY_CHAIN_ID
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STORY_CHAIN_ID
}

export function resolveStoryRpcUrl(env: Pick<Env, "STORY_RPC_URL">): string {
  const raw = String(env.STORY_RPC_URL || "").trim()
  return raw || DEFAULT_STORY_RPC_URL
}

export function resolveStoryRpcUrls(env: Pick<Env, "STORY_RPC_URL" | "STORY_RPC_FALLBACK_URLS">): string[] {
  const urls = [
    resolveStoryRpcUrl(env),
    ...String(env.STORY_RPC_FALLBACK_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ]
  const deduped = new Set<string>()
  for (const url of urls) {
    deduped.add(url.replace(/\/+$/, ""))
  }
  return [...deduped]
}

export function resolveStoryTxWaitTimeoutMs(env: Pick<Env, "STORY_TX_WAIT_TIMEOUT_MS">): number {
  const raw = String(env.STORY_TX_WAIT_TIMEOUT_MS || "").trim()
  const parsed = raw ? Number(raw) : DEFAULT_STORY_TX_WAIT_TIMEOUT_MS
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 300_000
    ? parsed
    : DEFAULT_STORY_TX_WAIT_TIMEOUT_MS
}

function parsePositiveBigInt(raw: string | null | undefined): bigint | null {
  const normalized = String(raw || "").trim()
  if (!normalized) return null
  if (!/^\d+$/.test(normalized)) return null
  try {
    const value = BigInt(normalized)
    return value > 0n ? value : null
  } catch {
    return null
  }
}

export function resolveStoryRuntimeSignerMinBalanceWei(
  env: Pick<Env, "STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI">,
): bigint {
  return parsePositiveBigInt(env.STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI) ?? DEFAULT_STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI
}

export function resolveStoryRuntimeSignerTargetBalanceWei(
  env: Pick<Env, "STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI" | "STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI">,
): bigint {
  const minBalance = resolveStoryRuntimeSignerMinBalanceWei(env)
  const target = parsePositiveBigInt(env.STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI) ?? DEFAULT_STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI
  return target >= minBalance ? target : minBalance
}
