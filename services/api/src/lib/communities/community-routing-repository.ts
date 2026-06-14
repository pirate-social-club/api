import type { DbExecutor } from "../db-helpers"
import { firstRow } from "../auth/auth-db-query-helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"

export type CommunityBackend = "turso" | "d1"

export type CommunityProvisioningState = "provisioning" | "ready" | "degraded" | "decommissioned"

/**
 * Row from the control-plane `community_database_routing` table
 * (migration 0117). This is the binding directory the router reads to decide
 * how to dispatch a community-touching request.
 */
export type CommunityDatabaseRoutingRow = {
  community_id: string
  backend: CommunityBackend
  provisioning_state: CommunityProvisioningState
  shard_worker_id: string | null
  binding_name: string | null
  region: string | null
  turso_database_binding_id: string | null
  migrated_at: string | null
  decommissioned_at: string | null
  last_error_at: string | null
  last_error_message: string | null
  created_at: string
  updated_at: string
}

const ROUTING_ROW_COLUMNS = `
  community_id, backend, provisioning_state, shard_worker_id, binding_name, region,
  turso_database_binding_id, migrated_at, decommissioned_at, last_error_at, last_error_message,
  created_at, updated_at
`

export function toCommunityDatabaseRoutingRow(row: unknown): CommunityDatabaseRoutingRow {
  return {
    community_id: requiredString(row, "community_id"),
    backend: requiredString(row, "backend") as CommunityBackend,
    provisioning_state: requiredString(row, "provisioning_state") as CommunityProvisioningState,
    shard_worker_id: stringOrNull(rowValue(row, "shard_worker_id")),
    binding_name: stringOrNull(rowValue(row, "binding_name")),
    region: stringOrNull(rowValue(row, "region")),
    turso_database_binding_id: stringOrNull(rowValue(row, "turso_database_binding_id")),
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
