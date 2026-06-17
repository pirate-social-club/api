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

/**
 * The shard's RPC surface, as seen by the API across the service binding. The
 * shard's `CommunityD1Shard` WorkerEntrypoint implements this; the API types its
 * `COMMUNITY_D1_SHARD` binding as this interface — so neither side imports the
 * other's package, only this shared contract. READ-ONLY: no write/transaction.
 */
export interface ShardReadRpc {
  execute(input: ShardReadRequest): Promise<ShardQueryResult>
  batch(input: ShardBatchReadRequest): Promise<ShardQueryResult[]>
}

/** Error codes the shard RPC surface raises (mapped to HttpError on the API side). */
export const SHARD_READ_ERROR = {
  /** bindingName is not in the shard's allowlist of bound D1 namespaces. */
  UNKNOWN_BINDING: "shard_unknown_binding",
  /** A statement failed the shard's read-only guard. */
  READ_ONLY_VIOLATION: "shard_read_only_violation",
} as const
