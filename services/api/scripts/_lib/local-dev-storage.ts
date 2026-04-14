import { createClient, type Client } from "@libsql/client"
import { mkdir, readFile, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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
  const configuredDbUrl = String(values.TURSO_CONTROL_PLANE_DATABASE_URL || "").trim()
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
    throw new Error("TURSO_CONTROL_PLANE_DATABASE_URL must resolve to a local file path for this command")
  }

  return storage.controlPlaneDbPath
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let inSingleQuote = false
  let inTrigger = false

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    current += char

    if (!inSingleQuote && !inTrigger && current.trimStart().toUpperCase().startsWith("CREATE TRIGGER")) {
      inTrigger = true
    }

    if (char === "'" && sql[index - 1] !== "\\") {
      if (inSingleQuote && next === "'") {
        current += next
        index += 1
        continue
      }
      inSingleQuote = !inSingleQuote
      continue
    }

    if (inTrigger && !inSingleQuote && current.trimEnd().toUpperCase().endsWith("END;")) {
      const statement = current.trim()
      if (statement) {
        statements.push(statement)
      }
      current = ""
      inTrigger = false
      continue
    }

    if (char === ";" && !inSingleQuote && !inTrigger) {
      const statement = current.trim()
      if (statement) {
        statements.push(statement)
      }
      current = ""
    }
  }

  const trailing = current.trim()
  if (trailing) {
    statements.push(trailing)
  }

  return statements
}

function toSqliteCompatibleStatement(statement: string): string | null {
  const normalized = statement.trim().replace(/\s+/g, " ").toUpperCase()

  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" ADD CONSTRAINT ")) {
    return null
  }

  let sqliteCompat = statement
  sqliteCompat = sqliteCompat.replace(/\bJSONB\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bTIMESTAMPTZ\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bTIMESTAMP\b/gi, "TEXT")

  return sqliteCompat
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

export async function applyLocalControlPlaneMigrations(storage: LocalDevStorage): Promise<void> {
  requireLocalControlPlaneDbPath(storage)
  const client = createClient({ url: storage.controlPlaneDbUrl })

  try {
    if (await hasTable(client, "auth_provider_links")) {
      return
    }

    const migrationsDir = resolve(storage.repoRoot, "db/control-plane/migrations")
    const entries = (await readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort()
    const baselineEntry = entries.find((entry) => entry.startsWith("0000_") && entry.includes("baseline"))
    const entriesToApply = baselineEntry ? [baselineEntry] : entries

    for (const entry of entriesToApply) {
      await applySqlFile(client, join(migrationsDir, entry))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`control-plane migration bootstrap failed:\n${message}`)
  } finally {
    client.close()
  }
}
