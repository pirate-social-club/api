import { getAddress } from "ethers"

import type { Env } from "../../env"
import { providerUnavailable } from "../errors"
import { decodePublicPostId } from "../public-ids"

export type RewardCampaignConfig = {
  enabled: boolean
  chainId: number
  tokenAddress: string
  tokenDecimals: number
  tokenSymbol: string
  treasuryAddress: string
  rpcUrl: string
  quoteTtlSeconds: number
  minBudgetCents: number
  maxBudgetCents: number
  maxRewardCents: number
  minDurationSeconds: number
  maxDurationSeconds: number
  postAllowlist: ReadonlySet<string> | null
}

export type RewardCampaignAssetConfig = Pick<
  RewardCampaignConfig,
  "chainId" | "tokenAddress" | "tokenDecimals" | "tokenSymbol" | "treasuryAddress" | "rpcUrl"
>

const CAMPAIGN_ENV_KEYS = [
  "REWARDS_CAMPAIGN_CHAIN_ID",
  "REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS",
  "REWARDS_CAMPAIGN_TREASURY_ADDRESS",
  "REWARDS_CAMPAIGN_RPC_URL",
  "REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS",
  "REWARDS_CAMPAIGN_MIN_BUDGET_CENTS",
  "REWARDS_CAMPAIGN_MAX_BUDGET_CENTS",
  "REWARDS_CAMPAIGN_MAX_REWARD_CENTS",
  "REWARDS_CAMPAIGN_MIN_DURATION_SECONDS",
  "REWARDS_CAMPAIGN_MAX_DURATION_SECONDS",
] as const

const REWARD_CAMPAIGN_ASSET_ENV_KEYS = [
  "REWARDS_CAMPAIGN_CHAIN_ID",
  "REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS",
  "REWARDS_CAMPAIGN_TREASURY_ADDRESS",
  "REWARDS_CAMPAIGN_RPC_URL",
] as const

type CampaignEnvKey = typeof CAMPAIGN_ENV_KEYS[number]

function enabled(raw: string | undefined): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true"
}

function positiveInteger(env: Env, key: CampaignEnvKey): number {
  const value = Number(String(env[key] ?? "").trim())
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw providerUnavailable(`Reward campaign configuration ${key} is invalid`, { key }, false)
  }
  return value
}

function address(env: Env, key: Extract<CampaignEnvKey, "REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS" | "REWARDS_CAMPAIGN_TREASURY_ADDRESS">): string {
  try {
    return getAddress(String(env[key] ?? "").trim())
  } catch {
    throw providerUnavailable(`Reward campaign configuration ${key} is invalid`, { key }, false)
  }
}

export function resolveRewardCampaignAssetConfig(env: Env): RewardCampaignAssetConfig {
  const chainId = positiveInteger(env, "REWARDS_CAMPAIGN_CHAIN_ID")
  if (![8453, 84532].includes(chainId)) {
    throw providerUnavailable("Reward campaign chain is not supported", { chain_id: chainId }, false)
  }

  const configuredRpcUrl = String(env.REWARDS_CAMPAIGN_RPC_URL ?? "").trim()
  const fallbackRpcUrl = chainId === 8453
    ? String(env.BASE_MAINNET_RPC_URL ?? "").trim()
    : String(env.BASE_SEPOLIA_RPC_URL ?? "").trim()
  const rpcUrl = configuredRpcUrl || fallbackRpcUrl
  if (!/^https:\/\//i.test(rpcUrl)) {
    throw providerUnavailable("Reward campaign RPC URL is invalid", { key: "REWARDS_CAMPAIGN_RPC_URL" }, false)
  }
  const config = {
    chainId,
    tokenAddress: address(env, "REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS"),
    // The campaign asset is canonical USDC by construction: the env key is
    // USDC-named and settlement readiness pins it to the canonical settlement
    // token, so precision/display metadata is constant. A token registry
    // lookup replaces these literals when non-USDC assets are admitted.
    tokenDecimals: 6,
    tokenSymbol: "USDC",
    treasuryAddress: address(env, "REWARDS_CAMPAIGN_TREASURY_ADDRESS"),
    rpcUrl,
  }
  return config
}

export function resolveOptionalRewardCampaignAssetConfig(env: Env): RewardCampaignAssetConfig | null {
  const configured = REWARD_CAMPAIGN_ASSET_ENV_KEYS.some((key) => String(env[key] ?? "").trim() !== "")
  return configured ? resolveRewardCampaignAssetConfig(env) : null
}

export function resolveRewardCampaignConfig(env: Env): RewardCampaignConfig {
  if (!enabled(env.REWARDS_CAMPAIGNS_ENABLED)) {
    return {
      enabled: false,
      chainId: 0,
      tokenAddress: "",
      tokenDecimals: 0,
      tokenSymbol: "",
      treasuryAddress: "",
      rpcUrl: "",
      quoteTtlSeconds: 0,
      minBudgetCents: 0,
      maxBudgetCents: 0,
      maxRewardCents: 0,
      minDurationSeconds: 0,
      maxDurationSeconds: 0,
      postAllowlist: null,
    }
  }

  if (!enabled(env.REWARDS_ACCRUAL_ENABLED) || !enabled(env.REWARDS_PAYOUTS_ENABLED)) {
    throw providerUnavailable(
      "Reward campaigns require reward accrual and payouts to be enabled",
      {
        rewards_accrual_enabled: enabled(env.REWARDS_ACCRUAL_ENABLED),
        rewards_payouts_enabled: enabled(env.REWARDS_PAYOUTS_ENABLED),
      },
      false,
    )
  }

  const asset = resolveRewardCampaignAssetConfig(env)

  const config: RewardCampaignConfig = {
    enabled: true,
    ...asset,
    quoteTtlSeconds: positiveInteger(env, "REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS"),
    minBudgetCents: positiveInteger(env, "REWARDS_CAMPAIGN_MIN_BUDGET_CENTS"),
    maxBudgetCents: positiveInteger(env, "REWARDS_CAMPAIGN_MAX_BUDGET_CENTS"),
    maxRewardCents: positiveInteger(env, "REWARDS_CAMPAIGN_MAX_REWARD_CENTS"),
    minDurationSeconds: positiveInteger(env, "REWARDS_CAMPAIGN_MIN_DURATION_SECONDS"),
    maxDurationSeconds: positiveInteger(env, "REWARDS_CAMPAIGN_MAX_DURATION_SECONDS"),
    postAllowlist: (() => {
      const values = String(env.REWARDS_CAMPAIGN_POST_ALLOWLIST ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        // Public post IDs are what operators see and copy from URLs. Store the
        // canonical shard form so either public or internal configuration
        // matches the normalized campaign target.
        .map(decodePublicPostId)
      return values.length > 0 ? new Set(values) : null
    })(),
  }
  if (
    config.minBudgetCents > config.maxBudgetCents
    || config.minDurationSeconds > config.maxDurationSeconds
    || config.quoteTtlSeconds > 86_400
  ) {
    throw providerUnavailable("Reward campaign guardrails are inconsistent", null, false)
  }
  return config
}
