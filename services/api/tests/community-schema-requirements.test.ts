import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SERVICE_ROOT = fileURLToPath(new URL("..", import.meta.url))
const REQUIREMENTS_PATH = fileURLToPath(new URL("../community-schema-requirements.json", import.meta.url))
const MIGRATIONS_ROOT = fileURLToPath(new URL("../test-fixtures/db/community-template/migrations/", import.meta.url))
const RUNTIME_ROOT = fileURLToPath(new URL("../src/", import.meta.url))

type RequirementsManifest = {
  unconditional: string[]
  features: Record<string, { migrations: string[] }>
  transitional: Record<string, {
    rationale?: unknown
    promotion_condition?: unknown
    capability_guard?: unknown
    runtime_references?: unknown
    compatibility_tests?: unknown
  }>
  deferred: Record<string, { rationale?: unknown }>
}

function deferredSchemaIdentifiers(sql: string): string[] {
  const identifiers = new Set<string>()
  const patterns = [
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]|\[)?([a-zA-Z_][a-zA-Z0-9_]*)/giu,
    /\bALTER\s+TABLE\s+(?:["`]|\[)?[a-zA-Z_][a-zA-Z0-9_]*(?:["`]|\])?\s+ADD\s+(?:COLUMN\s+)?(?:["`]|\[)?([a-zA-Z_][a-zA-Z0-9_]*)/giu,
  ]
  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) identifiers.add(match[1]!)
  }
  return [...identifiers].sort()
}

async function runtimeSourceFiles(directory = RUNTIME_ROOT): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "generated") files.push(...await runtimeSourceFiles(path))
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function runtimeReferences(
  identifier: string,
  sources: Array<{ path: string; source: string }>,
): string[] {
  const token = new RegExp(`\\b${identifier}\\b`, "u")
  return sources
    .filter(({ source }) => token.test(source))
    .map(({ path }) => relative(SERVICE_ROOT, path))
}

describe("community schema requirements manifest", () => {
  test("classifies every template migration in the manifest era", async () => {
    const manifest = JSON.parse(await readFile(REQUIREMENTS_PATH, "utf8")) as RequirementsManifest
    const classified = new Set([
      ...manifest.unconditional,
      ...Object.values(manifest.features).flatMap((policy) => policy.migrations),
      ...Object.keys(manifest.transitional),
      ...Object.keys(manifest.deferred),
    ])
    const classificationFloor = Math.min(
      ...[...classified].map((migration) => Number.parseInt(migration, 10)),
    )
    const migrations = (await readdir(MIGRATIONS_ROOT))
      .filter((migration) => /^\d+_.+\.sql$/u.test(migration))
      .filter((migration) => Number.parseInt(migration, 10) >= classificationFloor)

    expect(
      migrations.filter((migration) => !classified.has(migration)),
      `Every community-template migration from ${classificationFloor} onward must be unconditional, feature-gated, or deferred with rationale`,
    ).toEqual([])
  })

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
    for (const [migration, policy] of Object.entries(manifest.transitional)) {
      expect(
        typeof policy.rationale === "string" && policy.rationale.trim().length > 0,
        `${migration} is transitional without a rationale`,
      ).toBe(true)
      expect(
        typeof policy.promotion_condition === "string" && policy.promotion_condition.trim().length > 0,
        `${migration} is transitional without a promotion condition`,
      ).toBe(true)
      claim(migration, "transitional")
    }
    for (const [migration, policy] of Object.entries(manifest.deferred)) {
      expect(
        typeof policy.rationale === "string" && policy.rationale.trim().length > 0,
        `${migration} is deferred without a rationale`,
      ).toBe(true)
      claim(migration, "deferred")
    }

    expect(owners.size).toBeGreaterThan(0)
    for (const migration of owners.keys()) {
      const migrationPath = `${MIGRATIONS_ROOT}${migration}`
      expect((await stat(migrationPath)).isFile(), `${migration} is absent beneath ${SERVICE_ROOT}`).toBe(true)
    }
  })

  test("deferred migrations are not referenced by runtime source", async () => {
    const manifest = JSON.parse(await readFile(REQUIREMENTS_PATH, "utf8")) as RequirementsManifest
    const sources = await Promise.all(
      (await runtimeSourceFiles()).map(async (path) => ({ path, source: await readFile(path, "utf8") })),
    )

    for (const migration of Object.keys(manifest.deferred)) {
      const sql = await readFile(`${MIGRATIONS_ROOT}${migration}`, "utf8")
      const identifiers = deferredSchemaIdentifiers(sql)
      expect(identifiers.length, `${migration} exposes no mechanically checkable table or added-column identifiers`).toBeGreaterThan(0)

      for (const identifier of identifiers) {
        const references = runtimeReferences(identifier, sources)
        expect(
          references,
          `${migration} is deferred but runtime source references ${identifier}: ${references.join(", ")}`,
        ).toEqual([])
      }
    }
  })

  test("transitional migrations have exact audited runtime references and compatibility coverage", async () => {
    const manifest = JSON.parse(await readFile(REQUIREMENTS_PATH, "utf8")) as RequirementsManifest
    const sources = await Promise.all(
      (await runtimeSourceFiles()).map(async (path) => ({ path, source: await readFile(path, "utf8") })),
    )

    for (const [migration, policy] of Object.entries(manifest.transitional)) {
      expect(typeof policy.capability_guard, `${migration} has no capability guard`).toBe("string")
      expect(Array.isArray(policy.runtime_references), `${migration} has no runtime reference allowlist`).toBe(true)
      expect(Array.isArray(policy.compatibility_tests), `${migration} has no compatibility tests`).toBe(true)

      const sql = await readFile(`${MIGRATIONS_ROOT}${migration}`, "utf8")
      const identifiers = deferredSchemaIdentifiers(sql)
      expect(identifiers.length, `${migration} exposes no mechanically checkable identifiers`).toBeGreaterThan(0)

      const actualReferences = [...new Set(
        identifiers.flatMap((identifier) => runtimeReferences(identifier, sources)),
      )].sort()
      const allowedReferences = [...policy.runtime_references as string[]].sort()
      expect(
        actualReferences,
        `${migration} runtime references differ from its audited allowlist`,
      ).toEqual(allowedReferences)

      const guard = policy.capability_guard as string
      expect(
        sources.some(({ path, source }) => allowedReferences.includes(relative(SERVICE_ROOT, path))
          && new RegExp(`\\b${guard}\\b`, "u").test(source)),
        `${migration} capability guard ${guard} is absent from its allowed runtime path`,
      ).toBe(true)

      for (const testPath of policy.compatibility_tests as string[]) {
        expect(testPath.endsWith(".test.ts"), `${migration} compatibility coverage is not a test`).toBe(true)
        const source = await readFile(resolve(SERVICE_ROOT, testPath), "utf8")
        expect(source).toContain(`${guard}: true`)
        expect(source).toContain(`${guard}: false`)
        for (const identifier of identifiers) expect(source).toContain(identifier)
      }
    }
  })

  test("extracts new tables and added columns from deferred migration DDL", () => {
    expect(deferredSchemaIdentifiers(`
      CREATE TABLE IF NOT EXISTS community_handle_label_reservations (id TEXT PRIMARY KEY);
      ALTER TABLE namespace_bindings ADD COLUMN namespace_role TEXT;
    `)).toEqual(["community_handle_label_reservations", "namespace_role"])
  })

  test("detects the runtime references behind the 1133 and 1136 false deferrals", async () => {
    const sources = await Promise.all(
      (await runtimeSourceFiles()).map(async (path) => ({ path, source: await readFile(path, "utf8") })),
    )
    expect(runtimeReferences("namespace_role", sources).length).toBeGreaterThan(0)
    expect(runtimeReferences("community_handle_label_reservations", sources).length).toBeGreaterThan(0)
  })
})
