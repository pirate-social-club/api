import { createClient } from "@libsql/client"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { resolveLocalDevStorage } from "./_lib/local-dev-storage"

type MigrationRow = {
  migration_name: string
  checksum: string
}

type ExpectedMigration = {
  migrationName: string
  checksum: string
  path: string
}

function checksumSql(sql: string): string {
  return createHash("sha256").update(sql).digest("hex")
}

async function listExpectedMigrations(migrationsDir: string): Promise<ExpectedMigration[]> {
  const entries = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()

  const migrations: ExpectedMigration[] = []
  for (const entry of entries) {
    const migrationPath = join(migrationsDir, entry)
    const sql = await readFile(migrationPath, "utf8")
    migrations.push({
      migrationName: entry,
      checksum: checksumSql(sql),
      path: migrationPath,
    })
  }
  return migrations
}

function gitStatus(repoRoot: string, filePath: string): string {
  const relativePath = relative(repoRoot, filePath)
  try {
    const status = execFileSync("git", ["status", "--short", "--", relativePath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (status) {
      return status
    }
  } catch {
    return "git status unavailable"
  }

  try {
    execFileSync("git", ["ls-files", "--error-unmatch", relativePath], {
      cwd: repoRoot,
      stdio: "ignore",
    })
    return "tracked, clean"
  } catch {
    return "untracked"
  }
}

async function readAppliedMigrations(databaseUrl: string): Promise<MigrationRow[]> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute(`
      SELECT migration_name, checksum
      FROM schema_migrations
      ORDER BY migration_name
    `)
    return result.rows.map((row) => ({
      migration_name: String(row.migration_name ?? ""),
      checksum: String(row.checksum ?? ""),
    }))
  } finally {
    client.close()
  }
}

async function main(): Promise<void> {
  const storage = resolveLocalDevStorage(process.env, process.cwd())
  const migrationsDir = join(storage.coreRepoRoot, "db/control-plane/migrations")

  console.log("local control-plane migration doctor")
  console.log(`database_path: ${storage.controlPlaneDbPath ?? "(not a local file URL)"}`)
  console.log(`migrations_dir: ${migrationsDir}`)
  if (storage.controlPlaneDbRehomedFromPath) {
    console.log(`rehomed_from: ${storage.controlPlaneDbRehomedFromPath}`)
  }

  if (!storage.controlPlaneDbPath) {
    console.error("CONTROL_PLANE_DATABASE_URL does not resolve to a local file path")
    process.exit(1)
  }

  if (!existsSync(storage.controlPlaneDbPath)) {
    console.log("status: database file does not exist yet")
    console.log("next: run `bun run dev:local:raw` or `bun run dev:local:full:raw` to bootstrap it")
    return
  }

  const expected = await listExpectedMigrations(migrationsDir)
  let applied: MigrationRow[]
  try {
    applied = await readAppliedMigrations(storage.controlPlaneDbUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`status: unable to read schema_migrations: ${message}`)
    console.log("next: run `bun run dev:local:reset -- --yes` if this is the default services/api/.local database")
    process.exit(1)
  }

  const expectedByName = new Map(expected.map((migration) => [migration.migrationName, migration] as const))
  const appliedByName = new Map(applied.map((migration) => [migration.migration_name, migration] as const))
  const missing = expected.filter((migration) => !appliedByName.has(migration.migrationName))
  const mismatched = expected.filter((migration) => {
    const appliedMigration = appliedByName.get(migration.migrationName)
    return appliedMigration && appliedMigration.checksum !== migration.checksum
  })
  const unexpected = applied.filter((migration) => !expectedByName.has(migration.migration_name))
  const matching = expected.filter((migration) => appliedByName.get(migration.migrationName)?.checksum === migration.checksum)

  console.log(`expected_migrations: ${expected.length}`)
  console.log(`recorded_migrations: ${applied.length}`)
  console.log(`matching: ${matching.length}`)
  console.log(`missing: ${missing.length}`)
  console.log(`mismatched: ${mismatched.length}`)
  console.log(`unexpected: ${unexpected.length}`)

  if (missing.length > 0) {
    console.log("")
    console.log("missing:")
    for (const migration of missing) {
      console.log(`- ${migration.migrationName}`)
    }
  }

  if (mismatched.length > 0) {
    console.log("")
    console.log("mismatched:")
    for (const migration of mismatched) {
      const actual = appliedByName.get(migration.migrationName)?.checksum ?? "(missing)"
      console.log(`- ${migration.migrationName}`)
      console.log(`  expected: ${migration.checksum}`)
      console.log(`  actual:   ${actual}`)
      console.log(`  git:      ${gitStatus(storage.coreRepoRoot, migration.path)}`)
    }
  }

  if (unexpected.length > 0) {
    console.log("")
    console.log("unexpected:")
    for (const migration of unexpected) {
      console.log(`- ${migration.migration_name} ${migration.checksum}`)
    }
  }

  if (missing.length > 0 || mismatched.length > 0 || unexpected.length > 0) {
    console.log("")
    console.log("next: known compatible local drifts are repaired during dev bootstrap; otherwise reset with `bun run dev:local:reset -- --yes`")
    process.exit(1)
  }

  console.log("status: ok")
}

await main()
