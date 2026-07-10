import { Pool, neonConfig } from "@neondatabase/serverless"
import { AsyncLocalStorage } from "node:async_hooks"
import { isPlanetScalePostgresUrl, normalizePostgresConnectionStringForDriver } from "@pirate/api-shared"

// The transport package exposes its configuration through `neonConfig`, even when the actual
// PostgreSQL provider is PlanetScale. Keep configuration beside the Pool import so both use the
// same package singleton.
// poolQueryViaFetch is safe for all Postgres providers: routes pool.query() through HTTP
// instead of persistent WebSocket connections, preventing slot exhaustion.
neonConfig.poolQueryViaFetch = true

const defaultPostgresFetchEndpoint = neonConfig.fetchEndpoint
const defaultPostgresWsProxy = neonConfig.wsProxy
const defaultPostgresPipelineConnect = neonConfig.pipelineConnect

export function configureWorkerPostgresTransportForUrl(url: string): void {
  if (!isPlanetScalePostgresUrl(url)) {
    neonConfig.fetchEndpoint = defaultPostgresFetchEndpoint
    neonConfig.wsProxy = defaultPostgresWsProxy
    neonConfig.pipelineConnect = defaultPostgresPipelineConnect
    return
  }
  neonConfig.fetchEndpoint = (host: string) => `https://${host}/sql`
  neonConfig.wsProxy = (host: string, port: string | number) => `${host}/v2?address=${host}:${port}`
  neonConfig.pipelineConnect = false
}
import { globalSingleton } from "./db-helpers"
import { requireControlPlaneDbUrl } from "./auth/auth-db-query-helpers"
import type { Client, InStatement, QueryResult, QueryResultRow, Transaction } from "./sql-client"
import type { Env } from "../env"

type PostgresQueryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
}

// Structural pool shape the Postgres adapter depends on, so tests can substitute an in-memory pool.
type PostgresPoolLike = PostgresQueryable & {
  connect: () => Promise<PostgresQueryable & { release: () => void }>
  end: () => Promise<void>
}

// Test-only seam: override how the request-scoped control-plane Postgres pool is built.
type ControlPlanePostgresPoolFactory = (url: string) => PostgresPoolLike
let controlPlanePostgresPoolFactoryForTests: ControlPlanePostgresPoolFactory | null = null
export function setControlPlanePostgresPoolFactoryForTests(factory: ControlPlanePostgresPoolFactory | null): void {
  controlPlanePostgresPoolFactoryForTests = factory
}

type NonPostgresControlPlaneClientFactory = (url: string) => Client
let nonPostgresControlPlaneClientFactoryForTests: NonPostgresControlPlaneClientFactory | null = null

export function setNonPostgresControlPlaneClientFactoryForTests(
  factory: NonPostgresControlPlaneClientFactory | null,
): void {
  nonPostgresControlPlaneClientFactoryForTests = factory
}

type RequestControlPlaneStore = {
  clients: Map<string, Client>
}

const requestControlPlaneStore = new AsyncLocalStorage<RequestControlPlaneStore>()

export function isPostgresControlPlaneUrl(value: string): boolean {
  return value.startsWith("postgres://") || value.startsWith("postgresql://")
}

function normalizeStatement(statement: InStatement | string): InStatement {
  if (typeof statement === "string") {
    return { sql: statement, args: [] }
  }
  return {
    sql: statement.sql,
    args: statement.args ?? [],
  }
}

function normalizeArgs(args: unknown[]): unknown[] {
  return args.map((value) => value === undefined ? null : value)
}

function normalizeRowValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return value
}

function normalizeRows(rows: unknown[]): QueryResultRow[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object") {
      return {}
    }
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, normalizeRowValue(value)]),
    )
  })
}

const postgresUpsertConflictTargets = new Map<string, readonly string[]>([
  ["namespace_verification_capabilities", ["capability_record_id"]],
  ["namespace_verifications", ["namespace_verification_id"]],
])

function appendPostgresClause(sql: string, clause: string): string {
  const trimmed = sql.trimEnd()
  const hasSemicolon = trimmed.endsWith(";")
  const base = hasSemicolon ? trimmed.slice(0, -1).trimEnd() : trimmed
  return `${base}\n      ${clause}${hasSemicolon ? ";" : ""}`
}

function parseInsertColumns(columnList: string): string[] {
  return columnList
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
}

function translateInsertOrIgnore(sql: string): string {
  if (!/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
    return sql
  }

  return appendPostgresClause(
    sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO"),
    "ON CONFLICT DO NOTHING",
  )
}

function translateInsertOrReplace(sql: string): string {
  const match = sql.match(/\bINSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([\s\S]*?)\)\s*VALUES\b/i)
  if (!match) {
    return sql
  }

  const [, tableName, columnList] = match
  const conflictTarget = postgresUpsertConflictTargets.get(tableName)
  if (!conflictTarget) {
    throw new Error(`Unsupported INSERT OR REPLACE table for PostgreSQL translation: ${tableName}`)
  }

  const conflictColumns = new Set(conflictTarget)
  const updateColumns = parseInsertColumns(columnList).filter((column) => !conflictColumns.has(column))
  const insertSql = sql.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/i, "INSERT INTO")
  if (updateColumns.length === 0) {
    return appendPostgresClause(
      insertSql,
      `ON CONFLICT (${conflictTarget.join(", ")}) DO NOTHING`,
    )
  }

  return appendPostgresClause(
    insertSql,
    [
      `ON CONFLICT (${conflictTarget.join(", ")}) DO UPDATE SET`,
      ...updateColumns.map((column) => `        ${column} = EXCLUDED.${column}`),
    ].join("\n"),
  )
}

export function postgresifySql(sql: string): string {
  const normalized = sql.replace(/\?(\d+)/g, (_, index: string) => `$${index}`)
  return translateInsertOrReplace(translateInsertOrIgnore(normalized))
}

async function executePostgresStatement(queryable: PostgresQueryable, statement: InStatement | string): Promise<QueryResult> {
  const normalized = normalizeStatement(statement)
  const result = await queryable.query(postgresifySql(normalized.sql), normalizeArgs(normalized.args ?? []))
  return {
    rows: normalizeRows(result.rows),
    rowsAffected: result.rowCount ?? undefined,
  }
}

class PostgresTransactionAdapter implements Transaction {
  constructor(private readonly tx: PostgresQueryable & { release: () => void }) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return await executePostgresStatement(this.tx, statement)
  }

  async batch(statements: InStatement[]): Promise<QueryResult[]> {
    const results: QueryResult[] = []
    for (const statement of statements) {
      results.push(await this.execute(statement))
    }
    return results
  }

  async commit(): Promise<void> {
    await this.tx.query("COMMIT")
  }

  async rollback(): Promise<void> {
    await this.tx.query("ROLLBACK")
  }

  close(): void {
    this.tx.release()
  }
}

class PostgresClientAdapter implements Client {
  constructor(private readonly pool: PostgresPoolLike) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return await executePostgresStatement(this.pool, statement)
  }

  async batch(statements: InStatement[]): Promise<QueryResult[]> {
    const tx = await this.transaction()
    try {
      const results = await tx.batch(statements, "write")
      await tx.commit()
      return results
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[control-plane] transaction rollback failed during batch", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  }

  async transaction(_mode: "read" | "write" = "write"): Promise<Transaction> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
    } catch (error) {
      client.release()
      throw error
    }
    return new PostgresTransactionAdapter(client)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

class RequestScopedClientAdapter implements Client {
  constructor(private readonly client: Client) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return this.client.execute(statement)
  }

  async batch(statements: InStatement[], mode: "read" | "write" = "write"): Promise<QueryResult[]> {
    return this.client.batch(statements, mode)
  }

  async transaction(mode: "read" | "write" = "write"): Promise<Transaction> {
    return this.client.transaction(mode)
  }

  close(): void {
  }
}

async function closeRequestControlPlaneClients(store: RequestControlPlaneStore): Promise<void> {
  const clients = [...store.clients.values()]
  store.clients.clear()
  await Promise.all(clients.map(async (client) => {
    try {
      await client.close?.()
    } catch (error) {
      console.error("[control-plane] request-scoped client close failed", error)
    }
  }))
}

export async function withRequestControlPlaneClients<T>(operation: () => Promise<T>): Promise<T> {
  const existingStore = requestControlPlaneStore.getStore()
  if (existingStore) {
    return operation()
  }

  const store: RequestControlPlaneStore = { clients: new Map() }
  return requestControlPlaneStore.run(store, async () => {
    try {
      return await operation()
    } finally {
      await closeRequestControlPlaneClients(store)
    }
  })
}

export async function withStandaloneControlPlaneClient<T>(
  env: Env,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const url = requireControlPlaneDbUrl(env)
  if (!isPostgresControlPlaneUrl(url)) {
    return await operation(getControlPlaneClient(env))
  }

  configureWorkerPostgresTransportForUrl(url)
  const client = new PostgresClientAdapter(new Pool({
    connectionString: normalizePostgresConnectionStringForDriver(url),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  }))
  try {
    return await operation(client)
  } finally {
    await client.close?.()
  }
}

function getRequestScopedPostgresClient(url: string): Client | null {
  const store = requestControlPlaneStore.getStore()
  if (!store) {
    return null
  }

  // The test seam substitutes the pool and bypasses the real Worker transport.
  if (!controlPlanePostgresPoolFactoryForTests) {
    configureWorkerPostgresTransportForUrl(url)
  }
  const cacheKey = `pg:${url}`
  let client = store.clients.get(cacheKey)
  if (!client) {
    // max: 1 — one connection per request is sufficient.
    // connectionTimeoutMillis: fail fast rather than queue behind a stuck slot.
    // idleTimeoutMillis: recycle the slot even if pool.end() doesn't flush server-side.
    const pool: PostgresPoolLike = controlPlanePostgresPoolFactoryForTests
      ? controlPlanePostgresPoolFactoryForTests(url)
      : (new Pool({
          connectionString: normalizePostgresConnectionStringForDriver(url),
          max: 1,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
        }) as unknown as PostgresPoolLike)
    client = new PostgresClientAdapter(pool)
    store.clients.set(cacheKey, client)
  }
  return new RequestScopedClientAdapter(client)
}

export function getControlPlaneCacheKey(env: Env): string {
  return requireControlPlaneDbUrl(env)
}

function getControlPlaneClient(env: Env): Client {
  const url = requireControlPlaneDbUrl(env)
  if (isPostgresControlPlaneUrl(url)) {
    // In Cloudflare Workers, Postgres I/O objects must stay request-scoped.
    // Reusing a cached network pool across requests can trigger cross-request I/O failures.
    const requestScopedClient = getRequestScopedPostgresClient(url)
    if (requestScopedClient) {
      return requestScopedClient
    }
    throw new Error(
      "getControlPlaneClient called outside withRequestControlPlaneClients — " +
      "Postgres control-plane I/O must be request-scoped to avoid exhausting PlanetScale connection slots. " +
      "Wrap the call site in withRequestControlPlaneClients().",
    )
  }

  const testFactory = nonPostgresControlPlaneClientFactoryForTests
  if (env.ENVIRONMENT !== "test" || !testFactory) {
    throw new Error("Non-Postgres control-plane URLs are supported only by the explicit test adapter")
  }

  const cacheKey = `test-cp:${getControlPlaneCacheKey(env)}`
  return globalSingleton("controlPlaneClient", cacheKey, () => testFactory(url))
}

export { getControlPlaneClient }
