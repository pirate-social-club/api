import { rm } from "node:fs/promises"
import { readDevVarsFromCwd } from "./_lib/dev-vars"
import {
  applyLocalControlPlaneMigrations,
  ensureLocalDevStorage,
  resolveLocalDevStorage,
} from "./_lib/local-dev-storage"

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function isInsideServiceLocal(path: string): boolean {
  return path.startsWith(`${process.cwd()}/.local/`) || path === `${process.cwd()}/.local`
}

async function main(): Promise<void> {
  if (!hasFlag("--yes")) {
    throw new Error("Refusing to reset local dev storage without --yes")
  }

  const values = {
    ...readDevVarsFromCwd(),
    ...process.env,
  }
  const storage = resolveLocalDevStorage(values)
  if (!storage.controlPlaneDbPath) {
    throw new Error("CONTROL_PLANE_DATABASE_URL must resolve to a local file path")
  }

  if (!isInsideServiceLocal(storage.controlPlaneDbPath) || !isInsideServiceLocal(storage.communityDbRoot)) {
    throw new Error(
      [
        "Refusing to reset paths outside services/api/.local.",
        `control-plane db: ${storage.controlPlaneDbPath}`,
        `community db root: ${storage.communityDbRoot}`,
        "Set CONTROL_PLANE_DATABASE_URL and LOCAL_COMMUNITY_DB_ROOT under services/api/.local, or reset manually.",
      ].join("\n"),
    )
  }

  await rm(storage.controlPlaneDbPath, { force: true })
  await rm(`${storage.controlPlaneDbPath}-shm`, { force: true })
  await rm(`${storage.controlPlaneDbPath}-wal`, { force: true })
  await rm(storage.communityDbRoot, { recursive: true, force: true })

  await ensureLocalDevStorage(storage)
  await applyLocalControlPlaneMigrations(storage)

  console.log([
    "reset local dev storage",
    `control-plane db: ${storage.controlPlaneDbPath}`,
    `community db root: ${storage.communityDbRoot}`,
  ].join("\n"))
}

await main()
