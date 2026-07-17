import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { readWranglerVars } from "../scripts/_lib/dev-vars"

const wranglerConfigPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url))

describe("staging reward money-loop configuration", () => {
  test("arms the complete campaign money loop while keeping legacy accrual dark", () => {
    const vars = readWranglerVars(wranglerConfigPath, "staging")

    expect(vars.REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED).toBe("false")
    expect(vars).toMatchObject({
      REWARDS_READS_ENABLED: "true",
      REWARDS_CAMPAIGNS_ENABLED: "true",
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "very",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x053228674F055FBb94d1B8118638F61a4a6ee512",
      REWARDS_CAMPAIGN_RPC_URL: "https://sepolia.base.org",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0x47FfE9baBf7b64636298185dBf63Db9561334956",
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://sepolia.base.org",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "false",
      REWARDS_CAMPAIGN_ALERT_OWNER: "habitant_barber905@simplelogin.com",
      REWARDS_CAMPAIGN_ALERT_DESTINATION: "piratesocialclub@proton.me",
      REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
      REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "100",
      REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "10000",
      REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "100",
      REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
      REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
    })
  })

  test("limits the production pilot to Arkansas Blues with earning and payouts dark", () => {
    const vars = readWranglerVars(wranglerConfigPath, "production")
    expect(vars).toMatchObject({
      REWARDS_CAMPAIGNS_ENABLED: "true",
      REWARDS_READS_ENABLED: "true",
      REWARDS_ACCRUAL_ENABLED: "false",
      REWARDS_PAYOUTS_ENABLED: "false",
      REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED: "false",
      REWARDS_IDENTITY_PROVIDER: "very",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_POST_ALLOWLIST: "pst_66644f58a5824bff85de4a723a57aa47",
    })
    expect(vars.PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS).toBeUndefined()
  })
})
