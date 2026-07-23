import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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
    expires_after?: unknown
    capability_guard?: unknown
    runtime_reference_counts?: unknown
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

function runtimeReferenceCounts(
  identifiers: string[],
  sources: Array<{ path: string; source: string }>,
): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {}
  for (const { path, source } of sources) {
    const relativePath = relative(SERVICE_ROOT, path)
    for (const identifier of identifiers) {
      const matches = source.match(new RegExp(`\\b${identifier}\\b`, "gu"))?.length ?? 0
      if (matches === 0) continue
      counts[relativePath] ??= {}
      counts[relativePath]![identifier] = matches
    }
  }
  return counts
}

function transitionalDdlViolations(sql: string): string[] {
  const statements = sql
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/--[^\n]*/gu, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)

  const violations: string[] = []
  for (const statement of statements) {
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/iu.test(statement)) continue
    if (/^ALTER\s+TABLE\b[\s\S]*\bADD\s+(?:COLUMN\s+)?\b/iu.test(statement)) {
      if (/\bNOT\s+NULL\b/iu.test(statement) && !/\bDEFAULT\b/iu.test(statement)) {
        violations.push(`NOT NULL column has no DEFAULT: ${statement}`)
      }
      continue
    }
    violations.push(`non-additive statement: ${statement}`)
  }
  return violations
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
      expect(
        typeof policy.expires_after === "string" && Number.isFinite(Date.parse(policy.expires_after)),
        `${migration} is transitional without a valid expiry`,
      ).toBe(true)
      expect(
        Date.now(),
        `${migration} transitional policy expired at ${String(policy.expires_after)}; promote or explicitly renew it`,
      ).toBeLessThanOrEqual(Date.parse(policy.expires_after as string))
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
      expect(
        typeof policy.runtime_reference_counts === "object" && policy.runtime_reference_counts !== null,
        `${migration} has no exact runtime reference-count policy`,
      ).toBe(true)
      expect(Array.isArray(policy.compatibility_tests), `${migration} has no compatibility tests`).toBe(true)

      const sql = await readFile(`${MIGRATIONS_ROOT}${migration}`, "utf8")
      const identifiers = deferredSchemaIdentifiers(sql)
      expect(identifiers.length, `${migration} exposes no mechanically checkable identifiers`).toBeGreaterThan(0)
      expect(
        transitionalDdlViolations(sql),
        `${migration} is transitional but contains non-additive or unsafe DDL`,
      ).toEqual([])

      const actualReferences = runtimeReferenceCounts(identifiers, sources)
      const allowedReferences = policy.runtime_reference_counts as Record<string, Record<string, number>>
      expect(
        actualReferences,
        `${migration} runtime identifier counts differ from its audited policy`,
      ).toEqual(allowedReferences)

      const guard = policy.capability_guard as string
      expect(
        sources.some(({ path, source }) => Object.hasOwn(allowedReferences, relative(SERVICE_ROOT, path))
          && new RegExp(`\\b${guard}\\b`, "u").test(source)),
        `${migration} capability guard ${guard} is absent from its allowed runtime path`,
      ).toBe(true)

      for (const fixture of policy.compatibility_tests as Array<{ path: string; sha256: string }>) {
        const { path: testPath, sha256 } = fixture
        expect(testPath.endsWith(".test.ts"), `${migration} compatibility coverage is not a test`).toBe(true)
        const source = await readFile(resolve(SERVICE_ROOT, testPath), "utf8")
        expect(
          createHash("sha256").update(source).digest("hex"),
          `${migration} compatibility test changed without an explicit policy hash review`,
        ).toBe(sha256)
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

  test("transitional DDL permits only additive, backward-compatible statements", () => {
    expect(transitionalDdlViolations(`
      CREATE TABLE IF NOT EXISTS safe_table (id TEXT PRIMARY KEY);
      ALTER TABLE posts ADD COLUMN nullable_value TEXT;
      ALTER TABLE posts ADD COLUMN required_value INTEGER NOT NULL DEFAULT 0;
    `)).toEqual([])
    expect(transitionalDdlViolations("DROP TABLE posts;")).toHaveLength(1)
    expect(transitionalDdlViolations("ALTER TABLE posts RENAME COLUMN old TO new;")).toHaveLength(1)
    expect(transitionalDdlViolations("ALTER TABLE posts ADD COLUMN unsafe INTEGER NOT NULL;")).toHaveLength(1)
  })

  test("detects the runtime references behind the 1133 and 1136 false deferrals", async () => {
    const sources = await Promise.all(
      (await runtimeSourceFiles()).map(async (path) => ({ path, source: await readFile(path, "utf8") })),
    )
    expect(runtimeReferences("namespace_role", sources).length).toBeGreaterThan(0)
    expect(runtimeReferences("community_handle_label_reservations", sources).length).toBeGreaterThan(0)
  })
})
