import { spawnSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
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

export function applyLocalControlPlaneMigrations(storage: LocalDevStorage): void {
  const dbPath = requireLocalControlPlaneDbPath(storage)
  const migrate = spawnSync(
    "./scripts/apply-sqlite-migrations.sh",
    ["--db", dbPath, "--migrations", "db/control-plane/migrations", "--label", "control-plane"],
    {
      cwd: storage.repoRoot,
      encoding: "utf8",
    },
  )

  if (migrate.status !== 0) {
    const stderr = migrate.stderr.trim()
    const stdout = migrate.stdout.trim()
    throw new Error(`control-plane migration bootstrap failed:\n${stderr || stdout || "unknown error"}`)
  }
}
