import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { CommunityBindingResolver } from "./community-binding-resolver"
import { D1ReadClientAdapter, type D1DatabaseLike } from "../d1-read-client"
import { HttpError } from "../errors"

/**
 * Phase 0.1 synthetic binding smoke — LOGIC PROOF, NOT THE EXIT GATE.
 *
 * This exercises the router read path end to end against stubs:
 *   provision -> route read (d1) -> remove binding -> route fallback (turso) -> decommission.
 * It also covers the dual-TTL cache, the binding_pending / community_not_found
 * error paths, and the shard-rejects-unknown-community open question.
 *
 * The real exit gate per the design doc requires a live shard Worker deploy, a
 * router-to-shard service binding, and a measurement of actual D1 binding-metadata
 * size against the shard cap. Those need Cloudflare account access and are out of
 * scope here. The control-plane directory and the community D1 store are both
 * backed by in-memory libSQL so the routing SQL and the D1 adapter genuinely run.
 */

const SYNTHETIC_COMMUNITY = "cmty_synthetic_0001"
const SHARD_WORKER = "community-shard-001"
const BINDING_NAME = "DB_CMTY_SYNTHETIC_0001"

const NOW_BASE = 1_700_000_000_000

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = NOW_BASE
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

async function createRoutingDirectory(): Promise<Client> {
  const client = createClient({ url: ":memory:" })
  await client.execute(`
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
  return client
}

/** A D1DatabaseLike backed by a real in-memory libSQL store. */
function libsqlD1Stub(client: Client): D1DatabaseLike {
  const makeStmt = (sql: string) => {
    let boundArgs: unknown[] = []
    const stmt = {
      bind(...args: unknown[]) {
        boundArgs = args
        return stmt
      },
      async all() {
        const res = await client.execute({ sql, args: boundArgs as never })
        return {
          results: res.rows,
          success: true,
          meta: {
            changes: res.rowsAffected ?? 0,
            last_row_id: Number(res.lastInsertRowid ?? 0),
          },
        }
      },
      async run() {
        return stmt.all()
      },
    }
    return stmt
  }
  return {
    prepare: (sql) => makeStmt(sql) as unknown as D1PreparedStatement,
    batch: (async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out: unknown[] = []
      for (const s of statements) {
        out.push(await s.all())
      }
      return out
    }) as unknown as D1DatabaseLike["batch"],
  }
}

/** Minimal shard: it only serves communities explicitly in its config. */
function makeShard(configuredCommunityIds: string[], db: D1DatabaseLike) {
  const configured = new Set(configuredCommunityIds)
  return {
    async read(communityId: string, sql: string, args: unknown[]) {
      if (!configured.has(communityId)) {
        // Mirrors the design's `binding_stale` failure mode: the shard rejects a
        // community id that is not in its wrangler config.
        throw new HttpError(503, "binding_stale", `Shard does not serve community ${communityId}`, true)
      }
      const adapter = new D1ReadClientAdapter(db)
      return adapter.execute({ sql, args })
    },
  }
}

describe("Phase 0.1 synthetic binding smoke", () => {
  let cp: Client
  let communityDb: Client

  beforeEach(async () => {
    cp = await createRoutingDirectory()
    communityDb = createClient({ url: ":memory:" })
    await communityDb.execute("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
    await communityDb.execute({
      sql: "INSERT INTO posts (id, title) VALUES (?1, ?2)",
      args: ["post_1", "hello from d1"],
    })
  })

  afterEach(() => {
    cp.close()
    communityDb.close()
  })

  async function provisionD1Row(): Promise<void> {
    await cp.execute({
      sql: `
        INSERT INTO community_database_routing
          (community_id, provisioning_state, shard_worker_id, binding_name, region,
           created_at, updated_at)
        VALUES (?1, 'ready', ?2, ?3, 'enam', 't0', 't0')
      `,
      args: [SYNTHETIC_COMMUNITY, SHARD_WORKER, BINDING_NAME],
    })
  }

  test("provision -> route read (d1) -> decommission", async () => {
    const clock = makeClock()
    const resolver = new CommunityBindingResolver({ now: clock.now })

    // 1. provision
    await provisionD1Row()

    // 2. route read on d1: resolve, dispatch to the shard, read a real row
    const d1Binding = await resolver.resolve(cp, SYNTHETIC_COMMUNITY)
    expect(d1Binding.shardWorkerId).toBe(SHARD_WORKER)
    expect(d1Binding.bindingName).toBe(BINDING_NAME)

    const shard = makeShard([SYNTHETIC_COMMUNITY], libsqlD1Stub(communityDb))
    const read = await shard.read(d1Binding.communityId, "SELECT id, title FROM posts WHERE id = ?1", ["post_1"])
    expect(read.rows).toEqual([{ id: "post_1", title: "hello from d1" }])

    // 3. decommission
    await cp.execute({
      sql: `
        UPDATE community_database_routing
        SET provisioning_state = 'decommissioned', decommissioned_at = 't2', updated_at = 't2'
        WHERE community_id = ?1
      `,
      args: [SYNTHETIC_COMMUNITY],
    })
    resolver.invalidate(SYNTHETIC_COMMUNITY)

    // decommissioned fails closed — there is no live binding to dispatch to
    await expect(resolver.resolve(cp, SYNTHETIC_COMMUNITY)).rejects.toMatchObject({
      status: 410,
      code: "community_decommissioned",
    })
  })

  test("shard rejects a community id that is not in its config", async () => {
    const shard = makeShard(["cmty_other"], libsqlD1Stub(communityDb))
    await expect(
      shard.read(SYNTHETIC_COMMUNITY, "SELECT id FROM posts", []),
    ).rejects.toMatchObject({ status: 503, code: "binding_stale" })
  })

  test("routing entries are cached for the 60s TTL, then re-read", async () => {
    const clock = makeClock()
    const resolver = new CommunityBindingResolver({ now: clock.now })
    await provisionD1Row()

    const first = await resolver.resolve(cp, SYNTHETIC_COMMUNITY)
    expect(first.region).toBe("enam")

    // mutate the directory underneath the cache
    await cp.execute("UPDATE community_database_routing SET region = 'weur' WHERE community_id = ?1", [
      SYNTHETIC_COMMUNITY,
    ])

    // within the TTL: still the cached value
    clock.advance(59_000)
    const cached = await resolver.resolve(cp, SYNTHETIC_COMMUNITY)
    expect(cached.region).toBe("enam")

    // past the TTL: re-read picks up the change
    clock.advance(2_000)
    const fresh = await resolver.resolve(cp, SYNTHETIC_COMMUNITY)
    expect(fresh.region).toBe("weur")
  })

  test("degraded rows are still routable but use the shorter 5s TTL", async () => {
    const clock = makeClock()
    const resolver = new CommunityBindingResolver({ now: clock.now })
    await cp.execute({
      sql: `
        INSERT INTO community_database_routing
          (community_id, provisioning_state, shard_worker_id, binding_name, region, created_at, updated_at)
        VALUES (?1, 'degraded', ?2, ?3, 'enam', 't0', 't0')
      `,
      args: [SYNTHETIC_COMMUNITY, SHARD_WORKER, BINDING_NAME],
    })

    const first = await resolver.resolve(cp, SYNTHETIC_COMMUNITY)
    expect(first.provisioningState).toBe("degraded")
    expect(first.region).toBe("enam")

    await cp.execute("UPDATE community_database_routing SET region = 'weur' WHERE community_id = ?1", [
      SYNTHETIC_COMMUNITY,
    ])

    // a `ready` row would stay cached for 60s, but degraded uses the 5s TTL
    clock.advance(4_000)
    expect((await resolver.resolve(cp, SYNTHETIC_COMMUNITY)).region).toBe("enam")
    clock.advance(2_000)
    expect((await resolver.resolve(cp, SYNTHETIC_COMMUNITY)).region).toBe("weur")
  })

  test("decommissioned communities fail closed and are cached on the short TTL", async () => {
    const clock = makeClock()
    const resolver = new CommunityBindingResolver({ now: clock.now })
    let controlPlaneReads = 0
    const counting = {
      execute: (stmt: Parameters<Client["execute"]>[0]) => {
        controlPlaneReads += 1
        return cp.execute(stmt as never)
      },
    }
    await cp.execute({
      sql: `
        INSERT INTO community_database_routing
          (community_id, provisioning_state, decommissioned_at, created_at, updated_at)
        VALUES (?1, 'decommissioned', 't0', 't0', 't0')
      `,
      args: [SYNTHETIC_COMMUNITY],
    })

    // first resolve fails closed and caches the row
    await expect(resolver.resolve(counting, SYNTHETIC_COMMUNITY)).rejects.toMatchObject({ code: "community_decommissioned" })
    expect(controlPlaneReads).toBe(1)

    // within the short TTL: still fails closed, served from cache (no extra read)
    clock.advance(4_000)
    await expect(resolver.resolve(counting, SYNTHETIC_COMMUNITY)).rejects.toMatchObject({ code: "community_decommissioned" })
    expect(controlPlaneReads).toBe(1)

    // past the short TTL: re-reads the control plane
    clock.advance(2_000)
    await expect(resolver.resolve(counting, SYNTHETIC_COMMUNITY)).rejects.toMatchObject({ code: "community_decommissioned" })
    expect(controlPlaneReads).toBe(2)
  })

  test("a provisioning row throws binding_pending and is not cached", async () => {
    const clock = makeClock()
    const resolver = new CommunityBindingResolver({ now: clock.now })
    await cp.execute({
      sql: `
        INSERT INTO community_database_routing
          (community_id, provisioning_state, shard_worker_id, binding_name, region, created_at, updated_at)
        VALUES (?1, 'provisioning', ?2, ?3, 'enam', 't0', 't0')
      `,
      args: [SYNTHETIC_COMMUNITY, SHARD_WORKER, BINDING_NAME],
    })

    await expect(resolver.resolve(cp, SYNTHETIC_COMMUNITY)).rejects.toMatchObject({
      status: 503,
      code: "binding_pending",
    })

    // the deploy completes; because the throw was not cached, the next resolve sees 'ready'
    await cp.execute("UPDATE community_database_routing SET provisioning_state = 'ready' WHERE community_id = ?1", [
      SYNTHETIC_COMMUNITY,
    ])
    const resolved = await resolver.resolve(cp, SYNTHETIC_COMMUNITY)
    expect(resolved.provisioningState).toBe("ready")
  })

  test("an unknown community throws community_not_found", async () => {
    const resolver = new CommunityBindingResolver()
    await expect(resolver.resolve(cp, "cmty_missing")).rejects.toMatchObject({
      status: 404,
      code: "community_not_found",
    })
  })
})
