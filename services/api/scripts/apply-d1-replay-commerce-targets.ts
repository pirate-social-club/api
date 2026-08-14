#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

type EnvName = "staging" | "prod"
type ClassificationState =
  | "EMPTY"
  | "DONE"
  | "LEDGER_ONLY"
  | "NEEDS"
  | "BLOCKED_ORPHANS"
  | "ERROR"

type Classification = {
  db: string
  state: ClassificationState
  detail: string
  orphans?: Record<string, number>
}

const WRANGLER_VERSION = "wrangler@4.100.0"
const MIGRATION_NAME = "1114_live_room_replay_commerce_targets.sql"
const MIGRATION_LABEL = "community-template"
const MIGRATION_CHECKSUM = "72f709732cfcc33cc746a7f17d693e51bc35b4600998e487c0178f2162160fcf"

const args = process.argv.slice(2)
const env = readArg("--env")
const execute = args.includes("--execute")
const limit = readArg("--limit")
const onlySlot = readArg("--slot")
const onlyDb = readArg("--db")
const excludeDbs = new Set(
  (readArg("--exclude") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
)
const concurrency = Number(readArg("--concurrency") ?? 4)

if (env !== "staging" && env !== "prod") {
  throw new Error("--env must be explicitly set to staging or prod")
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
  throw new Error("--concurrency must be an integer from 1 to 10")
}

function readArg(name: string): string | null {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] ?? null : null
}

function runWrangler(args: string[]): string {
  const proc = Bun.spawnSync(["bunx", WRANGLER_VERSION, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = proc.stdout.toString()
  const stderr = proc.stderr.toString()
  if (!proc.success) {
    throw new Error(stderr.trim() || stdout.trim() || `wrangler exited with code ${proc.exitCode}`)
  }
  return stdout
}

function isTransientWranglerError(error: unknown): boolean {
  const message = String(error)
  return (
    message.includes("fetch failed") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNRESET") ||
    message.includes("D1 DB is overloaded") ||
    message.includes("code: 7429") ||
    message.includes("Too many API requests")
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(value: unknown, length = 220): string {
  return String(value).replace(/\s+/g, " ").trim().slice(0, length)
}

function numberValue(row: Record<string, unknown>, key: string): number {
  return Number(row[key] ?? 0)
}

async function d1(db: string, sql: string): Promise<Array<Record<string, unknown>>> {
  let lastError: unknown
  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const output = runWrangler(["d1", "execute", db, "--remote", "--json", "--command", sql])
      const parsed = JSON.parse(output)
      return parsed?.[0]?.results ?? []
    } catch (error) {
      lastError = error
      if (!isTransientWranglerError(error) || attempt === maxAttempts) break
      await sleep(1500 * attempt)
    }
  }
  throw lastError
}

async function listDbs(envName: EnvName): Promise<string[]> {
  const output = runWrangler(["d1", "list", "--json"])
  const databases = JSON.parse(output) as Array<{ name: string }>
  const pattern =
    envName === "staging"
      ? /^(community-d1-pool-\d{4}-staging|cmty-pilot-staging|cmty-d1-fixture-staging)$/
      : /^community-d1-pool-\d{4}-prod$/
  return databases
    .map((database) => database.name)
    .filter((name) => pattern.test(name))
    .filter((name) => !onlyDb || name === onlyDb)
    .filter((name) => !onlySlot || name.includes(`-${onlySlot}-`))
    .filter((name) => !excludeDbs.has(name))
    .sort()
}

async function hasMigrationLedger(db: string): Promise<boolean> {
  const rows = await d1(
    db,
    `SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations') AS has_ledger`,
  )
  if (numberValue(rows[0] ?? {}, "has_ledger") === 0) return false
  const ledgerRows = await d1(
    db,
    `SELECT COUNT(*) AS n FROM schema_migrations WHERE migration_name='${MIGRATION_NAME}'`,
  )
  return numberValue(ledgerRows[0] ?? {}, "n") > 0
}

function hasReplayTargetCheck(sql: string | null): boolean {
  return Boolean(sql?.includes("replay_asset_id IS NOT NULL"))
}

async function orphanCounts(db: string): Promise<Record<string, number>> {
  const rows = await d1(
    db,
    `
      SELECT
        (SELECT COUNT(*) FROM listings l LEFT JOIN communities c ON c.community_id = l.community_id WHERE c.community_id IS NULL) AS listings_community,
        (SELECT COUNT(*) FROM purchase_quotes q LEFT JOIN communities c ON c.community_id = q.community_id WHERE c.community_id IS NULL) AS quotes_community,
        (SELECT COUNT(*) FROM purchase_quotes q LEFT JOIN listings l ON l.listing_id = q.listing_id WHERE l.listing_id IS NULL) AS quotes_listing,
        (SELECT COUNT(*) FROM purchases p LEFT JOIN communities c ON c.community_id = p.community_id WHERE c.community_id IS NULL) AS purchases_community,
        (SELECT COUNT(*) FROM purchases p LEFT JOIN listings l ON l.listing_id = p.listing_id WHERE l.listing_id IS NULL) AS purchases_listing,
        (SELECT COUNT(*) FROM purchase_allocation_legs pal LEFT JOIN communities c ON c.community_id = pal.community_id WHERE c.community_id IS NULL) AS legs_community,
        (SELECT COUNT(*) FROM purchase_allocation_legs pal LEFT JOIN purchases p ON p.purchase_id = pal.purchase_id WHERE p.purchase_id IS NULL) AS legs_purchase,
        (SELECT COUNT(*) FROM purchase_allocation_legs pal LEFT JOIN purchase_quotes q ON q.quote_id = pal.quote_id WHERE q.quote_id IS NULL) AS legs_quote
    `,
  )
  const row = rows[0] ?? {}
  return {
    listings_community: numberValue(row, "listings_community"),
    quotes_community: numberValue(row, "quotes_community"),
    quotes_listing: numberValue(row, "quotes_listing"),
    purchases_community: numberValue(row, "purchases_community"),
    purchases_listing: numberValue(row, "purchases_listing"),
    legs_community: numberValue(row, "legs_community"),
    legs_purchase: numberValue(row, "legs_purchase"),
    legs_quote: numberValue(row, "legs_quote"),
  }
}

function positiveCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0))
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

async function classify(db: string): Promise<Classification> {
  try {
    const rows = await d1(
      db,
      `
        SELECT
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='listings') AS has_listings,
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='purchase_quotes') AS has_quotes,
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='purchases') AS has_purchases,
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='purchase_allocation_legs') AS has_legs,
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations') AS has_ledger,
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE '%\\_old' ESCAPE '\\') AS old_tables,
          (SELECT COUNT(*) FROM pragma_table_info('listings') WHERE name='replay_asset_id') AS listings_column,
          (SELECT COUNT(*) FROM pragma_table_info('purchase_quotes') WHERE name='replay_asset_id') AS quotes_column,
          (SELECT COUNT(*) FROM pragma_table_info('purchases') WHERE name='replay_asset_id') AS purchases_column,
          (SELECT sql FROM sqlite_master WHERE type='table' AND name='listings') AS listings_sql,
          (SELECT sql FROM sqlite_master WHERE type='table' AND name='purchase_quotes') AS quotes_sql,
          (SELECT sql FROM sqlite_master WHERE type='table' AND name='purchases') AS purchases_sql
      `,
    )
    const row = rows[0] ?? {}
    const oldTables = numberValue(row, "old_tables")
    if (oldTables > 0) {
      return { db, state: "ERROR", detail: `${oldTables} stray _old table(s) present; interrupted rebuild suspected` }
    }
    const tablesPresent = [
      numberValue(row, "has_listings") > 0,
      numberValue(row, "has_quotes") > 0,
      numberValue(row, "has_purchases") > 0,
      numberValue(row, "has_legs") > 0,
    ]
    const presentCount = tablesPresent.filter(Boolean).length
    if (presentCount === 0) {
      if (numberValue(row, "has_ledger") > 0) {
        const ledgerRows = await d1(
          db,
          `SELECT COUNT(*) AS n FROM schema_migrations WHERE migration_name='${MIGRATION_NAME}'`,
        )
        if (numberValue(ledgerRows[0] ?? {}, "n") > 0) {
          return { db, state: "ERROR", detail: "1114 ledgered but commerce tables missing" }
        }
        return { db, state: "EMPTY", detail: "no commerce tables; ledger table present, 1114 not ledgered" }
      }
      return { db, state: "EMPTY", detail: "no commerce tables; no schema_migrations table" }
    }
    if (presentCount < 4) {
      return {
        db,
        state: "ERROR",
        detail: `partial commerce table subset: listings=${tablesPresent[0]} quotes=${tablesPresent[1]} purchases=${tablesPresent[2]} legs=${tablesPresent[3]}`,
      }
    }

    let ledgered = false
    if (numberValue(row, "has_ledger") > 0) {
      const ledgerRows = await d1(
        db,
        `SELECT COUNT(*) AS n FROM schema_migrations WHERE migration_name='${MIGRATION_NAME}'`,
      )
      ledgered = numberValue(ledgerRows[0] ?? {}, "n") > 0
    }

    const listingsColumn = numberValue(row, "listings_column") > 0
    const quotesColumn = numberValue(row, "quotes_column") > 0
    const purchasesColumn = numberValue(row, "purchases_column") > 0
    const listingsSql = typeof row.listings_sql === "string" ? row.listings_sql : null
    const quotesSql = typeof row.quotes_sql === "string" ? row.quotes_sql : null
    const purchasesSql = typeof row.purchases_sql === "string" ? row.purchases_sql : null
    const columns = [listingsColumn, quotesColumn, purchasesColumn]
    const checks = [
      hasReplayTargetCheck(listingsSql),
      hasReplayTargetCheck(quotesSql),
      hasReplayTargetCheck(purchasesSql),
    ]
    const allColumns = columns.every(Boolean)
    const noColumns = columns.every((value) => !value)
    const allChecks = checks.every(Boolean)

    if (allColumns && allChecks) {
      return ledgered
        ? { db, state: "DONE", detail: "columns/checks + 1114 ledger present" }
        : { db, state: "LEDGER_ONLY", detail: "columns/checks present; 1114 ledger missing" }
    }
    if (!allColumns && !noColumns) {
      return {
        db,
        state: "ERROR",
        detail: `partial replay_asset_id columns: listings=${listingsColumn} quotes=${quotesColumn} purchases=${purchasesColumn}`,
      }
    }
    if (allColumns && !allChecks) {
      return {
        db,
        state: "ERROR",
        detail: `replay_asset_id columns present but 3-way CHECK missing: listings=${checks[0]} quotes=${checks[1]} purchases=${checks[2]}`,
      }
    }
    if (ledgered && noColumns) {
      return { db, state: "ERROR", detail: "1114 ledger present but replay_asset_id columns missing" }
    }

    const counts = await orphanCounts(db)
    const blockers = positiveCounts(counts)
    if (Object.keys(blockers).length > 0) {
      return {
        db,
        state: "BLOCKED_ORPHANS",
        detail: `FK orphan preflight failed: ${JSON.stringify(blockers)}`,
        orphans: blockers,
      }
    }
    return { db, state: "NEEDS", detail: "pre-1114 commerce schema; orphan preflight clean" }
  } catch (error) {
    return { db, state: "ERROR", detail: truncate(error) }
  }
}

async function writeD1MigrationFile(): Promise<string> {
  const workspaceRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../../..")
  const coreRoot = process.env.PIRATE_CORE_REPO
    ? resolve(process.env.PIRATE_CORE_REPO)
    : resolve(workspaceRoot, "core")
  const migrationPath = resolve(coreRoot, "db/community-template/migrations", MIGRATION_NAME)
  if (!existsSync(migrationPath)) {
    throw new Error(`canonical migration not found: ${migrationPath}`)
  }
  const canonicalSql = await readFile(migrationPath, "utf8")
  const actualChecksum = createHash("sha256").update(canonicalSql).digest("hex")
  if (actualChecksum !== MIGRATION_CHECKSUM) {
    throw new Error(
      `canonical migration checksum mismatch: expected ${MIGRATION_CHECKSUM}, got ${actualChecksum} (${migrationPath})`,
    )
  }
  let d1Sql = canonicalSql
    .replace(/^PRAGMA legacy_alter_table = ON;\n?/m, "")
    .replace(/^PRAGMA legacy_alter_table = OFF;\n?/m, "")

  const ledgerSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  migration_label TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
VALUES ('${MIGRATION_NAME}', '${MIGRATION_LABEL}', '${MIGRATION_CHECKSUM}');
`
  if (d1Sql.includes("PRAGMA foreign_keys = ON;")) {
    d1Sql = d1Sql.replace("PRAGMA foreign_keys = ON;", `${ledgerSql}\nPRAGMA foreign_keys = ON;`)
  } else {
    d1Sql = `${d1Sql.trim()}\n${ledgerSql}\n`
  }

  const outputPath = resolve("/tmp", `pirate-${MIGRATION_NAME.replace(".sql", "-d1.sql")}`)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, d1Sql)
  return outputPath
}

async function ledgerOnly(db: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await d1(
      db,
      `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          migration_name TEXT PRIMARY KEY,
          migration_label TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES ('${MIGRATION_NAME}', '${MIGRATION_LABEL}', '${MIGRATION_CHECKSUM}')
      `,
    )
    const ledgered = await hasMigrationLedger(db)
    return ledgered ? { ok: true, detail: "ledger recorded" } : { ok: false, detail: "ledger missing after write" }
  } catch (error) {
    return { ok: false, detail: truncate(error) }
  }
}

async function commerceTableCounts(db: string): Promise<Record<string, number>> {
  const rows = await d1(
    db,
    `
      SELECT
        (SELECT COUNT(*) FROM listings) AS listings,
        (SELECT COUNT(*) FROM purchase_quotes) AS purchase_quotes,
        (SELECT COUNT(*) FROM purchases) AS purchases,
        (SELECT COUNT(*) FROM purchase_allocation_legs) AS purchase_allocation_legs
    `,
  )
  const row = rows[0] ?? {}
  return {
    listings: numberValue(row, "listings"),
    purchase_quotes: numberValue(row, "purchase_quotes"),
    purchases: numberValue(row, "purchases"),
    purchase_allocation_legs: numberValue(row, "purchase_allocation_legs"),
  }
}

function sameCounts(left: Record<string, number>, right: Record<string, number>): boolean {
  return Object.keys(left).every((key) => left[key] === right[key])
}

// 1114 is NOT idempotent: a re-run RENAMEs the already-migrated table and copies
// replay_asset_id as NULL. D1 may have committed the --file batch server-side even
// when the client sees a transient error, so never blindly retry --file. On a
// transient failure, reclassify the shard: DONE means the apply landed (caller
// verifies); NEEDS means it did not commit and is safe to retry; anything else is
// an unexpected mid-state that must fail loudly for manual inspection.
async function applyMigrationFile(db: string, migrationFile: string): Promise<void> {
  const maxAttempts = 6
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      runWrangler(["d1", "execute", db, "--remote", "--file", migrationFile, "--yes"])
      return
    } catch (error) {
      lastError = error
      if (!isTransientWranglerError(error)) throw error
      const recheck = await classify(db)
      if (recheck.state === "DONE") return
      if (recheck.state !== "NEEDS") {
        throw new Error(
          `unsafe to retry --file after transient error: post-error state=${recheck.state} (${recheck.detail})`,
        )
      }
      if (attempt === maxAttempts) break
      await sleep(1500 * attempt)
    }
  }
  throw lastError
}

async function applyAndVerify(db: string, migrationFile: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const beforeCounts = await commerceTableCounts(db)
    await applyMigrationFile(db, migrationFile)
    const afterCounts = await commerceTableCounts(db)
    const rows = await d1(
      db,
      `
        SELECT
          (SELECT COUNT(*) FROM pragma_table_info('listings') WHERE name='replay_asset_id') AS listings_column,
          (SELECT COUNT(*) FROM pragma_table_info('purchase_quotes') WHERE name='replay_asset_id') AS quotes_column,
          (SELECT COUNT(*) FROM pragma_table_info('purchases') WHERE name='replay_asset_id') AS purchases_column,
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE '%\\_old' ESCAPE '\\') AS old_tables,
          (SELECT COUNT(*) FROM pragma_foreign_key_check) AS fk_violations,
          (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='${MIGRATION_NAME}') AS ledger
      `,
    )
    const row = rows[0] ?? {}
    const ok =
      numberValue(row, "listings_column") === 1 &&
      numberValue(row, "quotes_column") === 1 &&
      numberValue(row, "purchases_column") === 1 &&
      numberValue(row, "old_tables") === 0 &&
      numberValue(row, "fk_violations") === 0 &&
      numberValue(row, "ledger") === 1 &&
      sameCounts(beforeCounts, afterCounts)
    return { ok, detail: JSON.stringify({ verification: row, beforeCounts, afterCounts }) }
  } catch (error) {
    return { ok: false, detail: truncate(error) }
  }
}

const databases = await listDbs(env)
const selected = limit ? databases.slice(0, Number(limit)) : databases
console.log(
  `[d1-1114] env=${env} execute=${execute} candidates=${databases.length} selected=${selected.length} concurrency=${concurrency}` +
    (onlySlot ? ` slot=${onlySlot}` : "") +
    (onlyDb ? ` db=${onlyDb}` : "") +
    (excludeDbs.size > 0 ? ` exclude=${[...excludeDbs].join(",")}` : ""),
)

const classifications = await mapLimit(selected, concurrency, async (db) => {
  const classification = await classify(db)
  console.log(`  ${classification.state.padEnd(15)} ${db} (${classification.detail})`)
  return classification
})

const counts = classifications.reduce<Record<string, number>>((acc, classification) => {
  acc[classification.state] = (acc[classification.state] ?? 0) + 1
  return acc
}, {})
console.log(`[d1-1114] classification=${JSON.stringify(counts)}`)

const blocked = classifications.filter((classification) =>
  classification.state === "ERROR" || classification.state === "BLOCKED_ORPHANS"
)
if (blocked.length > 0) {
  console.log(`[d1-1114] refusing execution while ${blocked.length} shard(s) are blocked/error`)
}

const rebuildTargets = classifications
  .filter((classification) => classification.state === "NEEDS")
  .map((classification) => classification.db)
const ledgerTargets = classifications
  .filter((classification) => classification.state === "LEDGER_ONLY")
  .map((classification) => classification.db)

if (!execute) {
  console.log(`[d1-1114] DRY-RUN would rebuild=${rebuildTargets.length} ledger_only=${ledgerTargets.length}`)
  process.exit(blocked.length > 0 ? 1 : 0)
}

if (blocked.length > 0) process.exit(1)

const migrationFile = await writeD1MigrationFile()
console.log(`[d1-1114] EXECUTE using ${migrationFile}`)

let failures = 0
for (const db of rebuildTargets) {
  const result = await applyAndVerify(db, migrationFile)
  if (!result.ok) failures += 1
  console.log(`  ${result.ok ? "OK  " : "FAIL"} rebuild ${db} ${result.detail}`)
}
for (const db of ledgerTargets) {
  const result = await ledgerOnly(db)
  if (!result.ok) failures += 1
  console.log(`  ${result.ok ? "OK  " : "FAIL"} ledger  ${db} ${result.detail}`)
}
console.log(`[d1-1114] done ok=${rebuildTargets.length + ledgerTargets.length - failures} failed=${failures}`)
if (failures > 0) process.exit(1)
