import { afterEach, beforeEach, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { CommunityBindingResolver } from "./community-binding-resolver"
import {
  resolveCommunityReadHandle,
  resolveCommunityWriteHandle,
  openShardReadClientNotProvisioned,
  makeShardReadClient,
  type CommunityReadAccessDeps,
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

const STUB_READ_CLIENT: ReadClient = {
  execute: async () => ({ rows: [] }),
  batch: async () => [],
}

function makeDeps(overrides: Partial<CommunityReadAccessDeps>): CommunityReadAccessDeps {
  return {
    resolver: new CommunityBindingResolver(),
    controlPlane: cp,
    openShardReadClient: async () => ({ ...STUB_READ_CLIENT, __tag: "d1" } as ReadClient),
    ...overrides,
  }
}

test("d1 row → routed through the shard invoker", async () => {
  await seedD1Row("cmty_1")
  const handle = await resolveCommunityReadHandle(makeDeps({}), "cmty_1")
  expect((handle.client as { __tag?: string }).__tag).toBe("d1")
})

test("no routing row → propagates community_not_found", async () => {
  await expect(resolveCommunityReadHandle(makeDeps({}), "cmty_missing")).rejects.toMatchObject({
    code: "community_not_found",
  })
})

test("d1 row → propagates not-provisioned", async () => {
  await seedD1Row("cmty_d1")
  await expect(
    resolveCommunityReadHandle(makeDeps({ openShardReadClient: openShardReadClientNotProvisioned }), "cmty_d1"),
  ).rejects.toThrow(HttpError)
})

test("decommissioned row → propagates 410", async () => {
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, provisioning_state, decommissioned_at, created_at, updated_at)
      VALUES (?1, 'decommissioned', 't1', 't0', 't1')
    `,
    args: ["cmty_gone"],
  })
  const deps = makeDeps({})
  await expect(resolveCommunityReadHandle(deps, "cmty_gone")).rejects.toMatchObject({ status: 410 })
})

test("stale binding from invoker → cache invalidated and error propagates", async () => {
  await seedD1Row("cmty_stale")
  const stale: CommunityReadInvoker = async () => {
    throw new HttpError(409, "binding_stale", "stale", false)
  }
  await expect(resolveCommunityReadHandle(makeDeps({ openShardReadClient: stale }), "cmty_stale")).rejects.toMatchObject({
    code: "binding_stale",
  })
})

test("stale binding from shard execute → cache invalidated for the next request", async () => {
  await seedD1Row("cmty_rpc_stale")
  const resolver = new CommunityBindingResolver()
  const staleClient: ReadClient = {
    execute: async () => {
      throw new HttpError(409, "binding_stale", "stale", false)
    },
    batch: async () => [],
  }
  const deps = makeDeps({ resolver, openShardReadClient: async () => staleClient })
  const first = await resolveCommunityReadHandle(deps, "cmty_rpc_stale")
  await expect(first.client.execute("SELECT 1")).rejects.toMatchObject({ code: "binding_stale" })

  await cp.execute(
    "UPDATE community_database_routing SET binding_name = 'DB_REBOUND' WHERE community_id = ?1",
    ["cmty_rpc_stale"],
  )
  let reboundBinding: string | null = null
  await resolveCommunityReadHandle(
    makeDeps({
      resolver,
      openShardReadClient: async (binding) => {
        reboundBinding = binding.bindingName
        return STUB_READ_CLIENT
      },
    }),
    "cmty_rpc_stale",
  )
  expect(reboundBinding).toBe("DB_REBOUND")
})

test("makeShardReadClient dispatches execute/batch to the shard RPC with communityId + bindingName", async () => {
  const calls: Array<[string, unknown]> = []
  const shard = {
    execute: async (input: unknown) => {
      calls.push(["execute", input])
      return { ok: true as const, value: { rows: [{ ok: 1 }] } }
    },
    batch: async (input: unknown) => {
      calls.push(["batch", input])
      return { ok: true as const, value: [{ rows: [] }] }
    },
  } as unknown as Parameters<typeof makeShardReadClient>[0]
  const binding = {
    communityId: "cmt_d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_PILOT",
    region: "enam",
    decommissionedAt: null,
  } as ResolvedCommunityBinding

  const client = makeShardReadClient(shard, binding)
  const r = await client.execute("SELECT 1")
  expect(r.rows).toEqual([{ ok: 1 }])
  expect(calls[0]![1]).toMatchObject({ communityId: "cmt_d1", bindingName: "DB_CMTY_PILOT", statement: "SELECT 1" })

  // Write batch mode is rejected client-side (defense in depth; shard also guards).
  await expect(client.batch([{ sql: "INSERT INTO t VALUES (1)" }], "write")).rejects.toMatchObject({
    code: "read_only_violation",
  })
})

test("makeShardReadClient preserves shard error codes across the boundary (step 2.5)", async () => {
  // The shard returns a typed error as a VALUE (ShardResult), not as a thrown
  // Error. The client unwraps it and re-throws as an HttpError with the
  // original code preserved — so the API can distinguish shard_pool_write_conflict
  // (retry) from shard_pool_exhausted (fail to ops) from shard_binding_not_allowed
  // (security deny). This test pins the code-preservation contract that the
  // WorkerEntrypoint boundary would otherwise strip.
  //
  // Status mapping (D1-NATIVE-PROVISIONING-DESIGN.md §4.1):
  //   - security deny → 403, NOT retryable
  //   - pool transient (exhausted / write_conflict / not_allocated) → 503, retryable
  //   - generic → 500, retryable
  const cases: Array<{
    code: string
    expectedStatus: number
    expectedRetryable: boolean
  }> = [
    { code: "shard_binding_not_allowed", expectedStatus: 403, expectedRetryable: false },
    { code: "shard_pool_write_conflict", expectedStatus: 503, expectedRetryable: true },
    { code: "shard_pool_exhausted", expectedStatus: 503, expectedRetryable: true },
    { code: "shard_binding_not_allocated", expectedStatus: 503, expectedRetryable: true },
    { code: "shard_unknown_binding", expectedStatus: 500, expectedRetryable: true },
  ]
  for (const { code, expectedStatus, expectedRetryable } of cases) {
    const shard = {
      execute: async () => ({ ok: false as const, code, message: `shard says ${code}` }),
      batch: async () => ({ ok: false as const, code, message: `shard says ${code}` }),
    } as unknown as Parameters<typeof makeShardReadClient>[0]
    const binding = {
      communityId: "cmt_d1",
      provisioningState: "ready",
      shardWorkerId: "shard-1",
      bindingName: "DB_CMTY_PILOT",
      region: "enam",
      decommissionedAt: null,
    } as ResolvedCommunityBinding
    const client = makeShardReadClient(shard, binding)
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({
      code,
      status: expectedStatus,
      retryable: expectedRetryable,
    })
  }
})

test("makeShardReadClient throws if the d1 routing row has no binding_name", () => {
  const binding = {
    communityId: "cmt_d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: null,
    region: "enam",
    decommissionedAt: null,
  } as ResolvedCommunityBinding
  const shard = {
    execute: async () => ({ ok: true as const, value: { rows: [] } }),
    batch: async () => ({ ok: true as const, value: [] }),
  } as unknown as Parameters<typeof makeShardReadClient>[0]
  expect(() => makeShardReadClient(shard, binding)).toThrow(HttpError)
})

function writeDeps(overrides: Partial<CommunityWriteAccessDeps>): CommunityWriteAccessDeps {
  return {
    resolver: new CommunityBindingResolver(),
    controlPlane: cp,
    openD1: () => ({ ...STUB_READ_CLIENT, __tag: "d1", transaction: async () => { throw new Error("unused") } } as unknown as ApiClient),
    ...overrides,
  }
}

async function seedD1Row(communityId: string): Promise<void> {
  await cp.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, provisioning_state, shard_worker_id, binding_name, region, migrated_at, created_at, updated_at)
      VALUES (?1, 'ready', 'shard-1', 'DB_CMTY_PILOT', 'enam', 't1', 't0', 't1')
    `,
    args: [communityId],
  })
}

test("write: backend='d1' → D1 client", async () => {
  await seedD1Row("cmt_d1w")
  const h = await resolveCommunityWriteHandle(writeDeps({}), "cmt_d1w")
  expect((h.client as { __tag?: string }).__tag).toBe("d1")
})

test("write: backend='d1' never opens the legacy external client (enqueue backend consistency)", async () => {
  // Regression for #48: a write-on-read route (e.g. listCommentReplies' prewarm enqueue) routed
  // through openCommunityWriteClient must enqueue into the community's actual backend. For a
  // D1-backed community it must hit the D1 client and NEVER fall to the legacy external client —
  // otherwise jobs split-brain (enqueued to a legacy external DB, consumed from D1 by the routed runner).
  await seedD1Row("cmt_d1consistency")
  const deps = writeDeps({})
  const h = await resolveCommunityWriteHandle(deps, "cmt_d1consistency")
  expect((h.client as { __tag?: string }).__tag).toBe("d1")
})

test("write: stale binding from commit invalidates the cache without replaying the write", async () => {
  await seedD1Row("cmt_write_stale")
  const resolver = new CommunityBindingResolver()
  let commitCalls = 0
  const transaction = {
    execute: async () => ({ rows: [] }),
    batch: async () => [],
    commit: async () => {
      commitCalls += 1
      throw new HttpError(409, "binding_stale", "stale", false)
    },
    rollback: async () => {},
    close: () => {},
  }
  const staleClient = {
    ...STUB_READ_CLIENT,
    transaction: async () => transaction,
  } as ApiClient
  const first = await resolveCommunityWriteHandle(
    writeDeps({ resolver, openD1: () => staleClient }),
    "cmt_write_stale",
  )
  const tx = await first.client.transaction("write")
  await expect(tx.commit()).rejects.toMatchObject({ code: "binding_stale" })
  expect(commitCalls).toBe(1)

  await cp.execute(
    "UPDATE community_database_routing SET binding_name = 'DB_WRITE_REBOUND' WHERE community_id = ?1",
    ["cmt_write_stale"],
  )
  let reboundBinding: string | null = null
  await resolveCommunityWriteHandle(
    writeDeps({
      resolver,
      openD1: (binding) => {
        reboundBinding = binding.bindingName
        return staleClient
      },
    }),
    "cmt_write_stale",
  )
  expect(reboundBinding).toBe("DB_WRITE_REBOUND")
  expect(commitCalls).toBe(1)
})

test("write: no routing row → propagates community_not_found", async () => {
  await expect(resolveCommunityWriteHandle(writeDeps({}), "cmt_missing_w")).rejects.toMatchObject({
    code: "community_not_found",
  })
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
