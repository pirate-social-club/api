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
      provisioning_state TEXT NOT NULL,
      shard_worker_id TEXT,
      binding_name TEXT,
      region TEXT,
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

test("upsertD1: seeds a ready row with the allocated shard binding", async () => {
  const result = await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1",
    shardWorkerId: "community-d1-shard-staging",
    bindingName: "DB_CMTY_0001",
    region: "enam",
    now: "2026-06-19T00:00:00Z",
  })
  expect(result.written).toBe(true)

  const row = await getCommunityDatabaseRoutingRow(cp, "cmty_d1")
  expect(row?.provisioning_state).toBe("ready")
  expect(row?.shard_worker_id).toBe("community-d1-shard-staging")
  expect(row?.binding_name).toBe("DB_CMTY_0001")
  expect(row?.region).toBe("enam")
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

test("findStuckD1ProvisioningBindings returns only provisioning rows past the cutoff", async () => {
  // Stuck: provisioning, old.
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_stuck",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_STUCK",
    region: "weur",
    now: "2026-06-20T00:00:00Z",
    provisioningState: "provisioning",
  })
  // Not stuck: provisioning, but recent (after cutoff).
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_recent",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_RECENT",
    region: "weur",
    now: "2026-06-20T00:30:00Z",
    provisioningState: "provisioning",
  })
  // Not stuck: ready.
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_READY",
    region: "weur",
    now: "2026-06-20T00:00:00Z",
    provisioningState: "ready",
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

test("isSettlementEligibleRoute: only ready, non-decommissioned routes are eligible", () => {
  // eligible
  expect(isSettlementEligibleRoute({ provisioning_state: "ready", decommissioned_at: null })).toBe(true)
  // ineligible — decommissioned (either signal)
  expect(isSettlementEligibleRoute({ provisioning_state: "decommissioned", decommissioned_at: null })).toBe(false)
  expect(isSettlementEligibleRoute({ provisioning_state: "ready", decommissioned_at: "2026-06-27T00:00:00Z" })).toBe(false)
  // ineligible — not yet ready / degraded
  expect(isSettlementEligibleRoute({ provisioning_state: "provisioning", decommissioned_at: null })).toBe(false)
  expect(isSettlementEligibleRoute({ provisioning_state: "degraded", decommissioned_at: null })).toBe(false)
})

test("listSettlementEligibleCommunities returns only ready non-decommissioned routes, oldest-first", async () => {
  // eligible (ready) — newest of the two eligible
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1_ready_b", shardWorkerId: "shard-1", bindingName: "DB_CMTY_B", region: "weur", now: "2026-06-20T00:00:00Z",
  })
  // eligible (ready) — oldest, should sort first
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1_ready_a", shardWorkerId: "shard-1", bindingName: "DB_CMTY_A", region: "weur", now: "2026-06-19T00:00:00Z",
  })
  // ineligible — a route explicitly decommissioned
  await upsertD1CommunityRoutingRow(cp, {
    communityId: "cmty_d1_decom", shardWorkerId: "shard-1", bindingName: "DB_CMTY_D", region: "weur", now: "2026-06-17T00:00:00Z",
  })
  await cp.execute("UPDATE community_database_routing SET provisioning_state = 'decommissioned', decommissioned_at = '2026-06-21T00:00:00Z' WHERE community_id = 'cmty_d1_decom'")
  // ineligible — still provisioning (no usable binding yet)
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
