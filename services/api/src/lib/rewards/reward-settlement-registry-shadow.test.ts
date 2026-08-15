import { beforeEach, describe, expect, spyOn, test } from "bun:test"

import type { Env } from "../../env"
import type { QueryResult } from "../sql-client"
import {
  clearSettlementRegistryCacheForTests,
  type SettlementRegistrySnapshot,
} from "./reward-settlement-asset-registry"
import {
  clearSettlementRegistryShadowStateForTests,
  compareSettlementRegistry,
  observeSettlementRegistryShadow,
} from "./reward-settlement-registry-shadow"

const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const TREASURY = `0x${"1".repeat(40)}`
const OPERATOR = `0x${"2".repeat(40)}`

const SNAPSHOT: SettlementRegistrySnapshot = {
  assets: [
    {
      chainId: 84532,
      tokenAddress: SEPOLIA_USDC,
      decimals: 6,
      symbol: "USDC",
      denominationPolicy: "usd_par",
      status: "admitted",
      quoteCutoffAt: null,
    },
  ],
  rails: [
    {
      railId: "rail_1",
      environment: "staging",
      backend: "local",
      chainId: 84532,
      tokenAddress: SEPOLIA_USDC,
      treasuryAddress: TREASURY,
      vaultAddress: null,
      operatorAddress: OPERATOR,
      policyVersion: "v1",
    },
  ],
}

const EXPECTED_ASSET = {
  chainId: 84532,
  tokenAddress: SEPOLIA_USDC,
  tokenDecimals: 6,
  tokenSymbol: "USDC",
}

const EXPECTED_RAIL = {
  environment: "staging",
  backend: "local",
  treasuryAddress: TREASURY,
  operatorAddress: OPERATOR,
  vaultAddress: null,
}

beforeEach(() => {
  clearSettlementRegistryCacheForTests()
  clearSettlementRegistryShadowStateForTests()
})

describe("compareSettlementRegistry", () => {
  test("matching registry and configuration compare clean", () => {
    const result = compareSettlementRegistry({
      snapshot: SNAPSHOT,
      expectedAsset: EXPECTED_ASSET,
      expectedRail: EXPECTED_RAIL,
    })
    expect(result.outcome).toBe("match")
    expect(result.mismatch_reasons).toEqual({})
    expect(result.compared_fields).toBeGreaterThanOrEqual(7)
  })

  test("null expected custody fields are skipped, not mismatched", () => {
    const result = compareSettlementRegistry({
      snapshot: SNAPSHOT,
      expectedAsset: EXPECTED_ASSET,
      expectedRail: { ...EXPECTED_RAIL, operatorAddress: null, vaultAddress: null },
    })
    expect(result.outcome).toBe("match")
    expect(result.skipped_fields).toBe(2)
  })

  test("each drift is counted under its own reason", () => {
    const result = compareSettlementRegistry({
      snapshot: {
        assets: [{ ...SNAPSHOT.assets[0]!, decimals: 18, symbol: "FAKE", status: "suspended" }],
        rails: [{ ...SNAPSHOT.rails[0]!, backend: "eoa_vault", treasuryAddress: `0x${"9".repeat(40)}`, policyVersion: "v2" }],
      },
      expectedAsset: EXPECTED_ASSET,
      expectedRail: EXPECTED_RAIL,
    })
    expect(result.outcome).toBe("mismatch")
    expect(result.mismatch_reasons).toMatchObject({
      asset_suspended: 1,
      decimals_mismatch: 1,
      symbol_mismatch: 1,
      rail_backend_mismatch: 1,
      rail_treasury_mismatch: 1,
      rail_policy_version_unexpected: 1,
    })
  })

  test("missing asset and missing rail are distinct reasons", () => {
    const result = compareSettlementRegistry({
      snapshot: { assets: [], rails: [] },
      expectedAsset: EXPECTED_ASSET,
      expectedRail: EXPECTED_RAIL,
    })
    expect(result.mismatch_reasons).toEqual({ asset_missing: 1, rail_missing: 1 })
  })
})

describe("observeSettlementRegistryShadow", () => {
  const env = {
    CONTROL_PLANE_DATABASE_URL: "file:reward-settlement-shadow-test.db",
    ENVIRONMENT: "staging",
    PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: TREASURY,
  } as unknown as Env

  test("never throws and rate-limits repeat emissions per site and outcome", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {})
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const exec = {
        execute: async (statement: { sql: string }): Promise<QueryResult> => ({
          rows: (statement.sql.includes("reward_settlement_rails")
            ? [
                {
                  reward_settlement_rail_id: "rail_1",
                  environment: "staging",
                  backend: "local",
                  chain_id: 84532,
                  token_address: SEPOLIA_USDC,
                  treasury_address: TREASURY,
                  vault_address: null,
                  operator_address: OPERATOR,
                  policy_version: "v1",
                },
              ]
            : [
                {
                  chain_id: 84532,
                  token_address: SEPOLIA_USDC,
                  decimals: 6,
                  symbol: "USDC",
                  denomination_policy: "usd_par",
                  status: "admitted",
                  quote_cutoff_at: null,
                },
              ]) as QueryResult["rows"],
        }),
      }
      await observeSettlementRegistryShadow({ env, exec, site: "cashout", asset: EXPECTED_ASSET })
      await observeSettlementRegistryShadow({ env, exec, site: "cashout", asset: EXPECTED_ASSET })
      expect(info).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(String(info.mock.calls[0]?.[1]))
      expect(payload.site).toBe("cashout")
      expect(payload.totals.compared).toBe(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  test("registry unavailability is swallowed into a rate-limited warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const exec = {
        execute: async (): Promise<QueryResult> => {
          throw new Error("relation does not exist")
        },
      }
      await observeSettlementRegistryShadow({ env, exec, site: "funding_quote", asset: EXPECTED_ASSET })
      await observeSettlementRegistryShadow({ env, exec, site: "funding_quote", asset: EXPECTED_ASSET })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
