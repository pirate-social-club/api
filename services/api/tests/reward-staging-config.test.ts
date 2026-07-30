import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { readWranglerVars } from "../scripts/_lib/dev-vars"

const wranglerConfigPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url))

describe("staging reward money-loop configuration", () => {
  test("permits public Worker-to-Worker fetches for the Lit endpoint", () => {
    const config = readFileSync(wranglerConfigPath, "utf8")
    expect(config).toContain("\"global_fetch_strictly_public\"")
  })

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
      REWARDS_MIN_CASHOUT_CENTS: "500",
      REWARDS_IDENTITY_PROVIDER: "very",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
      REWARDS_CAMPAIGN_RPC_URL: "https://sepolia.base.org",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0xf536b0DAfD04AE1E5ADB8C170880c7996Fa26c5C",
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://sepolia.base.org",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "false",
      REWARDS_TREASURY_VAULT_ADDRESS: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
      REWARDS_TREASURY_VAULT_POLICY_VERSION: "2",
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

  test("keeps production settlement dark and contains no testnet reward custody config", () => {
    const vars = readWranglerVars(wranglerConfigPath, "production")
    expect(vars).toMatchObject({
      REWARDS_CAMPAIGNS_ENABLED: "false",
      REWARDS_REFUNDS_ENABLED: "false",
      REWARDS_READS_ENABLED: "true",
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "false",
      REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED: "false",
      REWARDS_IDENTITY_PROVIDER: "self",
    })

    const productionRewardVars = Object.fromEntries(
      Object.entries(vars).filter(([key]) => (
        key.startsWith("REWARDS_CAMPAIGN_")
        || key.startsWith("PIRATE_REWARDS_SETTLEMENT_")
        || key === "REWARDS_TREASURY_VAULT_ADDRESS"
      )),
    )
    const serialized = JSON.stringify(productionRewardVars).toLowerCase()

    expect(productionRewardVars).not.toHaveProperty("REWARDS_CAMPAIGN_CHAIN_ID")
    expect(productionRewardVars).not.toHaveProperty("REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS")
    expect(productionRewardVars).not.toHaveProperty("REWARDS_CAMPAIGN_TREASURY_ADDRESS")
    expect(productionRewardVars).not.toHaveProperty("REWARDS_CAMPAIGN_RPC_URL")
    expect(productionRewardVars).not.toHaveProperty("PIRATE_REWARDS_SETTLEMENT_CHAIN_ID")
    expect(productionRewardVars).not.toHaveProperty("PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS")
    expect(productionRewardVars).not.toHaveProperty("PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS")
    expect(productionRewardVars).not.toHaveProperty("PIRATE_REWARDS_SETTLEMENT_RPC_URL")
    expect(productionRewardVars).not.toHaveProperty("REWARDS_TREASURY_VAULT_ADDRESS")
    expect(serialized).not.toContain("84532")
    expect(serialized).not.toContain("sepolia")
    expect(serialized).not.toContain("0x036cbd53842c5426634e7929541ec2318f3dcf7e")
  })
})
