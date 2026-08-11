import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  BOOTSTRAP_STATE_TABLE_DDL,
  SCHEMA_ATTESTATION_INVENTORY_SQL,
  SCHEMA_ATTESTATION_MIGRATION_LEDGER_SQL,
  isBootstrapAllowedStatement,
  shardSchemaObservationProof,
  type ShardMigrationLedgerRow,
  type ShardSchemaInventoryRow,
} from "@pirate/api-shared"
import {
  COMMUNITY_SCHEMA_MIGRATIONS,
  COMMUNITY_SCHEMA_OBSERVATION_PROOF,
  COMMUNITY_SCHEMA_STATEMENTS,
} from "./community-schema-snapshot"

/**
 * Regression pin: every statement in the COMMITTED community schema snapshot
 * must pass the shard bootstrap guard. Migration 1147 added CREATE TRIGGERs
 * (body semicolons inside BEGIN ... END) that the guard rejected, taking down
 * d1_native provisioning in production while every CI check stayed green —
 * the snapshot freshness gate never validated guard compatibility and no test
 * imported this artifact. The generator now asserts the same contract at
 * build time; this test pins the committed file, so a hand-edited, stale, or
 * bypass-generated snapshot fails too.
 */
describe("COMMUNITY_SCHEMA_STATEMENTS vs the shard bootstrap guard", () => {
  test("every generated statement passes isBootstrapAllowedStatement", () => {
    const rejected = COMMUNITY_SCHEMA_STATEMENTS.filter(
      (sql) => !isBootstrapAllowedStatement(sql),
    )
    expect(rejected).toEqual([])
  })

  test("the snapshot still contains CREATE TRIGGER objects (guard-drift canary)", () => {
    // The 1147 triggers are what exercise the guard's trigger handling. If a
    // future schema change legitimately removes all triggers, delete this
    // canary — its only job is to prove the guard and the real snapshot shape
    // cannot silently part ways again.
    expect(
      COMMUNITY_SCHEMA_STATEMENTS.some((sql) => /^CREATE TRIGGER\b/i.test(sql)),
    ).toBe(true)
  })

  test("the generated observation proof matches an independently loaded database", async () => {
    const db = new Database(":memory:")
    try {
      for (const sql of COMMUNITY_SCHEMA_STATEMENTS) db.exec(sql)
      db.exec(BOOTSTRAP_STATE_TABLE_DDL)
      const insertMigration = db.prepare(
        "INSERT INTO schema_migrations (migration_name, migration_label, checksum) VALUES (?1, 'community-template', ?2)",
      )
      for (const migration of COMMUNITY_SCHEMA_MIGRATIONS) {
        insertMigration.run(migration.name, migration.checksum)
      }
      const actual = await shardSchemaObservationProof({
        schemaRows: db.query<ShardSchemaInventoryRow, []>(SCHEMA_ATTESTATION_INVENTORY_SQL).all(),
        migrationLedgerRows: db
          .query<ShardMigrationLedgerRow, []>(SCHEMA_ATTESTATION_MIGRATION_LEDGER_SQL)
          .all(),
      })
      expect(actual).toEqual(COMMUNITY_SCHEMA_OBSERVATION_PROOF)
    } finally {
      db.close()
    }
  })

  test("the generated commerce schema stores money only as integer cents and basis points", () => {
    const db = new Database(":memory:")
    try {
      for (const sql of COMMUNITY_SCHEMA_STATEMENTS) db.exec(sql)

      const expectedColumns = {
        listings: ["price_cents"],
        purchase_quotes: ["base_price_cents", "final_price_cents"],
        purchases: ["purchase_price_cents", "donation_share_bps", "donation_amount_cents"],
        purchase_allocation_legs: ["amount_cents"],
      } as const
      const retiredColumns = new Set([
        "price_usd",
        "base_price_usd",
        "final_price_usd",
        "purchase_price_usd",
        "donation_share_pct",
        "donation_amount_usd",
        "amount_usd",
      ])

      for (const [table, required] of Object.entries(expectedColumns)) {
        const columns = db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${table})`).all()
        const byName = new Map(columns.map((column) => [column.name, column.type.toUpperCase()]))
        for (const column of required) expect(byName.get(column)).toBe("INTEGER")
        for (const column of retiredColumns) expect(byName.has(column)).toBe(false)
      }
    } finally {
      db.close()
    }
  })
})
