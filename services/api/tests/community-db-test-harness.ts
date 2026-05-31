import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import type { Client } from "../src/lib/sql-client"

type CommunityMigrationFixture = {
  name: string
  path: string
  checksum: string
  sql: string
}

function communityMigrationFixtureDir(): string {
  return resolve(fileURLToPath(new URL("..", import.meta.url)), "test-fixtures/db/community-template/migrations")
}

async function listCommunityMigrationFixtures(): Promise<CommunityMigrationFixture[]> {
  const fixtureDir = communityMigrationFixtureDir()
  const entries = (await readdir(fixtureDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
  const fixtures: CommunityMigrationFixture[] = []
  for (const name of entries) {
    const path = join(fixtureDir, name)
    const sql = await readFile(path, "utf8")
    fixtures.push({
      name,
      path,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    })
  }
  return fixtures
}

export async function getNMinusOneCommunityMigrationName(): Promise<string> {
  const migrations = await listCommunityMigrationFixtures()
  if (migrations.length < 2) {
    throw new Error("At least two community migrations are required for N-1 schema tests")
  }
  return migrations[migrations.length - 2].name
}

export async function getMigrationBeforeCommunityMigration(migrationName: string): Promise<string> {
  const migrations = await listCommunityMigrationFixtures()
  const index = migrations.findIndex((migration) => migration.name === migrationName)
  if (index <= 0) {
    throw new Error(`No previous community migration found for ${migrationName}`)
  }
  return migrations[index - 1].name
}

export async function createCommunityDbThroughMigration(client: Client, throughMigrationName: string): Promise<void> {
  const migrations = await listCommunityMigrationFixtures()
  const throughIndex = migrations.findIndex((migration) => migration.name === throughMigrationName)
  if (throughIndex < 0) {
    throw new Error(`Unknown community migration fixture: ${throughMigrationName}`)
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      migration_label TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  for (const migration of migrations.slice(0, throughIndex + 1)) {
    const statements = splitSqlStatements(migration.sql).flatMap(toSqliteCompatibleStatements)
    for (const statement of statements) {
      await client.execute(statement)
    }
    await client.execute({
      sql: `
        INSERT INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [migration.name, migration.checksum],
    })
  }
}
