import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { resolveRewardCampaignRecoveryFinalityConfig } from "./reward-campaign-recovery"

describe("reward campaign recovery configuration", () => {
  test("resolves the campaign RPC from the chain fallback", () => {
    expect(resolveRewardCampaignRecoveryFinalityConfig({
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
      BASE_SEPOLIA_RPC_URL: "https://keyed-sepolia.example.test",
    } as Env)).toEqual({
      rpcUrl: "https://keyed-sepolia.example.test",
      chainId: 84532,
    })
  })
})
