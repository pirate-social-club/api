import { afterEach, beforeEach, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import {
  getCommunityDatabaseRoutingRow,
  upsertD1CommunityRoutingRow,
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
      updated_at TEXT NOT NULL,
      CONSTRAINT chk_d1_fields CHECK (
        (backend = 'd1' AND shard_worker_id IS NOT NULL AND binding_name IS NOT NULL
            AND region IS NOT NULL AND turso_database_binding_id IS NULL)
        OR (backend = 'turso' AND shard_worker_id IS NULL AND binding_name IS NULL
            AND region IS NULL AND turso_database_binding_id IS NOT NULL)
      )
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

test("upsertD1: seeds a backend='d1' ready row with the allocated shard binding", async () => {
  const result = await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1",
    shardWorkerId: "community-d1-shard-staging",
    bindingName: "DB_CMTY_0001",
    region: "enam",
    now: "2026-06-19T00:00:00Z",
  })
  expect(result.written).toBe(true)

  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_d1")
  expect(row?.backend).toBe("d1")
  expect(row?.provisioning_state).toBe("ready")
  expect(row?.shard_worker_id).toBe("community-d1-shard-staging")
  expect(row?.binding_name).toBe("DB_CMTY_0001")
  expect(row?.region).toBe("enam")
  expect(row?.turso_database_binding_id).toBeNull()
})

test("upsertD1: advances a 'provisioning' row to 'ready' (lifecycle transition)", async () => {
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_0002",
    region: "weur",
    now: "2026-06-19T00:00:00Z",
    provisioningState: "provisioning",
  })

  const advanced = await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_0002",
    region: "weur",
    now: "2026-06-19T00:05:00Z",
    provisioningState: "ready",
  })
  expect(advanced.written).toBe(true)

  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_d1")
  expect(row?.provisioning_state).toBe("ready")
  expect(row?.updated_at).toBe("2026-06-19T00:05:00Z")
})

test("upsertD1: never clobbers or downgrades an existing backend='turso' row", async () => {
  await upsertTursoCommunityRoutingRow(cp, {
    communityId: "cmty_turso",
    tursoDatabaseBindingId: "cdb_live",
    now: "2026-06-16T00:00:00Z",
  })

  const result = await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_turso",
    shardWorkerId: "shard-1",
    bindingName: "DB_STEAL",
    region: "enam",
    now: "2026-06-19T00:00:00Z",
  })
  expect(result.written).toBe(false)

  // The Turso row is untouched — a stale d1 provision cannot steal a live community.
  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_turso")
  expect(row?.backend).toBe("turso")
  expect(row?.turso_database_binding_id).toBe("cdb_live")
  expect(row?.shard_worker_id).toBeNull()
})
