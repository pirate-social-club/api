import { getAddress } from "ethers"

import type { Env } from "../../env"
import { providerUnavailable } from "../errors"

export type RewardTicketPoolConfig = {
  enabled: boolean
  mainnetEnabled: boolean
  chainId: 0 | 84532 | 8453
  rpcUrl: string
  jackpotAddress: string
  randomTicketBuyerAddress: string
  ticketNftAddress: string
  usdcTokenAddress: string
  custodyAddress: string
  referrerAddress: string
  sourceTag: string
  priceQuoteTtlSeconds: number
  entryCutoffSeconds: number
  purchaseReviewTtlSeconds: number
  sweepStaleSeconds: number
  alertOwner: string
  alertDestination: string
}

const BASE_SEPOLIA_CHAIN_ID = 84532
const BASE_MAINNET_CHAIN_ID = 8453

function enabled(raw: string | undefined): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true"
}

function required(raw: string | undefined, key: string): string {
  const value = String(raw ?? "").trim()
  if (!value) {
    throw providerUnavailable(`Megapot ticket-pool configuration ${key} is required`, { key }, false)
  }
  return value
}

function positiveInteger(raw: string | undefined, key: string): number {
  const value = Number(required(raw, key))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw providerUnavailable(`Megapot ticket-pool configuration ${key} is invalid`, { key }, false)
  }
  return value
}

function address(raw: string | undefined, key: string): string {
  try {
    return getAddress(required(raw, key))
  } catch {
    throw providerUnavailable(`Megapot ticket-pool configuration ${key} is invalid`, { key }, false)
  }
}

function sourceTag(raw: string | undefined): string {
  const value = required(raw, "MEGAPOT_SOURCE_TAG")
  if (new TextEncoder().encode(value).length > 32) {
    throw providerUnavailable(
      "Megapot ticket-pool configuration MEGAPOT_SOURCE_TAG must fit in bytes32",
      { key: "MEGAPOT_SOURCE_TAG" },
      false,
    )
  }
  return value
}

function disabledConfig(): RewardTicketPoolConfig {
  return {
    enabled: false,
    mainnetEnabled: false,
    chainId: 0,
    rpcUrl: "",
    jackpotAddress: "",
    randomTicketBuyerAddress: "",
    ticketNftAddress: "",
    usdcTokenAddress: "",
    custodyAddress: "",
    referrerAddress: "",
    sourceTag: "",
    priceQuoteTtlSeconds: 0,
    entryCutoffSeconds: 0,
    purchaseReviewTtlSeconds: 0,
    sweepStaleSeconds: 0,
    alertOwner: "",
    alertDestination: "",
  }
}

/**
 * Resolve only public Megapot protocol configuration. Private signing keys
 * are intentionally not returned here; the purchase worker will resolve and
 * use them in its narrowly scoped broadcast path.
 */
export function resolveRewardTicketPoolConfig(env: Env): RewardTicketPoolConfig {
  if (!enabled(env.REWARD_TICKET_POOLS_ENABLED)) return disabledConfig()

  const chainIdRaw = required(env.MEGAPOT_CHAIN_ID, "MEGAPOT_CHAIN_ID")
  const chainId = Number(chainIdRaw)
  if (
    !Number.isSafeInteger(chainId)
    || (chainId !== BASE_SEPOLIA_CHAIN_ID && chainId !== BASE_MAINNET_CHAIN_ID)
  ) {
    throw providerUnavailable("Megapot ticket-pool chain is not supported", { chain_id: chainIdRaw }, false)
  }

  const mainnetEnabled = enabled(env.REWARD_TICKET_POOLS_MAINNET_ENABLED)
  if (chainId === BASE_MAINNET_CHAIN_ID && !mainnetEnabled) {
    throw providerUnavailable(
      "Megapot ticket-pool mainnet promotion is disabled",
      { chain_id: chainId },
      false,
    )
  }

  const rpcUrl = required(env.MEGAPOT_RPC_URL, "MEGAPOT_RPC_URL")
  if (!/^https:\/\//i.test(rpcUrl)) {
    throw providerUnavailable("Megapot ticket-pool RPC URL must use HTTPS", { key: "MEGAPOT_RPC_URL" }, false)
  }

  return {
    enabled: true,
    mainnetEnabled,
    chainId: chainId as RewardTicketPoolConfig["chainId"],
    rpcUrl,
    jackpotAddress: address(env.MEGAPOT_JACKPOT_ADDRESS, "MEGAPOT_JACKPOT_ADDRESS"),
    randomTicketBuyerAddress: address(
      env.MEGAPOT_RANDOM_TICKET_BUYER_ADDRESS,
      "MEGAPOT_RANDOM_TICKET_BUYER_ADDRESS",
    ),
    ticketNftAddress: address(env.MEGAPOT_TICKET_NFT_ADDRESS, "MEGAPOT_TICKET_NFT_ADDRESS"),
    usdcTokenAddress: address(env.MEGAPOT_USDC_TOKEN_ADDRESS, "MEGAPOT_USDC_TOKEN_ADDRESS"),
    custodyAddress: address(env.MEGAPOT_CUSTODY_ADDRESS, "MEGAPOT_CUSTODY_ADDRESS"),
    referrerAddress: address(env.MEGAPOT_REFERRER_ADDRESS, "MEGAPOT_REFERRER_ADDRESS"),
    sourceTag: sourceTag(env.MEGAPOT_SOURCE_TAG),
    priceQuoteTtlSeconds: positiveInteger(
      env.MEGAPOT_PRICE_QUOTE_TTL_SECONDS,
      "MEGAPOT_PRICE_QUOTE_TTL_SECONDS",
    ),
    entryCutoffSeconds: positiveInteger(
      env.MEGAPOT_ENTRY_CUTOFF_SECONDS,
      "MEGAPOT_ENTRY_CUTOFF_SECONDS",
    ),
    purchaseReviewTtlSeconds: positiveInteger(
      env.MEGAPOT_PURCHASE_REVIEW_TTL_SECONDS,
      "MEGAPOT_PURCHASE_REVIEW_TTL_SECONDS",
    ),
    sweepStaleSeconds: positiveInteger(
      env.MEGAPOT_SWEEP_STALE_SECONDS,
      "MEGAPOT_SWEEP_STALE_SECONDS",
    ),
    alertOwner: required(env.MEGAPOT_ALERT_OWNER, "MEGAPOT_ALERT_OWNER"),
    alertDestination: required(env.MEGAPOT_ALERT_DESTINATION, "MEGAPOT_ALERT_DESTINATION"),
  }
}
