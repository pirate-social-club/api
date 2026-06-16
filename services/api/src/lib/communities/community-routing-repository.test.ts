import { afterEach, beforeEach, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import {
  getCommunityDatabaseRoutingRow,
  upsertTursoCommunityRoutingRow,
} from "./community-routing-repository"

let cp: Client

beforeEach(async () => {
  cp = createClient({ url: ":memory:" })
  await cp.execute(`
    CREATE TABLE community_database_routing (
      community_id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      provisioning_state TEXT NOT NULL,
      shard_worker_id TEXT,
      binding_name TEXT,
      region TEXT,
      turso_database_binding_id TEXT,
      migrated_at TEXT,
      decommissioned_at TEXT,
      last_error_at TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
})

afterEach(() => {
  cp.close()
})

test("seeds a backend='turso' ready row referencing the primary binding", async () => {
  const result = await upsertTursoCommunityRoutingRow(cp, {
    communityId: "cmty_1",
    tursoDatabaseBindingId: "cdb_1",
    now: "2026-06-16T00:00:00Z",
  })
  expect(result.inserted).toBe(true)

  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_1")
  expect(row).not.toBeNull()
  expect(row?.backend).toBe("turso")
  expect(row?.provisioning_state).toBe("ready")
  expect(row?.turso_database_binding_id).toBe("cdb_1")
  expect(row?.shard_worker_id).toBeNull()
  expect(row?.created_at).toBe("2026-06-16T00:00:00Z")
  expect(row?.updated_at).toBe("2026-06-16T00:00:00Z")
})

test("is idempotent: re-running never inserts or mutates an existing row", async () => {
  await upsertTursoCommunityRoutingRow(cp, {
    communityId: "cmty_1",
    tursoDatabaseBindingId: "cdb_1",
    now: "2026-06-16T00:00:00Z",
  })

  const second = await upsertTursoCommunityRoutingRow(cp, {
    communityId: "cmty_1",
    tursoDatabaseBindingId: "cdb_DIFFERENT",
    now: "2026-06-17T00:00:00Z",
  })
  expect(second.inserted).toBe(false)

  // Original row is untouched — backfill cannot clobber existing routing.
  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_1")
  expect(row?.turso_database_binding_id).toBe("cdb_1")
  expect(row?.created_at).toBe("2026-06-16T00:00:00Z")
})

test("does not regress a community already flipped to d1", async () => {
  // Simulate a community the provisioning path (PR2+) already migrated to d1.
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, shard_worker_id, binding_name, region,
         migrated_at, created_at, updated_at)
      VALUES (?1, 'd1', 'ready', 'shard-1', 'DB_X', 'enam', 't1', 't0', 't1')
    `,
    args: ["cmty_migrated"],
  })

  const result = await upsertTursoCommunityRoutingRow(cp, {
    communityId: "cmty_migrated",
    tursoDatabaseBindingId: "cdb_old",
    now: "2026-06-18T00:00:00Z",
  })
  expect(result.inserted).toBe(false)

  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_migrated")
  expect(row?.backend).toBe("d1")
  expect(row?.shard_worker_id).toBe("shard-1")
})
