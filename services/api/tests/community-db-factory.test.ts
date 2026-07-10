import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"
import { openCommunityDb, withRequestCommunityDbClients } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob } from "../src/lib/communities/jobs/store"
import type { CommunityDatabaseBindingRepository } from "../src/lib/communities/db-community-repository"
import { resolveCoreRepoPath } from "../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import { ensureRemoteCommunityMembershipStateIndexes } from "../src/lib/communities/ensure-remote-community-membership-indexes"
import { ensureRemoteThreadCommentLockColumns } from "../src/lib/communities/ensure-remote-thread-comment-lock-columns"
import { ensureRemoteCommentGuestAuthorship } from "../src/lib/communities/ensure-remote-comment-guest-authorship"
import { ensureRemoteLiveRoomTables } from "../src/lib/communities/ensure-remote-live-room-tables"
import { ensureRemotePostSongTitleColumn } from "../src/lib/communities/ensure-remote-post-song-title-column"
import { ensureRemoteCommerceVinylReleaseColumns } from "../src/lib/communities/ensure-remote-commerce-vinyl-release-columns"

const cleanupPaths: string[] = []
const COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS = 120_000
const testWithTimeout = test as unknown as (name: string, fn: () => Promise<void>, timeout: number) => void
const LEGACY_1064_THREAD_COMMENT_LOCKS_CHECKSUM =
  "bdb8e886939b733f10afff54e25f83cc39ed49c2a6501b7f7604ac3357b8d61f"
const LEGACY_1080_POST_COMMENT_LOCKS_CHECKSUM =
  "cc64b1844768fc2cd585bd76daab9e75a32c596ddbdfbe8d7ac060d38cc5d23f"

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function applyPartialCommunitySchema(databasePath: string, maxMigration = 1023): Promise<void> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        migration_label TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const migrationsDir = resolveCoreRepoPath("db/community-template/migrations", {
      serviceRoot: fileURLToPath(new URL("..", import.meta.url)),
    })
    const entries = (await readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()
      .filter((entry) => Number.parseInt(entry.slice(0, 4), 10) <= maxMigration)

    for (const entry of entries) {
      const sql = await readFile(join(migrationsDir, entry), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          await client.execute(sqliteStatement)
        }
      }

      await client.execute({
        sql: `
          INSERT INTO schema_migrations (migration_name, migration_label, checksum)
          VALUES (?1, 'community-template', ?2)
        `,
        args: [entry, createHash("sha256").update(sql).digest("hex")],
      })
    }
  } finally {
    client.close()
  }
}

async function getMigrationChecksum(databasePath: string, migrationName: string): Promise<string | null> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute({
      sql: "SELECT checksum FROM schema_migrations WHERE migration_name = ?1 LIMIT 1",
      args: [migrationName],
    })
    const checksum = result.rows[0]?.checksum
    return typeof checksum === "string" ? checksum : null
  } finally {
    client.close()
  }
}

async function getForeignKeysPragma(databasePath: string): Promise<number | null> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute("PRAGMA foreign_keys")
    const value = Object.values(result.rows[0] ?? {})[0]
    return value === null || value === undefined ? null : Number(value)
  } finally {
    client.close()
  }
}

async function getTableColumns(databasePath: string, tableName: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`PRAGMA table_info(${tableName})`)
    return result.rows.map((row) => String(row.name))
  } finally {
    client.close()
  }
}

async function countTableRows(databasePath: string, tableName: string): Promise<number> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`SELECT COUNT(*) AS row_count FROM ${tableName}`)
    return Number(result.rows[0]?.row_count ?? 0)
  } finally {
    client.close()
  }
}

async function listTableNames(databasePath: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `)
    return result.rows.map((row) => String(row.name))
  } finally {
    client.close()
  }
}

async function listIndexNames(databasePath: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
      ORDER BY name
    `)
    return result.rows.map((row) => String(row.name))
  } finally {
    client.close()
  }
}

async function getTableCreateSql(databasePath: string, tableName: string): Promise<string> {
  const client = createClient({ url: `file:${databasePath}` })
  try {
    const result = await client.execute({
      sql: `
        SELECT sql
        FROM sqlite_schema
        WHERE type = 'table'
          AND name = ?1
        LIMIT 1
      `,
      args: [tableName],
    })
    return String(result.rows[0]?.sql ?? "")
  } finally {
    client.close()
  }
}

function buildRepository(databasePath: string): CommunityDatabaseBindingRepository {
  return {
    async getPrimaryCommunityDatabaseBinding() {
      return {
        community_database_binding_id: "cdb_partial",
        community_id: "cmt_partial",
        binding_role: "primary",
        organization_slug: "local",
        group_name: "local",
        group_id: null,
        database_name: "community-cmt_partial",
        database_id: null,
        database_url: `file:${databasePath}`,
        location: null,
        requires_credentials: false,
        status: "active",
        transferred_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    },
  }
}

async function seedPostWithComment(databasePath: string): Promise<void> {
  const client = createClient({
    url: `file:${databasePath}`,
  })
  const now = new Date().toISOString()

  try {
    await client.execute("PRAGMA foreign_keys = ON")
    await client.execute({
      sql: `
        INSERT INTO communities (
          community_id, display_name, status, artist_governance_state, membership_mode,
          default_age_gate_policy, allow_anonymous_identity, donation_policy_mode,
          donation_partner_status, governance_mode, created_by_user_id, created_at, updated_at
        ) VALUES (
          'cmt_partial', 'Partial Community', 'active', 'fan_run', 'open',
          'none', 0, 'none', 'unconfigured', 'centralized', 'usr_seed', ?1, ?1
        )
      `,
      args: [now],
    })
    await client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, identity_mode, post_type, status, body,
          analysis_state, content_safety_state, age_gate_policy, created_at, updated_at
        ) VALUES (
          'pst_seed', 'cmt_partial', 'usr_seed', 'public', 'text', 'published', 'hello',
          'allow', 'safe', 'none', ?1, ?1
        )
      `,
      args: [now],
    })
    await client.execute({
      sql: `
        INSERT INTO comments (
          comment_id, community_id, thread_root_post_id, author_user_id, identity_mode,
          body, status, depth, created_at, updated_at
        ) VALUES (
          'cmt_seed_comment', 'cmt_partial', 'pst_seed', 'usr_seed', 'public',
          'reply', 'published', 0, ?1, ?1
        )
      `,
      args: [now],
    })
  } finally {
    client.close()
  }
}

describe("openCommunityDb", () => {
  test("refuses remote provisioned community database bindings", async () => {
    const databaseUrl = "libsql" + "://main-cmt-remote-test.example.invalid"
    const now = new Date().toISOString()
    const repo = {
      async getPrimaryCommunityDatabaseBinding() {
        return {
          community_database_binding_id: "cdb_remote",
          community_id: "cmt_remote",
          binding_role: "primary",
          organization_slug: "pirate-prod",
          group_name: "region-aws-us-east-1",
          group_id: "grp_remote",
          database_name: "main-cmt-remote-test",
          database_id: "db_remote",
          database_url: databaseUrl,
          location: "aws-us-east-1",
          requires_credentials: true,
          status: "active",
          transferred_at: null,
          created_at: now,
          updated_at: now,
        }
      },
    } satisfies CommunityDatabaseBindingRepository

    await expect(openCommunityDb({}, repo, "cmt_remote")).rejects.toThrow(
      "Remote community database bindings are no longer opened through openCommunityDb",
    )
  })

  testWithTimeout("applies pending template migrations for existing local community databases", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-db-factory-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath)

    const beforeTableNames = await listTableNames(databasePath)
    expect(beforeTableNames).not.toContain("comments")
    expect(beforeTableNames).not.toContain("comment_closure")
    expect(beforeTableNames).not.toContain("thread_snapshots")
    expect(beforeTableNames).not.toContain("donation_partners")

    const beforePostColumns = await getTableColumns(databasePath, "posts")
    expect(beforePostColumns).not.toContain("comment_count")
    expect(beforePostColumns).not.toContain("top_level_comment_count")
    expect(beforePostColumns).not.toContain("last_comment_at")

    const db = await openCommunityDb({}, buildRepository(databasePath), "cmt_partial")

    db.close()

    const tableNames = await listTableNames(databasePath)
    expect(tableNames).toContain("comments")
    expect(tableNames).toContain("comment_closure")
    expect(tableNames).toContain("comment_votes")
    expect(tableNames).toContain("thread_snapshots")
    expect(tableNames).toContain("donation_partners")
    expect(tableNames).toContain("purchase_settlement_effects")
    expect(tableNames).toContain("purchase_settlement_attempts")

    const postColumns = await getTableColumns(databasePath, "posts")
    expect(postColumns).toContain("comment_count")
    expect(postColumns).toContain("top_level_comment_count")
    expect(postColumns).toContain("last_comment_at")
    expect(postColumns).toContain("comments_locked")
    expect(postColumns).toContain("comments_locked_at")
    expect(postColumns).toContain("comments_locked_by_user_id")
    expect(postColumns).toContain("comments_lock_reason")

    const assetColumns = await getTableColumns(databasePath, "assets")
    expect(assetColumns).toContain("story_royalty_policy_id")
    expect(assetColumns).toContain("story_derivative_parent_ip_ids_json")
    expect(assetColumns).toContain("story_royalty_registration_status")
    expect(assetColumns).toContain("display_title")

    const donationPartnerColumns = await getTableColumns(databasePath, "donation_partners")
    expect(donationPartnerColumns).toContain("payout_destination_ref")

    const allocationLegColumns = await getTableColumns(databasePath, "purchase_allocation_legs")
    expect(allocationLegColumns).toContain("provider_receipt_ref")
    expect(allocationLegColumns).toContain("tax_receipt_ref")
    expect(allocationLegColumns).toContain("attempt_count")

    const purchaseQuoteColumns = await getTableColumns(databasePath, "purchase_quotes")
    expect(purchaseQuoteColumns).toContain("settlement_mode")
    expect(purchaseQuoteColumns).toContain("funding_destination_address")

    const settlementEffectColumns = await getTableColumns(databasePath, "purchase_settlement_effects")
    expect(settlementEffectColumns).toContain("metadata_json")

    const settlementAttemptColumns = await getTableColumns(databasePath, "purchase_settlement_attempts")
    expect(settlementAttemptColumns).toContain("attempt_count")
    expect(settlementAttemptColumns).toContain("settlement_wallet_attachment_id")

    const purchaseColumns = await getTableColumns(databasePath, "purchases")
    expect(purchaseColumns).toContain("settlement_mode")

    const moderationCaseColumns = await getTableColumns(databasePath, "moderation_cases")
    expect(moderationCaseColumns).toContain("comment_id")

    const moderationActionColumns = await getTableColumns(databasePath, "moderation_actions")
    expect(moderationActionColumns).toContain("comment_id")
    expect(moderationActionColumns).toContain("previous_post_status")
    expect(moderationActionColumns).toContain("next_post_status")

    const commentColumns = await getTableColumns(databasePath, "comments")
    expect(commentColumns).toContain("replies_locked")
    expect(commentColumns).toContain("replies_locked_at")
    expect(commentColumns).toContain("replies_locked_by_user_id")
    expect(commentColumns).toContain("replies_lock_reason")

    const indexNames = await listIndexNames(databasePath)
    expect(indexNames).toContain("idx_community_memberships_state_lookup")
    expect(indexNames).toContain("idx_community_roles_state_lookup")
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("applies table-rebuild migrations with connection-level foreign-key pragmas", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-db-factory-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath, 1078)
    await seedPostWithComment(databasePath)

    const beforePostColumns = await getTableColumns(databasePath, "posts")
    expect(beforePostColumns).not.toContain("crosspost_source_json")

    const db = await openCommunityDb({}, buildRepository(databasePath), "cmt_partial")
    db.close()

    const afterPostColumns = await getTableColumns(databasePath, "posts")
    expect(afterPostColumns).toContain("crosspost_source_json")
    expect(await countTableRows(databasePath, "posts")).toBe(1)
    expect(await countTableRows(databasePath, "comments")).toBe(1)
    expect(await getMigrationChecksum(databasePath, "1079_crosspost_posts.sql")).not.toBeNull()
    expect(await getForeignKeysPragma(databasePath)).toBe(1)
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("repairs compatible local checksum drift for comment lock migration", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-db-factory-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath, 1063)

    const client = createClient({ url: `file:${databasePath}` })
    try {
      await ensureRemoteThreadCommentLockColumns(client)
      await client.execute({
        sql: `
          INSERT INTO schema_migrations (migration_name, migration_label, checksum)
          VALUES ('1064_thread_comment_locks.sql', 'community-template', ?1)
        `,
        args: [LEGACY_1064_THREAD_COMMENT_LOCKS_CHECKSUM],
      })
    } finally {
      client.close()
    }

    const db = await openCommunityDb({}, buildRepository(databasePath), "cmt_partial")
    db.close()

    const migrationsDir = resolveCoreRepoPath("db/community-template/migrations", {
      serviceRoot: fileURLToPath(new URL("..", import.meta.url)),
    })
    const currentSql = await readFile(join(migrationsDir, "1064_thread_comment_locks.sql"), "utf8")
    const currentChecksum = createHash("sha256").update(currentSql).digest("hex")
    const repairedChecksum = await getMigrationChecksum(databasePath, "1064_thread_comment_locks.sql")
    expect(repairedChecksum).toBe(currentChecksum)
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("repairs compatible local checksum drift for post comment lock migration", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-db-factory-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath, 1079)

    const client = createClient({ url: `file:${databasePath}` })
    try {
      await ensureRemoteThreadCommentLockColumns(client)
      await client.execute({
        sql: `
          INSERT INTO schema_migrations (migration_name, migration_label, checksum)
          VALUES ('1080_post_comment_locks.sql', 'community-template', ?1)
        `,
        args: [LEGACY_1080_POST_COMMENT_LOCKS_CHECKSUM],
      })
    } finally {
      client.close()
    }

    const db = await openCommunityDb({}, buildRepository(databasePath), "cmt_partial")
    db.close()

    const migrationsDir = resolveCoreRepoPath("db/community-template/migrations", {
      serviceRoot: fileURLToPath(new URL("..", import.meta.url)),
    })
    const currentSql = await readFile(join(migrationsDir, "1080_post_comment_locks.sql"), "utf8")
    const currentChecksum = createHash("sha256").update(currentSql).digest("hex")
    const repairedChecksum = await getMigrationChecksum(databasePath, "1080_post_comment_locks.sql")
    expect(repairedChecksum).toBe(currentChecksum)
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("ensures membership state indexes on community database schema helper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-remote-schema-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath)

    const client = createClient({ url: `file:${databasePath}` })
    try {
      const beforeIndexNames = await listIndexNames(databasePath)
      expect(beforeIndexNames).not.toContain("idx_community_memberships_state_lookup")
      expect(beforeIndexNames).not.toContain("idx_community_roles_state_lookup")

      await ensureRemoteCommunityMembershipStateIndexes(client)

      const afterIndexNames = await listIndexNames(databasePath)
      expect(afterIndexNames).toContain("idx_community_memberships_state_lookup")
      expect(afterIndexNames).toContain("idx_community_roles_state_lookup")

      await ensureRemoteCommunityMembershipStateIndexes(client)
    } finally {
      client.close()
    }
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("ensures thread and comment lock columns on community database schema helper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-remote-lock-columns-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath)

    const client = createClient({ url: `file:${databasePath}` })
    try {
      const beforePostColumns = await getTableColumns(databasePath, "posts")
      expect(beforePostColumns).not.toContain("comments_locked")
      expect(beforePostColumns).not.toContain("comments_lock_reason")

      await client.execute(`
        CREATE TABLE comments (
          comment_id TEXT PRIMARY KEY,
          community_id TEXT NOT NULL,
          thread_root_post_id TEXT NOT NULL,
          parent_comment_id TEXT,
          body TEXT,
          status TEXT NOT NULL
        )
      `)
      const beforeCommentColumns = await getTableColumns(databasePath, "comments")
      expect(beforeCommentColumns).not.toContain("replies_locked")
      expect(beforeCommentColumns).not.toContain("replies_lock_reason")

      await ensureRemoteThreadCommentLockColumns(client)

      const afterPostColumns = await getTableColumns(databasePath, "posts")
      expect(afterPostColumns).toContain("comments_locked")
      expect(afterPostColumns).toContain("comments_locked_at")
      expect(afterPostColumns).toContain("comments_locked_by_user_id")
      expect(afterPostColumns).toContain("comments_lock_reason")

      const afterCommentColumns = await getTableColumns(databasePath, "comments")
      expect(afterCommentColumns).toContain("replies_locked")
      expect(afterCommentColumns).toContain("replies_locked_at")
      expect(afterCommentColumns).toContain("replies_locked_by_user_id")
      expect(afterCommentColumns).toContain("replies_lock_reason")

      await ensureRemoteThreadCommentLockColumns(client)
    } finally {
      client.close()
    }
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("rebuilds old comments authorship check to allow guest comments", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-guest-authorship-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    const client = createClient({ url: `file:${databasePath}` })
    try {
      await client.execute("CREATE TABLE communities (community_id TEXT PRIMARY KEY)")
      await client.execute("CREATE TABLE posts (post_id TEXT PRIMARY KEY)")
      await client.execute("INSERT INTO communities (community_id) VALUES ('cmt_guest')")
      await client.execute("INSERT INTO posts (post_id) VALUES ('pst_guest')")
      await client.execute(`
        CREATE TABLE comments (
          comment_id TEXT PRIMARY KEY,
          community_id TEXT NOT NULL,
          thread_root_post_id TEXT NOT NULL,
          parent_comment_id TEXT,
          author_user_id TEXT,
          identity_mode TEXT NOT NULL CHECK (
            identity_mode IN ('public', 'anonymous')
          ),
          anonymous_scope TEXT CHECK (
            anonymous_scope IS NULL OR anonymous_scope IN ('community_stable', 'thread_stable')
          ),
          anonymous_label TEXT,
          body TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('published', 'hidden', 'removed', 'deleted')
          ),
          depth INTEGER NOT NULL,
          direct_reply_count INTEGER NOT NULL DEFAULT 0,
          descendant_count INTEGER NOT NULL DEFAULT 0,
          upvote_count INTEGER NOT NULL DEFAULT 0,
          downvote_count INTEGER NOT NULL DEFAULT 0,
          score INTEGER NOT NULL DEFAULT 0,
          last_reply_at TEXT,
          content_hash TEXT,
          swarm_body_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          source_language TEXT,
          authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
            authorship_mode IN ('human_direct', 'user_agent')
          ),
          agent_id TEXT,
          agent_ownership_record_id TEXT,
          agent_display_name_snapshot TEXT,
          agent_owner_handle_snapshot TEXT,
          agent_ownership_provider_snapshot TEXT,
          agent_handle_snapshot TEXT,
          idempotency_key TEXT NOT NULL DEFAULT '',
          media_refs_json TEXT NOT NULL DEFAULT '[]',
          replies_locked INTEGER NOT NULL DEFAULT 0 CHECK (replies_locked IN (0, 1)),
          replies_locked_at TEXT,
          replies_locked_by_user_id TEXT,
          replies_lock_reason TEXT
        )
      `)
      await client.execute("CREATE INDEX idx_comments_agent_authorship ON comments(authorship_mode, agent_id, created_at DESC)")
      await client.execute(`
        INSERT INTO comments (
          comment_id, community_id, thread_root_post_id, identity_mode, body, status,
          depth, created_at, updated_at
        ) VALUES (
          'cmt_old', 'cmt_guest', 'pst_guest', 'public', 'old comment', 'published',
          0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `)

      const beforeSql = await getTableCreateSql(databasePath, "comments")
      expect(beforeSql).not.toContain("'guest'")

      await ensureRemoteCommentGuestAuthorship(client)

      const afterSql = await getTableCreateSql(databasePath, "comments")
      expect(afterSql).toContain("'guest'")
      expect(await listIndexNames(databasePath)).toContain("idx_comments_agent_authorship")
      await client.execute(`
        INSERT INTO comments (
          comment_id, community_id, thread_root_post_id, identity_mode, anonymous_scope,
          body, status, depth, created_at, updated_at, authorship_mode
        ) VALUES (
          'cmt_guest', 'cmt_guest', 'pst_guest', 'anonymous', 'community_stable',
          'guest comment', 'published', 0, '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:01.000Z', 'guest'
        )
      `)
    } finally {
      client.close()
    }
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("ensures live room tables on community database schema helper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-remote-live-rooms-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath, 1069)

    const client = createClient({ url: `file:${databasePath}` })
    try {
      const beforeTableNames = await listTableNames(databasePath)
      expect(beforeTableNames).not.toContain("live_rooms")
      expect(beforeTableNames).not.toContain("live_room_setlists")

      await ensureRemoteLiveRoomTables(client)

      const afterTableNames = await listTableNames(databasePath)
      expect(afterTableNames).toContain("live_rooms")
      expect(afterTableNames).toContain("live_room_performer_allocations")
      expect(afterTableNames).toContain("live_room_setlists")
      expect(afterTableNames).toContain("live_room_setlist_items")
      expect(afterTableNames).toContain("live_room_guest_invites")
      expect(afterTableNames).toContain("live_room_viewer_sessions")
      expect(afterTableNames).toContain("live_room_recordings")
      expect(afterTableNames).toContain("live_room_replay_assets")
      expect(afterTableNames).toContain("live_room_replay_allocations")

      const afterIndexNames = await listIndexNames(databasePath)
      expect(afterIndexNames).toContain("idx_live_rooms_community_status")
      expect(afterIndexNames).toContain("idx_live_room_setlists_room")
      expect(afterIndexNames).toContain("idx_live_room_guest_invites_active")
      expect(afterIndexNames).toContain("idx_live_room_viewer_sessions_uid")
      expect(afterIndexNames).toContain("idx_live_room_viewer_sessions_viewer")
      expect(afterIndexNames).toContain("idx_live_room_recordings_room")
      expect(afterIndexNames).toContain("idx_live_room_replay_assets_room")
      expect(afterIndexNames).toContain("idx_live_room_replay_allocations_asset")

      const setlistItemColumns = await getTableColumns(databasePath, "live_room_setlist_items")
      expect(setlistItemColumns).toContain("source_asset_ref")
      const replayAssetColumns = await getTableColumns(databasePath, "live_room_replay_assets")
      expect(replayAssetColumns).toEqual([
        "replay_asset_id",
        "community_id",
        "live_room_id",
        "source_recording_id",
        "publication_status",
        "title",
        "caption",
        "duration_ms",
        "preview_ref",
        "access_mode",
        "primary_content_ref",
        "locked_delivery_status",
        "locked_delivery_storage_ref",
        "story_cdr_vault_uuid",
        "published_at",
        "created_at",
        "updated_at",
        "locked_delivery_secret_json",
        "story_namespace",
        "story_entitlement_token_id",
        "story_read_condition",
        "story_write_condition",
        "locked_delivery_error",
      ])

      const checksum = await getMigrationChecksum(databasePath, "1070_live_rooms.sql")
      expect(checksum).toBe("47dcdd32d64789c6f93e6162f137b7238c75914532256aa0d186d5a8b68fa179")
      const sourceAssetRefChecksum = await getMigrationChecksum(databasePath, "1076_live_room_setlist_source_asset_ref.sql")
      expect(sourceAssetRefChecksum).toBe("55f125162ffc23a107556a295b1456a74065100e6a98895a11b2560b2540baab")
      const viewerSessionsChecksum = await getMigrationChecksum(databasePath, "1078_live_room_viewer_sessions.sql")
      expect(viewerSessionsChecksum).toBe("e56e39e1529e9fcd282795a6df8cc05639529aa59b535ef0c84261336b3ec5bc")
      const recordingEnabledChecksum = await getMigrationChecksum(databasePath, "1110_live_room_recording_enabled.sql")
      expect(recordingEnabledChecksum).toBe("f5c9413b994ff0ae278201b45c31510874209b07d699332e99912959146f6ae3")
      const recordingsChecksum = await getMigrationChecksum(databasePath, "1111_live_room_recordings.sql")
      expect(recordingsChecksum).toBe("c57f9e69547141e64d9c2425af4dedae0928fe42ac5350c6ee76855de3d73683")
      const replayAssetsChecksum = await getMigrationChecksum(databasePath, "1112_live_room_replay_assets.sql")
      expect(replayAssetsChecksum).toBe("3cd34e171f36eb93b508684645782bbee8690fc660108c23e38e934806a01475")
      const replayLockedDeliveryChecksum = await getMigrationChecksum(databasePath, "1113_live_room_replay_locked_delivery.sql")
      expect(replayLockedDeliveryChecksum).toBe("3b631159e77ed088823ac192f18e4945dc37a43c6f2f0cb2f3a26cf6ab38fb4a")

      await ensureRemoteLiveRoomTables(client)
    } finally {
      client.close()
    }
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("ensures post song presentation columns on community database schema helper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-remote-song-title-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath, 1068)

    const client = createClient({ url: `file:${databasePath}` })
    try {
      const beforePostColumns = await getTableColumns(databasePath, "posts")
      expect(beforePostColumns).not.toContain("song_title")
      expect(beforePostColumns).not.toContain("song_cover_art_ref")
      expect(beforePostColumns).not.toContain("song_duration_ms")
      expect(beforePostColumns).not.toContain("song_annotations_url")

      await ensureRemotePostSongTitleColumn(client)

      const afterPostColumns = await getTableColumns(databasePath, "posts")
      expect(afterPostColumns).toContain("song_title")
      expect(afterPostColumns).toContain("song_cover_art_ref")
      expect(afterPostColumns).toContain("song_duration_ms")
      expect(afterPostColumns).toContain("song_annotations_url")

      const checksum = await getMigrationChecksum(databasePath, "1069_post_song_title.sql")
      expect(checksum).toBe("03a5f95f8fe4bec0492dd6d7a2c4c2d7d9e4df7e0af244dcd58cae869cb9e802")
      const presentationChecksum = await getMigrationChecksum(databasePath, "1075_post_song_presentation.sql")
      expect(presentationChecksum).toBe("46da9ddcae0b2c5328a943d36dbb819d476e84dc4a5b7ffc5cc1268835b06368")
      const annotationsUrlChecksum = await getMigrationChecksum(databasePath, "1081_post_song_annotations_url.sql")
      expect(annotationsUrlChecksum).toBe("4ffa5faa01551ecf40fdcdfdb8a4a892e359110b17d077c287fbc91584718b7b")

      await ensureRemotePostSongTitleColumn(client)
    } finally {
      client.close()
    }
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("ensures commerce vinyl release columns on community database schema helper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-remote-vinyl-release-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath, 1093)

    const client = createClient({ url: `file:${databasePath}` })
    try {
      const beforeListingColumns = await getTableColumns(databasePath, "listings")
      expect(beforeListingColumns).not.toContain("vinyl_release_provider")
      expect(beforeListingColumns).not.toContain("vinyl_release_url")
      const beforePurchaseColumns = await getTableColumns(databasePath, "purchases")
      expect(beforePurchaseColumns).not.toContain("vinyl_release_provider")
      expect(beforePurchaseColumns).not.toContain("vinyl_release_url")

      await ensureRemoteCommerceVinylReleaseColumns(client)

      const afterListingColumns = await getTableColumns(databasePath, "listings")
      expect(afterListingColumns).toContain("vinyl_release_provider")
      expect(afterListingColumns).toContain("vinyl_release_url")
      const afterPurchaseColumns = await getTableColumns(databasePath, "purchases")
      expect(afterPurchaseColumns).toContain("vinyl_release_provider")
      expect(afterPurchaseColumns).toContain("vinyl_release_url")

      const checksum = await getMigrationChecksum(databasePath, "1094_vinyl_release_listings.sql")
      expect(checksum).toBe("04680b4600a34ce5275e33294b2e8d91d2fd869d66d0d82583dc1fe03d60cf1b")

      await ensureRemoteCommerceVinylReleaseColumns(client)
    } finally {
      client.close()
    }
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)

  testWithTimeout("enqueues community jobs after existing local databases are migrated", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-store-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyPartialCommunitySchema(databasePath)

    const db = await openCommunityDb({}, buildRepository(databasePath), "cmt_partial")

    try {
      const now = new Date().toISOString()
      await db.client.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, description, status, artist_identity_id, artist_governance_state,
            membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
            donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
            settings_json, created_by_user_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, NULL, 'active', NULL, 'fan_run',
            'request', 'none', 0, NULL,
            NULL, 'none', 'unconfigured', 'centralized',
            NULL, ?3, ?4, ?4
          )
        `,
        args: ["cmt_partial", "Partial Community", "usr_partial_owner", now],
      })

      const first = await enqueueCommunityJob({
        client: db.client,
        communityId: "cmt_partial",
        jobType: "comment_projection_sync",
        subjectType: "comment",
        subjectId: "cmt_01",
        payloadJson: JSON.stringify({ source_comment_id: "cmt_01" }),
        createdAt: now,
      })

      const second = await enqueueCommunityJob({
        client: db.client,
        communityId: "cmt_partial",
        jobType: "comment_projection_sync",
        subjectType: "comment",
        subjectId: "cmt_01",
        payloadJson: JSON.stringify({ source_comment_id: "cmt_01" }),
        createdAt: now,
      })

      expect(second.job_id).toBe(first.job_id)
      expect(second.status).toBe("queued")
    } finally {
      db.close()
    }
  }, COMMUNITY_DB_FACTORY_TEST_TIMEOUT_MS)
})

describe("withRequestCommunityDbClients", () => {
  test("shares the same community database handle across openCommunityDb calls in one request and opens a fresh one outside", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-share-handle-"))
    cleanupPaths.push(rootDir)
    const databasePath = join(rootDir, `${randomUUID()}.db`)

    const shared = await withRequestCommunityDbClients(async () => {
      const first = await openCommunityDb(
        { LOCAL_COMMUNITY_DB_ROOT: rootDir },
        buildRepository(databasePath),
        "cmt_shared",
      )
      const second = await openCommunityDb(
        { LOCAL_COMMUNITY_DB_ROOT: rootDir },
        buildRepository(databasePath),
        "cmt_shared",
      )
      return { first, second }
    })

    expect(shared.second.client).toBe(shared.first.client)
    expect(shared.second.databaseUrl).toBe(shared.first.databaseUrl)
    shared.second.close()
    shared.first.close()

    const outsideFirst = await openCommunityDb(
      { LOCAL_COMMUNITY_DB_ROOT: rootDir },
      buildRepository(databasePath),
      "cmt_shared",
    )
    try {
      const outsideSecond = await openCommunityDb(
        { LOCAL_COMMUNITY_DB_ROOT: rootDir },
        buildRepository(databasePath),
        "cmt_shared",
      )
      try {
        expect(outsideSecond.client).not.toBe(outsideFirst.client)
      } finally {
        outsideSecond.close()
      }
    } finally {
      outsideFirst.close()
    }
  })

  test("caches separate handles per community id within the same request", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-share-handle-"))
    cleanupPaths.push(rootDir)
    const databasePathA = join(rootDir, `a-${randomUUID()}.db`)
    const databasePathB = join(rootDir, `b-${randomUUID()}.db`)

    const repoA = buildRepository(databasePathA)
    const repoB = buildRepository(databasePathB)

    const result = await withRequestCommunityDbClients(async () => {
      const aFirst = await openCommunityDb({ LOCAL_COMMUNITY_DB_ROOT: rootDir }, repoA, "cmt_a")
      const aSecond = await openCommunityDb({ LOCAL_COMMUNITY_DB_ROOT: rootDir }, repoA, "cmt_a")
      const bFirst = await openCommunityDb({ LOCAL_COMMUNITY_DB_ROOT: rootDir }, repoB, "cmt_b")
      return { aFirst, aSecond, bFirst }
    })

    expect(result.aSecond.client).toBe(result.aFirst.client)
    expect(result.bFirst.client).not.toBe(result.aFirst.client)
  })

  test("dedupes concurrent opens for the same community into a single client", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-share-handle-"))
    cleanupPaths.push(rootDir)
    const databasePath = join(rootDir, `${randomUUID()}.db`)

    // Both opens start before either has populated the cache. Without in-flight
    // de-duplication each would create its own client; with it they share one.
    const result = await withRequestCommunityDbClients(async () => {
      const [first, second, third] = await Promise.all([
        openCommunityDb({ LOCAL_COMMUNITY_DB_ROOT: rootDir }, buildRepository(databasePath), "cmt_concurrent"),
        openCommunityDb({ LOCAL_COMMUNITY_DB_ROOT: rootDir }, buildRepository(databasePath), "cmt_concurrent"),
        openCommunityDb({ LOCAL_COMMUNITY_DB_ROOT: rootDir }, buildRepository(databasePath), "cmt_concurrent"),
      ])
      return { first, second, third }
    })

    expect(result.second.client).toBe(result.first.client)
    expect(result.third.client).toBe(result.first.client)
    expect(result.second.databaseUrl).toBe(result.first.databaseUrl)
  })

  test("exposes a no-op close for cached handles inside the request scope and closes the underlying client once the scope ends", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-share-handle-"))
    cleanupPaths.push(rootDir)
    const databasePath = join(rootDir, `${randomUUID()}.db`)

    let underlyingClosed = 0
    let cachedClientRef: { close: () => void } | null = null
    let cachedHandleClose: (() => void) | null = null
    let underlyingBeforeScopeExit: number | null = null
    let reopenedClientRef: { close: () => void } | null = null

    await withRequestCommunityDbClients(async () => {
      const first = await openCommunityDb(
        { LOCAL_COMMUNITY_DB_ROOT: rootDir },
        buildRepository(databasePath),
        "cmt_request_close",
      )
      const originalClose = first.client.close.bind(first.client)
      first.client.close = () => {
        underlyingClosed += 1
        originalClose()
      }
      const second = await openCommunityDb(
        { LOCAL_COMMUNITY_DB_ROOT: rootDir },
        buildRepository(databasePath),
        "cmt_request_close",
      )
      cachedClientRef = first.client
      cachedHandleClose = second.close
      second.close()
    })

    expect(cachedClientRef).not.toBeNull()
    expect(cachedHandleClose).not.toBeNull()
    const closeFn: () => void = cachedHandleClose as unknown as () => void
    expect(typeof closeFn).toBe("function")
    expect(underlyingClosed).toBe(1)
    underlyingBeforeScopeExit = underlyingClosed
    closeFn()
    expect(underlyingClosed).toBe(underlyingBeforeScopeExit)

    const reopened = await openCommunityDb(
      { LOCAL_COMMUNITY_DB_ROOT: rootDir },
      buildRepository(databasePath),
      "cmt_request_close",
    )
    try {
      reopenedClientRef = reopened.client
      expect(reopened.client).not.toBe(cachedClientRef)
    } finally {
      reopened.close()
    }

    expect(reopenedClientRef).not.toBeNull()
  })
})
