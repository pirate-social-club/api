import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const migrations = resolve(import.meta.dir, "../migrations")

async function migratedPool(): Promise<Database> {
  const db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const name of [
    "0001_d1_pool.sql",
    "0002_d1_pool_allocation_attribution.sql",
    "0003_d1_pool_schema_attestations.sql",
  ]) {
    db.exec(await readFile(resolve(migrations, name), "utf8"))
  }
  return db
}

const digest = "a".repeat(64)

describe("D1 pool schema attestation migration", () => {
  test("stores one generation-bound full-scan verdict per pool binding", async () => {
    const db = await migratedPool()
    try {
      db.exec("INSERT INTO d1_pool (binding_name, community_id, version) VALUES ('DB_CMTY_0001', 'community-1', 7)")
      db.query(`
        INSERT INTO d1_pool_schema_attestations (
          shard_worker_id, binding_name, community_id, pool_version,
          attestation_epoch, state, verdict_status, effective_policy_digest,
          schema_fingerprint, migration_ledger_digest, canonical_inventory_digest,
          verified_at, writer_kind, writer_run_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'verified', 'satisfied', ?6, ?6, ?6, ?6, ?7, 'full_scan', ?5)
      `).run("worker-a", "DB_CMTY_0001", "community-1", 7, "run-1", digest, "2026-08-03T00:00:00.000Z")

      expect(db.query("SELECT state, pool_version FROM d1_pool_schema_attestations").get())
        .toEqual({ state: "verified", pool_version: 7 })
    } finally {
      db.close()
    }
  })

  test("rejects malformed proof digests and inconsistent verified state", async () => {
    const db = await migratedPool()
    try {
      db.exec("INSERT INTO d1_pool (binding_name, community_id, version) VALUES ('DB_CMTY_0001', 'community-1', 7)")
      const insert = db.query(`
        INSERT INTO d1_pool_schema_attestations (
          shard_worker_id, binding_name, community_id, pool_version,
          attestation_epoch, state, verdict_status, effective_policy_digest,
          schema_fingerprint, migration_ledger_digest, canonical_inventory_digest,
          verified_at, writer_kind, writer_run_id, last_error_code
        ) VALUES (?1, 'DB_CMTY_0001', 'community-1', 7, 'run-1', 'verified', 'satisfied', ?2, ?2, ?2, ?2, ?3, 'full_scan', 'run-1', ?4)
      `)
      expect(() => insert.run("worker-a", "short", "2026-08-03T00:00:00.000Z", null)).toThrow()
      expect(() => insert.run("worker-a", digest, "2026-08-03T00:00:00.000Z", "error")).toThrow()
    } finally {
      db.close()
    }
  })
})
