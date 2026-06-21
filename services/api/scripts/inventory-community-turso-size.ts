import { createClient, type Client } from "@libsql/client"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { readDevVarsFromCwd } from "./_lib/dev-vars"

export const INVENTORY_TABLES = [
  "communities",
  "community_memberships",
  "community_roles",
  "posts",
  "comments",
  "comment_closure",
  "thread_snapshots",
  "content_translations",
  "community_jobs",
  "moderation_actions",
  "moderation_cases",
  "moderation_signals",
  "community_assistant_chats",
  "community_assistant_messages",
  "purchases",
  "purchase_quotes",
  "purchase_entitlements",
  "purchase_settlement_attempts",
  "purchase_settlement_effects",
  "community_handles",
] as const

export const INVENTORY_HOLDOUT_BYTES = 7 * 1024 * 1024 * 1024

export type TableInventory = {
  name: string
  rowCount: number
  indexCount: number
  present: boolean
}

export type CommunityInventory = {
  communityId: string
  source: string
  databaseUrl: string
  pageCount: number | null
  pageSize: number | null
  totalBytes: number | null
  tables: TableInventory[]
  indexCount: number
  holdout: boolean
  error: string | null
  measuredAt: string
}

export type InventoryReport = {
  generatedAt: string
  source: string
  communities: CommunityInventory[]
  totals: {
    communities: number
    measured: number
    failed: number
    holdouts: number
    totalBytes: number
  }
}

export type MeasureClient = () => Promise<Client> | Client

export type MeasureOptions = {
  measuredAt?: () => string
  tables?: readonly string[]
  clientTimeoutMs?: number
}

export async function measureCommunityDatabase(input: {
  communityId: string
  source: string
  databaseUrl: string
  openClient: MeasureClient
  options?: MeasureOptions
}): Promise<CommunityInventory> {
  const measuredAt = input.options?.measuredAt?.() ?? new Date().toISOString()
  const tables = input.options?.tables ?? INVENTORY_TABLES
  const timeoutMs = input.options?.clientTimeoutMs ?? 10_000

  let pageCount: number | null = null
  let pageSize: number | null = null
  let totalBytes: number | null = null
  let indexCount = 0
  let perTables: TableInventory[] = []
  let error: string | null = null

  let client: Client | null = null
  try {
    client = await withTimeout(input.openClient(), timeoutMs, "open")
    const pageCountRow = await firstRow(
      client,
      "SELECT (SELECT page_count FROM pragma_page_count) AS page_count, (SELECT page_size FROM pragma_page_size) AS page_size",
    )
    pageCount = pageCountRow?.page_count != null ? Number(pageCountRow.page_count) : null
    pageSize = pageCountRow?.page_size != null ? Number(pageCountRow.page_size) : null
    if (pageCount !== null && pageSize !== null) {
      totalBytes = pageCount * pageSize
    }

    const indexRow = await firstRow(
      client,
      "SELECT COUNT(*) AS index_count FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    )
    indexCount = indexRow?.index_count != null ? Number(indexRow.index_count) : 0

    perTables = await Promise.all(
      tables.map(async (name) => {
        const presentRow = await firstRow(
          client!,
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
          [name],
        )
        const present = presentRow !== null
        if (!present) {
          return { name, rowCount: 0, indexCount: 0, present: false }
        }
        const safeName = quoteIdentifier(name)
        const countRow = await firstRow(client!, `SELECT COUNT(*) AS row_count FROM ${safeName}`)
        const idxRow = await firstRow(
          client!,
          "SELECT COUNT(*) AS index_count FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND name NOT LIKE 'sqlite_%'",
          [name],
        )
        return {
          name,
          rowCount: countRow?.row_count != null ? Number(countRow.row_count) : 0,
          indexCount: idxRow?.index_count != null ? Number(idxRow.index_count) : 0,
          present: true,
        }
      }),
    )
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      client?.close?.()
    } catch {
      // best-effort
    }
  }

  return {
    communityId: input.communityId,
    source: input.source,
    databaseUrl: input.databaseUrl,
    pageCount,
    pageSize,
    totalBytes,
    tables: perTables,
    indexCount,
    holdout: totalBytes !== null && totalBytes > INVENTORY_HOLDOUT_BYTES,
    error,
    measuredAt,
  }
}

export async function measureCommunities(input: {
  bindings: Iterable<{ communityId: string; source: string; databaseUrl: string; openClient: MeasureClient }>
  options?: MeasureOptions
}): Promise<InventoryReport> {
  const inventories: CommunityInventory[] = []
  for (const binding of input.bindings) {
    const result = await measureCommunityDatabase({
      communityId: binding.communityId,
      source: binding.source,
      databaseUrl: binding.databaseUrl,
      openClient: binding.openClient,
      options: input.options,
    })
    inventories.push(result)
  }
  return summarize(inventories)
}

export function summarize(inventories: CommunityInventory[]): InventoryReport {
  let totalBytes = 0
  let measured = 0
  let failed = 0
  let holdouts = 0
  for (const inv of inventories) {
    if (inv.error) {
      failed += 1
    } else if (inv.totalBytes !== null) {
      measured += 1
      totalBytes += inv.totalBytes
    }
    if (inv.holdout) holdouts += 1
  }
  return {
    generatedAt: new Date().toISOString(),
    source: "summarize",
    communities: inventories,
    totals: {
      communities: inventories.length,
      measured,
      failed,
      holdouts,
      totalBytes,
    },
  }
}

export type FixtureBinding = {
  communityId: string
  source: "fixture-dir"
  databaseUrl: string
  filePath: string
  openClient: MeasureClient
}

export async function discoverFixtureBindings(input: {
  fixtureDir: string
}): Promise<FixtureBinding[]> {
  const entries = await readdir(input.fixtureDir, { withFileTypes: true })
  const bindings: FixtureBinding[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".db")) continue
    const filePath = join(input.fixtureDir, entry.name)
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat?.isFile()) continue
    const communityId = entry.name.slice(0, -".db".length)
    const databaseUrl = `file:${filePath}`
    bindings.push({
      communityId,
      source: "fixture-dir",
      databaseUrl,
      filePath,
      openClient: () => createClient({ url: databaseUrl }),
    })
  }
  return bindings.sort((a, b) => a.communityId.localeCompare(b.communityId))
}

export async function loadSchemaMigrationsDir(_coreRepoRoot: string): Promise<string[]> {
  return []
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function firstRow(
  client: Client,
  sql: string,
  args: unknown[] = [],
): Promise<Record<string, unknown> | null> {
  const result = await client.execute({ sql, args: args as never })
  const row = result.rows[0]
  return row ?? null
}

async function withTimeout<T>(promise: Promise<T> | T, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`inventory: ${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([Promise.resolve(promise), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type CliOptions = {
  mode: "dry-run" | "execute"
  source: "fixture-dir"
  fixtureDir: string | null
  output: string | null
}

function parseCli(argv: string[]): CliOptions {
  const getArg = (name: string): string | null => {
    const index = argv.indexOf(name)
    return index === -1 ? null : argv[index + 1] ?? null
  }
  const modeRaw = getArg("--mode")
  const mode: CliOptions["mode"] = modeRaw === "execute" ? "execute" : "dry-run"
  const output = getArg("--output")
  const fixtureDir = getArg("--fixture-dir")
  return {
    mode,
    source: "fixture-dir",
    fixtureDir,
    output,
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseCli(argv)
  if (!opts.fixtureDir) {
    process.stderr.write(
      "inventory-community-turso-size: --fixture-dir <path> is required (production Turso enumeration is not yet wired)\n",
    )
    return 2
  }
  const bindings = await discoverFixtureBindings({ fixtureDir: opts.fixtureDir })
  const report: InventoryReport = opts.mode === "dry-run"
    ? {
        generatedAt: new Date().toISOString(),
        source: opts.source,
        communities: bindings.map((b) => emptyInventory(b)),
        totals: { communities: bindings.length, measured: 0, failed: 0, holdouts: 0, totalBytes: 0 },
      }
    : await measureCommunities({ bindings })
  const payload = JSON.stringify(report, null, 2) + "\n"
  if (opts.output) {
    await import("node:fs/promises").then((fs) => fs.writeFile(opts.output!, payload, "utf8"))
  } else {
    process.stdout.write(payload)
  }
  if (report.totals.failed > 0) return 1
  return 0
}

function emptyInventory(binding: { communityId: string; source: string; databaseUrl: string }): CommunityInventory {
  return {
    communityId: binding.communityId,
    source: binding.source,
    databaseUrl: binding.databaseUrl,
    pageCount: null,
    pageSize: null,
    totalBytes: null,
    tables: [],
    indexCount: 0,
    holdout: false,
    error: null,
    measuredAt: new Date().toISOString(),
  }
}

const invokedDirectly = (() => {
  if (typeof process === "undefined") return false
  const arg1 = process.argv[1]
  if (!arg1) return false
  try {
    return import.meta.url === new URL(arg1, "file://" + process.cwd() + "/").href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  void readDevVarsFromCwd()
  main().then(
    (code) => {
      process.exit(code)
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
