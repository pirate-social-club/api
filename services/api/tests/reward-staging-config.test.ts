import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { readWranglerVars } from "../scripts/_lib/dev-vars"

const wranglerConfigPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url))

describe("staging reward money-loop configuration", () => {
  function expectCampaignEnablementIsCoordinated(vars: Record<string, string>): void {
    if (vars.REWARDS_CAMPAIGNS_ENABLED !== "true") return
    expect(vars.REWARDS_ACCRUAL_ENABLED).toBe("true")
    expect(vars.REWARDS_PAYOUTS_ENABLED).toBe("true")
  }

  test("arms the complete campaign money loop while keeping legacy accrual dark", () => {
    const vars = readWranglerVars(wranglerConfigPath, "staging")

    expectCampaignEnablementIsCoordinated(vars)

    expect(vars.REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED).toBe("false")
    expect(vars).toMatchObject({
      REWARDS_READS_ENABLED: "true",
      REWARDS_CAMPAIGNS_ENABLED: "true",
      REWARDS_REFUNDS_ENABLED: "true",
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "very",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
      REWARDS_CAMPAIGN_RPC_URL: "https://sepolia.base.org",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "lit_vault",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0x6a1C1a6C780E9F2eb23E564C04B6316864468c46",
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://sepolia.base.org",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "false",
      REWARDS_TREASURY_VAULT_ADDRESS: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
      REWARDS_TREASURY_VAULT_POLICY_VERSION: "1",
      LIT_REWARDS_ACTION_IPFS_ID: "QmR9EqhLEK7jE1wp44wLanmeJwK3Wr3kPtsfD4pjAmogm7",
      LIT_REWARDS_SIGNING_DEADLINE_SECONDS: "300",
      LIT_REWARDS_MAX_FEE_PER_GAS_WEI: "50000000000",
      LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI: "25000000000",
      LIT_REWARDS_MAX_GAS_LIMIT: "300000",
      REWARDS_CAMPAIGN_ALERT_OWNER: "habitant_barber905@simplelogin.com",
      REWARDS_CAMPAIGN_ALERT_DESTINATION: "piratesocialclub@proton.me",
      REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
      REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "100",
      REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "10000",
      REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "100",
      REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
      REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
    })
    expect(vars.REWARDS_CAMPAIGN_TREASURY_ADDRESS).toBe(vars.REWARDS_TREASURY_VAULT_ADDRESS)
    expect(vars.REWARDS_CAMPAIGN_TREASURY_ADDRESS).not.toBe(
      vars.PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS,
    )
  })

  test("enables the coordinated production pilot while keeping legacy accrual dark", () => {
    const vars = readWranglerVars(wranglerConfigPath, "production")
    expectCampaignEnablementIsCoordinated(vars)
    expect(vars).toMatchObject({
      REWARDS_CAMPAIGNS_ENABLED: "true",
      REWARDS_REFUNDS_ENABLED: "true",
      REWARDS_READS_ENABLED: "true",
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED: "false",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0xC74e72CE521674BcAea66c99874fe9d5984E12Be",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0xC74e72CE521674BcAea66c99874fe9d5984E12Be",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
    })
    // Empty/absent => no restriction (resolveRewardCampaignConfig treats a blank
    // allowlist as null): the pilot post-scoping has been deliberately removed so
    // any eligible published song can carry a funded bounty.
    expect(vars.REWARDS_CAMPAIGN_POST_ALLOWLIST ?? "").toBe("")
    expect(vars.REWARDS_CAMPAIGN_TREASURY_ADDRESS).toBe(vars.PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS)
  })
})
