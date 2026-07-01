import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { upsertCommunityMembership, type MembershipExecutor } from "./membership-state-store"
import { listCommunityMembershipProjectionSources } from "./projection-source-store"
import type { ReadClient } from "../../sql-client"

// Pins the participation_source upsert semantic (migration 1116):
//   'join' wins. A comment-driven upsert sets 'comment_pow' only on INSERT and
//   never clobbers an existing value on conflict; a real join upgrades
//   'comment_pow' -> 'join'.
// Runs against in-memory SQLite (same engine as D1/libsql) and applies the real
// migration ALTER so the DDL itself is exercised, not just the app code.

const BASE_DDL = `
  CREATE TABLE community_memberships (
    membership_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('member', 'left', 'banned')),
    joined_at TEXT,
    left_at TEXT,
    banned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`

// Verbatim from db/community-template/migrations/1116_community_membership_participation_source.sql
const MIGRATION_1116 = `
  ALTER TABLE community_memberships
    ADD COLUMN participation_source TEXT NOT NULL DEFAULT 'join'
    CHECK (participation_source IN ('join', 'comment_pow'));
`

let db: Database

function executor(): MembershipExecutor {
  return {
    execute: (async ({ sql, args }: { sql: string; args?: unknown[] }) => {
      if (/^\s*select/i.test(sql)) {
        return { rows: db.query(sql).all(...((args ?? []) as never[])) }
      }
      db.run(sql, ...((args ?? []) as never[]))
      return { rows: [] }
    }) as MembershipExecutor["execute"],
  } as MembershipExecutor
}

function sourceOf(userId: string): string | undefined {
  const row = db
    .query("SELECT participation_source, status FROM community_memberships WHERE user_id = ?1")
    .get(userId) as { participation_source: string; status: string } | null
  return row?.participation_source
}

function rowCount(userId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM community_memberships WHERE user_id = ?1")
    .get(userId) as { n: number }
  return row.n
}

function seedMembership(userId: string, status: string, participationSource: string): void {
  db.run(
    `INSERT INTO community_memberships (membership_id, community_id, user_id, status, joined_at, created_at, updated_at, participation_source)
     VALUES (?1, 'c', ?2, ?3, 't', 't', 't', ?4)`,
    [`mbr_c_${userId}`, userId, status, participationSource],
  )
}

beforeEach(() => {
  db = new Database(":memory:")
  db.run(BASE_DDL)
  db.run(MIGRATION_1116)
})

describe("upsertCommunityMembership participation_source", () => {
  test("default is 'join' when unspecified (existing callers unchanged)", async () => {
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u_join", now: "t0" })
    expect(sourceOf("u_join")).toBe("join")
  })

  test("comment-driven INSERT records 'comment_pow'", async () => {
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u_pow", now: "t0", participationSource: "comment_pow" })
    expect(sourceOf("u_pow")).toBe("comment_pow")
  })

  test("re-commenting ('comment_pow' again) does not clobber an existing 'join'", async () => {
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t0", participationSource: "join" })
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t1", participationSource: "comment_pow" })
    expect(sourceOf("u")).toBe("join")
  })

  test("a real join upgrades an existing 'comment_pow' -> 'join' via the UPDATE branch (single row)", async () => {
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t0", participationSource: "comment_pow" })
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t1", participationSource: "join" })
    expect(sourceOf("u")).toBe("join")
    // Proves the upgrade fired the ON CONFLICT UPDATE branch, not a second INSERT
    // (deterministic membership_id => PK conflict => UPDATE). Guards #1.
    expect(rowCount("u")).toBe(1)
  })

  test("re-commenting after an upgrade stays 'join' (join is sticky)", async () => {
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t0", participationSource: "comment_pow" })
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t1", participationSource: "join" })
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t2", participationSource: "comment_pow" })
    expect(sourceOf("u")).toBe("join")
  })

  test("CHECK constraint rejects an invalid participation_source", () => {
    expect(() => db.run(
      "INSERT INTO community_memberships (membership_id, community_id, user_id, status, created_at, updated_at, participation_source) VALUES ('m','c','u','member','t','t','bogus')",
    )).toThrow()
  })
})

describe("listCommunityMembershipProjectionSources excludes comment_pow (control-plane leak guard)", () => {
  test("a comment_pow participant (status='member') is NOT projected; join member is", async () => {
    seedMembership("u_join", "member", "join")
    seedMembership("u_pow", "member", "comment_pow")
    const rows = await listCommunityMembershipProjectionSources({
      client: executor() as unknown as ReadClient,
      communityId: "c",
      limit: 100,
    })
    const userIds = rows.map((r) => r.user_id)
    // Only the subscriber projects. If this ever includes u_pow, drive-by PoW
    // commenters leak into home-feed + royalty-claim eligibility (the bug this
    // whole change prevents).
    expect(userIds).toEqual(["u_join"])
    expect(rows[0]?.membership_state).toBe("member")
  })

  test("a banned comment_pow participant is also excluded (documented v1 reporting gap)", async () => {
    seedMembership("u_join", "member", "join")
    seedMembership("u_banned_pow", "banned", "comment_pow")
    const rows = await listCommunityMembershipProjectionSources({
      client: executor() as unknown as ReadClient,
      communityId: "c",
      limit: 100,
    })
    expect(rows.map((r) => r.user_id)).toEqual(["u_join"])
  })
})
