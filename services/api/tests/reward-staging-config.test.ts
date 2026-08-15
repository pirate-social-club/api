import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { Env } from "../src/env"
import {
  resolveRewardsSettlementBroadcastRpcUrl,
  resolveRewardsSettlementRpcUrl,
} from "../src/lib/communities/bookings/booking-chain-config"
import { resolveRewardCampaignAssetConfig } from "../src/lib/rewards/reward-campaign-config"
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
      REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: "false",
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_MIN_CASHOUT_CENTS: "50",
      REWARDS_IDENTITY_PROVIDER: "very",
      REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED: "true",
      REWARDS_NATIONALITY_SHADOW_IDENTITY_PROVIDER: "self",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "lit_vault",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0xf536b0DAfD04AE1E5ADB8C170880c7996Fa26c5C",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BROADCAST_RPC_URL: "https://sepolia.base.org",
      PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "false",
      REWARDS_TREASURY_VAULT_ADDRESS: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
      REWARDS_TREASURY_VAULT_POLICY_VERSION: "2",
      LIT_REWARDS_ACTION_IPFS_ID: "QmQ7mBbjbd4KgGfiKbYRv1p4kbcs8ebSz6ruAYfLeN8v9d",
      LIT_REWARDS_ACTION_POLICY_VERSION: "2",
      LIT_REWARDS_REQUEST_MAX_ATTEMPTS: "1",
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
    expect(vars.REWARDS_CAMPAIGN_RPC_URL).toBeUndefined()
    expect(vars.PIRATE_REWARDS_SETTLEMENT_RPC_URL).toBeUndefined()
    expect(resolveRewardCampaignAssetConfig({
      ...vars,
      REWARDS_CAMPAIGN_RPC_URL: undefined,
      BASE_SEPOLIA_RPC_URL: "https://keyed-sepolia.example.test",
    } as Env).rpcUrl).toBe("https://keyed-sepolia.example.test")
    expect(resolveRewardsSettlementRpcUrl({
      ...vars,
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: undefined,
      BASE_SEPOLIA_RPC_URL: "https://keyed-sepolia.example.test",
    } as Env)).toBe("https://keyed-sepolia.example.test")
    expect(resolveRewardsSettlementBroadcastRpcUrl(vars as Env)).toBe("https://sepolia.base.org")
  })

  test("arms production settlement on Base mainnet without testnet custody config", () => {
    const vars = readWranglerVars(wranglerConfigPath, "production")
    expectCampaignEnablementIsCoordinated(vars)
    expect(vars).toMatchObject({
      REWARDS_CAMPAIGNS_ENABLED: "true",
      REWARDS_REFUNDS_ENABLED: "true",
      REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: "false",
      REWARDS_READS_ENABLED: "true",
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_MIN_CASHOUT_CENTS: "100",
      REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED: "false",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED: "false",
      REWARDS_NATIONALITY_SHADOW_IDENTITY_PROVIDER: "self",
      REWARDS_CAMPAIGN_CHAIN_ID: "8453",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0xe2d03cB0678449e0cc1f1eD33E5c46102EC5AB86",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0x43bbA97370B00E9930994EA427DAEE400846617B",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "8453",
      PIRATE_REWARDS_SETTLEMENT_BROADCAST_RPC_URL: "https://mainnet.base.org",
      PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "false",
      REWARDS_TREASURY_VAULT_ADDRESS: "0xe2d03cB0678449e0cc1f1eD33E5c46102EC5AB86",
      REWARDS_TREASURY_VAULT_POLICY_VERSION: "1",
      LIT_REWARDS_ACTION_POLICY_VERSION: "1",
      LIT_REWARDS_REQUEST_MAX_ATTEMPTS: "1",
      LIT_REWARDS_SIGNING_DEADLINE_SECONDS: "300",
      LIT_REWARDS_MAX_FEE_PER_GAS_WEI: "50000000000",
      LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI: "25000000000",
      LIT_REWARDS_MAX_GAS_LIMIT: "300000",
    })

    const productionRewardVars = Object.fromEntries(
      Object.entries(vars).filter(([key]) => (
        key.startsWith("REWARDS_CAMPAIGN_")
        || key.startsWith("PIRATE_REWARDS_SETTLEMENT_")
        || key === "REWARDS_TREASURY_VAULT_ADDRESS"
      )),
    )
    const serialized = JSON.stringify(productionRewardVars).toLowerCase()

    expect(serialized).not.toContain("84532")
    expect(serialized).not.toContain("sepolia")
    expect(serialized).not.toContain("0x036cbd53842c5426634e7929541ec2318f3dcf7e")
    expect(vars.REWARDS_CAMPAIGN_TREASURY_ADDRESS).toBe(vars.REWARDS_TREASURY_VAULT_ADDRESS)
    expect(vars.REWARDS_CAMPAIGN_CHAIN_ID).toBe(vars.PIRATE_REWARDS_SETTLEMENT_CHAIN_ID)
    expect(vars.REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS).toBe(
      vars.PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS,
    )
    expect(vars.REWARDS_CAMPAIGN_RPC_URL).toBeUndefined()
    expect(vars.PIRATE_REWARDS_SETTLEMENT_RPC_URL).toBeUndefined()
    expect(resolveRewardCampaignAssetConfig({
      ...vars,
      REWARDS_CAMPAIGN_RPC_URL: undefined,
      BASE_MAINNET_RPC_URL: "https://keyed-mainnet.example.test",
    } as Env).rpcUrl).toBe("https://keyed-mainnet.example.test")
    expect(resolveRewardsSettlementRpcUrl({
      ...vars,
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: undefined,
      BASE_MAINNET_RPC_URL: "https://keyed-mainnet.example.test",
    } as Env)).toBe("https://keyed-mainnet.example.test")
    expect(resolveRewardsSettlementBroadcastRpcUrl(vars as Env)).toBe("https://mainnet.base.org")
  })
})
