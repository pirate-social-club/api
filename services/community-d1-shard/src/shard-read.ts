import {
  isReadOnlyStatement,
  isWriteAllowedStatement,
  readOnlyVerb,
  SHARD_READ_ERROR,
  type ShardBatchReadRequest,
  type ShardQueryResult,
  type ShardReadRequest,
  type ShardSqlStatement,
  type ShardWriteRequest,
} from "@pirate/api-shared"

/**
 * Pure shard read logic, free of the `cloudflare:workers` runtime import so it is
 * unit-testable under bun. The WorkerEntrypoint in index.ts is a thin wiring
 * shell over `runShardRead` / `runShardBatch`.
 */

export type ShardEnv = {
  COMMUNITY_D1_BINDING_MAP_JSON?: string
  [binding: string]: D1Database | string | undefined
}

export class ShardReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "ShardReadError"
  }
}

/** Parse the `(communityId → bindingName)` allowlist; fail-closed to {} on bad/missing JSON. */
function communityBindingMap(env: ShardEnv): Record<string, string> {
  const raw = typeof env.COMMUNITY_D1_BINDING_MAP_JSON === "string" ? env.COMMUNITY_D1_BINDING_MAP_JSON : ""
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // fall through to fail-closed
  }
  return {}
}

/**
 * Authorize a (communityId, bindingName) pair against this shard's allowlist.
 * Rejects unless the community is mapped here AND maps to exactly this binding —
 * so a stale/poisoned routing row for community A cannot read community B's
 * (otherwise valid) D1 binding on the same shard.
 */
export function assertCommunityBinding(env: ShardEnv, communityId: string, bindingName: string): void {
  const expected = communityBindingMap(env)[communityId]
  if (!expected || expected !== bindingName) {
    throw new ShardReadError(
      SHARD_READ_ERROR.BINDING_NOT_ALLOWED,
      `community ${communityId} is not authorized to read binding ${bindingName} on this shard`,
    )
  }
}

/**
 * Resolve a D1 binding by name, validated against the shard's OWN bound
 * namespaces (allowlist by capability: only a real D1 has prepare+batch). A
 * stale/poisoned control-plane routing row cannot steer us to an arbitrary
 * binding — unknown names are rejected, not silently served.
 */
export function resolveD1(env: ShardEnv, bindingName: string): D1Database {
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

function prepareGuarded(
  db: D1Database,
  statement: ShardSqlStatement | string,
  allowed: (sql: string) => boolean,
  errorCode: string,
  guardName: string,
): D1PreparedStatement {
  const sql = typeof statement === "string" ? statement : statement.sql
  const args = typeof statement === "string" ? [] : statement.args ?? []
  if (!allowed(sql)) {
    throw new ShardReadError(errorCode, `Statement rejected by shard ${guardName} guard: ${readOnlyVerb(sql)}`)
  }
  const prepared = db.prepare(sql)
  return args.length > 0 ? prepared.bind(...args) : prepared
}

function prepareReadOnly(db: D1Database, statement: ShardSqlStatement | string): D1PreparedStatement {
  return prepareGuarded(db, statement, isReadOnlyStatement, SHARD_READ_ERROR.READ_ONLY_VIOLATION, "read-only")
}

function prepareWrite(db: D1Database, statement: ShardSqlStatement): D1PreparedStatement {
  return prepareGuarded(db, statement, isWriteAllowedStatement, SHARD_READ_ERROR.WRITE_NOT_ALLOWED, "write")
}

function toResult(result: D1Result): ShardQueryResult {
  return {
    rows: (result.results ?? []) as Record<string, unknown>[],
    rowsAffected: result.meta?.changes,
    lastInsertRowid: result.meta?.last_row_id,
  }
}

export async function runShardRead(env: ShardEnv, input: ShardReadRequest): Promise<ShardQueryResult> {
  assertCommunityBinding(env, input.communityId, input.bindingName)
  const db = resolveD1(env, input.bindingName)
  const result = await prepareReadOnly(db, input.statement).all()
  return toResult(result)
}

export async function runShardBatch(env: ShardEnv, input: ShardBatchReadRequest): Promise<ShardQueryResult[]> {
  assertCommunityBinding(env, input.communityId, input.bindingName)
  const db = resolveD1(env, input.bindingName)
  const prepared = input.statements.map((statement) => prepareReadOnly(db, statement))
  const results = await db.batch(prepared)
  return results.map(toResult)
}

/**
 * PR3 write path. Runs the buffered statements of one community write transaction
 * as a single ATOMIC D1 batch (all-or-nothing). Same (communityId, bindingName)
 * authorization as reads; DML/SELECT only (DDL/PRAGMA rejected). Empty batch is a
 * no-op (returns []).
 */
export async function runShardWrite(env: ShardEnv, input: ShardWriteRequest): Promise<ShardQueryResult[]> {
  assertCommunityBinding(env, input.communityId, input.bindingName)
  const db = resolveD1(env, input.bindingName)
  if (input.statements.length === 0) return []
  const prepared = input.statements.map((statement) => prepareWrite(db, statement))
  const results = await db.batch(prepared)
  return results.map(toResult)
}
