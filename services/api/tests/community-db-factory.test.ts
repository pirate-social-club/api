import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob } from "../src/lib/communities/community-job-store"
import type { CommunityRepository } from "../src/lib/communities/db-community-repository"
import { splitSqlStatements, toSqliteCompatibleStatement } from "../shared/sql-migration"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function applyLegacyCommunitySchema(databasePath: string): Promise<void> {
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

    const migrationsDir = new URL("../../../../db/community-template/migrations/", import.meta.url)
    const entries = (await readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()
      .filter((entry) => Number.parseInt(entry.slice(0, 4), 10) <= 1023)

    for (const entry of entries) {
      const sql = await readFile(new URL(entry, migrationsDir), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        const sqliteStatement = toSqliteCompatibleStatement(statement)
        if (!sqliteStatement) {
          continue
        }
        await client.execute(sqliteStatement)
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

async function getSchemaMigrationChecksum(databasePath: string, migrationName: string): Promise<string | null> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT checksum
        FROM schema_migrations
        WHERE migration_name = ?1
        LIMIT 1
      `,
      args: [migrationName],
    })
    const value = result.rows[0]?.checksum
    return typeof value === "string" ? value : null
  } finally {
    client.close()
  }
}

function buildRepository(databasePath: string): CommunityRepository {
  return {
    async getPrimaryCommunityDatabaseBinding() {
      return {
        community_database_binding_id: "cdb_legacy",
        community_id: "cmt_legacy",
        binding_role: "primary",
        organization_slug: "local",
        group_name: "local",
        group_id: null,
        database_name: "community-cmt_legacy",
        database_id: null,
        database_url: `file:${databasePath}`,
        location: null,
        status: "active",
        transferred_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    },
    async getActiveCommunityDbCredential() {
      return null
    },
  } as unknown as CommunityRepository
}

describe("openCommunityDb", () => {
  test("applies pending template migrations for legacy community databases", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-db-factory-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyLegacyCommunitySchema(databasePath)

    const beforeTableNames = await listTableNames(databasePath)
    expect(beforeTableNames).not.toContain("comments")
    expect(beforeTableNames).not.toContain("comment_closure")
    expect(beforeTableNames).not.toContain("thread_snapshots")
    expect(beforeTableNames).not.toContain("donation_partners")

    const beforePostColumns = await getTableColumns(databasePath, "posts")
    expect(beforePostColumns).not.toContain("comment_count")
    expect(beforePostColumns).not.toContain("top_level_comment_count")
    expect(beforePostColumns).not.toContain("last_comment_at")

    const db = await openCommunityDb(
      {
        LOCAL_COMMUNITY_DB_ROOT: rootDir,
      },
      buildRepository(databasePath),
      "cmt_legacy",
    )

    db.close()

    const tableNames = await listTableNames(databasePath)
    expect(tableNames).toContain("comments")
    expect(tableNames).toContain("comment_closure")
    expect(tableNames).toContain("comment_votes")
    expect(tableNames).toContain("thread_snapshots")
    expect(tableNames).toContain("donation_partners")

    const postColumns = await getTableColumns(databasePath, "posts")
    expect(postColumns).toContain("comment_count")
    expect(postColumns).toContain("top_level_comment_count")
    expect(postColumns).toContain("last_comment_at")

    const moderationCaseColumns = await getTableColumns(databasePath, "moderation_cases")
    expect(moderationCaseColumns).toContain("comment_id")

    const moderationActionColumns = await getTableColumns(databasePath, "moderation_actions")
    expect(moderationActionColumns).toContain("comment_id")
    expect(moderationActionColumns).toContain("previous_post_status")
    expect(moderationActionColumns).toContain("next_post_status")
  })

  test("enqueues community jobs after legacy databases are migrated", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-store-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    await applyLegacyCommunitySchema(databasePath)

    const db = await openCommunityDb(
      {
        LOCAL_COMMUNITY_DB_ROOT: rootDir,
      },
      buildRepository(databasePath),
      "cmt_legacy",
    )

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
            'open', 'none', 0, NULL,
            NULL, 'none', 'unconfigured', 'centralized',
            NULL, ?3, ?4, ?4
          )
        `,
        args: ["cmt_legacy", "Legacy Community", "usr_legacy_owner", now],
      })

      const first = await enqueueCommunityJob({
        client: db.client,
        communityId: "cmt_legacy",
        jobType: "comment_projection_sync",
        subjectType: "comment",
        subjectId: "cmt_01",
        payloadJson: JSON.stringify({ source_comment_id: "cmt_01" }),
        createdAt: now,
      })

      const second = await enqueueCommunityJob({
        client: db.client,
        communityId: "cmt_legacy",
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
  })

  test.each([
    "35dd1dca31a58d594287c4636486940611fcc9e621ddf1c52d8627719bd18673",
    "b30841d6b60a02fe72d6ea61dbc3e7fb3459d069143b53d8a07fa8a9790f4d01",
  ])("accepts and normalizes the legacy checksum %s for 1036_community_post_labels_ai.sql", async (legacyChecksum) => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-db-factory-checksum-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, `${randomUUID()}.db`)
    const db = await openCommunityDb(
      {
        LOCAL_COMMUNITY_DB_ROOT: rootDir,
      },
      buildRepository(databasePath),
      "cmt_legacy",
    )

    try {
      await db.client.execute({
        sql: `
          UPDATE schema_migrations
          SET checksum = ?2
          WHERE migration_name = ?1
        `,
        args: [
          "1036_community_post_labels_ai.sql",
          legacyChecksum,
        ],
      })
    } finally {
      db.close()
    }

    const reopened = await openCommunityDb(
      {
        LOCAL_COMMUNITY_DB_ROOT: rootDir,
      },
      buildRepository(databasePath),
      "cmt_legacy",
    )
    reopened.close()

    expect(await getSchemaMigrationChecksum(
      databasePath,
      "1036_community_post_labels_ai.sql",
    )).toBe("1e9a8ffcfb6cf40d60e8130f0d446a49ec17d0a481d33b9ddd4bcabb24b4f951")
  })
})
