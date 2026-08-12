import type { InStatement, QueryResult, ReadClient } from "./sql-client"

type PendingRead = {
  statement: InStatement
  resolve: (result: QueryResult) => void
  reject: (error: unknown) => void
}

function normalizeStatement(statement: InStatement | string): InStatement {
  return typeof statement === "string" ? { sql: statement } : statement
}

/**
 * Coalesce independent reads queued in the same microtask into one database
 * batch. Dependent reads naturally form a later batch after their first await.
 */
export function createCoalescingReadClient(client: ReadClient): ReadClient {
  let pending: PendingRead[] = []
  let flushScheduled = false

  const flush = async (): Promise<void> => {
    flushScheduled = false
    const reads = pending
    pending = []
    try {
      const results = await client.batch(reads.map((read) => read.statement), "read")
      if (results.length !== reads.length) {
        throw new Error(`Read batch returned ${results.length} results for ${reads.length} statements`)
      }
      for (let index = 0; index < reads.length; index += 1) {
        reads[index]?.resolve(results[index]!)
      }
    } catch (error) {
      for (const read of reads) read.reject(error)
    }
  }

  return {
    execute: (statement) => new Promise<QueryResult>((resolve, reject) => {
      pending.push({ statement: normalizeStatement(statement), resolve, reject })
      if (flushScheduled) return
      flushScheduled = true
      queueMicrotask(() => {
        void flush()
      })
    }),
    batch: (statements, mode) => client.batch(statements, mode),
  }
}
