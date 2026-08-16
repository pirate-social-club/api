import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  executeSettlementRailBootstrap,
  planSettlementRailBootstrap,
  SettlementRailBootstrapError,
  type SettlementRailBootstrapOutcome,
  type SettlementRailBootstrapPlan,
} from "./reward-settlement-rail-bootstrap"

// Proves the ratified bootstrap properties — transactional, idempotent,
// dry-run, conflict-refusing, read-back evidence — against the real 0236
// schema, including its triggers and partial unique index.

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
if (process.env.REWARD_SETTLEMENT_REGISTRY_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("REWARD_SETTLEMENT_REGISTRY_PG_CI_REQUIRED is set but BOOKINGS_REPO_TEST_ADMIN_URL is missing")
}
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "reward_settlement_rail_bootstrap_test"

const REGISTRY_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0236_control_plane_reward_settlement_asset_registry.sql",
  import.meta.url,
)

const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"

function urlFor(db?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (db !== undefined) url.pathname = `/${db}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>)
}

function stagingPlan(overrides: Partial<Parameters<typeof planSettlementRailBootstrap>[0]> = {}): SettlementRailBootstrapPlan {
  return planSettlementRailBootstrap({
    environment: "staging",
    backend: "local",
    chainId: 84532,
    tokenAddress: SEPOLIA_USDC,
    treasuryAddress: `0x${"1".repeat(40)}`,
    operatorAddress: `0x${"2".repeat(40)}`,
    vaultAddress: null,
    randomHex: "0badf00d",
    ...overrides,
  })
}

describe.skipIf(!RUN)("reward settlement rail bootstrap (real Postgres)", () => {
  let db: SQL

  async function inTransaction(
    plan: SettlementRailBootstrapPlan,
    options: { dryRun: boolean },
  ): Promise<SettlementRailBootstrapOutcome> {
    await db.unsafe("BEGIN")
    try {
      const outcome = await executeSettlementRailBootstrap(db, plan, options)
      await db.unsafe(options.dryRun ? "ROLLBACK" : "COMMIT")
      return outcome
    } catch (error) {
      await db.unsafe("ROLLBACK").catch(() => undefined)
      throw error
    }
  }

  async function activeRailCount(): Promise<number> {
    const rows = await db.unsafe("SELECT count(*)::int AS rails FROM reward_settlement_rails WHERE status = 'active'")
    return Number(rows[0]?.rails)
  }

  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()
    db = connect(TEST_DB)
    await db.unsafe(await readFile(REGISTRY_MIGRATION_URL, "utf8"))
  })

  afterAll(async () => {
    await db?.end()
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => undefined)
    await root.end()
  })

  test("dry run reports the plan and writes nothing", async () => {
    const outcome = await inTransaction(stagingPlan(), { dryRun: true })
    expect(outcome.outcome).toBe("dry_run_would_insert")
    expect(await activeRailCount()).toBe(0)
  })

  test("insert reads the stored binding back as evidence", async () => {
    const plan = stagingPlan()
    const outcome = await inTransaction(plan, { dryRun: false })
    expect(outcome.outcome).toBe("inserted")
    if (outcome.outcome !== "inserted") throw new Error("unreachable")
    expect(outcome.binding).toMatchObject({
      railId: plan.railId,
      environment: "staging",
      backend: "local",
      chainId: 84532,
      tokenAddress: SEPOLIA_USDC,
      treasuryAddress: `0x${"1".repeat(40)}`,
      vaultAddress: null,
      operatorAddress: `0x${"2".repeat(40)}`,
      policyVersion: "v1",
      status: "active",
    })
    expect(outcome.binding.createdAt).not.toBe("")
    expect(await activeRailCount()).toBe(1)
  })

  test("an identical rerun is an idempotent no-op", async () => {
    const outcome = await inTransaction(stagingPlan({ randomHex: "0e11ef00" }), { dryRun: false })
    expect(outcome.outcome).toBe("already_bound")
    expect(await activeRailCount()).toBe(1)
    const dry = await inTransaction(stagingPlan({ randomHex: "0e11ef01" }), { dryRun: true })
    expect(dry.outcome).toBe("dry_run_already_bound")
  })

  test("a different binding for the same environment and asset is refused", async () => {
    let caught: unknown
    try {
      await inTransaction(stagingPlan({ treasuryAddress: `0x${"9".repeat(40)}` }), { dryRun: false })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SettlementRailBootstrapError)
    expect((caught as SettlementRailBootstrapError).reason).toBe("conflicting_active_rail")
    expect(await activeRailCount()).toBe(1)
  })

  test("refuses unknown and non-admitted assets", async () => {
    let caught: unknown
    try {
      await inTransaction(stagingPlan({ tokenAddress: `0x${"c".repeat(40)}` }), { dryRun: false })
    } catch (error) {
      caught = error
    }
    expect((caught as SettlementRailBootstrapError).reason).toBe("asset_missing")

    await db.unsafe(
      "UPDATE reward_settlement_assets SET status = 'suspended', suspended_at = NOW() WHERE chain_id = 8453",
    )
    caught = undefined
    try {
      await inTransaction(stagingPlan({ chainId: 8453, tokenAddress: BASE_USDC, randomHex: "0e11ef02" }), {
        dryRun: false,
      })
    } catch (error) {
      caught = error
    }
    expect((caught as SettlementRailBootstrapError).reason).toBe("asset_not_admitted")
    expect(await activeRailCount()).toBe(1)
  })
})
