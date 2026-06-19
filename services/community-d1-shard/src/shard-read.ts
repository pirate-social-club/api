import {
  isReadOnlyStatement,
  isWriteAllowedStatement,
  readOnlyVerb,
  SHARD_READ_ERROR,
  type ShardBatchReadRequest,
  type ShardBindRequest,
  type ShardBindResponse,
  type ShardQueryResult,
  type ShardReadRequest,
  type ShardSqlStatement,
  type ShardWriteRequest,
} from "@pirate/api-shared"

/**
 * Pure shard read/write logic, free of the `cloudflare:workers` runtime import so it
 * is unit-testable under bun. The WorkerEntrypoint in index.ts is a thin wiring
 * shell over `runShardRead` / `runShardBatch` / `runShardWrite`.
 *
 * Step 1 of the D1-native workstream (D1-NATIVE-PROVISIONING-DESIGN.md §3, §5):
 * `assertCommunityBinding` reads from the shard-owned `d1_pool` D1 (the
 * `D1_POOL` binding) instead of a static env JSON. The static
 * `COMMUNITY_D1_BINDING_MAP_JSON` is now ONLY a cold-start seed: it is read once
 * on the first cache miss and INSERT OR IGNORE'd into `d1_pool`. After that, the
 * pool table is the runtime source of truth.
 *
 * The two-gate authorization property is preserved: the control-plane
 * `community_database_routing` row is never trusted on its own — a poisoned row
 * pointing community A at community B's binding is still rejected here, because
 * the shard's pool table has A → A's binding, not A → B's. See §8.2 acceptance
 * criterion.
 */

export type ShardEnv = {
  /**
   * Cold-start seed for `d1_pool`. Read once on the first cache miss; INSERT OR
   * IGNORE'd. After seeding, the pool table is the runtime source of truth and
   * this env var is not consulted again for that isolate (until cache expiry).
   */
  COMMUNITY_D1_BINDING_MAP_JSON?: string
  /**
   * The shard's own worker id, returned in `communityD1Bind` responses so the
   * API can populate `community_database_routing.shard_worker_id`. Defaults to
   * "community-d1-shard-staging" for the staging deploy; can be overridden in
   * wrangler.jsonc for other environments.
   */
  COMMUNITY_D1_SHARD_WORKER_ID?: string
  /** Shard-owned pool metadata D1. The runtime allowlist lives here. */
  D1_POOL?: D1Database
  [binding: string]: D1Database | string | undefined
}

/**
 * Cache TTL for a stable (communityId → bindingName) lookup in the in-memory
 * pool cache. Per-isolate: each Worker isolate holds its own Map.
 */
export const POOL_CACHE_TTL_MS = 60_000

/**
 * Shorter TTL for rows carrying `last_error` (degraded rows): a recovery is
 * observed quickly, without waiting the full stable TTL.
 */
export const POOL_CACHE_SHORT_TTL_MS = 5_000

/**
 * The quarantine window — how long a released binding is kept out of the
 * allocatable free pool (set in step 5 by the reconciler; the column is already
 * in the d1_pool table to avoid a follow-up migration).
 *
 * **MUST exceed POOL_CACHE_TTL_MS above.** The pool cache is an optimization,
 * but a stale cache entry combined with a release+reallocate is a cross-tenant
 * read. The mitigation is the quarantine window: a released binding is not
 * returned to the allocatable free pool until quarantineWindow has elapsed,
 * exceeding the maximum of every cache TTL. Do not change one of these
 * constants without the other.
 */
export const QUARANTINE_WINDOW_MS = 5 * 60 * 1000

type PoolCacheEntry = {
  /** null = community is unknown to the pool (still cached as a negative result) */
  bindingName: string | null
  expiresAt: number
}

// Per-isolate cache of (communityId → bindingName | null) lookups. Module-level
// so it is shared across all calls within an isolate (the hot path is every
// routed read and write; this saves a D1 round-trip per request in the common
// case).
const poolCache = new Map<string, PoolCacheEntry>()

/** Test-only: clear the in-memory pool cache. Production code does not need this. */
export function resetPoolCacheForTests(): void {
  poolCache.clear()
}

export class ShardReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "ShardReadError"
  }
}

/** Parse the (communityId → bindingName) seed JSON; fail-closed to {} on bad/missing JSON. */
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
 * Cold-start: if `d1_pool` is empty, populate it from
 * `COMMUNITY_D1_BINDING_MAP_JSON`. Idempotent: re-running is a no-op
 * (INSERT OR IGNORE on binding_name PK).
 *
 * If a binding in the env JSON has no `wrangler d1_databases` entry on this
 * shard, the seed is skipped for that binding — the pool table only tracks
 * real D1 namespaces.
 *
 * If the env JSON disagrees with an existing pool row's `community_id`, the
 * existing row wins (the seed is non-authoritative once step 2's allocator
 * lands; before that, the env JSON is the only source and the row was either
 * already seeded with the same value or never existed).
 */
async function ensurePoolSeeded(env: ShardEnv, pool: D1Database): Promise<void> {
  const countRow = await pool.prepare("SELECT COUNT(*) AS n FROM d1_pool").first()
  const count = countRow ? Number((countRow as { n: number | string }).n) : 0
  if (count > 0) return

  const seed = communityBindingMap(env)
  const now = new Date().toISOString()
  for (const [communityId, bindingName] of Object.entries(seed)) {
    if (!env[bindingName]) continue
    await pool
      .prepare(
        "INSERT OR IGNORE INTO d1_pool (binding_name, community_id, allocated_at, version) VALUES (?1, ?2, ?3, 0)",
      )
      .bind(bindingName, communityId, now)
      .run()
  }
}

/**
 * Authorize a (communityId, bindingName) pair against this shard's allowlist.
 *
 * Runtime source of truth: the shard-owned `d1_pool` D1 table (the
 * `D1_POOL` binding). Rejects unless the community maps to exactly this
 * binding in the pool — so a stale/poisoned control-plane routing row for
 * community A cannot read community B's (otherwise valid) D1 binding on the
 * same shard.
 *
 * Performance: backed by an in-memory cache keyed by communityId. Stable
 * rows cache for POOL_CACHE_TTL_MS; rows carrying `last_error` cache for
 * POOL_CACHE_SHORT_TTL_MS so a recovery is observed quickly.
 *
 * The cache is per-isolate (a Map at module scope). Cross-isolate
 * invalidation on a pool-row update is NOT implemented in step 1 — the
 * quarantine window (QUARANTINE_WINDOW_MS) bounds the staleness window
 * instead, so correctness is independent of cross-isolate broadcast.
 */
export async function assertCommunityBinding(
  env: ShardEnv,
  communityId: string,
  bindingName: string,
): Promise<void> {
  const now = Date.now()
  const cached = poolCache.get(communityId)
  if (cached && cached.expiresAt > now) {
    if (cached.bindingName !== bindingName) {
      throw new ShardReadError(
        SHARD_READ_ERROR.BINDING_NOT_ALLOWED,
        `community ${communityId} is not authorized to read binding ${bindingName} on this shard`,
      )
    }
    return
  }

  const pool = env.D1_POOL
  if (!pool) {
    throw new ShardReadError(
      SHARD_READ_ERROR.UNKNOWN_BINDING,
      "D1_POOL binding is not configured on this shard",
    )
  }
  await ensurePoolSeeded(env, pool)

  const row = await pool
    .prepare("SELECT binding_name, last_error FROM d1_pool WHERE community_id = ?1")
    .bind(communityId)
    .first()
  const r = row as { binding_name?: string; last_error?: string | null } | null
  const expected = r?.binding_name
  const isDegraded = !!r?.last_error
  const ttl = isDegraded ? POOL_CACHE_SHORT_TTL_MS : POOL_CACHE_TTL_MS
  poolCache.set(communityId, { bindingName: expected ?? null, expiresAt: now + ttl })

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
  await assertCommunityBinding(env, input.communityId, input.bindingName)
  const db = resolveD1(env, input.bindingName)
  const result = await prepareReadOnly(db, input.statement).all()
  return toResult(result)
}

export async function runShardBatch(env: ShardEnv, input: ShardBatchReadRequest): Promise<ShardQueryResult[]> {
  await assertCommunityBinding(env, input.communityId, input.bindingName)
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
  await assertCommunityBinding(env, input.communityId, input.bindingName)
  const db = resolveD1(env, input.bindingName)
  if (input.statements.length === 0) return []
  const prepared = input.statements.map((statement) => prepareWrite(db, statement))
  const results = await db.batch(prepared)
  return results.map(toResult)
}

/**
 * Maximum retries on optimistic-lock conflict during allocator UPDATE.
 * A concurrent allocator is the only realistic source of conflict; with
 * the free-pool query using ORDER BY binding_name LIMIT 1, conflicts are
 * rare. Five retries is enough to absorb a few concurrent allocations
 * without unbounded spinning.
 */
const MAX_BIND_ATTEMPTS = 5

/**
 * Detect a UNIQUE(community_id) violation on d1_pool.community_id. libsql
 * exposes this as a LibsqlError with rawCode "SQLITE_CONSTRAINT_UNIQUE"
 * and a message containing "UNIQUE constraint failed". We check both to
 * stay robust across libsql versions.
 */
function isUniqueCommunityViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false
  const err = e as { rawCode?: string; code?: string; message?: string }
  if (err.rawCode === "SQLITE_CONSTRAINT_UNIQUE") return true
  if (err.code === "SQLITE_CONSTRAINT_UNIQUE") return true
  if (typeof err.message === "string" && /UNIQUE constraint failed:.*community_id/i.test(err.message)) {
    return true
  }
  return false
}

/**
 * Step 2 of the D1-native workstream: allocate a D1 binding from the shard's
 * pool for `communityId`. Idempotent on `communityId` — repeated calls return
 * the same binding, with `allocated: false` on subsequent calls. Concurrent
 * calls for the same community are handled by the UNIQUE(community_id) catch:
 * the loser re-queries by community_id and returns the winner's binding.
 *
 * Selection: a free binding is one with `community_id IS NULL` AND outside
 * the quarantine window (`released_at IS NULL OR released_at < now() -
 * QUARANTINE_WINDOW_MS`). The quarantine is the §5 mitigation for the
 * stale-cache + release+reallocate cross-tenant hole.
 *
 * Atomicity: the free-binding SELECT and the version-conditional UPDATE are
 * NOT in a single transaction (D1 has none, and a transaction across
 * statements would defeat the point of the optimistic lock). On a
 * version mismatch (0 rows affected), the allocator retries with a fresh
 * SELECT up to MAX_BIND_ATTEMPTS times. On UNIQUE(community_id) violation
 * (concurrent allocator claimed the same communityId between our SELECT
 * and UPDATE), the allocator re-queries and returns the winner's binding.
 *
 * See D1-NATIVE-PROVISIONING-DESIGN.md §3.3, §4.1, §8.3.
 */
export async function runShardBind(env: ShardEnv, input: ShardBindRequest): Promise<ShardBindResponse> {
  const pool = env.D1_POOL
  if (!pool) {
    throw new ShardReadError(
      SHARD_READ_ERROR.UNKNOWN_BINDING,
      "D1_POOL binding is not configured on this shard",
    )
  }

  const shardWorkerId = String(env.COMMUNITY_D1_SHARD_WORKER_ID ?? "community-d1-shard-staging")

  // 1. Idempotency: if communityId is already in the pool, return its binding.
  //    No allocation. This is the path the retry path takes — second
  //    communityD1Bind(X) for the same X returns allocated: false.
  const existing = await pool
    .prepare("SELECT binding_name FROM d1_pool WHERE community_id = ?1")
    .bind(input.communityId)
    .first()
  if (existing) {
    return {
      bindingName: String((existing as { binding_name: string }).binding_name),
      shardWorkerId,
      allocated: false,
    }
  }

  // 2. Allocate: pick a free binding (with quarantine filter) and claim it
  //    with an optimistic-lock UPDATE.
  const quarantineThreshold = new Date(Date.now() - QUARANTINE_WINDOW_MS).toISOString()

  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
    // 2a. Pick a free binding outside the quarantine window.
    const freeRow = await pool
      .prepare(
        "SELECT binding_name, version FROM d1_pool " +
          "WHERE community_id IS NULL " +
          "AND (released_at IS NULL OR released_at < ?1) " +
          "ORDER BY binding_name LIMIT 1",
      )
      .bind(quarantineThreshold)
      .first()
    if (!freeRow) {
      throw new ShardReadError(
        SHARD_READ_ERROR.POOL_EXHAUSTED,
        "d1_pool has no free (non-quarantined) binding to allocate",
      )
    }
    const freeBinding = String((freeRow as { binding_name: string; version: number }).binding_name)
    const freeVersion = Number((freeRow as { binding_name: string; version: number }).version)

    // 2b. Verify the chosen binding is actually a bound D1 namespace on this
    //     Worker (defends against wrangler config drift: a d1_pool row exists
    //     but the binding isn't bound). Mark last_error and return an explicit
    //     code so ops can see it.
    if (!env[freeBinding]) {
      await pool
        .prepare(
          "UPDATE d1_pool SET last_error = ?2, version = version + 1 " +
            "WHERE binding_name = ?1 AND version = ?3",
        )
        .bind(freeBinding, "binding not initialized on this shard", freeVersion)
        .run()
      throw new ShardReadError(
        SHARD_READ_ERROR.BINDING_NOT_INITIALIZED,
        `Binding ${freeBinding} has a d1_pool row but is not a bound D1 namespace on this shard`,
      )
    }

    // 2c. Optimistic-lock UPDATE: claim the binding for this communityId.
    //     If version doesn't match (concurrent allocator raced us), 0 rows
    //     are affected and we retry from 2a.
    try {
      const updateResult = await pool
        .prepare(
          "UPDATE d1_pool SET " +
            "community_id = ?2, allocated_at = ?3, " +
            "released_at = NULL, last_loaded_at = NULL, last_error = NULL, " +
            "version = version + 1 " +
            "WHERE binding_name = ?1 AND version = ?4",
        )
        .bind(freeBinding, input.communityId, input.now, freeVersion)
        .run()

      if (updateResult.meta?.changes && updateResult.meta.changes > 0) {
        return { bindingName: freeBinding, shardWorkerId, allocated: true }
      }
      // 0 rows affected — version mismatch. Retry.
    } catch (e) {
      // UNIQUE(community_id) violation: a concurrent allocator claimed this
      // communityId between our SELECT and UPDATE. Re-query and return the
      // winner's binding with allocated: false.
      if (isUniqueCommunityViolation(e)) {
        const winner = await pool
          .prepare("SELECT binding_name FROM d1_pool WHERE community_id = ?1")
          .bind(input.communityId)
          .first()
        if (winner) {
          return {
            bindingName: String((winner as { binding_name: string }).binding_name),
            shardWorkerId,
            allocated: false,
          }
        }
        // The winner's row was somehow deleted between the violation and our
        // re-query (extremely unlikely). Fall through to retry.
      } else {
        throw e
      }
    }
  }

  throw new ShardReadError(
    SHARD_READ_ERROR.POOL_WRITE_CONFLICT,
    "d1_pool allocator exhausted retries on optimistic-lock conflict",
  )
}
