import { describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const SERVICE_ROOT = fileURLToPath(new URL("..", import.meta.url))
const REQUIREMENTS_PATH = fileURLToPath(new URL("../community-schema-requirements.json", import.meta.url))
const MIGRATIONS_ROOT = fileURLToPath(new URL("../test-fixtures/db/community-template/migrations/", import.meta.url))

type RequirementsManifest = {
  unconditional: string[]
  features: Record<string, { migrations: string[] }>
  deferred: Record<string, unknown>
}

describe("community schema requirements manifest", () => {
  test("assigns every declared migration to exactly one policy class", async () => {
    const manifest = JSON.parse(await readFile(REQUIREMENTS_PATH, "utf8")) as RequirementsManifest
    const owners = new Map<string, string>()
    const claim = (migration: string, owner: string) => {
      expect(owners.get(migration), `${migration} overlaps ${owners.get(migration)} and ${owner}`).toBeUndefined()
      owners.set(migration, owner)
    }

    for (const migration of manifest.unconditional) claim(migration, "unconditional")
    for (const [feature, policy] of Object.entries(manifest.features)) {
      for (const migration of policy.migrations) claim(migration, `features.${feature}`)
    }
    for (const migration of Object.keys(manifest.deferred)) claim(migration, "deferred")

    expect(owners.size).toBeGreaterThan(0)
    for (const migration of owners.keys()) {
      const migrationPath = `${MIGRATIONS_ROOT}${migration}`
      expect((await stat(migrationPath)).isFile(), `${migration} is absent beneath ${SERVICE_ROOT}`).toBe(true)
    }
  })
})
