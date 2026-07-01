import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { upsertCommunityMembership, type MembershipExecutor } from "./membership-state-store"

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

  test("a real join upgrades an existing 'comment_pow' -> 'join'", async () => {
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t0", participationSource: "comment_pow" })
    await upsertCommunityMembership({ client: executor(), communityId: "c", userId: "u", now: "t1", participationSource: "join" })
    expect(sourceOf("u")).toBe("join")
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
