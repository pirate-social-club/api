import { describe, expect, test } from "bun:test"

import {
  MIGRATION_0001,
  verifyPhysicalPre0003,
  verifyRepairableSnapshot,
  type PoolSchemaSnapshot,
} from "./reconcile-pool-migration-ledger"

function snapshot(): PoolSchemaSnapshot {
  const columns = [
    ["binding_name", "TEXT", 0, null, 1],
    ["community_id", "TEXT", 0, null, 0],
    ["allocated_at", "TEXT", 0, null, 0],
    ["last_loaded_at", "TEXT", 0, null, 0],
    ["last_error", "TEXT", 0, null, 0],
    ["released_at", "TEXT", 0, null, 0],
    ["version", "INTEGER", 1, "0", 0],
    ["allocation_source", "TEXT", 0, null, 0],
    ["allocation_run_id", "TEXT", 0, null, 0],
  ].map(([name, type, notnull, dflt_value, pk], cid) => ({ cid, name, type, notnull, dflt_value, pk }))
  const index = (index_name: string, columns: string[], unique: number, origin: string, partial: number) =>
    columns.map((column_name, seqno) => ({ index_name, unique, origin, partial, seqno, column_name }))
  return {
    columns,
    indexes: [
      ...index("idx_d1_pool_free", ["community_id", "released_at"], 0, "c", 0),
      ...index("idx_d1_pool_allocation_source", ["allocation_source", "allocated_at"], 0, "c", 1),
      ...index("sqlite_autoindex_d1_pool_2", ["community_id"], 1, "u", 0),
      ...index("sqlite_autoindex_d1_pool_1", ["binding_name"], 1, "pk", 0),
    ],
    objects: [
      { type: "table", name: "d1_pool", sql: "CREATE TABLE d1_pool (...)" },
      { type: "table", name: "d1_migrations", sql: "CREATE TABLE d1_migrations (...)" },
      { type: "index", name: "idx_d1_pool_free", sql: "CREATE INDEX idx_d1_pool_free ON d1_pool(community_id, released_at)" },
      { type: "index", name: "idx_d1_pool_allocation_source", sql: "CREATE INDEX idx_d1_pool_allocation_source ON d1_pool(allocation_source, allocated_at) WHERE allocation_source IS NOT NULL" },
    ],
    ledger: [{ id: 1, name: MIGRATION_0001, applied_at: "2026-08-03 14:27:49" }],
  }
}

describe("verifyRepairableSnapshot", () => {
  test("accepts the exact reconciliable 0001-ledger/0001+0002-physical state", () => {
    expect(() => verifyRepairableSnapshot(snapshot())).not.toThrow()
  })

  test("rejects a missing partial-index predicate", () => {
    const input = snapshot()
    const row = input.objects.find((candidate) => candidate.name === "idx_d1_pool_allocation_source")!
    row.sql = "CREATE INDEX idx_d1_pool_allocation_source ON d1_pool(allocation_source, allocated_at)"
    expect(() => verifyRepairableSnapshot(input)).toThrow("sqlite_master.sql mismatch")
  })

  test("rejects a partial 0002 physical state", () => {
    const input = snapshot()
    input.columns.pop()
    expect(() => verifyRepairableSnapshot(input)).toThrow("column count")
  })

  test("rejects an unexpected ledger state", () => {
    const input = snapshot()
    input.ledger.push({ id: 2, name: "0002_d1_pool_allocation_attribution.sql" })
    expect(() => verifyRepairableSnapshot(input)).toThrow("ledger must contain exactly")
  })

  test("accepts the exact physical state independently of a missing ledger", () => {
    const input = snapshot()
    input.objects = input.objects.filter((row) => row.name !== "d1_migrations")
    input.ledger = []
    expect(() => verifyPhysicalPre0003(input)).not.toThrow()
  })

  test("rejects 0003 artifacts", () => {
    const input = snapshot()
    input.objects.push({ type: "table", name: "d1_pool_schema_attestations", sql: "CREATE TABLE ..." })
    expect(() => verifyRepairableSnapshot(input)).toThrow("0003 artifacts already exist")
  })
})
