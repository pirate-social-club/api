import { createClient, type Client } from "@libsql/client"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { splitSqlStatements, toSqliteCompatibleStatement } from "../../shared/sql-migration"

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
    if (appliedChecksum) {
      if (appliedChecksum !== baselineChecksum) {
        throw new Error(`baseline checksum mismatch for ${baselineMigrationName}`)
      }
    } else {
      await applySqlFile(client, baselineMigrationPath)
      await recordAppliedMigration(client, baselineMigrationName, baselineChecksum)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`control-plane migration bootstrap failed:\n${message}`)
  } finally {
    client.close()
  }
}
