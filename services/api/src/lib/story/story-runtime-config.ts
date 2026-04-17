import type { Env } from "../../types"

export const DEFAULT_STORY_CHAIN_ID = 1315
export const DEFAULT_STORY_RPC_URL = "https://rpc.ankr.com/story_aeneid_testnet"
export const DEFAULT_STORY_TX_WAIT_TIMEOUT_MS = 45_000

export const STORY_DELIVERY_CONTRACTS = {
  purchaseEntitlementToken: "0x0d3eF43a98077c9a71853309EE4C6665C20C1Fa6",
  pirateSignerRegistry: "0xFdbBd5B130Ce519e9CF3DFE070De241519C1f51C",
  tokenGateCondition: "0x1b5340517389bd91316ee7ac866b16f2e9387e96",
  signedAccessConditionV1: "0x82c30cf9524ad83c8a67e6b855d9c286c89586b3",
  assetPublishCoordinatorV1: "0xf68b731a5801A50e983E9302E32eF6DA22CB0792",
  marketplaceSettlementV1: "0xFECcC2cF8C9946E1384eF5733B509ac70677c5bd",
} as const

export function resolveStoryChainId(env: Pick<Env, "STORY_CHAIN_ID">): number {
  const raw = String(env.STORY_CHAIN_ID || "").trim()
  const parsed = raw ? Number(raw) : DEFAULT_STORY_CHAIN_ID
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STORY_CHAIN_ID
}

export function resolveStoryRpcUrl(env: Pick<Env, "STORY_RPC_URL">): string {
  const raw = String(env.STORY_RPC_URL || "").trim()
  return raw || DEFAULT_STORY_RPC_URL
}

export function resolveStoryTxWaitTimeoutMs(env: Pick<Env, "STORY_TX_WAIT_TIMEOUT_MS">): number {
  const raw = String(env.STORY_TX_WAIT_TIMEOUT_MS || "").trim()
  const parsed = raw ? Number(raw) : DEFAULT_STORY_TX_WAIT_TIMEOUT_MS
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 300_000
    ? parsed
    : DEFAULT_STORY_TX_WAIT_TIMEOUT_MS
}
