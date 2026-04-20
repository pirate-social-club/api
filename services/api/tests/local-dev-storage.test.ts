import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

async function readMigrationChecksum(migrationName: string): Promise<string> {
  const migrationUrl = new URL(`../../../../db/control-plane/migrations/${migrationName}`, import.meta.url)
  const sql = await readFile(migrationUrl, "utf8")
  return createHash("sha256").update(sql).digest("hex")
}

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

describe("applyLocalControlPlaneMigrations", () => {
  test("applies the post visibility migration to legacy local control-plane databases", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-"))
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
      await client.execute(`
        CREATE TABLE auth_provider_links (
          link_id TEXT PRIMARY KEY
        )
      `)
      await client.execute(`
        CREATE TABLE community_post_projections (
          projection_id TEXT PRIMARY KEY
        )
      `)

      for (const migrationName of [
        "0000_control_plane_baseline_postgres.sql",
        "0034_control_plane_communities_pending_namespace.sql",
        "0035_control_plane_namespace_setup_nameservers.sql",
        "0036_control_plane_linked_handles.sql",
        "0037_control_plane_comment_projections.sql",
        "0038_control_plane_post_feed_metrics.sql",
      ]) {
        await client.execute({
          sql: `
            INSERT INTO schema_migrations (migration_name, migration_label, checksum)
            VALUES (?1, 'control-plane', ?2)
          `,
          args: [migrationName, await readMigrationChecksum(migrationName)],
        })
      }
    } finally {
      client.close()
    }

    const serviceRoot = fileURLToPath(new URL("..", import.meta.url))
    const storage = resolveLocalDevStorage({
      CONTROL_PLANE_DATABASE_URL: `file:${databasePath}`,
      LOCAL_COMMUNITY_DB_ROOT: join(rootDir, "community-dbs"),
    }, serviceRoot)

    await applyLocalControlPlaneMigrations(storage)

    const columns = await listTableColumns(databasePath, "community_post_projections")
    expect(columns).toContain("visibility")
  })

  test("applies agent ownership migrations to legacy local control-plane databases", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-agents-"))
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
      await client.execute(`
        CREATE TABLE auth_provider_links (
          link_id TEXT PRIMARY KEY
        )
      `)
      await client.execute(`
        CREATE TABLE users (
          user_id TEXT PRIMARY KEY
        )
      `)

      for (const migrationName of [
        "0000_control_plane_baseline_postgres.sql",
        "0034_control_plane_communities_pending_namespace.sql",
        "0035_control_plane_namespace_setup_nameservers.sql",
        "0036_control_plane_linked_handles.sql",
        "0037_control_plane_comment_projections.sql",
        "0038_control_plane_post_feed_metrics.sql",
        "0039_control_plane_post_visibility.sql",
      ]) {
        await client.execute({
          sql: `
            INSERT INTO schema_migrations (migration_name, migration_label, checksum)
            VALUES (?1, 'control-plane', ?2)
          `,
          args: [migrationName, await readMigrationChecksum(migrationName)],
        })
      }
    } finally {
      client.close()
    }

    const serviceRoot = fileURLToPath(new URL("..", import.meta.url))
    const storage = resolveLocalDevStorage({
      CONTROL_PLANE_DATABASE_URL: `file:${databasePath}`,
      LOCAL_COMMUNITY_DB_ROOT: join(rootDir, "community-dbs"),
    }, serviceRoot)

    await applyLocalControlPlaneMigrations(storage)

    await expect(listTableColumns(databasePath, "user_agents")).resolves.toContain("agent_id")
    await expect(listTableColumns(databasePath, "agent_ownership_records")).resolves.toContain("device_id")
    await expect(listTableColumns(databasePath, "agent_action_nonce_replays")).resolves.toContain("nonce")
  })
})
