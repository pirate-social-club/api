import { describe, expect, spyOn, test } from "bun:test"
import type { Env } from "../../../env"
import type { Client } from "../../sql-client"
import { buildReconcilerDeps, reportD1ReconcilerSweepHealth } from "./reconciler-host"

function captureWarningCalls(into: unknown[][]) {
  return (
    env: Env,
    message: string,
    task: string,
    extra?: Record<string, unknown>,
    tags?: Record<string, string>,
  ) => {
    into.push([env, message, task, extra, tags].filter((value) => value !== undefined))
  }
}

describe("buildReconcilerDeps", () => {
  test("filters stale unloaded pool rows still claimed by active routing rows", async () => {
    const executeCalls: Array<{ sql: string; args?: unknown[] }> = []
    const client = {
      execute: async (statement: { sql: string; args?: unknown[] }) => {
        executeCalls.push(statement)
        if (statement.sql.includes("FROM community_database_routing") && statement.sql.includes("binding_name IN")) {
          return { rows: [{ binding_name: "DB_CMTY_ACTIVE" }] }
        }
        return { rows: [] }
      },
    } as unknown as Client
    const shardCalls: unknown[] = []
    const env = {
      SHARD_ADMIN_TOKEN: "adm_test",
      COMMUNITY_D1_SHARD: {
        communityD1ListStaleUnloadedPoolRows: async (input: unknown) => {
          shardCalls.push(input)
          return {
            ok: true as const,
            value: {
              rows: [
                {
                  bindingName: "DB_CMTY_ACTIVE",
                  communityId: "cmt_active",
                  allocatedAt: "2026-06-19T00:00:00Z",
                  version: 1,
                },
                {
                  bindingName: "DB_CMTY_ORPHAN",
                  communityId: "cmt_orphan",
                  allocatedAt: "2026-06-19T00:00:00Z",
                  version: 1,
                },
              ],
            },
          }
        },
      },
    } as unknown as Env

    const deps = buildReconcilerDeps(env, client, "2026-06-20T00:15:00.000Z")
    const result = await deps.findUnclaimedStaleUnloadedPoolBindings()

    expect(shardCalls).toEqual([{
      adminToken: "adm_test",
      allocatedBefore: "2026-06-20T00:00:00.000Z",
      limit: 50,
    }])
    expect(result).toEqual({
      ok: true,
      value: {
        rows: [
          {
            bindingName: "DB_CMTY_ORPHAN",
            communityId: "cmt_orphan",
            allocatedAt: "2026-06-19T00:00:00Z",
            version: 1,
          },
        ],
      },
    })
    expect(executeCalls[0]?.args).toEqual(["DB_CMTY_ACTIVE", "DB_CMTY_ORPHAN"])
  })
})

describe("reportD1ReconcilerSweepHealth", () => {
  test("logs a summary without reporting when the sweep has no errors", () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    const error = spyOn(console, "error").mockImplementation(() => {})
    const warnings: unknown[][] = []
    try {
      reportD1ReconcilerSweepHealth(
        {} as Env,
        { scanned: 0, advanced: 0, released: 0, orphanReleased: 0, errors: [] },
        captureWarningCalls(warnings),
      )

      expect(log).toHaveBeenCalledWith("[d1-reconciler] sweep", {
        scanned: 0,
        advanced: 0,
        released: 0,
        orphanReleased: 0,
        errorCount: 0,
      })
      expect(error).not.toHaveBeenCalled()
      expect(warnings).toEqual([])
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })

  test("logs and reports one grouped warning when the sweep has errors", () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    const error = spyOn(console, "error").mockImplementation(() => {})
    const env = { SENTRY_DSN: "https://example.invalid/1" } as Env
    const warnings: unknown[][] = []
    const errors = [
      { communityId: "cmt_1", bindingName: "DB_CMTY_0001", reason: "reset: shard_binding_not_empty" },
      { communityId: "cmt_2", bindingName: "DB_CMTY_0002", reason: "release: shard_admin_unauthorized" },
    ]
    try {
      reportD1ReconcilerSweepHealth(
        env,
        { scanned: 2, advanced: 0, released: 0, orphanReleased: 0, errors },
        captureWarningCalls(warnings),
      )

      const extra = { errorCount: 2, sample: errors }
      expect(log).toHaveBeenCalledWith("[d1-reconciler] sweep", {
        scanned: 2,
        advanced: 0,
        released: 0,
        orphanReleased: 0,
        errorCount: 2,
      })
      expect(error).toHaveBeenCalledWith("[d1-reconciler] sweep errors", extra)
      expect(warnings).toEqual([[
        env,
        "Community D1 provisioning reconciler reported errors",
        "community_d1_provisioning_reconciler",
        extra,
      ]])
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })
})
