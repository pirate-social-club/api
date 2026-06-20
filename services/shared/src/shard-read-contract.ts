/**
 * RPC contract between the API Worker and the community D1 shard Worker
 * (Turso→D1 PR2, read-only). Shared so both sides compile against one shape.
 *
 * READ-ONLY BY DESIGN: there is no mutation/transaction/write-batch method here.
 * Adding a write surface is PR3 and must be a deliberate, separate contract
 * change — not an incremental addition to this type.
 *
 * The SQL/result shapes mirror the API's `sql-client` `InStatement`/`QueryResult`
 * (structurally identical, so values pass through the binding without mapping),
 * but are redeclared here so the shard Worker does not depend on the API package.
 */

export type ShardSqlStatement = {
  sql: string
  args?: unknown[]
}

export type ShardQueryResultRow = Record<string, unknown>

export type ShardQueryResult = {
  rows: ShardQueryResultRow[]
  rowsAffected?: number
  lastInsertRowid?: unknown
}

export type ShardReadRequest = {
  /** Community whose shard DB is being read (for audit/log + future sharding). */
  communityId: string
  /** D1 binding name on the shard. The shard re-validates this against its own
   * allowlist of bound namespaces — the control-plane row is NOT trusted alone. */
  bindingName: string
  statement: ShardSqlStatement | string
}

export type ShardBatchReadRequest = {
  communityId: string
  bindingName: string
  statements: ShardSqlStatement[]
}

export interface ShardReadRpc {
  execute(input: ShardReadRequest): Promise<ShardResult<ShardQueryResult>>
  batch(input: ShardBatchReadRequest): Promise<ShardResult<ShardQueryResult[]>>
}

/**
 * PR3 write surface. A community write transaction is buffered on the API side
 * and committed as ONE atomic D1 `batch()` — D1 has no interactive transactions,
 * and the community write-tx bodies are write-only atomic units, so this maps
 * cleanly. `statements` run atomically (all-or-nothing) in order. DML only:
 * the shard rejects DDL/PRAGMA/ATTACH (schema is managed by migrations, not the
 * runtime write path).
 */
export type ShardWriteRequest = {
  communityId: string
  bindingName: string
  statements: ShardSqlStatement[]
}

export interface ShardWriteRpc {
  batchWrite(input: ShardWriteRequest): Promise<ShardResult<ShardQueryResult[]>>
}

/**
 * Full shard RPC surface, as seen by the API across the service binding. The
 * shard's `CommunityD1Shard` WorkerEntrypoint implements this; the API types its
 * `COMMUNITY_D1_SHARD` binding as this interface — so neither side imports the
 * other's package, only this shared contract.
 */
export interface ShardRpc extends ShardReadRpc, ShardWriteRpc, ShardPoolRpc, ShardBootstrapRpc, ShardAdminRpc {}

/**
 * Step 2 of the D1-native workstream. Allocates a D1 binding from the shard's
 * pool (the `d1_pool` table; see D1-NATIVE-PROVISIONING-DESIGN.md §3.3, §4.1).
 * Idempotent on `communityId`: repeated calls for the same community return
 * the same binding, with `allocated: false` on subsequent calls. Concurrent
 * calls for the same community are handled by the UNIQUE(community_id) catch
 * — both succeed with the same binding, exactly one reports `allocated: true`.
 */
export type ShardBindRequest = {
  communityId: string
  /** ISO timestamp; recorded as allocated_at on the pool row. */
  now: string
}

export type ShardBindResponse = {
  /** The binding allocated to (or already held by) communityId. */
  bindingName: string
  /** The shard's worker id; the API writes this to community_database_routing.shard_worker_id. */
  shardWorkerId: string
  /** True if this call performed the allocation; false if the binding was already held. */
  allocated: boolean
}

export interface ShardPoolRpc {
  communityD1Bind(input: ShardBindRequest): Promise<ShardResult<ShardBindResponse>>
}

/**
 * Step 3 of the D1-native workstream. Loads the community schema + snapshot
 * rows into the allocated D1 binding via an atomic `batch()`. Idempotent on
 * retry: if `last_loaded_at` is already set for this binding, the load is a
 * no-op. The shard re-validates the pool row before any write (the §4.2
 * invariant against the release+reallocate window) and sets
 * `last_loaded_at = now()` on full success. DDL allowed (CREATE TABLE IF NOT
 * EXISTS + INSERT only) — the existing `WRITE_NOT_ALLOWED` guard is too strict
 * for bootstrap; a separate `isBootstrapAllowedStatement` guard applies here.
 */
export type ShardLoadSnapshotRequest = {
  communityId: string
  bindingName: string
  /** Ordered D1 statements: schema DDL first, then snapshot rows. */
  statements: ShardSqlStatement[]
}

export type ShardLoadSnapshotResponse = {
  /** Total rows affected across the batch (DDL counts as 0, INSERTs as their count). */
  rowsAffected: number
  /**
   * True if this call performed the load; false if it was a no-op because
   * `last_loaded_at` was already set (idempotent re-run). The retry path in
   * `resolveProvisioningRetryAction` calls this twice for the same community
   * — the second call is a no-op.
   */
  loaded: boolean
}

export interface ShardBootstrapRpc {
  communityD1LoadSnapshot(input: ShardLoadSnapshotRequest): Promise<ShardResult<ShardLoadSnapshotResponse>>
}

/**
 * Admin RPCs (step 5 reconciler). These are SERVICE-level authenticated — the
 * caller proves it with a shared `adminToken` (a real wrangler secret), NOT the
 * per-community `(communityId, bindingName)` authorization the read/write RPCs
 * use. The reconciler is not impersonating a community: it inspects pool rows,
 * drops a half-loaded community's tables, and frees pool bindings — operations
 * no per-community caller may perform. `communityD1Reset` and
 * `communityD1Release` are DESTRUCTIVE, which is exactly why they sit behind a
 * secret rather than the identifier-based auth.
 */
export type ShardAdminGetPoolRowRequest = {
  adminToken: string
  bindingName: string
}

export type ShardAdminGetPoolRowResponse = {
  /** Null if no pool row exists for this binding. */
  row: {
    bindingName: string
    communityId: string | null
    allocatedAt: string | null
    lastLoadedAt: string | null
    lastError: string | null
    releasedAt: string | null
    version: number
  } | null
}

export type ShardAdminResetRequest = {
  adminToken: string
  bindingName: string
}

export type ShardAdminResetResponse = {
  /** Number of user tables dropped from the community D1. */
  tablesDropped: number
}

export type ShardAdminReleaseRequest = {
  adminToken: string
  bindingName: string
  /** ISO timestamp recorded as `released_at` (starts the §5 quarantine window). */
  now: string
}

export type ShardAdminReleaseResponse = {
  /** True if a row was freed; false if the binding had no allocated row. */
  released: boolean
}

export interface ShardAdminRpc {
  communityD1GetPoolRow(input: ShardAdminGetPoolRowRequest): Promise<ShardResult<ShardAdminGetPoolRowResponse>>
  communityD1Reset(input: ShardAdminResetRequest): Promise<ShardResult<ShardAdminResetResponse>>
  communityD1Release(input: ShardAdminReleaseRequest): Promise<ShardResult<ShardAdminReleaseResponse>>
}

/**
 * Discriminated-union return type for all shard RPCs. The shard returns errors
 * as VALUES (not thrown) so they survive the WorkerEntrypoint boundary
 * losslessly. The Cloudflare Workers RPC layer strips custom properties from
 * thrown `Error` subclasses across the boundary, so `{ ok: false, code }` is
 * the only way the API can distinguish `shard_pool_write_conflict` (retry)
 * from `shard_pool_exhausted` (fail to ops) from `shard_binding_not_allowed`
 * (security deny) — see D1-NATIVE-PROVISIONING-DESIGN.md §4.1 acceptance
 * criteria. Throwing stays for genuinely unexpected errors (the `try`/
 * `catch` in the API remaps those to a generic 500).
 */
export type ShardErrorCode =
  | "shard_unknown_binding"
  | "shard_binding_not_allowed"
  | "shard_read_only_violation"
  | "shard_write_not_allowed"
  | "shard_pool_exhausted"
  | "shard_pool_write_conflict"
  | "shard_binding_not_initialized"
  | "shard_binding_not_allocated"
  | "shard_admin_unauthorized"

export type ShardError = {
  ok: false
  code: ShardErrorCode
  message: string
}

export type ShardResult<T> = { ok: true; value: T } | ShardError

/**
 * HTTP status + retryable mapping for each ShardErrorCode. Single source of
 * truth (D1-NATIVE-PROVISIONING-DESIGN.md §4.1) — any consumer that needs to
 * translate a `ShardError` to an HTTP-shaped decision imports this. The
 * actual `throw new HttpError(...)` lives in each consumer (the shared
 * package has no HTTP dependency; each side's `HttpError` type is its own).
 *
 *   - `shard_binding_not_allowed` → 403, NOT retryable (security deny;
 *     retrying a rejection is pointless).
 *   - `shard_pool_exhausted` / `shard_pool_write_conflict` /
 *     `shard_binding_not_allocated` → 503, retryable. These are transient
 *     (ops allocates more, optimistic-lock contention resolves, the
 *     reconciler re-allocates past the quarantine).
 *   - Everything else → 500, retryable (defensive default).
 *
 * SECURITY-RELEVANT: every API consumer that surfaces a shard error to the
 * HTTP boundary must use this mapping. Do not duplicate the switch — drift
 * between copies is a cross-tenant read or a silent retry of a security
 * deny.
 */
export function mapShardErrorToHttp(code: ShardErrorCode): { status: number; retryable: boolean } {
  switch (code) {
    case "shard_binding_not_allowed":
      return { status: 403, retryable: false }
    case "shard_admin_unauthorized":
      return { status: 403, retryable: false }
    case "shard_pool_exhausted":
    case "shard_pool_write_conflict":
    case "shard_binding_not_allocated":
      return { status: 503, retryable: true }
    default:
      return { status: 500, retryable: true }
  }
}

/** Error codes the shard RPC surface uses (string constants for the ShardErrorCode union). */
export const SHARD_READ_ERROR = {
  /** bindingName is not in the shard's allowlist of bound D1 namespaces. */
  UNKNOWN_BINDING: "shard_unknown_binding",
  /**
   * The (communityId, bindingName) pair is not authorized on this shard: the
   * community is not mapped here, or it maps to a DIFFERENT binding. Guards
   * against a stale/poisoned routing row for community A pointing at community
   * B's (otherwise valid) D1 binding on the same shard.
   */
  BINDING_NOT_ALLOWED: "shard_binding_not_allowed",
  /** A statement failed the shard's read-only guard. */
  READ_ONLY_VIOLATION: "shard_read_only_violation",
  /** A write-path statement was DDL/PRAGMA/connection verb (not allowed at runtime). */
  WRITE_NOT_ALLOWED: "shard_write_not_allowed",
  /** The pool has no free (non-quarantined) binding to allocate. */
  POOL_EXHAUSTED: "shard_pool_exhausted",
  /**
   * Optimistic-lock collision on a pool row during allocation. Transient —
   * the caller retries the whole communityD1Bind call.
   */
  POOL_WRITE_CONFLICT: "shard_pool_write_conflict",
  /**
   * The chosen binding has a d1_pool row but is not actually a bound D1
   * namespace on this Worker (wrangler config drift). The allocator frees
   * the row and retries; this error is for an unrecoverable case.
   */
  BINDING_NOT_INITIALIZED: "shard_binding_not_initialized",
  /**
   * A communityD1LoadSnapshot call was made for a binding whose `d1_pool`
   * row's `community_id` does not match the request's `communityId`, or the
   * row was released (community_id IS NULL). The last line of defense against
   * the release+reallocate window: even if the cache says "this binding is
   * for community X", the pool-table re-validation before the load confirms
   * it.
   */
  BINDING_NOT_ALLOCATED: "shard_binding_not_allocated",
  /**
   * An admin RPC (communityD1GetPoolRow/Reset/Release) was called with a missing
   * or incorrect `adminToken`, or the shard has no SHARD_ADMIN_TOKEN configured
   * (fail-closed). Distinct from BINDING_NOT_ALLOWED — that is per-community
   * authorization; this is the service-level admin gate.
   */
  ADMIN_UNAUTHORIZED: "shard_admin_unauthorized",
} as const
