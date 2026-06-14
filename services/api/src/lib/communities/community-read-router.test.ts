import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { routeCommunityRead, type CommunityReadInvoker } from "./community-read-router"
import { CommunityBindingResolver, type ResolvedCommunityBinding } from "./community-binding-resolver"
import { HttpError } from "../errors"
import type { ReadClient } from "../sql-client"

const COMMUNITY = "cmty_router_0001"

async function createRoutingDirectory(): Promise<Client> {
  const client = createClient({ url: ":memory:" })
  await client.execute(`
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
  return client
}

function stubReadClient(label: string): ReadClient {
  return {
    async execute() {
      return { rows: [{ served_by: label }] }
    },
    async batch() {
      return []
    },
  }
}

describe("routeCommunityRead", () => {
  let cp: Client

  beforeEach(async () => {
    cp = await createRoutingDirectory()
  })

  afterEach(() => {
    cp.close()
  })

  async function insertRow(values: {
    backend: "d1" | "turso"
    state?: string
    shard?: string | null
    binding?: string | null
    region?: string | null
    tursoBindingId?: string | null
  }): Promise<void> {
    await cp.execute({
      sql: `
        INSERT INTO community_database_routing
          (community_id, backend, provisioning_state, shard_worker_id, binding_name, region,
           turso_database_binding_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 't0', 't0')
      `,
      args: [
        COMMUNITY,
        values.backend,
        values.state ?? "ready",
        values.shard ?? null,
        values.binding ?? null,
        values.region ?? null,
        values.tursoBindingId ?? null,
      ],
    })
  }

  test("d1 backend dispatches to the shard read client", async () => {
    await insertRow({ backend: "d1", shard: "shard-1", binding: "DB_X", region: "enam" })
    const calls: string[] = []
    const openShardReadClient: CommunityReadInvoker = async (b) => {
      calls.push(`shard:${b.bindingName}`)
      return stubReadClient("d1")
    }
    const openTursoReadClient: CommunityReadInvoker = async () => {
      throw new Error("turso should not be called")
    }
    const resolver = new CommunityBindingResolver()

    const { binding, client } = await routeCommunityRead(
      { resolver, controlPlane: cp, openShardReadClient, openTursoReadClient },
      COMMUNITY,
    )

    expect(binding.backend).toBe("d1")
    expect(calls).toEqual(["shard:DB_X"])
    expect((await client.execute("SELECT 1")).rows).toEqual([{ served_by: "d1" }])
  })

  test("turso backend dispatches to the turso shim read client", async () => {
    await insertRow({ backend: "turso", tursoBindingId: "tdb_1" })
    const calls: string[] = []
    const openShardReadClient: CommunityReadInvoker = async () => {
      throw new Error("shard should not be called")
    }
    const openTursoReadClient: CommunityReadInvoker = async (b) => {
      calls.push(`turso:${b.tursoDatabaseBindingId}`)
      return stubReadClient("turso")
    }
    const resolver = new CommunityBindingResolver()

    const { binding } = await routeCommunityRead(
      { resolver, controlPlane: cp, openShardReadClient, openTursoReadClient },
      COMMUNITY,
    )

    expect(binding.backend).toBe("turso")
    expect(calls).toEqual(["turso:tdb_1"])
  })

  test("a stale-binding error invalidates the cache so the next request re-resolves", async () => {
    await insertRow({ backend: "d1", shard: "shard-1", binding: "DB_X", region: "enam" })
    const resolver = new CommunityBindingResolver()

    let attempts = 0
    const flakyShard: CommunityReadInvoker = async (b: ResolvedCommunityBinding) => {
      attempts += 1
      if (attempts === 1) {
        throw new HttpError(503, "binding_stale", "binding no longer served")
      }
      return stubReadClient(`d1:${b.bindingName}`)
    }
    const openTursoReadClient: CommunityReadInvoker = async () => stubReadClient("turso")
    const deps = { resolver, controlPlane: cp, openShardReadClient: flakyShard, openTursoReadClient }

    await expect(routeCommunityRead(deps, COMMUNITY)).rejects.toMatchObject({ code: "binding_stale" })

    // The stale error invalidated the cache, so the retry re-reads the directory
    // and picks up the new binding name.
    await cp.execute("UPDATE community_database_routing SET binding_name = 'DB_Y' WHERE community_id = ?1", [
      COMMUNITY,
    ])
    const { binding } = await routeCommunityRead(deps, COMMUNITY)
    expect(binding.bindingName).toBe("DB_Y")
    expect(attempts).toBe(2)
  })

  test("a transient open error does NOT invalidate the cache", async () => {
    await insertRow({ backend: "d1", shard: "shard-1", binding: "DB_X", region: "enam" })
    const resolver = new CommunityBindingResolver()

    let attempts = 0
    const flakyShard: CommunityReadInvoker = async (b: ResolvedCommunityBinding) => {
      attempts += 1
      if (attempts === 1) {
        throw new HttpError(503, "binding_unreachable", "shard timed out")
      }
      return stubReadClient(`d1:${b.bindingName}`)
    }
    const openTursoReadClient: CommunityReadInvoker = async () => stubReadClient("turso")
    const deps = { resolver, controlPlane: cp, openShardReadClient: flakyShard, openTursoReadClient }

    await expect(routeCommunityRead(deps, COMMUNITY)).rejects.toMatchObject({ code: "binding_unreachable" })

    // Mutate the directory. Because the transient error did NOT invalidate, the
    // retry still serves the cached (pre-mutation) binding name.
    await cp.execute("UPDATE community_database_routing SET binding_name = 'DB_Y' WHERE community_id = ?1", [
      COMMUNITY,
    ])
    const { binding } = await routeCommunityRead(deps, COMMUNITY)
    expect(binding.bindingName).toBe("DB_X")
    expect(attempts).toBe(2)
  })

  test("a decommissioned community fails closed without dispatching", async () => {
    await insertRow({ backend: "turso", state: "decommissioned", tursoBindingId: "tdb_x" })
    const resolver = new CommunityBindingResolver()

    let dispatched = false
    const invoker: CommunityReadInvoker = async () => {
      dispatched = true
      return stubReadClient("should-not-run")
    }

    await expect(
      routeCommunityRead(
        { resolver, controlPlane: cp, openShardReadClient: invoker, openTursoReadClient: invoker },
        COMMUNITY,
      ),
    ).rejects.toMatchObject({ status: 410, code: "community_decommissioned" })
    expect(dispatched).toBe(false)
  })

  test("resolver errors (e.g. community_not_found) propagate without dispatch", async () => {
    const resolver = new CommunityBindingResolver()
    const openShardReadClient: CommunityReadInvoker = async () => {
      throw new Error("should not dispatch")
    }
    const openTursoReadClient = openShardReadClient

    await expect(
      routeCommunityRead({ resolver, controlPlane: cp, openShardReadClient, openTursoReadClient }, "cmty_absent"),
    ).rejects.toMatchObject({ code: "community_not_found" })
  })
})
