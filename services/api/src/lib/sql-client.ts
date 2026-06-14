export type InStatement = {
  sql: string
  args?: any[]
}

export type QueryResultRow = Record<string, unknown>

export type QueryResult = {
  rows: QueryResultRow[]
  rowsAffected?: number
  lastInsertRowid?: unknown
}

export interface ReadClient {
  execute(statement: InStatement | string): Promise<QueryResult>
  batch(statements: InStatement[], mode?: "read" | "write"): Promise<QueryResult[]>
  close?(): void | Promise<void>
}

export interface Transaction {
  execute(statement: InStatement | string): Promise<QueryResult>
  batch(statements: InStatement[], mode?: "read" | "write"): Promise<QueryResult[]>
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): void
}

export interface Client extends ReadClient {
  transaction(mode?: "read" | "write"): Promise<Transaction>
}
