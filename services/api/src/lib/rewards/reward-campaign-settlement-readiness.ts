import { getAddress } from "ethers"

import type { Env } from "../../env"
import {
  assertRewardsCampaignAndSettlementChainsMatch,
  assertRewardsCampaignTreasuryMatchesSettlementOperator,
  resolveRewardsSettlementOperatorPrivateKey,
  resolveRewardsSettlementRpcUrl,
  resolveRewardsSettlementUsdcTokenAddress,
} from "../communities/bookings/booking-chain-config"
import { providerUnavailable } from "../errors"
import {
  resolveRewardCampaignAssetConfig,
  type RewardCampaignAssetConfig,
} from "./reward-campaign-config"

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
    resolveRewardsSettlementOperatorPrivateKey(env)
    const settlementRpcUrl = resolveRewardsSettlementRpcUrl(env)
    if (!/^https:\/\//i.test(settlementRpcUrl)) {
      throw new Error('PIRATE_REWARDS_SETTLEMENT_RPC_URL must use HTTPS')
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
