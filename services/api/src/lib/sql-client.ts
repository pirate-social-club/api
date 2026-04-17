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

export interface Transaction {
  execute(statement: InStatement | string): Promise<QueryResult>
  batch(statements: InStatement[], mode?: "read" | "write"): Promise<QueryResult[]>
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): void
}

export interface Client {
  execute(statement: InStatement | string): Promise<QueryResult>
  batch(statements: InStatement[], mode?: "read" | "write"): Promise<QueryResult[]>
  transaction(mode?: "read" | "write"): Promise<Transaction>
  close?(): void
}
