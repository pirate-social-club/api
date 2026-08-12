import { createClient as createLibsqlClient } from "@libsql/client"
import type { Client as LibsqlClient, Transaction as LibsqlTransaction } from "@libsql/client"
import { AsyncLocalStorage } from "node:async_hooks"
import { Client as PgClient } from "pg"
import { globalSingleton } from "./db-helpers"
import { logPipelineError, logPipelineInfo } from "./observability/pipeline-log"
import { requireControlPlaneDbUrl } from "./auth/auth-db-query-helpers"
import type { Client, InStatement, QueryResult, QueryResultRow, Transaction } from "./sql-client"
import type { Env } from "../env"

type PostgresQueryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
  abortPendingQuery?: () => void
  statementTimeoutMs?: number
}

// Structural connection shape the Postgres adapter depends on, so tests can substitute a local database.
type PostgresPoolLike = PostgresQueryable & {
  connect: () => Promise<PostgresQueryable & { release: () => void }>
  end: () => Promise<void>
}

// Every control-plane await is bounded. On 2026-07-31 a wallet-bearing
// `POST /auth/session/exchange` stalled for >120s with 0.5s CPU, no exception
// and no statement ever reaching PlanetScale — the request simply never
// settled, so the release contract gate reported an opaque test timeout. The
// pool's own `connectionTimeoutMillis` did not fire, so the transport bound has
// to be enforced here. PostgreSQL's session timeout independently cancels
// statements that do reach the server.
const controlPlaneConnectTimeoutMs = 5_000
const controlPlaneStatementTimeoutMs = 15_000
// Logged (not failed) so a statement that is merely slow stays visible without
// turning latency into an outage.
const controlPlaneSlowStatementMs = 1_000

class RequestScopedPgConnection implements PostgresPoolLike {
  private readonly client: PgClient
  private connectPromise: Promise<void> | null = null
  private endPromise: Promise<void> | null = null

  constructor(connectionString: string) {
    this.client = new PgClient({
      connectionString,
      connectionTimeoutMillis: 5_000,
      statement_timeout: controlPlaneStatementTimeoutMs,
      idle_in_transaction_session_timeout: controlPlaneStatementTimeoutMs * 2,
    })
  }

  private async ensureConnected(): Promise<void> {
    this.connectPromise ??= this.client.connect().then(() => undefined)
    await this.connectPromise
  }

  async query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> {
    if (this.endPromise) {
      throw new Error("control-plane PostgreSQL connection is closed")
    }
    await this.ensureConnected()
    const result = await this.client.query(sql, values)
    return { rows: result.rows, rowCount: result.rowCount }
  }

  async connect(): Promise<PostgresQueryable & { release: () => void }> {
    await this.ensureConnected()
    return {
      query: (sql, values) => this.query(sql, values),
      abortPendingQuery: () => this.abortPendingQuery(),
      statementTimeoutMs: controlPlaneStatementTimeoutMs,
      // The request owns one pg.Client. Hyperdrive owns the underlying pool, so a
      // transaction release is intentionally deferred until request-scope cleanup.
      release: () => {},
    }
  }

  abortPendingQuery(): void {
    // node-postgres force-destroys the socket when end() sees an active query.
    // That makes a client-side transport timeout terminal for this request-scoped
    // connection instead of allowing the query to finish invisibly and then
    // reusing a connection whose transaction state is unknown.
    void this.closeClient().catch((error: unknown) => {
      console.error("[control-plane] failed to terminate timed-out PostgreSQL connection", error)
    })
  }

  private closeClient(): Promise<void> {
    this.endPromise ??= this.client.end()
    return this.endPromise
  }

  async end(): Promise<void> {
    if (this.endPromise) {
      await withControlPlaneDeadline(
        "connection close",
        controlPlaneConnectTimeoutMs,
        () => this.endPromise as Promise<void>,
      )
      return
    }
    if (!this.connectPromise) {
      return
    }
    try {
      await withControlPlaneDeadline(
        "connection readiness before close",
        controlPlaneConnectTimeoutMs,
        () => this.connectPromise as Promise<void>,
        () => this.abortPendingQuery(),
      )
    } catch (error) {
      if (error instanceof ControlPlaneTimeoutError) throw error
      return
    }
    await withControlPlaneDeadline(
      "connection close",
      controlPlaneConnectTimeoutMs,
      () => this.closeClient(),
    )
  }

  readonly statementTimeoutMs = controlPlaneStatementTimeoutMs
}

// Test-only seam: override how the request-scoped CONTROL-PLANE Postgres connection is built.
type ControlPlanePostgresPoolFactory = (url: string) => PostgresPoolLike
let controlPlanePostgresPoolFactoryForTests: ControlPlanePostgresPoolFactory | null = null
export function setControlPlanePostgresPoolFactoryForTests(factory: ControlPlanePostgresPoolFactory | null): void {
  controlPlanePostgresPoolFactoryForTests = factory
}

const LIBSQL_BUSY_RETRY_TIMEOUT_MS = 5000
const LIBSQL_BUSY_RETRY_DELAY_MS = 50

type RequestControlPlaneStore = {
  clients: Map<string, Client>
}

const requestControlPlaneStore = new AsyncLocalStorage<RequestControlPlaneStore>()

export function isPostgresControlPlaneUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith("postgres://") || normalized.startsWith("postgresql://")
}

export function resolveControlPlanePostgresConnectionString(env: Env, fallbackUrl: string): string {
  const hyperdriveUrl = env.CONTROL_PLANE_HYPERDRIVE?.connectionString
  if (hyperdriveUrl) {
    return hyperdriveUrl
  }
  if (env.ENVIRONMENT === "production") {
    throw new Error("Missing CONTROL_PLANE_HYPERDRIVE binding in production")
  }
  return fallbackUrl
}

function createPostgresConnection(env: Env, fallbackUrl: string): PostgresPoolLike {
  return new RequestScopedPgConnection(resolveControlPlanePostgresConnectionString(env, fallbackUrl))
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

class ControlPlaneTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number, elapsedMs: number) {
    super(
      `control-plane ${operation} did not settle within ${timeoutMs}ms (waited ${elapsedMs}ms).`
      + " No response was received from the Postgres transport.",
    )
    this.name = "ControlPlaneTimeoutError"
  }
}

async function withControlPlaneDeadline<T>(
  operation: string,
  timeoutMs: number,
  run: () => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            try {
              onTimeout?.()
            } catch (error) {
              console.error("[control-plane] timeout cancellation failed", error)
            }
            reject(new ControlPlaneTimeoutError(operation, timeoutMs, Date.now() - startedAt))
          },
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// First keyword plus target table — enough to identify the stalled statement in
// logs without ever emitting predicates or bound arguments.
function describeStatement(sql: string): string {
  const collapsed = sql.replace(/\s+/gu, " ").trim()
  const match = collapsed.match(
    /^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET)\b(?:[\s\S]*?\b(?:FROM|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*))?/iu,
  )
  if (!match) return "unknown"
  const [, keyword, table] = match
  return table ? `${keyword.toUpperCase()} ${table}` : keyword.toUpperCase()
}

async function executePostgresStatement(queryable: PostgresQueryable, statement: InStatement | string): Promise<QueryResult> {
  const normalized = normalizeStatement(statement)
  const description = describeStatement(normalized.sql)
  const startedAt = Date.now()
  const result = await withControlPlaneDeadline(
    `statement ${description}`,
    queryable.statementTimeoutMs ?? controlPlaneStatementTimeoutMs,
    () => queryable.query(postgresifySql(normalized.sql), normalizeArgs(normalized.args ?? [])),
    () => queryable.abortPendingQuery?.(),
  ).catch((error: unknown) => {
    if (error instanceof ControlPlaneTimeoutError) {
      logPipelineError("control-plane statement stalled", {
        statement: description,
        timeout_ms: queryable.statementTimeoutMs ?? controlPlaneStatementTimeoutMs,
        elapsed_ms: Date.now() - startedAt,
      })
    }
    throw error
  })
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs >= controlPlaneSlowStatementMs) {
    logPipelineInfo("control-plane statement slow", {
      statement: description,
      elapsed_ms: elapsedMs,
    })
  }
  return {
    rows: normalizeRows(result.rows),
    rowsAffected: result.rowCount ?? undefined,
  }
}

function isLibsqlBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const code = "code" in error ? String((error as { code?: unknown }).code) : ""
  const extendedCode = "extendedCode" in error ? String((error as { extendedCode?: unknown }).extendedCode) : ""
  const rawCode = "rawCode" in error ? Number((error as { rawCode?: unknown }).rawCode) : NaN
  return code === "SQLITE_BUSY" || extendedCode === "SQLITE_BUSY" || rawCode === 5
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function withLibsqlBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  let delayMs = LIBSQL_BUSY_RETRY_DELAY_MS

  while (true) {
    try {
      return await operation()
    } catch (error) {
      if (!isLibsqlBusyError(error) || Date.now() - startedAt >= LIBSQL_BUSY_RETRY_TIMEOUT_MS) {
        throw error
      }

      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 250)
    }
  }
}

class LibsqlTransactionAdapter implements Transaction {
  constructor(private readonly tx: LibsqlTransaction) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    const result = await this.tx.execute(statement as never)
    return {
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  async batch(statements: InStatement[], _mode: "read" | "write" = "write"): Promise<QueryResult[]> {
    const results = await this.tx.batch(statements as never)
    return results.map((result) => ({
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }))
  }

  async commit(): Promise<void> {
    await this.tx.commit()
  }

  async rollback(): Promise<void> {
    await this.tx.rollback()
  }

  close(): void {
    this.tx.close()
  }
}

class LibsqlClientAdapter implements Client {
  constructor(
    private readonly client: LibsqlClient,
    private readonly shouldCloseClient = true,
  ) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    const result = await withLibsqlBusyRetry(() => this.client.execute(statement as never))
    return {
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  async batch(statements: InStatement[], mode: "read" | "write" = "write"): Promise<QueryResult[]> {
    const results = await withLibsqlBusyRetry(() => this.client.batch(statements as never, mode))
    return results.map((result) => ({
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }))
  }

  async transaction(mode: "read" | "write" = "write"): Promise<Transaction> {
    const tx = await withLibsqlBusyRetry(() => this.client.transaction(mode))
    return new LibsqlTransactionAdapter(tx)
  }

  close(): void {
    if (this.shouldCloseClient) {
      this.client.close()
    }
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
    await this.finalize("COMMIT")
  }

  async rollback(): Promise<void> {
    await this.finalize("ROLLBACK")
  }

  private async finalize(statement: "COMMIT" | "ROLLBACK"): Promise<void> {
    try {
      await executePostgresStatement(this.tx, statement)
    } catch (error) {
      // A finalizer error leaves its outcome or transaction state uncertain.
      // Never return that connection to request-scoped work; transport deadline
      // errors already terminated it inside executePostgresStatement.
      if (!(error instanceof ControlPlaneTimeoutError)) {
        this.tx.abortPendingQuery?.()
      }
      throw error
    }
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
    // Acquisition is bounded separately from BEGIN: waiting on the pool (max: 1)
    // and waiting on the server are different failures, and collapsing them
    // hides which boundary stalled.
    const acquireStartedAt = Date.now()
    const client = await withControlPlaneDeadline(
      "pool acquisition",
      controlPlaneConnectTimeoutMs,
      () => this.pool.connect(),
      () => this.pool.abortPendingQuery?.(),
    ).catch((error: unknown) => {
      if (error instanceof ControlPlaneTimeoutError) {
        logPipelineError("control-plane pool acquisition stalled", {
          timeout_ms: controlPlaneConnectTimeoutMs,
          elapsed_ms: Date.now() - acquireStartedAt,
        })
      }
      throw error
    })
    const acquireMs = Date.now() - acquireStartedAt
    try {
      await executePostgresStatement(client, "BEGIN")
      // Server-side backstop for anything that reaches Postgres but never
      // returns, and for a transaction abandoned mid-flight by a dead
      // connection. The client-side deadline above covers the case where the
      // statement never arrives at all.
      await executePostgresStatement(
        client,
        `SET LOCAL statement_timeout = ${client.statementTimeoutMs ?? controlPlaneStatementTimeoutMs}`,
      )
      await executePostgresStatement(
        client,
        `SET LOCAL idle_in_transaction_session_timeout = ${(client.statementTimeoutMs ?? controlPlaneStatementTimeoutMs) * 2}`,
      )
    } catch (error) {
      client.release()
      throw error
    }
    if (acquireMs >= controlPlaneSlowStatementMs) {
      logPipelineInfo("control-plane pool acquisition slow", { elapsed_ms: acquireMs })
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

async function runInFreshControlPlaneScope<T>(operation: () => Promise<T>): Promise<T> {
  const store: RequestControlPlaneStore = { clients: new Map() }
  return requestControlPlaneStore.run(store, async () => {
    try {
      return await operation()
    } finally {
      await closeRequestControlPlaneClients(store)
    }
  })
}

export async function withRequestControlPlaneClients<T>(operation: () => Promise<T>): Promise<T> {
  const existingStore = requestControlPlaneStore.getStore()
  if (existingStore) {
    return operation()
  }

  return runInFreshControlPlaneScope(operation)
}

/**
 * Control-plane scope for work that OUTLIVES the request that scheduled it
 * (`ctx.waitUntil(...)` background tasks).
 *
 * `withRequestControlPlaneClients` deliberately joins an enclosing scope so that
 * nested calls within one request share a single connection. That reuse is wrong
 * for a background task: the request middleware closes the request store's
 * clients as soon as the response is produced, while the task is still running.
 * The task then either operates on a closed pool or lazily allocates a
 * replacement into an orphaned store that nobody ever closes (a leaked
 * PlanetScale slot — the exact exhaustion the scheduled-batch concurrency cap
 * exists to prevent).
 *
 * This ALWAYS opens its own store, so the background task owns an independent
 * client lifecycle: usable for as long as the task runs, closed exactly once
 * when it settles, unaffected by the request scope closing first.
 */
export async function withBackgroundControlPlaneClients<T>(operation: () => Promise<T>): Promise<T> {
  return runInFreshControlPlaneScope(operation)
}

export async function withStandaloneControlPlaneClient<T>(
  env: Env,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const url = requireControlPlaneDbUrl(env)
  if (!isPostgresControlPlaneUrl(url)) {
    return await operation(getControlPlaneClient(env))
  }

  const client = new PostgresClientAdapter(createPostgresConnection(env, url))
  try {
    return await operation(client)
  } finally {
    await client.close?.()
  }
}

function getRequestScopedPostgresClient(env: Env, url: string): Client | null {
  const store = requestControlPlaneStore.getStore()
  if (!store) {
    return null
  }

  const cacheKey = `pg:${url}`
  let client = store.clients.get(cacheKey)
  if (!client) {
    const pool: PostgresPoolLike = controlPlanePostgresPoolFactoryForTests
      ? controlPlanePostgresPoolFactoryForTests(url)
      : createPostgresConnection(env, url)
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
    // Hyperdrive owns the underlying pool; the pg.Client itself remains request-scoped.
    const requestScopedClient = getRequestScopedPostgresClient(env, url)
    if (requestScopedClient) {
      return requestScopedClient
    }
    throw new Error(
      "getControlPlaneClient called outside withRequestControlPlaneClients — " +
      "Postgres control-plane I/O must be request-scoped to avoid exhausting PlanetScale connection slots. " +
      "Wrap the call site in withRequestControlPlaneClients().",
    )
  }

  const cacheKey = `cp:${getControlPlaneCacheKey(env)}`
  return globalSingleton("controlPlaneClient", cacheKey, () => new LibsqlClientAdapter(createLibsqlClient({
    url,
  }), false))
}

export { getControlPlaneClient }
