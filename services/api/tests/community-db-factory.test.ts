import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import type { CommunityRepository } from "../src/lib/communities/control-plane-community-repository"
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
      .filter((entry) => Number.parseInt(entry.slice(0, 4), 10) <= 1020)

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

async function getCommunityColumns(databasePath: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute("PRAGMA table_info(communities)")
    return result.rows.map((row) => String(row.name))
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

    const beforeColumns = await getCommunityColumns(databasePath)
    expect(beforeColumns).not.toContain("avatar_ref")
    expect(beforeColumns).not.toContain("banner_ref")

    const db = await openCommunityDb(
      {
        LOCAL_COMMUNITY_DB_ROOT: rootDir,
      },
      buildRepository(databasePath),
      "cmt_legacy",
    )

    db.close()

    const afterColumns = await getCommunityColumns(databasePath)
    expect(afterColumns).toContain("avatar_ref")
    expect(afterColumns).toContain("banner_ref")
  })
})
