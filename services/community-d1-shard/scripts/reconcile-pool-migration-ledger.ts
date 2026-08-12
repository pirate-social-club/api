#!/usr/bin/env bun

import { resolve } from "node:path"
import { readFile } from "node:fs/promises"

export const MIGRATION_0001 = "0001_d1_pool.sql"
export const MIGRATION_0002 = "0002_d1_pool_allocation_attribution.sql"
export const MIGRATION_0003 = "0003_d1_pool_schema_attestations.sql"

type Row = Record<string, unknown>

export type PoolSchemaSnapshot = {
  columns: Row[]
  indexes: Row[]
  objects: Row[]
  ledger: Row[]
}

const expectedColumns = [
  ["binding_name", "TEXT", 0, null, 1],
  ["community_id", "TEXT", 0, null, 0],
  ["allocated_at", "TEXT", 0, null, 0],
  ["last_loaded_at", "TEXT", 0, null, 0],
  ["last_error", "TEXT", 0, null, 0],
  ["released_at", "TEXT", 0, null, 0],
  ["version", "INTEGER", 1, "0", 0],
  ["allocation_source", "TEXT", 0, null, 0],
  ["allocation_run_id", "TEXT", 0, null, 0],
] as const

function normalizeSql(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase()
}

function fail(message: string): never {
  throw new Error(`pool_migration_ledger_repair_refused: ${message}`)
}

function rowsForIndex(snapshot: PoolSchemaSnapshot, name: string): Row[] {
  return snapshot.indexes
    .filter((row) => row.index_name === name)
    .sort((a, b) => Number(a.seqno) - Number(b.seqno))
}

export function verifyPhysicalPre0003(snapshot: PoolSchemaSnapshot): void {
  if (snapshot.columns.length !== expectedColumns.length) {
    fail(`d1_pool column count ${snapshot.columns.length} != ${expectedColumns.length}`)
  }
  expectedColumns.forEach(([name, type, notnull, defaultValue, pk], index) => {
    const row = snapshot.columns[index]
    const actual = [
      String(row?.name ?? ""),
      String(row?.type ?? "").toUpperCase(),
      Number(row?.notnull),
      row?.dflt_value === null ? null : String(row?.dflt_value ?? ""),
      Number(row?.pk),
    ]
    const expected = [name, type, notnull, defaultValue, pk]
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`d1_pool column ${index} mismatch: ${JSON.stringify({ expected, actual })}`)
    }
  })

  const freeRows = rowsForIndex(snapshot, "idx_d1_pool_free")
  if (
    freeRows.length !== 2
    || freeRows.some((row) => Number(row.unique) !== 0 || String(row.origin) !== "c" || Number(row.partial) !== 0)
    || freeRows.map((row) => row.column_name).join(",") !== "community_id,released_at"
  ) fail("idx_d1_pool_free definition mismatch")

  const attributionRows = rowsForIndex(snapshot, "idx_d1_pool_allocation_source")
  if (
    attributionRows.length !== 2
    || attributionRows.some((row) => Number(row.unique) !== 0 || String(row.origin) !== "c" || Number(row.partial) !== 1)
    || attributionRows.map((row) => row.column_name).join(",") !== "allocation_source,allocated_at"
  ) fail("idx_d1_pool_allocation_source structure mismatch")

  const uniqueCommunityIndexes = new Set(
    snapshot.indexes
      .filter((row) => Number(row.unique) === 1 && String(row.origin) === "u" && row.column_name === "community_id")
      .map((row) => String(row.index_name)),
  )
  if (uniqueCommunityIndexes.size !== 1) fail("community_id UNIQUE auto-index missing or ambiguous")

  const byName = new Map(snapshot.objects.map((row) => [String(row.name), row]))
  const pool = byName.get("d1_pool")
  if (pool?.type !== "table") fail("d1_pool table missing")
  const freeSql = normalizeSql(byName.get("idx_d1_pool_free")?.sql)
  if (!/^create index (if not exists )?idx_d1_pool_free on d1_pool\s*\(community_id,\s*released_at\)$/u.test(freeSql)) {
    fail("idx_d1_pool_free sqlite_master.sql mismatch")
  }
  const attributionSql = normalizeSql(byName.get("idx_d1_pool_allocation_source")?.sql)
  if (!/^create index (if not exists )?idx_d1_pool_allocation_source on d1_pool\s*\(allocation_source,\s*allocated_at\) where allocation_source is not null$/u.test(attributionSql)) {
    fail("idx_d1_pool_allocation_source sqlite_master.sql mismatch")
  }
  if (byName.has("d1_pool_schema_attestations") || byName.has("idx_d1_pool_schema_attestations_policy")) {
    fail("0003 artifacts already exist; ordinary repair state expected them absent")
  }

}

export function verifyRepairableSnapshot(snapshot: PoolSchemaSnapshot): void {
  verifyPhysicalPre0003(snapshot)
  const names = snapshot.ledger.map((row) => String(row.name ?? ""))
  if (JSON.stringify(names) !== JSON.stringify([MIGRATION_0001])) {
    fail(`ledger must contain exactly ${MIGRATION_0001}; observed ${JSON.stringify(names)}`)
  }
}

type Environment = "staging" | "production"

function parseArgs(argv: string[]): { environment: Environment; apply: boolean; bootstrapPreimage: boolean; verifyComplete: boolean; evidenceOutput?: string; expectedPreimage?: string } {
  const option = (name: string) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const environment = option("--environment")
  if (environment !== "staging" && environment !== "production") {
    fail("--environment must be staging or production")
  }
  return {
    environment,
    apply: argv.includes("--apply"),
    bootstrapPreimage: argv.includes("--bootstrap-preimage"),
    verifyComplete: argv.includes("--verify-complete"),
    evidenceOutput: option("--evidence-output"),
    expectedPreimage: option("--expected-preimage"),
  }
}

async function verifyCompleteSnapshot(snapshot: PoolSchemaSnapshot): Promise<void> {
  const without0003: PoolSchemaSnapshot = {
    ...snapshot,
    objects: snapshot.objects.filter((row) => !["d1_pool_schema_attestations", "idx_d1_pool_schema_attestations_policy"].includes(String(row.name))),
  }
  verifyPhysicalPre0003(without0003)
  const names = snapshot.ledger.map((row) => String(row.name ?? ""))
  if (JSON.stringify(names) !== JSON.stringify([MIGRATION_0001, MIGRATION_0002, MIGRATION_0003])) {
    fail(`complete ledger mismatch: ${JSON.stringify(names)}`)
  }
  const migration = await readFile(resolve(import.meta.dir, "../migrations", MIGRATION_0003), "utf8")
  const tableStart = migration.indexOf("CREATE TABLE d1_pool_schema_attestations")
  const indexStart = migration.indexOf("CREATE INDEX idx_d1_pool_schema_attestations_policy")
  if (tableStart < 0 || indexStart < 0) fail("could not parse checked-in 0003 migration")
  const expectedTableSql = normalizeSql(migration.slice(tableStart, indexStart).replace(/;\s*$/u, ""))
  const expectedIndexSql = normalizeSql(migration.slice(indexStart).replace(/;\s*$/u, ""))
  const byName = new Map(snapshot.objects.map((row) => [String(row.name), row]))
  if (normalizeSql(byName.get("d1_pool_schema_attestations")?.sql) !== expectedTableSql) {
    fail("d1_pool_schema_attestations sqlite_master.sql mismatch")
  }
  if (normalizeSql(byName.get("idx_d1_pool_schema_attestations_policy")?.sql) !== expectedIndexSql) {
    fail("idx_d1_pool_schema_attestations_policy sqlite_master.sql mismatch")
  }
}

function physicalState(snapshot: PoolSchemaSnapshot): Omit<PoolSchemaSnapshot, "ledger"> {
  return {
    columns: snapshot.columns,
    indexes: snapshot.indexes,
    objects: snapshot.objects.filter((row) => row.name !== "d1_migrations"),
  }
}

async function wranglerQuery(environment: Environment, sql: string): Promise<Row[]> {
  const args = ["bunx", "wrangler@4.100.0", "d1", "execute", "D1_POOL", "--remote", "--json", "--command", sql]
  if (environment === "production") args.push("--env", "production")
  const child = Bun.spawn(args, { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) fail(`Wrangler query failed (${exitCode}): ${stderr.trim() || stdout.trim()}`)
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    fail(`Wrangler returned malformed JSON: ${stdout.slice(0, 500)}`)
  }
  if (!Array.isArray(payload) || payload.length !== 1) fail("Wrangler response must contain exactly one result")
  const result = payload[0] as { success?: unknown; results?: unknown }
  if (result.success !== true || !Array.isArray(result.results)) fail("Wrangler result did not report success with a results array")
  return result.results as Row[]
}

async function captureSnapshot(environment: Environment, allowMissingLedger = false): Promise<PoolSchemaSnapshot> {
  const objects = await wranglerQuery(environment, `
    SELECT type, name, sql FROM sqlite_master
    WHERE name IN (
      'd1_pool', 'idx_d1_pool_free', 'idx_d1_pool_allocation_source',
      'd1_pool_schema_attestations', 'idx_d1_pool_schema_attestations_policy', 'd1_migrations'
    ) ORDER BY type, name
  `)
  const hasLedger = objects.some((row) => row.name === "d1_migrations" && row.type === "table")
  if (!hasLedger && !allowMissingLedger) {
    fail("d1_migrations is absent; bootstrap with pinned Wrangler before using this repair")
  }
  const [columns, indexes, ledger] = await Promise.all([
    wranglerQuery(environment, "PRAGMA table_info('d1_pool')"),
    wranglerQuery(environment, `
      SELECT il.name AS index_name, il."unique", il.origin, il.partial,
             ii.seqno, ii.name AS column_name
      FROM pragma_index_list('d1_pool') AS il
      JOIN pragma_index_info(il.name) AS ii
      ORDER BY il.name, ii.seqno
    `),
    hasLedger ? wranglerQuery(environment, "SELECT id, name, applied_at FROM d1_migrations ORDER BY id") : Promise.resolve([]),
  ])
  return { columns, indexes, objects, ledger }
}

async function writeEvidence(path: string | undefined, evidence: unknown): Promise<void> {
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`
  if (path) await Bun.write(resolve(path), encoded)
  console.log(encoded)
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2))
  if ([args.apply, args.bootstrapPreimage, args.verifyComplete].filter(Boolean).length > 1) {
    fail("--apply, --bootstrap-preimage, and --verify-complete are mutually exclusive")
  }
  const before = await captureSnapshot(args.environment, args.bootstrapPreimage)
  if (args.verifyComplete) {
    await verifyCompleteSnapshot(before)
    await writeEvidence(args.evidenceOutput, {
      format_version: 1,
      environment: args.environment,
      observed_at: new Date().toISOString(),
      mode: "verify_complete",
      before,
    })
    return
  }
  if (args.bootstrapPreimage) {
    verifyPhysicalPre0003(before)
    if (before.objects.some((row) => row.name === "d1_migrations") || before.ledger.length !== 0) {
      fail("bootstrap pre-image requires d1_migrations to be absent")
    }
    await writeEvidence(args.evidenceOutput, {
      format_version: 1,
      environment: args.environment,
      observed_at: new Date().toISOString(),
      mode: "bootstrap_preimage",
      before,
    })
    return
  }
  verifyRepairableSnapshot(before)
  if (args.expectedPreimage) {
    const encoded = await readFile(resolve(args.expectedPreimage), "utf8")
    const expectedEvidence = JSON.parse(encoded) as { before?: PoolSchemaSnapshot }
    if (!expectedEvidence.before) fail("expected pre-image artifact has no before snapshot")
    if (JSON.stringify(physicalState(expectedEvidence.before)) !== JSON.stringify(physicalState(before))) {
      fail("current physical schema differs from the captured bootstrap pre-image")
    }
  }
  const evidence = {
    format_version: 1,
    environment: args.environment,
    observed_at: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    proposed_action: `insert ${MIGRATION_0002} into d1_migrations`,
    before,
  }
  if (!args.apply) {
    await writeEvidence(args.evidenceOutput, evidence)
    return
  }
  await wranglerQuery(args.environment, `INSERT INTO d1_migrations(name) VALUES ('${MIGRATION_0002}') RETURNING id, name, applied_at`)
  const after = await captureSnapshot(args.environment)
  const names = after.ledger.map((row) => String(row.name ?? ""))
  if (JSON.stringify(names) !== JSON.stringify([MIGRATION_0001, MIGRATION_0002])) {
    fail(`post-write ledger mismatch: ${JSON.stringify(names)}`)
  }
  if (JSON.stringify({ ...before, ledger: [] }) !== JSON.stringify({ ...after, ledger: [] })) {
    fail("physical schema changed during ledger repair")
  }
  await writeEvidence(args.evidenceOutput, { ...evidence, completed_at: new Date().toISOString(), after })
}

if (import.meta.main) await main()
