import { createClient, type Client as LibsqlClient, type Transaction as LibsqlTransaction } from "@libsql/client"

import type { Client, InStatement, QueryResult, QueryResultRow, Transaction } from "../../src/lib/sql-client"

const BUSY_RETRY_TIMEOUT_MS = 5_000
const BUSY_RETRY_DELAY_MS = 50

function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? String((error as { code?: unknown }).code) : ""
  const extendedCode = "extendedCode" in error ? String((error as { extendedCode?: unknown }).extendedCode) : ""
  const rawCode = "rawCode" in error ? Number((error as { rawCode?: unknown }).rawCode) : NaN
  return code === "SQLITE_BUSY" || extendedCode === "SQLITE_BUSY" || rawCode === 5
}

async function withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  let delayMs = BUSY_RETRY_DELAY_MS
  while (true) {
    try {
      return await operation()
    } catch (error) {
      if (!isBusyError(error) || Date.now() - startedAt >= BUSY_RETRY_TIMEOUT_MS) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      delayMs = Math.min(delayMs * 2, 250)
    }
  }
}

function toQueryResult(result: {
  rows: unknown[]
  rowsAffected: number
  lastInsertRowid?: bigint
}): QueryResult {
  return {
    rows: result.rows as QueryResultRow[],
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid,
  }
}

class LibsqlTestTransactionAdapter implements Transaction {
  constructor(private readonly transaction: LibsqlTransaction) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return toQueryResult(await this.transaction.execute(statement as never))
  }

  async batch(statements: InStatement[]): Promise<QueryResult[]> {
    return (await this.transaction.batch(statements as never)).map(toQueryResult)
  }

  async commit(): Promise<void> {
    await this.transaction.commit()
  }

  async rollback(): Promise<void> {
    await this.transaction.rollback()
  }

  close(): void {
    this.transaction.close()
  }
}

class LibsqlTestClientAdapter implements Client {
  constructor(private readonly client: LibsqlClient) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return toQueryResult(await withBusyRetry(() => this.client.execute(statement as never)))
  }

  async batch(statements: InStatement[], mode: "read" | "write" = "write"): Promise<QueryResult[]> {
    return (await withBusyRetry(() => this.client.batch(statements as never, mode))).map(toQueryResult)
  }

  async transaction(mode: "read" | "write" = "write"): Promise<Transaction> {
    return new LibsqlTestTransactionAdapter(await withBusyRetry(() => this.client.transaction(mode)))
  }

  close(): void {
    // The route-test fixture owns the underlying file client lifecycle.
  }
}

export function createLibsqlTestClientAdapter(url: string): Client {
  return new LibsqlTestClientAdapter(createClient({ url }))
}
