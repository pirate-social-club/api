import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { readModeEnv } from "./_lib/dev-vars"

function requireEnv(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim()
  if (!value) {
    throw new Error(`${key} is not configured in .env.local-sqlite`)
  }
  return value
}

function requireLocalFilePath(url: string, key: string): string {
  if (!url.startsWith("file:")) {
    throw new Error(`${key} must use a local file: URL for local-sqlite mode`)
  }

  const parsed = new URL(url)
  if (!parsed.pathname) {
    throw new Error(`${key} must resolve to a writable local file path`)
  }

  return parsed.pathname
}

async function main(): Promise<void> {
  const serviceRoot = resolve(import.meta.dirname, "..")
  const repoRoot = resolve(serviceRoot, "../..")
  const devVars = readModeEnv(serviceRoot, "local-sqlite")

  const controlPlaneDbPath = requireLocalFilePath(
    requireEnv(devVars, "CONTROL_PLANE_DATABASE_URL"),
    "CONTROL_PLANE_DATABASE_URL",
  )
  const communityDbRoot = requireEnv(devVars, "LOCAL_COMMUNITY_DB_ROOT")

  const targets = [
    controlPlaneDbPath,
    `${controlPlaneDbPath}-shm`,
    `${controlPlaneDbPath}-wal`,
    communityDbRoot,
  ]

  process.stdout.write([
    "reset targets:",
    ...targets.map((t) => `  - ${t}`),
    "",
  ].join("\n"))

  for (const target of targets) {
    await rm(target, { recursive: true, force: true })
  }
  await mkdir(communityDbRoot, { recursive: true })

  const migrate = spawnSync(
    "./scripts/apply-sqlite-migrations.sh",
    ["--db", controlPlaneDbPath, "--migrations", "db/control-plane/migrations", "--label", "control-plane"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  )
  if (migrate.status !== 0) {
    throw new Error(`migration bootstrap failed:\n${migrate.stderr}`)
  }

  process.stdout.write([
    "",
    "local-sqlite reset complete",
    `  control_plane_db = ${controlPlaneDbPath}`,
    `  community_db_root = ${communityDbRoot}`,
    "",
  ].join("\n"))
}

await main()
