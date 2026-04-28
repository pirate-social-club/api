import { createClient as createLibsqlClient } from "@libsql/client"
import type { Client as LibsqlClient, Transaction as LibsqlTransaction } from "@libsql/client"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { globalSingleton } from "./db-helpers"
import { requireControlPlaneDbUrl } from "./auth/auth-db-query-helpers"
import type { Client, InStatement, QueryResult, QueryResultRow, Transaction } from "./sql-client"
import type { Env } from "../types"

type PostgresQueryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
}

neonConfig.poolQueryViaFetch = true

const LIBSQL_BUSY_RETRY_TIMEOUT_MS = 5000
const LIBSQL_BUSY_RETRY_DELAY_MS = 50

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
  constructor(private readonly pool: Pool) {}

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
      } catch {}
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

  close(): void {
    void this.pool.end()
  }
}

export function getControlPlaneCacheKey(env: Env): string {
  return requireControlPlaneDbUrl(env)
}

function getControlPlaneClient(env: Env): Client {
  const url = requireControlPlaneDbUrl(env)
  if (isPostgresControlPlaneUrl(url)) {
    // In Cloudflare Workers, Postgres I/O objects must stay request-scoped.
    // Reusing a cached Neon pool across requests can trigger cross-request I/O failures.
    return new PostgresClientAdapter(new Pool({ connectionString: url, max: 4 }))
  }

  const cacheKey = `cp:${getControlPlaneCacheKey(env)}`
  return globalSingleton("controlPlaneClient", cacheKey, () => new LibsqlClientAdapter(createLibsqlClient({
    url,
  }), false))
}

export { getControlPlaneClient }
