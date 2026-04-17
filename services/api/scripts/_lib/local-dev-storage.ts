import { createClient, type Client } from "@libsql/client"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { splitSqlStatements, toSqliteCompatibleStatement } from "../../shared/sql-migration"

const SQLITE_COMPATIBLE_CONTROL_PLANE_MIGRATIONS = new Set([
  "0034_control_plane_communities_pending_namespace.sql",
  "0035_control_plane_namespace_setup_nameservers.sql",
  "0036_control_plane_linked_handles.sql",
])

export type LocalDevStorage = {
  repoRoot: string
  controlPlaneDbUrl: string
  controlPlaneDbPath: string | null
  communityDbRoot: string
}

function resolveLocalPath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value)
}

function normalizeFileUrl(value: string, baseDir: string): string {
  if (value.startsWith("file://")) {
    return pathToFileURL(fileURLToPath(value)).href
  }

  const rawPath = decodeURIComponent(value.slice("file:".length))
  return pathToFileURL(resolveLocalPath(rawPath, baseDir)).href
}

function toLocalFilePath(value: string, baseDir: string): string | null {
  if (value.startsWith("file:")) {
    return fileURLToPath(normalizeFileUrl(value, baseDir))
  }

  if (value.includes("://")) {
    return null
  }

  return resolveLocalPath(value, baseDir)
}

export function resolveLocalDevStorage(
  values: Record<string, string | undefined>,
  serviceRoot = process.cwd(),
): LocalDevStorage {
  const repoRoot = resolve(serviceRoot, "../../..")
  const defaultDataRoot = resolve(serviceRoot, ".local")
  const configuredDbUrl = String(values.CONTROL_PLANE_DATABASE_URL || "").trim()
  const configuredCommunityRoot = String(values.LOCAL_COMMUNITY_DB_ROOT || "").trim()

  const controlPlaneDbUrl = configuredDbUrl
    ? (configuredDbUrl.startsWith("file:") ? normalizeFileUrl(configuredDbUrl, serviceRoot) : configuredDbUrl)
    : pathToFileURL(resolve(defaultDataRoot, "control-plane.db")).href

  const controlPlaneDbPath = toLocalFilePath(controlPlaneDbUrl, serviceRoot)
  const communityDbRoot = configuredCommunityRoot
    ? resolveLocalPath(configuredCommunityRoot, serviceRoot)
    : resolve(defaultDataRoot, "community-dbs")

  return {
    repoRoot,
    controlPlaneDbUrl,
    controlPlaneDbPath,
    communityDbRoot,
  }
}

export async function ensureLocalDevStorage(storage: LocalDevStorage): Promise<void> {
  if (storage.controlPlaneDbPath) {
    await mkdir(dirname(storage.controlPlaneDbPath), { recursive: true })
  }
  await mkdir(storage.communityDbRoot, { recursive: true })
}

export function requireLocalControlPlaneDbPath(storage: LocalDevStorage): string {
  if (!storage.controlPlaneDbPath) {
    throw new Error("CONTROL_PLANE_DATABASE_URL must resolve to a local file path for this command")
  }

  return storage.controlPlaneDbPath
}

async function applySqlFile(client: Client, path: string): Promise<void> {
  const rawSql = await readFile(path, "utf8")
  const statements = splitSqlStatements(rawSql)

  for (const statement of statements) {
    const sqliteStatement = toSqliteCompatibleStatement(statement)
    if (!sqliteStatement) {
      continue
    }
    await client.execute(sqliteStatement)
  }
}

async function hasTable(client: Client, tableName: string): Promise<boolean> {
  const result = await client.execute({
    sql: `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?1
      LIMIT 1
    `,
    args: [tableName],
  })

  return result.rows.length > 0
}

async function hasColumn(client: Client, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`)

  for (const row of result.rows) {
    const name = row.name
    if (typeof name === "string" && name === columnName) {
      return true
    }
  }

  return false
}

async function ensureSchemaMigrationsTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      migration_label TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

async function getAppliedChecksum(client: Client, migrationName: string): Promise<string | null> {
  const result = await client.execute({
    sql: `
      SELECT checksum
      FROM schema_migrations
      WHERE migration_name = ?1
      LIMIT 1
    `,
    args: [migrationName],
  })

  const row = result.rows[0]
  if (!row) {
    return null
  }

  const checksum = row.checksum
  return typeof checksum === "string" ? checksum : String(checksum)
}

async function recordAppliedMigration(
  client: Client,
  migrationName: string,
  checksum: string,
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES (?1, 'control-plane', ?2)
      ON CONFLICT(migration_name) DO UPDATE SET
        migration_label = excluded.migration_label,
        checksum = excluded.checksum
    `,
    args: [migrationName, checksum],
  })
}

export async function applyLocalControlPlaneMigrations(storage: LocalDevStorage): Promise<void> {
  requireLocalControlPlaneDbPath(storage)
  const client = createClient({ url: storage.controlPlaneDbUrl })

  try {
    const migrationsDir = resolve(storage.repoRoot, "db/control-plane/migrations")
    const entries = (await readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()
    const baselineEntry = entries.find((entry) => entry.startsWith("0000_") && entry.includes("baseline"))
    const baselineMigrationName = baselineEntry ?? entries[0]
    if (!baselineMigrationName) {
      throw new Error("no control-plane baseline migration found")
    }
    const baselineMigrationPath = join(migrationsDir, baselineMigrationName)
    const baselineSql = await readFile(baselineMigrationPath, "utf8")
    const baselineChecksum = createHash("sha256").update(baselineSql).digest("hex")

    await ensureSchemaMigrationsTable(client)

    const appliedChecksum = await getAppliedChecksum(client, baselineMigrationName)
    const hasBootstrappedSchema = await hasTable(client, "auth_provider_links")
    if (appliedChecksum) {
      if (appliedChecksum !== baselineChecksum && !hasBootstrappedSchema) {
        throw new Error(`baseline checksum mismatch for ${baselineMigrationName}`)
      }
    } else if (hasBootstrappedSchema) {
      await recordAppliedMigration(client, baselineMigrationName, baselineChecksum)
    } else {
      await applySqlFile(client, baselineMigrationPath)
      await recordAppliedMigration(client, baselineMigrationName, baselineChecksum)
    }

    for (const entry of entries) {
      if (entry === baselineMigrationName || !SQLITE_COMPATIBLE_CONTROL_PLANE_MIGRATIONS.has(entry)) {
        continue
      }

      const migrationPath = join(migrationsDir, entry)
      const migrationSql = await readFile(migrationPath, "utf8")
      const migrationChecksum = createHash("sha256").update(migrationSql).digest("hex")
      const appliedMigrationChecksum = await getAppliedChecksum(client, entry)
      if (appliedMigrationChecksum) {
        if (appliedMigrationChecksum !== migrationChecksum) {
          throw new Error(`checksum mismatch for ${entry}`)
        }
        continue
      }

      // The rolling baseline can already contain columns introduced by a later
      // SQLite-compatible migration. Record it as applied instead of replaying
      // the ALTER TABLE and failing on fresh local databases.
      if (
        entry === "0034_control_plane_communities_pending_namespace.sql"
        && await hasColumn(client, "communities", "pending_namespace_verification_session_id")
      ) {
        await recordAppliedMigration(client, entry, migrationChecksum)
        continue
      }

      if (
        entry === "0035_control_plane_namespace_setup_nameservers.sql"
        && await hasColumn(client, "namespace_verification_sessions", "setup_nameservers_json")
      ) {
        await recordAppliedMigration(client, entry, migrationChecksum)
        continue
      }

      if (
        entry === "0036_control_plane_linked_handles.sql"
        && await hasTable(client, "linked_handles")
        && await hasColumn(client, "profiles", "primary_linked_handle_id")
      ) {
        await recordAppliedMigration(client, entry, migrationChecksum)
        continue
      }

      await applySqlFile(client, migrationPath)
      await recordAppliedMigration(client, entry, migrationChecksum)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`control-plane migration bootstrap failed:\n${message}`)
  } finally {
    client.close()
  }
}
