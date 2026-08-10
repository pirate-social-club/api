import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { isBootstrapAllowedStatement, shardSnapshotDigest } from "@pirate/api-shared"
import { localCommunityShardStatements } from "./repository"
import { type CreateCommunityAuth, withPersistedCommunityCreatedAt } from "./validation"
import { toCommunityRow } from "../../auth/auth-db-community-rows"
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
  test("pg Date round-trip produces the exact retry digest consumed by the shard marker", async () => {
    const first = req()
    const firstAuth = first.auth as unknown as CreateCommunityAuth
    const persisted = toCommunityRow({
      community_id: first.communityId,
      creator_user_id: "usr_owner",
      display_name: "Drill Community",
      description: null,
      avatar_ref: null,
      banner_ref: null,
      branding_json: "{}",
      default_surface: "threads",
      video_feed_enabled: 1,
      status: "active",
      provisioning_state: "provisioning",
      transfer_state: "none",
      route_slug: null,
      namespace_verification_id: null,
      pending_namespace_verification_session_id: null,
      follower_count: 0,
      created_at: new Date(firstAuth.createdAt),
      updated_at: new Date(firstAuth.createdAt),
    })
    const retryAuth = withPersistedCommunityCreatedAt(
      { ...(first.auth as unknown as CreateCommunityAuth), createdAt: "2026-06-20T00:05:00.000Z" },
      persisted.created_at,
    )
    const firstStatements = localCommunityShardStatements(first)
    const retryStatements = localCommunityShardStatements({ ...first, auth: retryAuth })

    expect(persisted.created_at).toBe(firstAuth.createdAt)
    expect(await shardSnapshotDigest(retryStatements)).toBe(await shardSnapshotDigest(firstStatements))
  })

  test("a retry reuses persisted community created_at so snapshot statements stay byte-identical", () => {
    const first = req()
    const retry = req()
    const firstAuth = first.auth as unknown as CreateCommunityAuth
    const retryAuth = withPersistedCommunityCreatedAt(
      { ...(retry.auth as unknown as CreateCommunityAuth), createdAt: "2026-06-20T00:05:00.000Z" },
      firstAuth.createdAt,
    )

    expect(localCommunityShardStatements({ ...retry, auth: retryAuth })).toEqual(localCommunityShardStatements(first))
  })

  test("produces schema + schema_migrations seed + data, all CREATE/INSERT", () => {
    const stmts = localCommunityShardStatements(req())
    const verbs = new Set(stmts.map((s) => s.sql.trim().split(/\s+/)[0].toUpperCase()))
    // guard-compatible: only CREATE + INSERT reach the shard
    expect([...verbs].sort()).toEqual(["CREATE", "INSERT"])
    // The leading-verb check above is NOT what makes this guard-compatible —
    // migration 1147's CREATE TRIGGERs pass it while their BEGIN ... END body
    // semicolons were rejected by the real shard guard, taking down d1_native
    // provisioning in production. Assert every statement against the guard
    // itself; that is the contract the shard enforces.
    const guardRejected = stmts.filter((s) => !isBootstrapAllowedStatement(s.sql))
    expect(guardRejected).toEqual([])
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
