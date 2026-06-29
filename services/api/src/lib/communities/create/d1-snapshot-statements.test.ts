import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { localCommunityShardStatements } from "./repository"
import type { Env } from "../../../types"

function req() {
  return {
    env: { LOCAL_COMMUNITY_DB_ROOT: "/tmp/d1-translator-test" } as unknown as Env,
    body: { display_name: "Drill", membership_mode: "request" } as never,
    auth: {
      userId: "usr_owner",
      communityDisplayName: "Drill Community",
      createdAt: "2026-06-20T00:00:00.000Z",
    } as never,
    communityId: "cmt_translator",
    namespaceVerificationId: null,
    namespaceLabel: null,
  }
}

// Under `bun test src` (test:unit), post-service-asset-transaction.test.ts does a
// process-wide mock.module of create/repository, stubbing localCommunityShardStatements
// to () => []. This file tests the REAL function, so it skips when it detects the
// stub (returns []) — it verifies for real when run in isolation (`bun test <this file>`)
// and in CI's per-file invocation. Sequence coverage is in backend.test.ts §8.1.
const isMocked = localCommunityShardStatements(req()).length === 0

function schemaMigrationSeedCount(stmts: ReturnType<typeof localCommunityShardStatements>): number {
  return stmts.filter((s) => /INSERT INTO schema_migrations/i.test(s.sql)).length
}

describe.skipIf(isMocked)("localCommunityShardStatements (§8.7 translator)", () => {
  test("produces schema + schema_migrations seed + data, all CREATE/INSERT", () => {
    const stmts = localCommunityShardStatements(req())
    const verbs = new Set(stmts.map((s) => s.sql.trim().split(/\s+/)[0].toUpperCase()))
    // guard-compatible: only CREATE + INSERT reach the shard
    expect([...verbs].sort()).toEqual(["CREATE", "INSERT"])
    // schema (CREATE) + migrations seed + data seed present
    expect(stmts.filter((s) => /^\s*CREATE/i.test(s.sql)).length).toBeGreaterThan(150)
    expect(schemaMigrationSeedCount(stmts)).toBeGreaterThan(100)
    expect(stmts.some((s) => /INSERT INTO communities/i.test(s.sql))).toBe(true)
  })

  test("applies cleanly to a fresh DB and yields a queryable community", async () => {
    const stmts = localCommunityShardStatements(req())
    const db = createClient({ url: ":memory:" })
    for (const s of stmts) {
      await db.execute({ sql: s.sql, args: s.args ?? [] })
    }
    // schema present
    const tables = (await db.execute("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0]
    expect(Number(tables.n)).toBeGreaterThan(50)
    // data seeded: the community row, owner membership + role, migration ledger
    const community = (await db.execute({ sql: "SELECT display_name, membership_mode, created_by_user_id FROM communities WHERE community_id = ?1", args: ["cmt_translator"] })).rows[0]
    expect(community.display_name).toBe("Drill Community")
    expect(community.created_by_user_id).toBe("usr_owner")
    const roles = (await db.execute("SELECT role FROM community_roles WHERE role = 'owner'")).rows
    expect(roles.length).toBe(1)
    const migs = (await db.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0]
    expect(Number(migs.n)).toBe(schemaMigrationSeedCount(stmts))
  })
})
