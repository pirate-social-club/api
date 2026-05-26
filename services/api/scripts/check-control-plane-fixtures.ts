import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const apiRoot = resolve(scriptDir, "..")
const repoRoot = resolve(apiRoot, "../..")
const fixtureMigrationsDir = resolve(apiRoot, "test-fixtures/db/control-plane/migrations")

function candidateHasCoreMigrations(root: string): boolean {
  return existsSync(resolve(root, "db/control-plane/migrations"))
}

function resolveCanonicalCoreRoot(): string {
  const candidates = [
    process.env.PIRATE_CORE_REPO?.trim(),
    resolve(repoRoot, "core"),
    resolve(repoRoot, "../core"),
    resolve(apiRoot, "../../core"),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of new Set(candidates)) {
    if (candidateHasCoreMigrations(candidate)) {
      return candidate
    }
  }

  throw new Error(
    "could not locate canonical Pirate core migrations; set PIRATE_CORE_REPO to a core checkout",
  )
}

function listSqlFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function syncFixturesFromCore(coreMigrationsDir: string): void {
  mkdirSync(fixtureMigrationsDir, { recursive: true })
  for (const file of listSqlFiles(fixtureMigrationsDir)) {
    rmSync(resolve(fixtureMigrationsDir, file))
  }
  for (const file of listSqlFiles(coreMigrationsDir)) {
    copyFileSync(resolve(coreMigrationsDir, file), resolve(fixtureMigrationsDir, file))
  }
}

function main(): void {
  const coreRoot = resolveCanonicalCoreRoot()
  const coreMigrationsDir = resolve(coreRoot, "db/control-plane/migrations")
  const shouldWrite = process.argv.includes("--write")

  if (shouldWrite) {
    syncFixturesFromCore(coreMigrationsDir)
  }

  const coreFiles = listSqlFiles(coreMigrationsDir)
  const fixtureFiles = listSqlFiles(fixtureMigrationsDir)
  const coreSet = new Set(coreFiles)
  const fixtureSet = new Set(fixtureFiles)
  const problems: string[] = []

  for (const file of coreFiles) {
    if (!fixtureSet.has(file)) {
      problems.push(`missing fixture migration: ${file}`)
    }
  }

  for (const file of fixtureFiles) {
    if (!coreSet.has(file)) {
      problems.push(`fixture migration not present in core: ${file}`)
    }
  }

  for (const file of coreFiles) {
    if (!fixtureSet.has(file)) {
      continue
    }
    const coreHash = sha256(resolve(coreMigrationsDir, file))
    const fixtureHash = sha256(resolve(fixtureMigrationsDir, file))
    if (coreHash !== fixtureHash) {
      problems.push(`fixture migration differs from core: ${file}`)
    }
  }

  if (problems.length > 0) {
    console.error("Control-plane fixture migrations are out of sync with core:")
    for (const problem of problems) {
      console.error(`- ${problem}`)
    }
    process.exit(1)
  }

  const verb = shouldWrite ? "Synced" : "Checked"
  console.log(`${verb} control-plane fixture migrations against core (${coreFiles.length} files).`)
}

main()
