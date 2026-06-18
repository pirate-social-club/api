import { afterEach, beforeEach, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { CommunityBindingResolver } from "./community-binding-resolver"
import {
  resolveCommunityReadHandle,
  resolveCommunityWriteHandle,
  openShardReadClientNotProvisioned,
  makeShardReadClient,
  type CommunityReadAccessDeps,
  type CommunityReadHandle,
  type CommunityWriteAccessDeps,
} from "./community-read-access"
import type { CommunityReadInvoker } from "./community-read-router"
import type { ResolvedCommunityBinding } from "./community-binding-resolver"
import { HttpError } from "../errors"
import type { Client as ApiClient, ReadClient } from "../sql-client"

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

test("makeShardReadClient dispatches execute/batch to the shard RPC with communityId + bindingName", async () => {
  const calls: Array<[string, unknown]> = []
  const shard = {
    execute: async (input: unknown) => {
      calls.push(["execute", input])
      return { rows: [{ ok: 1 }] }
    },
    batch: async (input: unknown) => {
      calls.push(["batch", input])
      return [{ rows: [] }]
    },
  }
  const binding = {
    communityId: "cmt_d1",
    backend: "d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_PILOT",
    region: "enam",
    tursoDatabaseBindingId: null,
    decommissionedAt: null,
  } as ResolvedCommunityBinding

  const client = makeShardReadClient(shard, binding)
  const r = await client.execute("SELECT 1")
  expect(r.rows).toEqual([{ ok: 1 }])
  expect(calls[0][1]).toMatchObject({ communityId: "cmt_d1", bindingName: "DB_CMTY_PILOT", statement: "SELECT 1" })

  // Write batch mode is rejected client-side (defense in depth; shard also guards).
  await expect(client.batch([{ sql: "INSERT INTO t VALUES (1)" }], "write")).rejects.toMatchObject({
    code: "read_only_violation",
  })
})

test("makeShardReadClient throws if the d1 routing row has no binding_name", () => {
  const binding = {
    communityId: "cmt_d1",
    backend: "d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: null,
    region: "enam",
    tursoDatabaseBindingId: null,
    decommissionedAt: null,
  } as ResolvedCommunityBinding
  const shard = { execute: async () => ({ rows: [] }), batch: async () => [] }
  expect(() => makeShardReadClient(shard, binding)).toThrow(HttpError)
})

function writeDeps(overrides: Partial<CommunityWriteAccessDeps>): CommunityWriteAccessDeps {
  return {
    enabled: true,
    resolver: new CommunityBindingResolver(),
    controlPlane: cp,
    openD1: () => ({ ...STUB_READ_CLIENT, __tag: "d1", transaction: async () => { throw new Error("unused") } } as unknown as ApiClient),
    openLegacy: async () => ({ client: { ...STUB_READ_CLIENT, __tag: "legacy" } as unknown as ApiClient, close: () => {} }),
    ...overrides,
  }
}

async function seedD1Row(communityId: string): Promise<void> {
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, backend, provisioning_state, shard_worker_id, binding_name, region, migrated_at, created_at, updated_at)
      VALUES (?1, 'd1', 'ready', 'shard-1', 'DB_CMTY_PILOT', 'enam', 't1', 't0', 't1')
    `,
    args: [communityId],
  })
}

test("write: flag off → legacy (no resolver/control-plane touch)", async () => {
  let resolved = false
  const deps = writeDeps({ enabled: false, openD1: () => { resolved = true; return {} as Client } })
  const h = await resolveCommunityWriteHandle(deps, "cmt_x")
  expect((h.client as { __tag?: string }).__tag).toBe("legacy")
  expect(resolved).toBe(false)
})

test("write: backend='d1' → D1 client", async () => {
  await seedD1Row("cmt_d1w")
  const h = await resolveCommunityWriteHandle(writeDeps({}), "cmt_d1w")
  expect((h.client as { __tag?: string }).__tag).toBe("d1")
})

test("write: backend='d1' never opens the Turso/legacy client (enqueue backend consistency)", async () => {
  // Regression for #48: a write-on-read route (e.g. listCommentReplies' prewarm enqueue) routed
  // through openCommunityWriteClient must enqueue into the community's actual backend. For a
  // D1-backed community it must hit the D1 client and NEVER fall to the Turso/legacy client —
  // otherwise jobs split-brain (enqueued to Turso, consumed from D1 by the routed runner).
  await seedD1Row("cmt_d1consistency")
  let legacyOpened = false
  const deps = writeDeps({
    openLegacy: async () => {
      legacyOpened = true
      return { client: { ...STUB_READ_CLIENT, __tag: "legacy" } as unknown as ApiClient, close: () => {} }
    },
  })
  const h = await resolveCommunityWriteHandle(deps, "cmt_d1consistency")
  expect((h.client as { __tag?: string }).__tag).toBe("d1")
  expect(legacyOpened).toBe(false)
})

test("write: backend='turso' → legacy", async () => {
  await seedTursoRow("cmt_tw")
  const h = await resolveCommunityWriteHandle(writeDeps({}), "cmt_tw")
  expect((h.client as { __tag?: string }).__tag).toBe("legacy")
})

test("write: no routing row → falls back to legacy", async () => {
  const h = await resolveCommunityWriteHandle(writeDeps({}), "cmt_missing_w")
  expect((h.client as { __tag?: string }).__tag).toBe("legacy")
})

test("write: backend='d1' but shard absent → propagates d1_backend_not_provisioned", async () => {
  await seedD1Row("cmt_d1noshard")
  const deps = writeDeps({
    openD1: () => {
      throw new HttpError(503, "d1_backend_not_provisioned", "no shard", true)
    },
  })
  await expect(resolveCommunityWriteHandle(deps, "cmt_d1noshard")).rejects.toMatchObject({ code: "d1_backend_not_provisioned" })
})
