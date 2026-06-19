import { isReadOnlyStatement, type ShardResult, type ShardRpc, type ShardSqlStatement } from "@pirate/api-shared"
import { HttpError } from "../errors"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import type { ResolvedCommunityBinding } from "./community-binding-resolver"

/**
 * A `Client` (read + write) backed by the community D1 shard over RPC (PR3
 * cutover). The community write call sites use `client.transaction("write")` —
 * but D1 has NO interactive transactions, only atomic `batch()`. The community
 * write-tx bodies are write-only atomic units (reads/validation happen before
 * the tx, post-processing after), so we BUFFER the tx's statements and `commit()`
 * them as one atomic shard `batchWrite`.
 *
 * CONSTRAINT (verified by the call-site audit): a buffered `tx.execute()` returns
 * an empty result immediately — real results arrive only at commit. A site that
 * reads-and-branches on a statement's result INSIDE a write tx is unsupported and
 * must be refactored to do that read before opening the tx.
 *
 * Step 2.5: the shard returns errors as `ShardResult<T>` values (not thrown),
 * so the custom error codes survive the WorkerEntrypoint RPC boundary. This
 * client unwraps the result and re-throws as an HttpError with the original
 * code preserved.
 */

const EMPTY_RESULT: QueryResult = Object.freeze({ rows: [] }) as QueryResult

function sqlOf(statement: InStatement | string): string {
  return typeof statement === "string" ? statement : statement.sql
}

function toShardStatement(statement: InStatement | string): ShardSqlStatement | string {
  return statement as ShardSqlStatement | string
}

/** Normalize to the write contract shape (string → {sql}); batchWrite needs objects. */
function normalizeWrite(statement: InStatement | string): ShardSqlStatement {
  return typeof statement === "string" ? { sql: statement } : { sql: statement.sql, args: statement.args }
}

/**
 * Unwrap a `ShardResult<T>`: return the value on success, or throw an HttpError
 * with the original code on failure. The code is preserved across the
 * WorkerEntrypoint boundary because the shard returns errors as VALUES
 * (step 2.5), not thrown errors.
 *
 * Status mapping (D1-NATIVE-PROVISIONING-DESIGN.md §4.1):
 *   - `shard_binding_not_allowed` → 403, NOT retryable (security deny).
 *   - `shard_pool_exhausted` / `shard_pool_write_conflict` /
 *     `shard_binding_not_allocated` → 503, retryable. These are transient.
 *   - Everything else → 500, retryable (defensive default).
 */
function unwrap<T>(r: ShardResult<T>): T {
  if (r.ok) return r.value
  let status: number
  let retryable: boolean
  switch (r.code) {
    case "shard_binding_not_allowed":
      status = 403
      retryable = false
      break
    case "shard_pool_exhausted":
    case "shard_pool_write_conflict":
    case "shard_binding_not_allocated":
      status = 503
      retryable = true
      break
    default:
      status = 500
      retryable = true
  }
  throw new HttpError(status, r.code, r.message, retryable)
}

/** Buffers statements and commits them as one atomic D1 batch. */
class BufferingD1WriteTransaction implements Transaction {
  private readonly buffer: Array<InStatement | string> = []
  private finalized = false

  constructor(
    private readonly shard: ShardRpc,
    private readonly communityId: string,
    private readonly bindingName: string,
  ) {}

  private assertOpen(): void {
    if (this.finalized) throw new HttpError(500, "tx_finalized", "D1 shard transaction already committed/rolled back")
  }

  async execute(statement: InStatement | string): Promise<QueryResult> {
    this.assertOpen()
    this.buffer.push(statement)
    return EMPTY_RESULT
  }

  async batch(statements: InStatement[], mode?: "read" | "write"): Promise<QueryResult[]> {
    this.assertOpen()
    if (mode === "read") {
      throw new HttpError(400, "read_only_violation", "read batch inside a D1 write transaction is not supported")
    }
    for (const s of statements) this.buffer.push(s)
    return statements.map(() => EMPTY_RESULT)
  }

  async commit(): Promise<void> {
    this.assertOpen()
    this.finalized = true
    if (this.buffer.length === 0) return
    const r = await this.shard.batchWrite({
      communityId: this.communityId,
      bindingName: this.bindingName,
      statements: this.buffer.map(normalizeWrite),
    })
    unwrap(r)
  }

  async rollback(): Promise<void> {
    // Nothing was sent to D1 yet (buffered) — just drop the buffer.
    this.finalized = true
    this.buffer.length = 0
  }

  close(): void {}
}

/** Reads execute immediately; commit/rollback are no-ops (no atomicity needed). */
class ReadThroughD1Transaction implements Transaction {
  constructor(
    private readonly shard: ShardRpc,
    private readonly communityId: string,
    private readonly bindingName: string,
  ) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    const r = await this.shard.execute({
      communityId: this.communityId,
      bindingName: this.bindingName,
      statement: toShardStatement(statement),
    })
    return unwrap(r)
  }

  async batch(statements: InStatement[]): Promise<QueryResult[]> {
    const r = await this.shard.batch({
      communityId: this.communityId,
      bindingName: this.bindingName,
      statements: statements.map((s) => toShardStatement(s) as ShardSqlStatement),
    })
    return unwrap(r)
  }

  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  close(): void {}
}

export function makeCommunityD1Client(shard: ShardRpc, binding: ResolvedCommunityBinding): Client {
  const bindingName = binding.bindingName
  if (!bindingName) {
    throw new HttpError(500, "binding_not_found", `d1 routing row for ${binding.communityId} has no binding_name`)
  }
  const communityId = binding.communityId

  return {
    execute: async (statement) => {
      if (isReadOnlyStatement(sqlOf(statement))) {
        const r = await shard.execute({ communityId, bindingName, statement: toShardStatement(statement) })
        return unwrap(r)
      }
      const r = await shard.batchWrite({ communityId, bindingName, statements: [normalizeWrite(statement)] })
      return unwrap(r)[0] ?? EMPTY_RESULT
    },
    batch: async (statements, mode) => {
      if (mode === "write") {
        const r = await shard.batchWrite({ communityId, bindingName, statements: statements.map(normalizeWrite) })
        return unwrap(r)
      }
      const r = await shard.batch({
        communityId,
        bindingName,
        statements: statements.map((s) => toShardStatement(s) as ShardSqlStatement),
      })
      return unwrap(r)
    },
    transaction: async (mode) =>
      mode === "read"
        ? new ReadThroughD1Transaction(shard, communityId, bindingName)
        : new BufferingD1WriteTransaction(shard, communityId, bindingName),
    close: () => {},
  }
}
