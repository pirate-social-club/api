import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import type { Env } from "../../env"
import { HttpError } from "../errors"
import type { InStatement, QueryResult } from "../sql-client"
import {
  assertRegistryAllowsSettlementInitiation,
  clearSettlementRegistryCacheForTests,
  findActiveRegistryRail,
  readSettlementRegistrySnapshot,
} from "./reward-settlement-asset-registry"

// Proves the reader's SQL and row decoding against the real 0236 schema —
// the vendored control-plane fixture applied to actual PostgreSQL — instead
// of hand-written fake rows.

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "reward_settlement_registry_reader_test"

const REGISTRY_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0236_control_plane_reward_settlement_asset_registry.sql",
  import.meta.url,
)

const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const TREASURY = `0x${"1".repeat(40)}`
const OPERATOR = `0x${"2".repeat(40)}`

function urlFor(db?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (db !== undefined) url.pathname = `/${db}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>)
}

describe.skipIf(!RUN)("reward settlement asset registry reader (real Postgres)", () => {
  let db: SQL

  const env = {
    CONTROL_PLANE_DATABASE_URL: "postgres://reader-pg-test",
    ENVIRONMENT: "staging",
    PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: TREASURY,
    REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED: "true",
  } as unknown as Env

  const exec = {
    execute: async (statement: InStatement): Promise<QueryResult> => {
      const sql = typeof statement === "string" ? statement : statement.sql
      const rows = await db.unsafe(sql)
      return { rows: rows as QueryResult["rows"] }
    },
  }

  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()
    db = connect(TEST_DB)
    await db.unsafe(await readFile(REGISTRY_MIGRATION_URL, "utf8"))
    clearSettlementRegistryCacheForTests()
  })

  afterAll(async () => {
    await db?.end()
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => undefined)
    await root.end()
  })

  test("decodes the seeded canonical USDC assets", async () => {
    const snapshot = await readSettlementRegistrySnapshot({ env, exec })
    expect(snapshot.assets.map((asset) => [asset.chainId, asset.symbol, asset.status, asset.denominationPolicy]).sort()).toEqual([
      [8453, "USDC", "admitted", "usd_par"],
      [84532, "USDC", "admitted", "usd_par"],
    ])
    expect(snapshot.rails).toHaveLength(0)
  })

  test("gates initiation on a real rail row and decodes its binding", async () => {
    await db.unsafe(`
      INSERT INTO reward_settlement_rails (
        reward_settlement_rail_id, environment, backend, chain_id, token_address,
        treasury_address, vault_address, operator_address, policy_version, status
      ) VALUES ('rail_pg', 'staging', 'local', 84532, '${SEPOLIA_USDC}',
        '${TREASURY}', NULL, '${OPERATOR}', 'v1', 'active')
    `)
    clearSettlementRegistryCacheForTests()

    const snapshot = await readSettlementRegistrySnapshot({ env, exec })
    const rail = findActiveRegistryRail(snapshot, "staging", 84532, SEPOLIA_USDC)
    expect(rail).toMatchObject({
      railId: "rail_pg",
      backend: "local",
      treasuryAddress: TREASURY,
      operatorAddress: OPERATOR,
      vaultAddress: null,
      policyVersion: "v1",
    })

    await assertRegistryAllowsSettlementInitiation({
      env,
      exec,
      asset: { chainId: 84532, tokenAddress: SEPOLIA_USDC, tokenDecimals: 6, tokenSymbol: "USDC" },
    })

    let caught: unknown
    try {
      await assertRegistryAllowsSettlementInitiation({
        env,
        exec,
        asset: { chainId: 1, tokenAddress: `0x${"a".repeat(40)}`, tokenDecimals: 6, tokenSymbol: "USDC" },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as HttpError).details).toMatchObject({ reason: "asset_not_admitted" })
  })
})
