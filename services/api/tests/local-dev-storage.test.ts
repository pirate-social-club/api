import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createClient } from "@libsql/client"
import {
  applyLocalControlPlaneMigrations,
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

async function listTriggerNames(databasePath: string): Promise<string[]> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  try {
    const result = await client.execute(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger'
      ORDER BY name
    `)
    return result.rows.map((row) => String(row.name))
  } finally {
    client.close()
  }
}

async function insertNamespaceVerification(databasePath: string, input: {
  family: "hns" | "spaces"
  normalizedRootLabel: string
  id: string
}): Promise<void> {
  const client = createClient({
    url: `file:${databasePath}`,
  })

  const now = new Date().toISOString()
  const sessionId = `nvs_${input.id}`
  try {
    await client.execute({
      sql: `
        INSERT OR IGNORE INTO users (
          user_id, verification_state, verification_capabilities_json, created_at, updated_at
        ) VALUES (
          'usr_local_trigger_test', 'verified', '[]', ?1, ?1
        )
      `,
      args: [now],
    })
    await client.execute({
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, user_id, family, submitted_root_label, normalized_root_label,
          status, expires_at, created_at, updated_at
        ) VALUES (
          ?1, 'usr_local_trigger_test', ?2, ?3, ?4,
          'verified', ?5, ?5, ?5
        )
      `,
      args: [sessionId, input.family, input.normalizedRootLabel, input.normalizedRootLabel, now],
    })
    await client.execute({
      sql: `
        INSERT INTO namespace_verifications (
          namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
          status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
          accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'usr_local_trigger_test', ?3, ?4,
          'verified', 1, 1, 1, 1,
          0, 1, 1, 0,
          ?5, ?5, ?5, ?5
        )
      `,
      args: [input.id, sessionId, input.family, input.normalizedRootLabel, now],
    })
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
  return entries
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
    const triggerNames = await listTriggerNames(databasePath)
    expect(triggerNames).toContain("namespace_verifications_spaces_root_label_ascii_insert")
    expect(triggerNames).toContain("namespace_verifications_spaces_root_label_ascii_update")
  })

  test("enforces canonical ASCII labels for Spaces namespace verifications in local sqlite", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-spaces-label-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    const storage = buildStorage(rootDir, databasePath)
    await applyLocalControlPlaneMigrations(storage)

    await insertNamespaceVerification(databasePath, {
      family: "spaces",
      id: "nv_ascii_spaces",
      normalizedRootLabel: "xn--t77hga",
    })
    await insertNamespaceVerification(databasePath, {
      family: "hns",
      id: "nv_unicode_hns",
      normalizedRootLabel: "example",
    })
    await expect(insertNamespaceVerification(databasePath, {
      family: "spaces",
      id: "nv_unicode_spaces",
      normalizedRootLabel: "🇵🇸",
    })).rejects.toThrow("canonical IDNA ASCII")
  })

  test("rejects local control-plane databases with stale baseline checksums", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-stale-baseline-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "control-plane.db")
    const storage = buildStorage(rootDir, databasePath)
    await applyLocalControlPlaneMigrations(storage)
    await setMigrationChecksum(databasePath, "0000_control_plane_baseline_postgres.sql", "stale-checksum")

    await expect(applyLocalControlPlaneMigrations(storage))
      .rejects.toThrow("migration checksum mismatch for 0000_control_plane_baseline_postgres.sql")
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
          "0051_control_plane_notifications.sql",
          "stale-checksum",
        ],
      })
    } finally {
      client.close()
    }

    await expect(applyLocalControlPlaneMigrations(
      buildStorage(rootDir, databasePath),
    )).rejects.toThrow("migration checksum mismatch for 0051_control_plane_notifications.sql")
  })

  test("does not rehome configured local control-plane database paths outside the current service .local", async () => {
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
    expect(storage.controlPlaneDbRehomedFromPath).toBeNull()
    expect(storage.controlPlaneDbPath).toBe(staleDbPath)
    expect(storage.controlPlaneDbUrl).toBe(pathToFileURL(staleDbPath).href)
  })

  test("rehomes missing nested current .local database paths when the basename exists at the .local root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-local-dev-storage-rehome-current-"))
    cleanupPaths.push(rootDir)

    const serviceRoot = join(rootDir, "workspace", "services", "api")
    const currentLocalDir = join(serviceRoot, ".local")
    await mkdir(currentLocalDir, { recursive: true })

    const dbFilename = "turso-live-smoke-control-plane.db"
    const currentDbPath = join(currentLocalDir, dbFilename)
    await writeFile(currentDbPath, "")

    const nestedMissingDbPath = join(currentLocalDir, "old", dbFilename)
    const fakeCoreRepoRoot = join(rootDir, "pirate-core")
    await mkdir(join(fakeCoreRepoRoot, "db", "control-plane", "migrations"), { recursive: true })

    const storage = resolveLocalDevStorage({
      CONTROL_PLANE_DATABASE_URL: `file:${nestedMissingDbPath}`,
      PIRATE_CORE_REPO: fakeCoreRepoRoot,
    }, serviceRoot)

    expect(storage.controlPlaneDbConfiguredPath).toBe(nestedMissingDbPath)
    expect(storage.controlPlaneDbRehomedFromPath).toBe(nestedMissingDbPath)
    expect(storage.controlPlaneDbPath).toBe(currentDbPath)
    expect(storage.controlPlaneDbUrl).toBe(pathToFileURL(currentDbPath).href)
  })
})
