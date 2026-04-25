import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createClient } from "@libsql/client"
import {
  applyLocalControlPlaneMigrations,
  FIRST_LOCAL_POST_BASELINE_MIGRATION,
  resolveLocalDevStorage,
  type LocalDevStorage,
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

async function getMigrationChecksum(databasePath: string, migrationName: string): Promise<string | null> {
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
    const checksum = result.rows[0]?.checksum
    return checksum === undefined ? null : String(checksum)
  } finally {
    client.close()
  }
}

async function setMigrationChecksum(databasePath: string, migrationName: string, checksum: string): Promise<void> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    await client.execute({
      sql: `
        UPDATE schema_migrations
        SET checksum = ?2
        WHERE migration_name = ?1
      `,
      args: [migrationName, checksum],
    })
  } finally {
    client.close()
  }
}

async function dropColumn(databasePath: string, tableName: string, columnName: string): Promise<void> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    await client.execute(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`)
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

async function listExpectedLocalMigrationNames(storage: LocalDevStorage): Promise<string[]> {
  const entries = (await readdir(join(storage.coreRepoRoot, "db/control-plane/migrations")))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
  const baselineEntry = entries.find((entry) => entry.startsWith("0000_") && entry.includes("baseline"))
  const baselineMigrationName = baselineEntry ?? entries[0]

  return entries.filter((entry) =>
    entry === baselineMigrationName || entry >= FIRST_LOCAL_POST_BASELINE_MIGRATION
  )
}

describe("applyLocalControlPlaneMigrations", () => {
  test("applies the current baseline and post-baseline migrations to fresh local control-plane databases", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    const storage = buildStorage(rootDir, databasePath)
    await applyLocalControlPlaneMigrations(storage)

    expect(await listMigrationNames(databasePath)).toEqual(await listExpectedLocalMigrationNames(storage))
    expect(await listTableColumns(databasePath, "communities")).toContain("follower_count")
    expect(await listTableColumns(databasePath, "community_follow_projections")).toContain("follow_state")
    expect(await listTableColumns(databasePath, "community_post_projections")).toContain("visibility")
    expect(await listTableColumns(databasePath, "community_post_projections")).toContain("upvote_count")
    expect(await listTableColumns(databasePath, "user_agents")).toContain("agent_id")
    expect(await listTableColumns(databasePath, "agent_handles")).toContain("label_normalized")
    expect(await listTableColumns(databasePath, "agent_ownership_records")).toContain("device_id")
    expect(await listTableColumns(databasePath, "agent_action_nonce_replays")).toContain("nonce")
    expect(await listTableColumns(databasePath, "user_tasks")).toContain("task_id")
    expect(await listTableColumns(databasePath, "notification_events")).toContain("event_id")
  })

  test("repairs stale local baseline checksums", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-stale-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    const storage = buildStorage(rootDir, databasePath)
    await applyLocalControlPlaneMigrations(storage)
    const currentChecksum = await getMigrationChecksum(databasePath, "0000_control_plane_baseline_postgres.sql")
    expect(currentChecksum).not.toBeNull()
    await setMigrationChecksum(databasePath, "0000_control_plane_baseline_postgres.sql", "stale-checksum")

    await applyLocalControlPlaneMigrations(storage)

    expect(await getMigrationChecksum(databasePath, "0000_control_plane_baseline_postgres.sql")).toBe(currentChecksum)
  })

  test("backfills columns added to the local baseline after an existing database was created", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-stale-column-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    const storage = buildStorage(rootDir, databasePath)
    await applyLocalControlPlaneMigrations(storage)
    await dropColumn(databasePath, "verification_sessions", "verification_requirements_json")
    expect(await listTableColumns(databasePath, "verification_sessions")).not.toContain("verification_requirements_json")

    await applyLocalControlPlaneMigrations(storage)

    expect(await listTableColumns(databasePath, "verification_sessions")).toContain("verification_requirements_json")
  })

  test("rejects local control-plane databases with stale post-baseline checksums", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-stale-post-baseline-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    await applyLocalControlPlaneMigrations(buildStorage(rootDir, databasePath))
    const client = createClient({
      url: `file:${databasePath}`,
    })

    try {
      await client.execute({
        sql: `
          UPDATE schema_migrations
          SET checksum = ?2
          WHERE migration_name = ?1
        `,
        args: [
          "0047_control_plane_notifications.sql",
          "stale-checksum",
        ],
      })
    } finally {
      client.close()
    }

    await expect(applyLocalControlPlaneMigrations(
      buildStorage(rootDir, databasePath),
    )).rejects.toThrow("migration checksum mismatch for 0047_control_plane_notifications.sql")
  })

  test("rehomes stale configured local control-plane database paths into the current service .local when the same db already exists", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-rehome-"))
    cleanupPaths.push(rootDir)

    const serviceRoot = join(rootDir, "workspace", "services", "api")
    const currentLocalDir = join(serviceRoot, ".local")
    await mkdir(currentLocalDir, { recursive: true })

    const dbFilename = "turso-live-smoke-control-plane.db"
    const currentDbPath = join(currentLocalDir, dbFilename)
    await writeFile(currentDbPath, "")

    const staleDbPath = join(rootDir, "old-checkout", "services", "api", ".local", dbFilename)
    const fakeCoreRepoRoot = join(rootDir, "pirate-core")
    await mkdir(join(fakeCoreRepoRoot, "db", "control-plane", "migrations"), { recursive: true })

    const storage = resolveLocalDevStorage({
      CONTROL_PLANE_DATABASE_URL: `file:${staleDbPath}`,
      PIRATE_CORE_REPO: fakeCoreRepoRoot,
    }, serviceRoot)

    expect(storage.controlPlaneDbConfiguredPath).toBe(staleDbPath)
    expect(storage.controlPlaneDbRehomedFromPath).toBe(staleDbPath)
    expect(storage.controlPlaneDbPath).toBe(currentDbPath)
    expect(storage.controlPlaneDbUrl).toBe(pathToFileURL(currentDbPath).href)
  })
})
