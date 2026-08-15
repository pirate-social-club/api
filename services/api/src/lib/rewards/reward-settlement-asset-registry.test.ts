import { beforeEach, describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { HttpError } from "../errors"
import type { InStatement, QueryResult } from "../sql-client"
import {
  assertRegistryAllowsSettlementInitiation,
  clearSettlementRegistryCacheForTests,
  normalizeEvmAddressOrNull,
  readSettlementRegistrySnapshot,
  resolveSettlementRegistryEnvironment,
  settlementRegistryAuthorityEnabled,
} from "./reward-settlement-asset-registry"

const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const TREASURY = `0x${"1".repeat(40)}`
const OPERATOR = `0x${"2".repeat(40)}`

const ASSET_ROW = {
  chain_id: 84532,
  token_address: SEPOLIA_USDC,
  decimals: 6,
  symbol: "USDC",
  denomination_policy: "usd_par",
  status: "admitted",
  quote_cutoff_at: null,
}

const RAIL_ROW = {
  reward_settlement_rail_id: "rail_1",
  environment: "staging",
  backend: "local",
  chain_id: 84532,
  token_address: SEPOLIA_USDC,
  treasury_address: TREASURY,
  vault_address: null,
  operator_address: OPERATOR,
  policy_version: "v1",
}

const CONFIGURED_ASSET = {
  chainId: 84532,
  tokenAddress: SEPOLIA_USDC,
  tokenDecimals: 6,
  tokenSymbol: "USDC",
}

function registryEnv(overrides: Record<string, string> = {}): Env {
  return {
    CONTROL_PLANE_DATABASE_URL: "file:reward-settlement-registry-test.db",
    ENVIRONMENT: "staging",
    PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: TREASURY,
    REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: "true",
    ...overrides,
  } as unknown as Env
}

function fakeExec(rowsByTable: { assets?: unknown[]; rails?: unknown[] }, calls?: { count: number }) {
  return {
    execute: async (statement: InStatement): Promise<QueryResult> => {
      if (calls) calls.count += 1
      const sql = typeof statement === "string" ? statement : statement.sql
      const rows = sql.includes("reward_settlement_rails")
        ? (rowsByTable.rails ?? [])
        : (rowsByTable.assets ?? [])
      return { rows: rows as QueryResult["rows"] }
    },
  }
}

function failingExec() {
  return {
    execute: async (): Promise<QueryResult> => {
      throw new Error("relation does not exist")
    },
  }
}

async function expectFailClosed(promise: Promise<void>, reason: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(HttpError)
  const httpError = caught as HttpError
  expect(httpError.status).toBe(502)
  expect(httpError.code).toBe("provider_unavailable")
  expect(httpError.details).toMatchObject({ reason })
}

beforeEach(() => {
  clearSettlementRegistryCacheForTests()
})

describe("settlement registry flag and environment", () => {
  test("authority flag requires the literal string true", () => {
    expect(settlementRegistryAuthorityEnabled({ REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: "true" })).toBe(true)
    expect(settlementRegistryAuthorityEnabled({ REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: " TRUE " })).toBe(true)
    expect(settlementRegistryAuthorityEnabled({ REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: "1" })).toBe(false)
    expect(settlementRegistryAuthorityEnabled({ REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: undefined })).toBe(false)
  })

  test("environment resolves to local unless explicitly staging or production", () => {
    expect(resolveSettlementRegistryEnvironment({ ENVIRONMENT: "staging" })).toBe("staging")
    expect(resolveSettlementRegistryEnvironment({ ENVIRONMENT: "Production" })).toBe("production")
    expect(resolveSettlementRegistryEnvironment({ ENVIRONMENT: "development" })).toBe("local")
    expect(resolveSettlementRegistryEnvironment({ ENVIRONMENT: undefined })).toBe("local")
  })

  test("address normalization lowercases and rejects malformed values", () => {
    expect(normalizeEvmAddressOrNull(`0x${"A".repeat(40)}`)).toBe(`0x${"a".repeat(40)}`)
    expect(normalizeEvmAddressOrNull(" ")).toBeNull()
    expect(normalizeEvmAddressOrNull("0x123")).toBeNull()
  })
})

describe("settlement registry snapshot cache", () => {
  test("a second read within the TTL does not query again", async () => {
    const calls = { count: 0 }
    const exec = fakeExec({ assets: [ASSET_ROW], rails: [RAIL_ROW] }, calls)
    const env = registryEnv()
    const first = await readSettlementRegistrySnapshot({ env, exec })
    const second = await readSettlementRegistrySnapshot({ env, exec })
    expect(calls.count).toBe(2)
    expect(second).toBe(first)
    expect(first.assets[0]?.tokenAddress).toBe(SEPOLIA_USDC)
  })

  test("a failed load is not cached", async () => {
    const env = registryEnv()
    await expect(readSettlementRegistrySnapshot({ env, exec: failingExec() })).rejects.toThrow()
    const snapshot = await readSettlementRegistrySnapshot({
      env,
      exec: fakeExec({ assets: [ASSET_ROW], rails: [RAIL_ROW] }),
    })
    expect(snapshot.assets).toHaveLength(1)
  })
})

describe("settlement initiation gate", () => {
  test("is a complete no-op while the authority flag is off", async () => {
    const env = registryEnv({ REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: "false" })
    await assertRegistryAllowsSettlementInitiation({
      env,
      exec: {
        execute: async () => {
          throw new Error("must not query while the flag is off")
        },
      },
      asset: CONFIGURED_ASSET,
    })
  })

  test("allows initiation for an admitted asset on a matching rail", async () => {
    await assertRegistryAllowsSettlementInitiation({
      env: registryEnv(),
      exec: fakeExec({ assets: [ASSET_ROW], rails: [RAIL_ROW] }),
      asset: CONFIGURED_ASSET,
    })
  })

  test("fails closed when the registry is unreachable", async () => {
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: failingExec(),
        asset: CONFIGURED_ASSET,
      }),
      "registry_unreachable",
    )
  })

  test("fails closed per lifecycle state", async () => {
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({ assets: [], rails: [RAIL_ROW] }),
        asset: CONFIGURED_ASSET,
      }),
      "asset_not_admitted",
    )
    clearSettlementRegistryCacheForTests()
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({
          assets: [{ ...ASSET_ROW, status: "suspended" }],
          rails: [RAIL_ROW],
        }),
        asset: CONFIGURED_ASSET,
      }),
      "asset_suspended",
    )
    clearSettlementRegistryCacheForTests()
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({
          assets: [{ ...ASSET_ROW, status: "retired", quote_cutoff_at: "2026-08-15T00:00:00Z" }],
          rails: [RAIL_ROW],
        }),
        asset: CONFIGURED_ASSET,
      }),
      "asset_retired",
    )
  })

  test("fails closed on descriptor drift", async () => {
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({ assets: [{ ...ASSET_ROW, decimals: 18 }], rails: [RAIL_ROW] }),
        asset: CONFIGURED_ASSET,
      }),
      "asset_descriptor_mismatch",
    )
  })

  test("fails closed on missing or drifted rails", async () => {
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({ assets: [ASSET_ROW], rails: [] }),
        asset: CONFIGURED_ASSET,
      }),
      "rail_missing",
    )
    clearSettlementRegistryCacheForTests()
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({ assets: [ASSET_ROW], rails: [{ ...RAIL_ROW, backend: "eoa_vault", vault_address: `0x${"3".repeat(40)}` }] }),
        asset: CONFIGURED_ASSET,
      }),
      "rail_backend_mismatch",
    )
    clearSettlementRegistryCacheForTests()
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({ assets: [ASSET_ROW], rails: [{ ...RAIL_ROW, treasury_address: `0x${"9".repeat(40)}` }] }),
        asset: CONFIGURED_ASSET,
      }),
      "rail_treasury_mismatch",
    )
    clearSettlementRegistryCacheForTests()
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv(),
        exec: fakeExec({ assets: [ASSET_ROW], rails: [{ ...RAIL_ROW, policy_version: "v2" }] }),
        asset: CONFIGURED_ASSET,
      }),
      "rail_policy_version_unexpected",
    )
  })

  test("fails closed when the expected configuration is unresolvable", async () => {
    await expectFailClosed(
      assertRegistryAllowsSettlementInitiation({
        env: registryEnv({ PIRATE_REWARDS_SETTLEMENT_BACKEND: "" }),
        exec: fakeExec({ assets: [ASSET_ROW], rails: [RAIL_ROW] }),
        asset: CONFIGURED_ASSET,
      }),
      "expected_config_unresolvable",
    )
  })

  test("treasury comparison is case-insensitive", async () => {
    await assertRegistryAllowsSettlementInitiation({
      env: registryEnv({ REWARDS_CAMPAIGN_TREASURY_ADDRESS: TREASURY.toUpperCase().replace("0X", "0x") }),
      exec: fakeExec({ assets: [ASSET_ROW], rails: [RAIL_ROW] }),
      asset: { ...CONFIGURED_ASSET, tokenAddress: SEPOLIA_USDC.toUpperCase().replace("0X", "0x") },
    })
  })
})
