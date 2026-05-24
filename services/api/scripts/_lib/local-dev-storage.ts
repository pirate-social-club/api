import { createClient, type Client } from "@libsql/client"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveCoreRepoRoot } from "../../shared/core-repo-paths"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../../shared/sql-migration"

const LOCAL_CONTROL_PLANE_BUSY_TIMEOUT_MS = 5000
const LOCAL_FOLLOWER_COUNT_RENAME_MIGRATIONS = new Set([
  "0064_control_plane_communities_follower_count_column.sql",
])
const LOCAL_TELEGRAM_COMMUNITY_CHATS_MIGRATION = "0099_control_plane_telegram_community_chats.sql"

type LocalControlPlaneMigrationDriftPolicy = {
  controlPlane?: {
    compatibleChecksumDrifts?: Array<{
      migrationName?: string
      oldChecksum?: string
      reason?: string
    }>
  }
}

export type LocalDevStorage = {
  repoRoot: string
  coreRepoRoot: string
  controlPlaneDbUrl: string
  controlPlaneDbConfiguredPath: string | null
  controlPlaneDbPath: string | null
  controlPlaneDbRehomedFromPath: string | null
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

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)
}

function rehomeMissingConfiguredLocalDb(input: {
  configuredDbUrl: string
  defaultDataRoot: string
  resolvedDbPath: string | null
}): {
  configuredPath: string | null
  dbPath: string | null
  dbUrl: string
  rehomedFromPath: string | null
} {
  const configuredPath = input.resolvedDbPath
  if (!input.configuredDbUrl || !configuredPath || existsSync(configuredPath)) {
    return {
      configuredPath,
      dbPath: configuredPath,
      dbUrl: input.configuredDbUrl,
      rehomedFromPath: null,
    }
  }

  if (!isPathInside(input.defaultDataRoot, configuredPath)) {
    return {
      configuredPath,
      dbPath: configuredPath,
      dbUrl: input.configuredDbUrl,
      rehomedFromPath: null,
    }
  }

  const rehomedPath = resolve(input.defaultDataRoot, basename(configuredPath))
  if (rehomedPath === configuredPath || !existsSync(rehomedPath)) {
    return {
      configuredPath,
      dbPath: configuredPath,
      dbUrl: input.configuredDbUrl,
      rehomedFromPath: null,
    }
  }

  return {
    configuredPath,
    dbPath: rehomedPath,
    dbUrl: pathToFileURL(rehomedPath).href,
    rehomedFromPath: configuredPath,
  }
}

export function resolveLocalDevStorage(
  values: Record<string, string | undefined>,
  serviceRoot = process.cwd(),
): LocalDevStorage {
  const repoRoot = resolve(serviceRoot, "../../..")
  const coreRepoRoot = resolveCoreRepoRoot({
    override: values.PIRATE_CORE_REPO,
    serviceRoot,
  })
  const defaultDataRoot = resolve(serviceRoot, ".local")
  const configuredDbUrl = String(values.CONTROL_PLANE_DATABASE_URL || "").trim()
  const configuredCommunityRoot = String(values.LOCAL_COMMUNITY_DB_ROOT || "").trim()

  const initialControlPlaneDbUrl = configuredDbUrl
    ? (configuredDbUrl.startsWith("file:") ? normalizeFileUrl(configuredDbUrl, serviceRoot) : configuredDbUrl)
    : pathToFileURL(resolve(defaultDataRoot, "control-plane.db")).href

  const resolvedConfiguredDb = rehomeMissingConfiguredLocalDb({
    configuredDbUrl: initialControlPlaneDbUrl,
    defaultDataRoot,
    resolvedDbPath: toLocalFilePath(initialControlPlaneDbUrl, serviceRoot),
  })
  const communityDbRoot = configuredCommunityRoot
    ? resolveLocalPath(configuredCommunityRoot, serviceRoot)
    : resolve(defaultDataRoot, "community-dbs")

  return {
    repoRoot,
    coreRepoRoot,
    controlPlaneDbUrl: resolvedConfiguredDb.dbUrl,
    controlPlaneDbConfiguredPath: resolvedConfiguredDb.configuredPath,
    controlPlaneDbPath: resolvedConfiguredDb.dbPath,
    controlPlaneDbRehomedFromPath: resolvedConfiguredDb.rehomedFromPath,
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
    if (await shouldSkipExistingAddColumn(client, statement)) {
      continue
    }
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
}

function parseAddColumnIfNotExists(statement: string): { tableName: string; columnName: string } | null {
  const match = statement.match(/^\s*ALTER\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\b/iu)
  if (!match) {
    return null
  }
  return {
    tableName: match[1]!,
    columnName: match[2]!,
  }
}

async function shouldSkipExistingAddColumn(client: Client, statement: string): Promise<boolean> {
  const target = parseAddColumnIfNotExists(statement)
  if (!target) {
    return false
  }

  const result = await client.execute(`PRAGMA table_info(${target.tableName})`)
  return result.rows.some((row) => String(row.name) === target.columnName)
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

async function configureLocalControlPlaneClient(client: Client): Promise<void> {
  await client.execute("PRAGMA journal_mode = WAL")
  await client.execute("PRAGMA synchronous = NORMAL")
  await client.execute(`PRAGMA busy_timeout = ${LOCAL_CONTROL_PLANE_BUSY_TIMEOUT_MS}`)
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

async function getAppliedMigrations(client: Client): Promise<Map<string, string>> {
  const result = await client.execute(`
    SELECT migration_name, checksum
    FROM schema_migrations
  `)

  return new Map(result.rows.map((row) => [
    String(row.migration_name),
    typeof row.checksum === "string" ? row.checksum : String(row.checksum),
  ]))
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

async function updateAppliedMigrationChecksum(
  client: Client,
  migrationName: string,
  checksum: string,
): Promise<void> {
  await client.execute({
    sql: `
      UPDATE schema_migrations
      SET checksum = ?2
      WHERE migration_name = ?1
    `,
    args: [migrationName, checksum],
  })
}

async function loadCompatibleLocalControlPlaneChecksumDrifts(input: {
  coreRepoRoot: string
  expectedChecksumsByName: Map<string, string>
}): Promise<Map<string, Set<string>>> {
  const policyPath = resolve(input.coreRepoRoot, "db/local-control-plane-migration-drifts.json")
  const rawPolicy = await readFile(policyPath, "utf8")
  const policy = JSON.parse(rawPolicy) as LocalControlPlaneMigrationDriftPolicy
  const compatibleChecksums = new Map<string, Set<string>>()

  for (const drift of policy.controlPlane?.compatibleChecksumDrifts ?? []) {
    const migrationName = String(drift.migrationName ?? "").trim()
    const oldChecksum = String(drift.oldChecksum ?? "").trim()
    const reason = String(drift.reason ?? "").trim()
    if (!migrationName || !oldChecksum || !reason) {
      throw new Error("invalid local control-plane migration drift policy entry")
    }
    const expectedChecksum = input.expectedChecksumsByName.get(migrationName)
    if (!expectedChecksum) {
      continue
    }
    if (oldChecksum === expectedChecksum) {
      throw new Error(`local control-plane drift policy oldChecksum matches current migration: ${migrationName}`)
    }

    const checksums = compatibleChecksums.get(migrationName) ?? new Set<string>()
    checksums.add(oldChecksum)
    compatibleChecksums.set(migrationName, checksums)
  }

  return compatibleChecksums
}

async function repairCompatibleLocalControlPlaneMigration(input: {
  client: Client
  migrationName: string
  migrationPath: string
  existingChecksum: string
  migrationChecksum: string
  compatibleChecksumsByName: Map<string, Set<string>>
}): Promise<boolean> {
  const compatibleChecksums = input.compatibleChecksumsByName.get(input.migrationName)
  if (!compatibleChecksums?.has(input.existingChecksum)) {
    return false
  }

  if (input.migrationName === LOCAL_TELEGRAM_COMMUNITY_CHATS_MIGRATION) {
    await ensureTelegramCommunityChatsRequestColumns(input.client)
  }
  await applySqlFile(input.client, input.migrationPath)
  await updateAppliedMigrationChecksum(input.client, input.migrationName, input.migrationChecksum)
  return true
}

async function repairCompatibleLocalControlPlaneBaselineMigration(input: {
  client: Client
  migrationName: string
  existingChecksum: string
  migrationChecksum: string
  compatibleChecksumsByName: Map<string, Set<string>>
}): Promise<boolean> {
  const compatibleChecksums = input.compatibleChecksumsByName.get(input.migrationName)
  if (!compatibleChecksums?.has(input.existingChecksum)) {
    return false
  }

  await updateAppliedMigrationChecksum(input.client, input.migrationName, input.migrationChecksum)
  return true
}

async function listTableColumns(client: Client, tableName: string): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`)
  return new Set(result.rows.map((row) => String(row.name)))
}

async function ensureRenamedColumn(
  client: Client,
  tableName: string,
  sourceColumnName: string,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const columns = await listTableColumns(client, tableName)
  if (columns.has(columnName)) {
    return
  }
  if (columns.has(sourceColumnName)) {
    await client.execute(`ALTER TABLE ${tableName} RENAME COLUMN ${sourceColumnName} TO ${columnName}`)
    return
  }

  await client.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
}

async function ensureColumn(
  client: Client,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const columns = await listTableColumns(client, tableName)
  if (columns.has(columnName)) {
    return
  }

  await client.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
}

async function ensureTelegramCommunityChatsRequestColumns(client: Client): Promise<void> {
  await ensureColumn(client, "telegram_setup_intents", "request_id", "INTEGER")
  await ensureColumn(client, "telegram_setup_intents", "request_owner_telegram_user_id", "TEXT")
  await ensureColumn(client, "telegram_setup_intents", "request_private_chat_id", "TEXT")
  await ensureColumn(client, "telegram_setup_intents", "request_message_id", "INTEGER")
  await ensureColumn(client, "telegram_setup_intents", "request_sent_at", "TIMESTAMPTZ")
}

export async function applyLocalControlPlaneMigrations(storage: LocalDevStorage): Promise<void> {
  requireLocalControlPlaneDbPath(storage)
  const client = createClient({ url: storage.controlPlaneDbUrl })

  try {
    await configureLocalControlPlaneClient(client)

    const migrationsDir = resolve(storage.coreRepoRoot, "db/control-plane/migrations")
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
    const expectedChecksumsByName = new Map<string, string>()
    for (const migrationName of entries) {
      const migrationSql = await readFile(join(migrationsDir, migrationName), "utf8")
      expectedChecksumsByName.set(migrationName, createHash("sha256").update(migrationSql).digest("hex"))
    }
    const compatibleChecksumsByName = await loadCompatibleLocalControlPlaneChecksumDrifts({
      coreRepoRoot: storage.coreRepoRoot,
      expectedChecksumsByName,
    })

    await ensureSchemaMigrationsTable(client)

    const appliedChecksum = await getAppliedChecksum(client, baselineMigrationName)
    if (appliedChecksum) {
      if (appliedChecksum !== baselineChecksum) {
        const repaired = await repairCompatibleLocalControlPlaneBaselineMigration({
          client,
          migrationName: baselineMigrationName,
          existingChecksum: appliedChecksum,
          migrationChecksum: baselineChecksum,
          compatibleChecksumsByName,
        })
        if (!repaired) {
          throw new Error(`migration checksum mismatch for ${baselineMigrationName}`)
        }
      }
    } else {
      await applySqlFile(client, baselineMigrationPath)
      await recordAppliedMigration(client, baselineMigrationName, baselineChecksum)
    }

    const appliedMigrations = await getAppliedMigrations(client)
    for (const migrationName of entries) {
      if (migrationName === baselineMigrationName) {
        continue
      }

      const migrationPath = join(migrationsDir, migrationName)
      const migrationChecksum = expectedChecksumsByName.get(migrationName)
      if (!migrationChecksum) {
        throw new Error(`missing expected checksum for ${migrationName}`)
      }
      const existingChecksum = appliedMigrations.get(migrationName)

      if (existingChecksum) {
        if (existingChecksum !== migrationChecksum) {
          const repaired = await repairCompatibleLocalControlPlaneMigration({
            client,
            migrationName,
            migrationPath,
            existingChecksum,
            migrationChecksum,
            compatibleChecksumsByName,
          })
          if (repaired) {
            appliedMigrations.set(migrationName, migrationChecksum)
            continue
          }
          throw new Error(`migration checksum mismatch for ${migrationName}`)
        }
        continue
      }

      if (LOCAL_FOLLOWER_COUNT_RENAME_MIGRATIONS.has(migrationName)) {
        await ensureRenamedColumn(client, "communities", "projected_follower_count", "follower_count", "INTEGER NOT NULL DEFAULT 0")
      } else {
        await applySqlFile(client, migrationPath)
      }
      await recordAppliedMigration(client, migrationName, migrationChecksum)
      appliedMigrations.set(migrationName, migrationChecksum)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`control-plane migration bootstrap failed:\n${message}`)
  } finally {
    client.close()
  }
}
