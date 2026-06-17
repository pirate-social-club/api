import {
  isReadOnlyStatement,
  readOnlyVerb,
  SHARD_READ_ERROR,
  type ShardBatchReadRequest,
  type ShardQueryResult,
  type ShardReadRequest,
  type ShardSqlStatement,
} from "@pirate/api-shared"

/**
 * Pure shard read logic, free of the `cloudflare:workers` runtime import so it is
 * unit-testable under bun. The WorkerEntrypoint in index.ts is a thin wiring
 * shell over `runShardRead` / `runShardBatch`.
 */

export type D1BindingEnv = { [binding: string]: D1Database | undefined }

export class ShardReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "ShardReadError"
  }
}

/**
 * Resolve a D1 binding by name, validated against the shard's OWN bound
 * namespaces (allowlist by capability: only a real D1 has prepare+batch). A
 * stale/poisoned control-plane routing row cannot steer us to an arbitrary
 * binding — unknown names are rejected, not silently served.
 */
export function resolveD1(env: D1BindingEnv, bindingName: string): D1Database {
  const candidate = env[bindingName]
  if (
    !candidate ||
    typeof (candidate as D1Database).prepare !== "function" ||
    typeof (candidate as D1Database).batch !== "function"
  ) {
    throw new ShardReadError(
      SHARD_READ_ERROR.UNKNOWN_BINDING,
      `Unknown or non-D1 binding on this shard: ${bindingName}`,
    )
  }
  return candidate as D1Database
}

function prepareReadOnly(db: D1Database, statement: ShardSqlStatement | string): D1PreparedStatement {
  const sql = typeof statement === "string" ? statement : statement.sql
  const args = typeof statement === "string" ? [] : statement.args ?? []
  if (!isReadOnlyStatement(sql)) {
    throw new ShardReadError(
      SHARD_READ_ERROR.READ_ONLY_VIOLATION,
      `Statement rejected by shard read-only guard: ${readOnlyVerb(sql)}`,
    )
  }
  const prepared = db.prepare(sql)
  return args.length > 0 ? prepared.bind(...args) : prepared
}

function toResult(result: D1Result): ShardQueryResult {
  return {
    rows: (result.results ?? []) as Record<string, unknown>[],
    rowsAffected: result.meta?.changes,
    lastInsertRowid: result.meta?.last_row_id,
  }
}

export async function runShardRead(env: D1BindingEnv, input: ShardReadRequest): Promise<ShardQueryResult> {
  const db = resolveD1(env, input.bindingName)
  const result = await prepareReadOnly(db, input.statement).all()
  return toResult(result)
}

export async function runShardBatch(env: D1BindingEnv, input: ShardBatchReadRequest): Promise<ShardQueryResult[]> {
  const db = resolveD1(env, input.bindingName)
  const prepared = input.statements.map((statement) => prepareReadOnly(db, statement))
  const results = await db.batch(prepared)
  return results.map(toResult)
}
