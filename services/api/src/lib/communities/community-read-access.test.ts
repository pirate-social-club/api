import { afterEach, beforeEach, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { CommunityBindingResolver } from "./community-binding-resolver"
import {
  resolveCommunityReadHandle,
  openShardReadClientNotProvisioned,
  type CommunityReadAccessDeps,
  type CommunityReadHandle,
} from "./community-read-access"
import type { CommunityReadInvoker } from "./community-read-router"
import { HttpError } from "../errors"
import type { ReadClient } from "../sql-client"

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

const STUB_READ_CLIENT: ReadClient = {
  execute: async () => ({ rows: [] }),
  batch: async () => [],
}

function legacyHandle(tag: string): CommunityReadHandle {
  return { client: { ...STUB_READ_CLIENT, __tag: tag } as ReadClient, close: () => {} }
}

function makeDeps(overrides: Partial<CommunityReadAccessDeps>): CommunityReadAccessDeps {
  return {
    enabled: true,
    resolver: new CommunityBindingResolver(),
    controlPlane: cp,
    openTursoReadClient: async () => ({ ...STUB_READ_CLIENT, __tag: "turso" } as ReadClient),
    openShardReadClient: openShardReadClientNotProvisioned,
    openLegacy: async () => legacyHandle("legacy"),
    ...overrides,
  }
}

async function seedTursoRow(communityId: string): Promise<void> {
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, turso_database_binding_id, created_at, updated_at)
      VALUES (?1, 'turso', 'ready', 'cdb_1', 't0', 't0')
    `,
    args: [communityId],
  })
}

test("flag off → legacy path, control plane never consulted", async () => {
  let routerInvoked = false
  const deps = makeDeps({
    enabled: false,
    openTursoReadClient: async () => {
      routerInvoked = true
      return STUB_READ_CLIENT
    },
  })
  const handle = await resolveCommunityReadHandle(deps, "cmty_1")
  expect((handle.client as { __tag?: string }).__tag).toBe("legacy")
  expect(routerInvoked).toBe(false)
})

test("flag on + turso row present → routed through the Turso invoker", async () => {
  await seedTursoRow("cmty_1")
  const handle = await resolveCommunityReadHandle(makeDeps({}), "cmty_1")
  expect((handle.client as { __tag?: string }).__tag).toBe("turso")
})

test("flag on + no routing row → falls back to legacy (no 404)", async () => {
  // Directory empty for this community (predates backfill).
  const handle = await resolveCommunityReadHandle(makeDeps({}), "cmty_missing")
  expect((handle.client as { __tag?: string }).__tag).toBe("legacy")
})

test("flag on + d1 row → propagates not-provisioned (does NOT fall back)", async () => {
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, shard_worker_id, binding_name, region, created_at, updated_at)
      VALUES (?1, 'd1', 'ready', 'shard-1', 'DB_X', 'enam', 't0', 't0')
    `,
    args: ["cmty_d1"],
  })
  await expect(resolveCommunityReadHandle(makeDeps({}), "cmty_d1")).rejects.toThrow(HttpError)
})

test("flag on + decommissioned row → propagates 410 (does NOT fall back)", async () => {
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, turso_database_binding_id, decommissioned_at, created_at, updated_at)
      VALUES (?1, 'turso', 'decommissioned', 'cdb_1', 't1', 't0', 't1')
    `,
    args: ["cmty_gone"],
  })
  const deps = makeDeps({})
  await expect(resolveCommunityReadHandle(deps, "cmty_gone")).rejects.toMatchObject({ status: 410 })
})

test("stale binding from invoker → cache invalidated and error propagates", async () => {
  await seedTursoRow("cmty_stale")
  const stale: CommunityReadInvoker = async () => {
    throw new HttpError(409, "binding_stale", "stale", false)
  }
  // binding_stale is a fallback code, so the helper recovers via legacy.
  const handle = await resolveCommunityReadHandle(
    makeDeps({ openTursoReadClient: stale }),
    "cmty_stale",
  )
  expect((handle.client as { __tag?: string }).__tag).toBe("legacy")
})
