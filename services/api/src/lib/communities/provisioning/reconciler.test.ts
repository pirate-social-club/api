import { describe, expect, test } from "bun:test"
import {
  runReconciliationSweep,
  type ReconcilerDeps,
  type StuckBinding,
} from "./reconciler"

const BINDING: StuckBinding = {
  communityId: "cmt_1",
  bindingName: "DB_CMTY_1",
  shardWorkerId: "community-d1-shard-staging",
  region: "weur",
}

function deps(over: Partial<ReconcilerDeps> & { calls?: string[] } = {}): ReconcilerDeps {
  const calls = over.calls ?? []
  const base: ReconcilerDeps = {
    now: "2026-06-20T00:00:00Z",
    findStuckProvisioningBindings: async () => [BINDING],
    shardGetPoolRow: async () => ({ ok: true, value: { row: poolRow({ lastLoadedAt: null }) } }),
    shardReset: async () => {
      calls.push("reset")
      return { ok: true, value: { tablesDropped: 2 } }
    },
    shardRelease: async () => {
      calls.push("release")
      return { ok: true, value: { released: true } }
    },
    advanceRoutingToReady: async () => {
      calls.push("advance")
    },
    markRoutingDegraded: async () => {
      calls.push("degraded")
    },
  }
  return { ...base, ...over }
}

function poolRow(over: { lastLoadedAt: string | null }) {
  return {
    bindingName: "DB_CMTY_1",
    communityId: "cmt_1",
    allocatedAt: "t0",
    lastLoadedAt: over.lastLoadedAt,
    lastError: null,
    releasedAt: null,
    version: 1,
  }
}

describe("runReconciliationSweep (step 5 part 2)", () => {
  test("advances a loaded-but-stuck binding to ready (no reset/release)", async () => {
    const calls: string[] = []
    const r = await runReconciliationSweep(
      deps({
        calls,
        shardGetPoolRow: async () => ({ ok: true, value: { row: poolRow({ lastLoadedAt: "t1" }) } }),
      }),
    )
    expect(r).toEqual({ scanned: 1, advanced: 1, released: 0, errors: [] })
    expect(calls).toEqual(["advance"])
  })

  test("resets + releases a never-loaded binding and marks routing degraded", async () => {
    const calls: string[] = []
    const r = await runReconciliationSweep(deps({ calls }))
    expect(r).toEqual({ scanned: 1, advanced: 0, released: 1, errors: [] })
    expect(calls).toEqual(["reset", "release", "degraded"])
  })

  test("RACE: reset refused with shard_binding_loaded → advances instead of releasing", async () => {
    const calls: string[] = []
    const r = await runReconciliationSweep(
      deps({
        calls,
        shardReset: async () => {
          calls.push("reset")
          return { ok: false, code: "shard_binding_loaded", message: "loaded mid-sweep" }
        },
      }),
    )
    expect(r).toEqual({ scanned: 1, advanced: 1, released: 0, errors: [] })
    // reset was attempted, refused, then advance — NO release.
    expect(calls).toEqual(["reset", "advance"])
  })

  test("records an error and does not release when getPoolRow fails", async () => {
    const calls: string[] = []
    const r = await runReconciliationSweep(
      deps({
        calls,
        shardGetPoolRow: async () => ({ ok: false, code: "shard_admin_unauthorized", message: "bad token" }),
      }),
    )
    expect(r.scanned).toBe(1)
    expect(r.advanced).toBe(0)
    expect(r.released).toBe(0)
    expect(r.errors).toEqual([
      { communityId: "cmt_1", bindingName: "DB_CMTY_1", reason: "getPoolRow: shard_admin_unauthorized" },
    ])
    expect(calls).toEqual([]) // never touched reset/release
  })

  test("records an error when reset fails for a non-race reason (no release)", async () => {
    const calls: string[] = []
    const r = await runReconciliationSweep(
      deps({
        calls,
        shardReset: async () => {
          calls.push("reset")
          return { ok: false, code: "shard_unknown_binding", message: "drift" }
        },
      }),
    )
    expect(r.released).toBe(0)
    expect(r.errors).toEqual([
      { communityId: "cmt_1", bindingName: "DB_CMTY_1", reason: "reset: shard_unknown_binding" },
    ])
    expect(calls).toEqual(["reset"]) // refused → no release, no degraded
  })

  test("processes multiple stuck bindings independently", async () => {
    const b2: StuckBinding = { ...BINDING, communityId: "cmt_2", bindingName: "DB_CMTY_2" }
    let n = 0
    const r = await runReconciliationSweep(
      deps({
        findStuckProvisioningBindings: async () => [BINDING, b2],
        // first loaded (advance), second never-loaded (release)
        shardGetPoolRow: async (binding) => {
          n++
          return {
            ok: true,
            value: { row: poolRow({ lastLoadedAt: binding === "DB_CMTY_1" ? "t1" : null }) },
          }
        },
      }),
    )
    expect(r.scanned).toBe(2)
    expect(r.advanced).toBe(1)
    expect(r.released).toBe(1)
    expect(n).toBe(2)
  })

  test("empty sweep is a clean no-op", async () => {
    const r = await runReconciliationSweep(deps({ findStuckProvisioningBindings: async () => [] }))
    expect(r).toEqual({ scanned: 0, advanced: 0, released: 0, errors: [] })
  })
})
