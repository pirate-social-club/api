import { afterEach, beforeEach, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import {
  findStuckD1ProvisioningBindings,
  getCommunityDatabaseRoutingRow,
  isSettlementEligibleRoute,
  listSettlementEligibleCommunities,
  upsertD1CommunityRoutingRow,
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
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, turso_database_binding_id, created_at, updated_at)
      VALUES (?1, 'turso', 'ready', 'cdb_live', '2026-06-16T00:00:00Z', '2026-06-16T00:00:00Z')
    `,
    args: ["cmty_turso"],
  })

  const result = await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_turso",
    shardWorkerId: "shard-1",
    bindingName: "DB_STEAL",
    region: "enam",
    now: "2026-06-19T00:00:00Z",
  })
  expect(result.written).toBe(false)

  // The legacy row is untouched — a stale d1 provision cannot steal a live community.
  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_turso")
  expect(row?.backend).toBe("turso")
  expect(row?.turso_database_binding_id).toBe("cdb_live")
  expect(row?.shard_worker_id).toBeNull()
})

test("findStuckD1ProvisioningBindings returns only d1 provisioning rows past the cutoff", async () => {
  // Stuck: d1, provisioning, old.
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_stuck",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_STUCK",
    region: "weur",
    now: "2026-06-20T00:00:00Z",
    provisioningState: "provisioning",
  })
  // Not stuck: d1, provisioning, but recent (after cutoff).
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_recent",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_RECENT",
    region: "weur",
    now: "2026-06-20T00:30:00Z",
    provisioningState: "provisioning",
  })
  // Not stuck: d1, ready.
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_READY",
    region: "weur",
    now: "2026-06-20T00:00:00Z",
    provisioningState: "ready",
  })
  // Not stuck: legacy turso row (different backend).
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, turso_database_binding_id, created_at, updated_at)
      VALUES (?1, 'turso', 'provisioning', 'cdb_t', '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')
    `,
    args: ["cmty_turso2"],
  })

  const cutoff = "2026-06-20T00:15:00Z" // 15-min grace boundary
  const stuck = await findStuckD1ProvisioningBindings(cp, cutoff)

  expect(stuck).toHaveLength(1)
  expect(stuck[0]).toEqual({
    communityId: "cmty_stuck",
    bindingName: "DB_CMTY_STUCK",
    shardWorkerId: "shard-1",
    region: "weur",
  })
})

test("isSettlementEligibleRoute: only ready, non-decommissioned D1 routes are eligible", () => {
  // eligible
  expect(isSettlementEligibleRoute({ backend: "d1", provisioning_state: "ready", decommissioned_at: null })).toBe(true)
  // ineligible — non-d1 backend (Turso)
  expect(isSettlementEligibleRoute({ backend: "turso", provisioning_state: "ready", decommissioned_at: null })).toBe(false)
  // ineligible — decommissioned (either signal)
  expect(isSettlementEligibleRoute({ backend: "d1", provisioning_state: "decommissioned", decommissioned_at: null })).toBe(false)
  expect(isSettlementEligibleRoute({ backend: "d1", provisioning_state: "ready", decommissioned_at: "2026-06-27T00:00:00Z" })).toBe(false)
  // ineligible — not yet ready / degraded
  expect(isSettlementEligibleRoute({ backend: "d1", provisioning_state: "provisioning", decommissioned_at: null })).toBe(false)
  expect(isSettlementEligibleRoute({ backend: "d1", provisioning_state: "degraded", decommissioned_at: null })).toBe(false)
  // ineligible — unsupported/unknown backend is excluded by the allowlist, never assumed D1
  expect(isSettlementEligibleRoute({ backend: "experimental" as never, provisioning_state: "ready", decommissioned_at: null })).toBe(false)
})

test("listSettlementEligibleCommunities returns only ready non-decommissioned D1, oldest-first", async () => {
  // eligible D1 (ready) — newest of the two eligible
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1_ready_b", shardWorkerId: "shard-1", bindingName: "DB_CMTY_B", region: "weur", now: "2026-06-20T00:00:00Z",
  })
  // eligible D1 (ready) — oldest, should sort first
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1_ready_a", shardWorkerId: "shard-1", bindingName: "DB_CMTY_A", region: "weur", now: "2026-06-19T00:00:00Z",
  })
  // ineligible — legacy Turso row
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, turso_database_binding_id, created_at, updated_at)
      VALUES (?1, 'turso', 'ready', 'cdb_t', '2026-06-18T00:00:00Z', '2026-06-18T00:00:00Z')
    `,
    args: ["cmty_turso"],
  })
  // ineligible — a D1 route explicitly decommissioned
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1_decom", shardWorkerId: "shard-1", bindingName: "DB_CMTY_D", region: "weur", now: "2026-06-17T00:00:00Z",
  })
  await cp.execute("UPDATE community_database_routing SET provisioning_state = 'decommissioned', decommissioned_at = '2026-06-21T00:00:00Z' WHERE community_id = 'cmty_d1_decom'")
  // ineligible — D1 still provisioning (no usable binding yet)
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1_prov", shardWorkerId: "shard-1", bindingName: "DB_CMTY_P", region: "weur", now: "2026-06-16T00:00:00Z", provisioningState: "provisioning",
  })

  const eligible = await listSettlementEligibleCommunities(cp)
  expect(eligible.map((c) => c.community_id)).toEqual(["cmty_d1_ready_a", "cmty_d1_ready_b"])
  expect(eligible[0].created_at).toBe("2026-06-19T00:00:00Z")

  // limit is honoured
  const limited = await listSettlementEligibleCommunities(cp, { limit: 1 })
  expect(limited.map((c) => c.community_id)).toEqual(["cmty_d1_ready_a"])
})
