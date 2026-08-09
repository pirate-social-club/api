import { getAddress } from "ethers"

import type { Env } from "../../env"
import {
  assertRewardsCampaignAndSettlementChainsMatch,
  assertRewardsCampaignTreasuryMatchesSettlementOperator,
  resolveRewardsSettlementBroadcastRpcUrl,
  resolveRewardsSettlementOperatorPrivateKey,
  resolveRewardsSettlementRpcUrl,
  resolveRewardsSettlementUsdcTokenAddress,
} from "../communities/bookings/booking-chain-config"
import { providerUnavailable } from "../errors"
import {
  resolveRewardCampaignAssetConfig,
  type RewardCampaignAssetConfig,
} from "./reward-campaign-config"
import { LitChipotleClient } from "./lit-chipotle-client"
import {
  resolveRewardsSettlementBackend,
  resolveRewardVaultConfig,
  resolveRewardVaultLitConfig,
} from "./reward-vault-lit-config"

const successfulReadiness = new WeakMap<object, RewardCampaignAssetConfig>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Proves that the campaign custody wallet is usable by the settlement rail before
 * funding is advertised or accepted. Only the successful public configuration is
 * cached; the private key is validated but never retained by this module.
 */
export function assertRewardCampaignSettlementReadiness(env: Env): RewardCampaignAssetConfig {
  const cached = successfulReadiness.get(env)
  if (cached) return cached

  try {
    const campaign = resolveRewardCampaignAssetConfig(env)
    const backend = resolveRewardsSettlementBackend(env)
    if (backend === "lit_vault") {
      const lit = resolveRewardVaultLitConfig(env)
      // Constructor validation proves the production endpoint and credential
      // tuple is structurally usable without making a metered external call.
      new LitChipotleClient({
        usageApiKey: lit.usageApiKey,
        baseUrl: lit.apiUrl,
        timeoutMs: lit.requestTimeoutMs,
        maxAttempts: lit.requestMaxAttempts,
      })
    } else if (backend === "eoa_vault") {
      resolveRewardVaultConfig(env)
      resolveRewardsSettlementOperatorPrivateKey(env)
    } else {
      resolveRewardsSettlementOperatorPrivateKey(env)
    }
    const settlementRpcUrl = resolveRewardsSettlementRpcUrl(env)
    if (!/^https:\/\//i.test(settlementRpcUrl)) {
      throw new Error('PIRATE_REWARDS_SETTLEMENT_RPC_URL must use HTTPS')
    }
    const broadcastRpcUrl = resolveRewardsSettlementBroadcastRpcUrl(env)
    if (!/^https:\/\//i.test(broadcastRpcUrl)) {
      throw new Error('PIRATE_REWARDS_SETTLEMENT_BROADCAST_RPC_URL must use HTTPS')
    }
    assertRewardsCampaignTreasuryMatchesSettlementOperator(env)
    assertRewardsCampaignAndSettlementChainsMatch(env)
    const settlementToken = resolveRewardsSettlementUsdcTokenAddress(env)
    if (getAddress(campaign.tokenAddress) !== getAddress(settlementToken)) {
      throw new Error("Reward campaign and settlement token addresses must match")
    }
    successfulReadiness.set(env, campaign)
    return campaign
  } catch (error) {
    throw providerUnavailable(
      "Reward campaign settlement is unavailable",
      { reason: errorMessage(error) },
      false,
    )
  }
}

export function rewardFundingRefundsEnabled(env: Env): boolean {
  const configured = env.REWARDS_REFUNDS_ENABLED ?? env.REWARDS_PAYOUTS_ENABLED
  return String(configured ?? "").trim().toLowerCase() === "true"
}
