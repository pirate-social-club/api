import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { readWranglerVars } from "../scripts/_lib/dev-vars"

const wranglerConfigPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url))

describe("staging reward money-loop configuration", () => {
  test("keeps every reward surface dark while versioning the public campaign configuration", () => {
    const vars = readWranglerVars(wranglerConfigPath, "staging")

    for (const flag of [
      "REWARDS_ACCRUAL_ENABLED",
      "REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED",
      "REWARDS_READS_ENABLED",
      "REWARDS_PAYOUTS_ENABLED",
      "REWARDS_CAMPAIGNS_ENABLED",
    ]) {
      expect(vars[flag]).toBe("false")
    }
    expect(vars).toMatchObject({
      REWARDS_IDENTITY_PROVIDER: "very",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x053228674F055FBb94d1B8118638F61a4a6ee512",
      REWARDS_CAMPAIGN_RPC_URL: "https://sepolia.base.org",
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

  test("does not copy staging campaign configuration into production", () => {
    const vars = readWranglerVars(wranglerConfigPath, "production")
    expect(vars.REWARDS_CAMPAIGNS_ENABLED).toBeUndefined()
    expect(vars.REWARDS_IDENTITY_PROVIDER).toBeUndefined()
    expect(vars.REWARDS_CAMPAIGN_CHAIN_ID).toBeUndefined()
  })
})

