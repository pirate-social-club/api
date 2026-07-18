import {
  isReadOnlyStatement,
  isWriteAllowedStatement,
  isBootstrapAllowedStatement,
  readOnlyVerb,
  SHARD_READ_ERROR,
  type ShardBatchReadRequest,
  type ShardBindRequest,
  type ShardLoadSnapshotRequest,
  type ShardLoadSnapshotResponse,
  type ShardBindResponse,
  type ShardError,
  type ShardQueryResult,
  type ShardReadRequest,
  type ShardResult,
  type ShardSqlStatement,
  type ShardWriteRequest,
  type ShardAdminGetPoolRowRequest,
  type ShardAdminGetPoolRowResponse,
  type ShardAdminListStaleUnloadedPoolRowsRequest,
  type ShardAdminListStaleUnloadedPoolRowsResponse,
  type ShardAdminPoolStatsRequest,
  type ShardAdminPoolStatsResponse,
  type ShardAdminResetRequest,
  type ShardAdminResetResponse,
  type ShardAdminReleaseRequest,
  type ShardAdminReleaseResponse,
  type ShardAdminDecommissionRequest,
  type ShardAdminDecommissionResponse,
} from "@pirate/api-shared"

/**
 * Pure shard read/write logic, free of the `cloudflare:workers` runtime import so it
 * is unit-testable under bun. The WorkerEntrypoint in index.ts is a thin wiring
 * shell over `runShardRead` / `runShardBatch` / `runShardWrite` / `runShardBind` /
 * `runShardLoadSnapshot`.
 *
 * Step 1 of the D1-native workstream (D1-NATIVE-PROVISIONING-DESIGN.md §3, §5):
 * `assertCommunityBinding` reads from the shard-owned `d1_pool` D1 (the
 * `D1_POOL` binding) instead of a static env JSON. The static
 * `COMMUNITY_D1_BINDING_MAP_JSON` is now ONLY a cold-start seed: it is read once
 * on the first cache miss and INSERT OR IGNORE'd into `d1_pool`. After that, the
 * pool table is the runtime source of truth.
 *
 * Step 2.5: all expected shard failures are returned as VALUES (not thrown) via
 * the `ShardResult<T>` discriminated union. Throwing across a WorkerEntrypoint
 * RPC boundary strips custom `Error` properties — `code` is lost, and the
 * caller cannot distinguish `shard_pool_write_conflict` (retry) from
 * `shard_pool_exhausted` (fail to ops) from `shard_binding_not_allowed`
 * (security deny). The §4.1 acceptance criteria depend on this distinction.
 * Throwing stays for genuinely unexpected errors (D1 driver failures, etc.)
 * which the API remaps to a generic 500.
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
  /**
   * Service-level admin secret (a wrangler secret) gating the admin RPCs
   * (communityD1GetPoolRow/Reset/Release) used by the step-5 reconciler. When
   * unset, all admin RPCs fail closed (ADMIN_UNAUTHORIZED) — destructive ops
   * must never be reachable on a misconfigured shard.
   */
  SHARD_ADMIN_TOKEN?: string
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

function err(code: ShardError["code"], message: string): ShardError {
  return { ok: false, code, message }
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
 * Returns the error (as a value) rather than throwing, so the code survives the
 * WorkerEntrypoint boundary losslessly.
 *
 * Runtime source of truth: the shard-owned `d1_pool` D1 table. Rejects unless
 * the community maps to exactly this binding in the pool — so a
 * stale/poisoned control-plane routing row for community A cannot read
 * community B's (otherwise valid) D1 binding on the same shard.
 */
export async function assertCommunityBinding(
  env: ShardEnv,
  communityId: string,
  bindingName: string,
): Promise<ShardError | null> {
  const now = Date.now()
  const cached = poolCache.get(communityId)
  if (cached && cached.expiresAt > now) {
    if (cached.bindingName !== bindingName) {
      return err(
        SHARD_READ_ERROR.BINDING_NOT_ALLOWED,
        `community ${communityId} is not authorized to read binding ${bindingName} on this shard`,
      )
    }
    return null
  }

  const pool = env.D1_POOL
  if (!pool) {
    return err(
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
    return err(
      SHARD_READ_ERROR.BINDING_NOT_ALLOWED,
      `community ${communityId} is not authorized to read binding ${bindingName} on this shard`,
    )
  }
  return null
}

/**
 * Resolve a D1 binding by name, validated against the shard's OWN bound
 * namespaces (allowlist by capability: only a real D1 has prepare+batch). A
 * stale/poisoned control-plane routing row cannot steer us to an arbitrary
 * binding — unknown names are rejected, not silently served.
 */
export function resolveD1(env: ShardEnv, bindingName: string): D1Database | ShardError {
  const candidate = env[bindingName]
  if (
    !candidate ||
    typeof (candidate as D1Database).prepare !== "function" ||
    typeof (candidate as D1Database).batch !== "function"
  ) {
    return err(
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
  errorCode: ShardError["code"],
  guardName: string,
): D1PreparedStatement | ShardError {
  const sql = typeof statement === "string" ? statement : statement.sql
  const args = typeof statement === "string" ? [] : statement.args ?? []
  if (!allowed(sql)) {
    return err(errorCode, `Statement rejected by shard ${guardName} guard: ${readOnlyVerb(sql)}`)
  }
  const prepared = db.prepare(sql)
  return args.length > 0 ? prepared.bind(...args) : prepared
}

function prepareReadOnly(db: D1Database, statement: ShardSqlStatement | string): D1PreparedStatement | ShardError {
  return prepareGuarded(db, statement, isReadOnlyStatement, SHARD_READ_ERROR.READ_ONLY_VIOLATION, "read-only")
}

function prepareWrite(db: D1Database, statement: ShardSqlStatement): D1PreparedStatement | ShardError {
  return prepareGuarded(db, statement, isWriteAllowedStatement, SHARD_READ_ERROR.WRITE_NOT_ALLOWED, "write")
}

function prepareBootstrap(db: D1Database, statement: ShardSqlStatement): D1PreparedStatement | ShardError {
  return prepareGuarded(
    db,
    statement,
    isBootstrapAllowedStatement,
    SHARD_READ_ERROR.WRITE_NOT_ALLOWED,
    "bootstrap",
  )
}

function toResult(result: D1Result): ShardQueryResult {
  return {
    rows: (result.results ?? []) as Record<string, unknown>[],
    rowsAffected: result.meta?.changes,
    lastInsertRowid: result.meta?.last_row_id,
  }
}

export async function runShardRead(
  env: ShardEnv,
  input: ShardReadRequest,
): Promise<ShardResult<ShardQueryResult>> {
  const authError = await assertCommunityBinding(env, input.communityId, input.bindingName)
  if (authError) return authError
  const dbOrError = resolveD1(env, input.bindingName)
  if (!("prepare" in dbOrError)) return dbOrError
  const prepared = prepareReadOnly(dbOrError, input.statement)
  if (!("all" in prepared)) return prepared
  const result = await prepared.all()
  return { ok: true, value: toResult(result) }
}

export async function runShardBatch(
  env: ShardEnv,
  input: ShardBatchReadRequest,
): Promise<ShardResult<ShardQueryResult[]>> {
  const authError = await assertCommunityBinding(env, input.communityId, input.bindingName)
  if (authError) return authError
  const dbOrError = resolveD1(env, input.bindingName)
  if (!("prepare" in dbOrError)) return dbOrError
  const prepared: D1PreparedStatement[] = []
  for (const statement of input.statements) {
    const p = prepareReadOnly(dbOrError, statement)
    if (!("all" in p)) return p
    prepared.push(p)
  }
  const results = await dbOrError.batch(prepared)
  return { ok: true, value: results.map(toResult) }
}

/**
 * PR3 write path. Runs the buffered statements of one community write transaction
 * as a single ATOMIC D1 batch (all-or-nothing). Same (communityId, bindingName)
 * authorization as reads; DML/SELECT only (DDL/PRAGMA rejected). Empty batch is a
 * no-op (returns []).
 */
export async function runShardWrite(
  env: ShardEnv,
  input: ShardWriteRequest,
): Promise<ShardResult<ShardQueryResult[]>> {
  const authError = await assertCommunityBinding(env, input.communityId, input.bindingName)
  if (authError) return authError
  const dbOrError = resolveD1(env, input.bindingName)
  if (!("prepare" in dbOrError)) return dbOrError
  if (input.statements.length === 0) return { ok: true, value: [] }
  const prepared: D1PreparedStatement[] = []
  for (const statement of input.statements) {
    const p = prepareWrite(dbOrError, statement)
    if (!("all" in p)) return p
    prepared.push(p)
  }
  const results = await dbOrError.batch(prepared)
  return { ok: true, value: results.map(toResult) }
}

/**
 * Maximum retries on optimistic-lock conflict during allocator UPDATE.
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
 * calls for the same community are handled by the UNIQUE(community_id) catch.
 * See D1-NATIVE-PROVISIONING-DESIGN.md §3.3, §4.1, §8.3.
 */
export async function runShardBind(
  env: ShardEnv,
  input: ShardBindRequest,
): Promise<ShardResult<ShardBindResponse>> {
  const pool = env.D1_POOL
  if (!pool) {
    return err(
      SHARD_READ_ERROR.UNKNOWN_BINDING,
      "D1_POOL binding is not configured on this shard",
    )
  }

  const shardWorkerId = String(env.COMMUNITY_D1_SHARD_WORKER_ID ?? "community-d1-shard-staging")

  // 1. Idempotency: if communityId is already in the pool, return its binding.
  const existing = await pool
    .prepare("SELECT binding_name FROM d1_pool WHERE community_id = ?1")
    .bind(input.communityId)
    .first()
  if (existing) {
    return {
      ok: true,
      value: {
        bindingName: String((existing as { binding_name: string }).binding_name),
        shardWorkerId,
        allocated: false,
      },
    }
  }

  // 2. Allocate: pick a free binding (with quarantine filter) and claim it.
  const quarantineThreshold = new Date(Date.now() - QUARANTINE_WINDOW_MS).toISOString()

  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
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
      return err(
        SHARD_READ_ERROR.POOL_EXHAUSTED,
        "d1_pool has no free (non-quarantined) binding to allocate",
      )
    }
    const freeBinding = String((freeRow as { binding_name: string; version: number }).binding_name)
    const freeVersion = Number((freeRow as { binding_name: string; version: number }).version)

    if (!env[freeBinding]) {
      await pool
        .prepare(
          "UPDATE d1_pool SET last_error = ?2, version = version + 1 " +
            "WHERE binding_name = ?1 AND version = ?3",
        )
        .bind(freeBinding, "binding not initialized on this shard", freeVersion)
        .run()
      return err(
        SHARD_READ_ERROR.BINDING_NOT_INITIALIZED,
        `Binding ${freeBinding} has a d1_pool row but is not a bound D1 namespace on this shard`,
      )
    }

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
        return {
          ok: true,
          value: { bindingName: freeBinding, shardWorkerId, allocated: true },
        }
      }
    } catch (e) {
      if (isUniqueCommunityViolation(e)) {
        const winner = await pool
          .prepare("SELECT binding_name FROM d1_pool WHERE community_id = ?1")
          .bind(input.communityId)
          .first()
        if (winner) {
          return {
            ok: true,
            value: {
              bindingName: String((winner as { binding_name: string }).binding_name),
              shardWorkerId,
              allocated: false,
            },
          }
        }
      } else {
        throw e
      }
    }
  }

  return err(
    SHARD_READ_ERROR.POOL_WRITE_CONFLICT,
    "d1_pool allocator exhausted retries on optimistic-lock conflict",
  )
}

/**
 * Step 3 of the D1-native workstream: load the community schema + snapshot
 * rows into the allocated D1 binding. Atomic `batchWrite` of DDL + rows.
 *
 * Three invariants enforced server-side, in addition to the existing
 * `assertCommunityBinding` + `resolveD1`:
 *
 *  1. **Pool-table re-validation before any write (§4.2).** The existing
 *     `assertCommunityBinding` checks the in-memory pool cache, which can be
 *     stale. Before any write, this RPC re-`SELECT community_id FROM d1_pool
 *     WHERE binding_name = ?` and confirms the row's `community_id` matches
 *     `input.communityId`. If the row's `community_id` is NULL (released) or a
 *     different community, reject with `shard_binding_not_allocated`. This is
 *     the last line of defense against the release+reallocate window.
 *  2. **Idempotency on retry.** If `last_loaded_at` is already set for this
 *     binding, the load is a no-op. The retry path in
 *     `resolveProvisioningRetryAction` calls this twice for the same community
 *     — the second call returns `loaded: false` with `rowsAffected: 0` and
 *     leaves `last_loaded_at` unchanged.
 *  3. **Bootstrap guard.** Schema DDL is allowed here (CREATE TABLE IF NOT
 *     EXISTS + INSERT only) via `isBootstrapAllowedStatement`; the existing
 *     `isWriteAllowedStatement` (used by `runShardWrite`) rejects DDL by
 *     design.
 *
 * On full success, sets `last_loaded_at = now()` and clears `last_error` on
 * the pool row. The `provision()` orchestrator (step 4) then advances the
 * routing row from `provisioning` to `ready`.
 *
 * See D1-NATIVE-PROVISIONING-DESIGN.md §4.2, §6.1, §8.4.
 */
export async function runShardLoadSnapshot(
  env: ShardEnv,
  input: ShardLoadSnapshotRequest,
): Promise<ShardResult<ShardLoadSnapshotResponse>> {
  const authError = await assertCommunityBinding(env, input.communityId, input.bindingName)
  if (authError) return authError
  const pool = env.D1_POOL
  if (!pool) {
    return err(
      SHARD_READ_ERROR.UNKNOWN_BINDING,
      "D1_POOL binding is not configured on this shard",
    )
  }

  // 1. Pool-table re-validation (the §4.2 invariant). assertCommunityBinding
  //    checked the cache; this re-reads the pool row to confirm the binding is
  //    still allocated to this community at write time.
  const row = await pool
    .prepare(
      "SELECT community_id, last_loaded_at FROM d1_pool WHERE binding_name = ?1",
    )
    .bind(input.bindingName)
    .first()
  if (!row) {
    return err(
      SHARD_READ_ERROR.BINDING_NOT_ALLOCATED,
      `binding ${input.bindingName} has no d1_pool row — cannot load snapshot`,
    )
  }
  const r = row as { community_id: string | null; last_loaded_at: string | null }
  if (r.community_id !== input.communityId) {
    return err(
      SHARD_READ_ERROR.BINDING_NOT_ALLOCATED,
      `binding ${input.bindingName} is allocated to ${String(r.community_id)} (not ${input.communityId}); refusing to load snapshot`,
    )
  }

  // 2. Idempotency: if already loaded, no-op. Returns the existing
  //    last_loaded_at (the retry path expects an idempotent no-op).
  if (r.last_loaded_at) {
    return { ok: true, value: { rowsAffected: 0, loaded: false } }
  }

  // 3. Bootstrap guard: DDL + INSERTs only, run as one atomic batch.
  const dbOrError = resolveD1(env, input.bindingName)
  if (!("prepare" in dbOrError)) return dbOrError
  if (input.statements.length === 0) {
    // Empty statements + no prior load: still mark loaded (the schema is
    // expected to already be in place via migration; this is a no-op seed).
    await pool
      .prepare(
        "UPDATE d1_pool SET last_loaded_at = ?2, last_error = NULL, version = version + 1 " +
          "WHERE binding_name = ?1 AND last_loaded_at IS NULL",
      )
      .bind(input.bindingName, new Date().toISOString())
      .run()
    return { ok: true, value: { rowsAffected: 0, loaded: true } }
  }
  const prepared: D1PreparedStatement[] = []
  for (const statement of input.statements) {
    const p = prepareBootstrap(dbOrError, statement)
    if (!("all" in p)) return p
    prepared.push(p)
  }
  const results = await dbOrError.batch(prepared)
  const rowsAffected = results.reduce(
    (sum, r) => sum + (r.meta?.changes ?? 0),
    0,
  )

  // 4. Mark loaded on the pool row. Only set last_loaded_at if the batch
  //    succeeded — a partial batch is an atomic D1 failure (all-or-nothing),
  //    so if we reach this point, everything committed.
  await pool
    .prepare(
      "UPDATE d1_pool SET last_loaded_at = ?2, last_error = NULL, version = version + 1 " +
        "WHERE binding_name = ?1",
    )
    .bind(input.bindingName, new Date().toISOString())
    .run()

  return { ok: true, value: { rowsAffected, loaded: true } }
}

// --- Admin RPCs (step 5 reconciler) -----------------------------------------
// Service-level auth: gated by SHARD_ADMIN_TOKEN (a wrangler secret), NOT the
// per-community (communityId, bindingName) authorization. Fail closed when no
// token is configured so destructive ops can never run on a misconfigured shard.

/** Constant-time-ish string compare to avoid leaking length/prefix via timing. */
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Returns a ShardError if the admin token is missing/unconfigured/wrong, else null. */
function requireAdminToken(env: ShardEnv, provided: string): ShardError | null {
  const configured = typeof env.SHARD_ADMIN_TOKEN === "string" ? env.SHARD_ADMIN_TOKEN.trim() : ""
  if (!configured) {
    return err(SHARD_READ_ERROR.ADMIN_UNAUTHORIZED, "shard admin token is not configured")
  }
  if (!provided || !tokensEqual(provided, configured)) {
    return err(SHARD_READ_ERROR.ADMIN_UNAUTHORIZED, "admin token rejected")
  }
  return null
}

function requirePoolDb(env: ShardEnv): D1Database | ShardError {
  const pool = env.D1_POOL
  if (!pool || typeof pool.prepare !== "function") {
    return err(SHARD_READ_ERROR.BINDING_NOT_INITIALIZED, "D1_POOL binding is not configured on this shard")
  }
  return pool
}

function isResettableUserTable(name: string): boolean {
  return !name.startsWith("sqlite_") && !name.startsWith("_cf_") && name !== "schema_migrations"
}

function isResettableMetadataTable(name: string): boolean {
  return name === "schema_migrations"
}

function quoteSqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

type SqliteTableDefinition = { name: string; sql: string }

/** Order child tables before the parents named by their FOREIGN KEY clauses. */
export function orderTablesForDrop(definitions: SqliteTableDefinition[]): string[] {
  const names = new Set(definitions.map((definition) => definition.name))
  const references = new Map<string, Set<string>>()
  const referencePattern = /\bREFERENCES\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/giu
  for (const definition of definitions) {
    const parents = new Set<string>()
    for (const match of definition.sql.matchAll(referencePattern)) {
      const parent = match[1] ?? match[2] ?? match[3] ?? match[4]
      if (parent && parent !== definition.name && names.has(parent)) parents.add(parent)
    }
    references.set(definition.name, parents)
  }

  const remaining = new Set(names)
  const ordered: string[] = []
  while (remaining.size > 0) {
    const referencedParents = new Set<string>()
    for (const child of remaining) {
      for (const parent of references.get(child) ?? []) {
        if (remaining.has(parent)) referencedParents.add(parent)
      }
    }
    const leaves = [...remaining].filter((name) => !referencedParents.has(name)).sort()
    if (leaves.length === 0) {
      // Mutual cycles have no child-first order. The surrounding batch enables
      // deferred FK checks, so deterministic ordering is the safest fallback.
      ordered.push(...[...remaining].sort())
      break
    }
    for (const leaf of leaves) {
      ordered.push(leaf)
      remaining.delete(leaf)
    }
  }
  return ordered
}

/** Admin: read a single pool row (reconciler introspection — keys off last_loaded_at). */
export async function runShardGetPoolRow(
  env: ShardEnv,
  input: ShardAdminGetPoolRowRequest,
): Promise<ShardResult<ShardAdminGetPoolRowResponse>> {
  const authErr = requireAdminToken(env, input.adminToken)
  if (authErr) return authErr
  const pool = requirePoolDb(env)
  if ("ok" in pool) return pool

  const row = await pool
    .prepare(
      "SELECT binding_name, community_id, allocated_at, last_loaded_at, last_error, released_at, version " +
        "FROM d1_pool WHERE binding_name = ?1",
    )
    .bind(input.bindingName)
    .first()

  if (!row) return { ok: true, value: { row: null } }
  const r = row as Record<string, unknown>
  return {
    ok: true,
    value: {
      row: {
        bindingName: String(r["binding_name"]),
        communityId: r["community_id"] == null ? null : String(r["community_id"]),
        allocatedAt: r["allocated_at"] == null ? null : String(r["allocated_at"]),
        lastLoadedAt: r["last_loaded_at"] == null ? null : String(r["last_loaded_at"]),
        lastError: r["last_error"] == null ? null : String(r["last_error"]),
        releasedAt: r["released_at"] == null ? null : String(r["released_at"]),
        version: Number(r["version"] ?? 0),
      },
    },
  }
}

/** Admin: list allocated pool rows that never completed snapshot load. */
export async function runShardListStaleUnloadedPoolRows(
  env: ShardEnv,
  input: ShardAdminListStaleUnloadedPoolRowsRequest,
): Promise<ShardResult<ShardAdminListStaleUnloadedPoolRowsResponse>> {
  const authErr = requireAdminToken(env, input.adminToken)
  if (authErr) return authErr
  const pool = requirePoolDb(env)
  if ("ok" in pool) return pool

  const limit = Number.isInteger(input.limit) && input.limit != null
    ? Math.min(Math.max(input.limit, 1), 100)
    : 25
  const result = await pool
    .prepare(
      "SELECT binding_name, community_id, allocated_at, version " +
        "FROM d1_pool " +
        "WHERE community_id IS NOT NULL " +
        "AND allocated_at IS NOT NULL " +
        "AND allocated_at < ?1 " +
        "AND last_loaded_at IS NULL " +
        "ORDER BY allocated_at ASC, binding_name ASC " +
        "LIMIT ?2",
    )
    .bind(input.allocatedBefore, limit)
    .all()

  return {
    ok: true,
    value: {
      rows: (result.results ?? []).map((row) => {
        const r = row as Record<string, unknown>
        return {
          bindingName: String(r["binding_name"]),
          communityId: String(r["community_id"]),
          allocatedAt: String(r["allocated_at"]),
          version: Number(r["version"] ?? 0),
        }
      }),
    },
  }
}

/**
 * Admin: reset a never-loaded community D1 before releasing its pool binding.
 *
 * SERVER-SIDE SAFETY GATE: refuses unless the binding's `d1_pool` row exists AND
 * `last_loaded_at IS NULL`. This makes the destructive drop safe-by-construction
 * — it can never touch a fully-loaded (live) community even if a buggy reconciler
 * calls it, AND it closes the reconciler's load-vs-reset race: a concurrent
 * provision() retry can set `last_loaded_at` between the reconciler's GetPoolRow
 * read and this call, so we re-check here at drop time. A loaded community is
 * decommissioned via a separate deliberate path, never here.
 *
 * DATA-SAFETY GATE: also refuses if the target D1 contains any resettable
 * user/community tables. `last_loaded_at` is metadata; the table check is the
 * independent guard against migration-seeded or otherwise metadata-corrupt rows.
 */
export async function runShardReset(
  env: ShardEnv,
  input: ShardAdminResetRequest,
): Promise<ShardResult<ShardAdminResetResponse>> {
  const authErr = requireAdminToken(env, input.adminToken)
  if (authErr) return authErr

  const pool = requirePoolDb(env)
  if ("ok" in pool) return pool
  const poolRow = await pool
    .prepare("SELECT last_loaded_at FROM d1_pool WHERE binding_name = ?1")
    .bind(input.bindingName)
    .first()
  if (!poolRow || (poolRow as { last_loaded_at: unknown }).last_loaded_at != null) {
    return err(
      SHARD_READ_ERROR.BINDING_LOADED,
      `refusing to reset ${input.bindingName}: binding is fully loaded or not tracked in d1_pool`,
    )
  }

  const db = resolveD1(env, input.bindingName)
  if ("ok" in db) return db

  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
  const tableNames = (tables.results ?? [])
    .map((t) => String((t as { name: unknown }).name))
  const userTableNames = tableNames.filter(isResettableUserTable)
  if (userTableNames.length > 0) {
    return err(
      SHARD_READ_ERROR.BINDING_NOT_EMPTY,
      `refusing to reset ${input.bindingName}: target D1 contains user tables`,
    )
  }

  const metadataTableNames = tableNames.filter(isResettableMetadataTable)
  if (metadataTableNames.length === 0) return { ok: true, value: { tablesDropped: 0 } }

  await db.batch(metadataTableNames.map((name) => db.prepare(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(name)}`)))
  return { ok: true, value: { tablesDropped: metadataTableNames.length } }
}

/**
 * Admin: irreversibly empty and release an explicitly identified staging binding.
 *
 * This is intentionally separate from runShardReset: reset protects unfinished
 * provisioning and must continue refusing loaded databases. Decommission is
 * guarded by a staging-only kill switch and re-checks the exact community-to-
 * binding mapping in the shard-owned pool before touching the target database.
 */
export async function runShardDecommission(
  env: ShardEnv,
  input: ShardAdminDecommissionRequest,
): Promise<ShardResult<ShardAdminDecommissionResponse>> {
  const authErr = requireAdminToken(env, input.adminToken)
  if (authErr) return authErr
  if (env.STAGING_RECLAIM_ENABLED !== "true") {
    return err(SHARD_READ_ERROR.ADMIN_UNAUTHORIZED, "staging reclaim is disabled")
  }

  const pool = requirePoolDb(env)
  if ("ok" in pool) return pool
  const poolRow = await pool
    .prepare("SELECT community_id FROM d1_pool WHERE binding_name = ?1")
    .bind(input.bindingName)
    .first()
  const mappedCommunityId = String((poolRow as { community_id?: unknown } | null)?.community_id ?? "")
  if (!poolRow || (mappedCommunityId !== input.communityId && mappedCommunityId !== "")) {
    return err(
      SHARD_READ_ERROR.BINDING_NOT_ALLOWED,
      `refusing to decommission ${input.bindingName}: community mapping does not match`,
    )
  }

  const db = resolveD1(env, input.bindingName)
  if ("ok" in db) return db
  const tables = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all()
  const definitions = (tables.results ?? [])
    .map((row) => ({
      name: String((row as { name: unknown }).name),
      sql: String((row as { sql?: unknown }).sql ?? ""),
    }))
    .filter(({ name }) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"))
  const tableNames = orderTablesForDrop(definitions)
  // The target D1 and pool metadata are separate databases, and a Service RPC
  // response can be lost after both commits. Permit a retry to report success
  // only when the pool row has no current tenant and the target is demonstrably
  // empty. This branch performs no shard mutation; any non-empty target still
  // fails closed, while a row mapped to another community was rejected above.
  if (mappedCommunityId === "") {
    if (tableNames.length > 0) {
      return err(
        SHARD_READ_ERROR.BINDING_NOT_EMPTY,
        `refusing to finalize ${input.bindingName}: released target still contains user tables`,
      )
    }
    return { ok: true, value: { tablesDropped: 0, released: false } }
  }
  if (tableNames.length > 0) {
    await db.batch([
      db.prepare("PRAGMA defer_foreign_keys = ON"),
      ...tableNames.map((name) => db.prepare(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(name)}`)),
    ])
  }

  const released = await pool
    .prepare(
      "UPDATE d1_pool SET community_id = NULL, allocated_at = NULL, last_loaded_at = NULL, " +
        "last_error = NULL, released_at = ?3, version = version + 1 " +
        "WHERE binding_name = ?1 AND community_id = ?2",
    )
    .bind(input.bindingName, input.communityId, input.now)
    .run()
  return {
    ok: true,
    value: { tablesDropped: tableNames.length, released: (released.meta?.changes ?? 0) > 0 },
  }
}

/** Admin: free a pool binding (sets community_id NULL + released_at for the §5 quarantine). */
export async function runShardRelease(
  env: ShardEnv,
  input: ShardAdminReleaseRequest,
): Promise<ShardResult<ShardAdminReleaseResponse>> {
  const authErr = requireAdminToken(env, input.adminToken)
  if (authErr) return authErr
  const pool = requirePoolDb(env)
  if ("ok" in pool) return pool

  const result = await pool
    .prepare(
      "UPDATE d1_pool SET community_id = NULL, allocated_at = NULL, last_loaded_at = NULL, " +
        "last_error = NULL, released_at = ?2, version = version + 1 " +
        "WHERE binding_name = ?1 AND community_id IS NOT NULL",
    )
    .bind(input.bindingName, input.now)
    .run()

  return { ok: true, value: { released: (result.meta?.changes ?? 0) > 0 } }
}

/** Admin: aggregate pool capacity using the allocator's exact free/quarantine predicate. */
export async function runShardPoolStats(
  env: ShardEnv,
  input: ShardAdminPoolStatsRequest,
): Promise<ShardResult<ShardAdminPoolStatsResponse>> {
  const authErr = requireAdminToken(env, input.adminToken)
  if (authErr) return authErr
  const pool = requirePoolDb(env)
  if ("ok" in pool) return pool

  const quarantineThreshold = new Date(Date.now() - QUARANTINE_WINDOW_MS).toISOString()
  const row = await pool
    .prepare(
      "SELECT " +
        "COUNT(*) AS total, " +
        "SUM(CASE WHEN community_id IS NOT NULL THEN 1 ELSE 0 END) AS allocated, " +
        "SUM(CASE WHEN community_id IS NULL AND (released_at IS NULL OR released_at < ?1) THEN 1 ELSE 0 END) AS free, " +
        "SUM(CASE WHEN community_id IS NULL AND released_at IS NOT NULL AND released_at >= ?1 THEN 1 ELSE 0 END) AS quarantined " +
        "FROM d1_pool",
    )
    .bind(quarantineThreshold)
    .first()
  const r = row as Record<string, unknown> | null

  return {
    ok: true,
    value: {
      total: Number(r?.["total"] ?? 0),
      allocated: Number(r?.["allocated"] ?? 0),
      free: Number(r?.["free"] ?? 0),
      quarantined: Number(r?.["quarantined"] ?? 0),
    },
  }
}
