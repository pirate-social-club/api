import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"
import {
  applyLocalControlPlaneMigrations,
  resolveLocalDevStorage,
} from "../scripts/_lib/local-dev-storage"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function listTableColumns(databasePath: string, tableName: string): Promise<string[]> {
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

async function listMigrationNames(databasePath: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`
      SELECT migration_name
      FROM schema_migrations
      ORDER BY migration_name
    `)
    return result.rows.map((row) => String(row.migration_name))
  } finally {
    client.close()
  }
}

function buildStorage(rootDir: string, databasePath: string) {
  const serviceRoot = fileURLToPath(new URL("..", import.meta.url))
  return resolveLocalDevStorage({
    CONTROL_PLANE_DATABASE_URL: `file:${databasePath}`,
    LOCAL_COMMUNITY_DB_ROOT: join(rootDir, "community-dbs"),
  }, serviceRoot)
}

describe("applyLocalControlPlaneMigrations", () => {
  test("applies the current baseline to fresh local control-plane databases", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    await applyLocalControlPlaneMigrations(buildStorage(rootDir, databasePath))

    expect(await listMigrationNames(databasePath)).toEqual([
      "0000_control_plane_baseline_postgres.sql",
    ])
    expect(await listTableColumns(databasePath, "community_post_projections")).toContain("visibility")
    expect(await listTableColumns(databasePath, "community_post_projections")).toContain("upvote_count")
    expect(await listTableColumns(databasePath, "user_agents")).toContain("agent_id")
    expect(await listTableColumns(databasePath, "agent_handles")).toContain("label_normalized")
    expect(await listTableColumns(databasePath, "agent_ownership_records")).toContain("device_id")
    expect(await listTableColumns(databasePath, "agent_action_nonce_replays")).toContain("nonce")
  })

  test("rejects local control-plane databases with stale baseline checksums", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-stale-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    const client = createClient({
      url: `file:${databasePath}`,
    })

    try {
      await client.execute(`
        CREATE TABLE schema_migrations (
          migration_name TEXT PRIMARY KEY,
          migration_label TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await client.execute({
        sql: `
          INSERT INTO schema_migrations (migration_name, migration_label, checksum)
          VALUES (?1, 'control-plane', ?2)
        `,
        args: [
          "0000_control_plane_baseline_postgres.sql",
          "stale-checksum",
        ],
      })
    } finally {
      client.close()
    }

    await expect(applyLocalControlPlaneMigrations(
      buildStorage(rootDir, databasePath),
    )).rejects.toThrow("baseline checksum mismatch for 0000_control_plane_baseline_postgres.sql")
  })
})
