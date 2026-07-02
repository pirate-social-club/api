import type { DbExecutor } from "../db-helpers"
import { firstRow } from "../auth/auth-db-query-helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"

export type CommunityProvisioningState = "provisioning" | "ready" | "degraded" | "decommissioned"

/**
 * Row from the control-plane `community_database_routing` table
 * (migration 0117). This is the binding directory the router reads to decide
 * how to dispatch a community-touching request.
 */
export type CommunityDatabaseRoutingRow = {
  community_id: string
  provisioning_state: CommunityProvisioningState
  shard_worker_id: string | null
  binding_name: string | null
  region: string | null
  migrated_at: string | null
  decommissioned_at: string | null
  last_error_at: string | null
  last_error_message: string | null
  created_at: string
  updated_at: string
}

const ROUTING_ROW_COLUMNS = `
  community_id, provisioning_state, shard_worker_id, binding_name, region,
  migrated_at, decommissioned_at, last_error_at, last_error_message,
  created_at, updated_at
`

export function toCommunityDatabaseRoutingRow(row: unknown): CommunityDatabaseRoutingRow {
  return {
    community_id: requiredString(row, "community_id"),
    provisioning_state: requiredString(row, "provisioning_state") as CommunityProvisioningState,
    shard_worker_id: stringOrNull(rowValue(row, "shard_worker_id")),
    binding_name: stringOrNull(rowValue(row, "binding_name")),
    region: stringOrNull(rowValue(row, "region")),
    migrated_at: stringOrNull(rowValue(row, "migrated_at")),
    decommissioned_at: stringOrNull(rowValue(row, "decommissioned_at")),
    last_error_at: stringOrNull(rowValue(row, "last_error_at")),
    last_error_message: stringOrNull(rowValue(row, "last_error_message")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getCommunityDatabaseRoutingRow(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityDatabaseRoutingRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT ${ROUTING_ROW_COLUMNS}
      FROM community_database_routing
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })

  return row ? toCommunityDatabaseRoutingRow(row) : null
}

export type UpsertD1RoutingRowInput = {
  communityId: string
  shardWorkerId: string
  bindingName: string
  region: string
  now: string
  provisioningState?: CommunityProvisioningState
}

/**
 * Seed (or advance) a `backend='d1'` routing row for a community born on D1.
 *
 * The D1-native provisioning path owns the row's lifecycle: it may write the row
 * at `provisioning_state='provisioning'` while the shard binding is being loaded
 * and then advance it to `'ready'` (or `'degraded'`) once load completes.
 *
 * Each community is allocated its OWN shard binding 1:1 (the binding name is
 * unique to the community) — the shard authorizes the (community_id, bindingName)
 * pair, so isolation is at the binding/database level, not a shared partition.
 *
 * Returns whether the row was inserted or updated.
 */
export async function upsertD1CommunityRoutingRow(
  executor: DbExecutor,
  input: UpsertD1RoutingRowInput,
): Promise<{ written: boolean }> {
  const result = await executor.execute({
    sql: `
      INSERT INTO community_database_routing
        (community_id, provisioning_state, shard_worker_id, binding_name, region,
         created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      ON CONFLICT (community_id) DO UPDATE SET
        provisioning_state = excluded.provisioning_state,
        shard_worker_id = excluded.shard_worker_id,
        binding_name = excluded.binding_name,
        region = excluded.region,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      input.provisioningState ?? "ready",
      input.shardWorkerId,
      input.bindingName,
      input.region,
      input.now,
    ],
  })

  return { written: (result.rowsAffected ?? 0) > 0 }
}

export type StuckD1ProvisioningBinding = {
  communityId: string
  bindingName: string
  shardWorkerId: string
  region: string
}

/**
 * Find `backend='d1'` routing rows stranded at `provisioning_state='provisioning'`
 * past a cutoff — the input to the step-5 reconciler sweep (§6.1). A row is stuck
 * if a `provision()` run crashed after writing the 'provisioning' routing row but
 * before flipping it to 'ready'. A ready/provisioning routing row always carries
 * NON-NULL shard_worker_id / binding_name / region, so the cast is safe.
 *
 * `cutoffIso` is `now - graceWindow` (e.g. 15 min); pass it in for determinism.
 */
export async function findStuckD1ProvisioningBindings(
  executor: DbExecutor,
  cutoffIso: string,
): Promise<StuckD1ProvisioningBinding[]> {
  const result = await executor.execute({
    sql: `
      SELECT community_id, binding_name, shard_worker_id, region
      FROM community_database_routing
      WHERE provisioning_state = 'provisioning'
        AND updated_at < ?1
      ORDER BY updated_at ASC
    `,
    args: [cutoffIso],
  })

  return (result.rows ?? []).map((row) => ({
    communityId: requiredString(row, "community_id"),
    bindingName: requiredString(row, "binding_name"),
    shardWorkerId: requiredString(row, "shard_worker_id"),
    region: requiredString(row, "region"),
  }))
}

/**
 * A community route is "settlement-capable" only when its authoritative
 * control-plane routing state is a fully-ready binding that has not been
 * decommissioned. The unattended booking-settlement cron MUST enumerate from
 * this predicate rather than the generic active-community list: a decommissioned
 * or not-yet-ready route cannot settle. Skipping them here (instead of attempting
 * + failing) keeps the sweep free of spurious settlement errors for routes that
 * were never eligible.
 *
 * `provisioning_state === 'ready'` excludes 'provisioning' (no usable binding yet)
 * and 'degraded' (a known-unhealthy DB should not be hammered by settlement; it
 * recovers to 'ready' before its bookings settle). `decommissioned_at === null`
 * is belt-and-suspenders alongside the 'decommissioned' provisioning state.
 */
export function isSettlementEligibleRoute(
  row: Pick<CommunityDatabaseRoutingRow, "provisioning_state" | "decommissioned_at">,
): boolean {
  return row.provisioning_state === "ready" && row.decommissioned_at === null
}

export type SettlementEligibleCommunity = { community_id: string; created_at: string }

/**
 * Enumerate settlement-capable community routes (see {@link isSettlementEligibleRoute}),
 * ordered oldest-first for stable rotation. The SQL filter mirrors the predicate; results
 * are re-checked through the predicate as defence-in-depth so the cron can never treat a
 * non-eligible route as D1 even if the query and predicate ever drift.
 */
export async function listSettlementEligibleCommunities(
  executor: DbExecutor,
  input?: { limit?: number },
): Promise<SettlementEligibleCommunity[]> {
  const limit = input?.limit
  const result = await executor.execute({
    sql: `
      SELECT community_id, provisioning_state, decommissioned_at, created_at
      FROM community_database_routing
      WHERE provisioning_state = 'ready'
        AND decommissioned_at IS NULL
      ORDER BY created_at ASC, community_id ASC
      ${limit === undefined ? "" : "LIMIT ?1"}
    `,
    args: limit === undefined ? [] : [limit],
  })

  return (result.rows ?? [])
    .filter((row) =>
      isSettlementEligibleRoute({
        provisioning_state: requiredString(row, "provisioning_state") as CommunityProvisioningState,
        decommissioned_at: stringOrNull(rowValue(row, "decommissioned_at")),
      }),
    )
    .map((row) => ({
      community_id: requiredString(row, "community_id"),
      created_at: requiredString(row, "created_at"),
    }))
}
