import { getAddress } from "ethers"

import type { Env } from "../../env"
import { providerUnavailable } from "../errors"

export type RewardCampaignConfig = {
  enabled: boolean
  chainId: number
  tokenAddress: string
  treasuryAddress: string
  rpcUrl: string
  quoteTtlSeconds: number
  minBudgetCents: number
  maxBudgetCents: number
  maxRewardCents: number
  minDurationSeconds: number
  maxDurationSeconds: number
}

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

export function resolveRewardCampaignConfig(env: Env): RewardCampaignConfig {
  if (!enabled(env.REWARDS_CAMPAIGNS_ENABLED)) {
    return {
      enabled: false,
      chainId: 0,
      tokenAddress: "",
      treasuryAddress: "",
      rpcUrl: "",
      quoteTtlSeconds: 0,
      minBudgetCents: 0,
      maxBudgetCents: 0,
      maxRewardCents: 0,
      minDurationSeconds: 0,
      maxDurationSeconds: 0,
    }
  }

  const rpcUrl = String(env.REWARDS_CAMPAIGN_RPC_URL ?? "").trim()
  if (!/^https:\/\//i.test(rpcUrl)) {
    throw providerUnavailable("Reward campaign RPC URL is invalid", { key: "REWARDS_CAMPAIGN_RPC_URL" }, false)
  }

  const config: RewardCampaignConfig = {
    enabled: true,
    chainId: positiveInteger(env, "REWARDS_CAMPAIGN_CHAIN_ID"),
    tokenAddress: address(env, "REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS"),
    treasuryAddress: address(env, "REWARDS_CAMPAIGN_TREASURY_ADDRESS"),
    rpcUrl,
    quoteTtlSeconds: positiveInteger(env, "REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS"),
    minBudgetCents: positiveInteger(env, "REWARDS_CAMPAIGN_MIN_BUDGET_CENTS"),
    maxBudgetCents: positiveInteger(env, "REWARDS_CAMPAIGN_MAX_BUDGET_CENTS"),
    maxRewardCents: positiveInteger(env, "REWARDS_CAMPAIGN_MAX_REWARD_CENTS"),
    minDurationSeconds: positiveInteger(env, "REWARDS_CAMPAIGN_MIN_DURATION_SECONDS"),
    maxDurationSeconds: positiveInteger(env, "REWARDS_CAMPAIGN_MAX_DURATION_SECONDS"),
  }
  if (
    ![8453, 84532].includes(config.chainId)
    || config.minBudgetCents > config.maxBudgetCents
    || config.minDurationSeconds > config.maxDurationSeconds
    || config.quoteTtlSeconds > 86_400
  ) {
    throw providerUnavailable("Reward campaign guardrails are inconsistent", null, false)
  }
  return config
}
