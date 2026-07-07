import { describe, expect, test } from "bun:test"
import type { Env } from "../../../env"
import type { Client } from "../../sql-client"
import { buildReconcilerDeps } from "./reconciler-host"

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
