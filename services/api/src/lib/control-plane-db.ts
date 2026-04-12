import { internalError } from "./errors"
import type { Env } from "../types"

type SqlStatement = {
  sql: string
  args?: Array<string | number | boolean | null>
}

type SqlRow = Record<string, unknown>

type BunSqlResult<T> = Array<T> & {
  affectedRows?: number | null
  count?: number | null
}

type BunSqlClient = {
  unsafe<T>(sql: string, values?: Array<string | number | boolean | null>): Promise<BunSqlResult<T>>
  reserve(): Promise<BunReservedSqlClient>
  close(options?: { timeout?: number }): Promise<void>
}

type BunReservedSqlClient = BunSqlClient & {
  release(): void
}

export type ControlPlaneQueryResult = {
  rows: SqlRow[]
  rowsAffected: number
}

export interface ControlPlaneDbExecutor {
  execute(statement: SqlStatement): Promise<ControlPlaneQueryResult>
  batch(statements: SqlStatement[], mode?: "write" | "read"): Promise<ControlPlaneQueryResult[]>
}

export interface ControlPlaneDbTransaction extends ControlPlaneDbExecutor {
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): void
}

export interface ControlPlaneDbClient extends ControlPlaneDbExecutor {
  transaction(mode?: "write" | "read"): Promise<ControlPlaneDbTransaction>
  close(): Promise<void> | void
}

function requireBunSql(): new (url: string) => BunSqlClient {
  const BunRuntime = (globalThis as { Bun?: { SQL?: new (url: string) => BunSqlClient } }).Bun
  if (!BunRuntime?.SQL) {
    throw internalError("Bun.SQL is required for the control-plane runtime")
  }
  return BunRuntime.SQL
}

function normalizeStatement(databaseUrl: string, sql: string): string {
  if (databaseUrl.startsWith("file:")) {
    return sql
  }
  return sql.replace(/\?(\d+)/g, (_match, index) => `$${index}`)
}

function toQueryResult(rows: BunSqlResult<SqlRow>): ControlPlaneQueryResult {
  return {
    rows: rows as SqlRow[],
    rowsAffected: Number(rows.affectedRows ?? rows.count ?? 0),
  }
}

function bindExecute(
  databaseUrl: string,
  client: { unsafe<T>(sql: string, values?: Array<string | number | boolean | null>): Promise<BunSqlResult<T>> },
) {
  return async (statement: SqlStatement): Promise<ControlPlaneQueryResult> => {
    const rows = await client.unsafe<SqlRow>(normalizeStatement(databaseUrl, statement.sql), statement.args ?? [])
    return toQueryResult(rows)
  }
}

export function requireControlPlaneDatabaseUrl(env: Env): string {
  const url = String(env.CONTROL_PLANE_DATABASE_URL || "").trim()
  if (!url) {
    throw internalError("CONTROL_PLANE_DATABASE_URL is not configured")
  }
  return url
}

export function createControlPlaneDbClient(env: Env): ControlPlaneDbClient {
  const databaseUrl = requireControlPlaneDatabaseUrl(env)
  const SQL = requireBunSql()
  const client = new SQL(databaseUrl)
  const execute = bindExecute(databaseUrl, client)
  const isFileDatabase = databaseUrl.startsWith("file:")

  return {
    execute,
    async batch(statements) {
      const results: ControlPlaneQueryResult[] = []
      for (const statement of statements) {
        results.push(await execute(statement))
      }
      return results
    },
    async transaction(mode = "write") {
      const txClient = isFileDatabase ? client : await client.reserve()
      const txExecute = bindExecute(databaseUrl, txClient)
      const beginSql = isFileDatabase && mode === "write"
        ? "BEGIN IMMEDIATE"
        : "BEGIN"

      await txClient.unsafe(beginSql)

      let finished = false

      return {
        execute: txExecute,
        async batch(statements) {
          const results: ControlPlaneQueryResult[] = []
          for (const statement of statements) {
            results.push(await txExecute(statement))
          }
          return results
        },
        async commit() {
          if (finished) return
          await txClient.unsafe("COMMIT")
          finished = true
        },
        async rollback() {
          if (finished) return
          await txClient.unsafe("ROLLBACK")
          finished = true
        },
        close() {
          if (!isFileDatabase) {
            txClient.release()
          }
        },
      }
    },
    async close() {
      await client.close()
    },
  }
}
