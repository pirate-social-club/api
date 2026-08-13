import type { DbExecutor } from "../../db-helpers"
import { executeFirst } from "../../db-helpers"
import {
  numberOrNull,
  requiredString,
  stringOrNull,
  type AssetEnforcementRow,
  type AssetPayloadRow,
} from "./row-types"

export async function getActivePrimaryAssetPayload(
  client: DbExecutor,
  assetId: string,
): Promise<AssetPayloadRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT asset_payload_id, asset_id, role, payload_version, status,
             content_blob_ref, payload_format, delivery_behavior, display_filename,
             mime_type, size_bytes, content_hash, created_at, updated_at
      FROM asset_payloads
      WHERE asset_id = ?1
        AND role = 'primary'
        AND status = 'active'
      LIMIT 1
    `,
    args: [assetId],
  })
  if (!row) return null
  return {
    asset_payload_id: requiredString(row, "asset_payload_id"),
    asset_id: requiredString(row, "asset_id"),
    role: requiredString(row, "role") as AssetPayloadRow["role"],
    payload_version: Number(numberOrNull(row, "payload_version")),
    status: requiredString(row, "status") as AssetPayloadRow["status"],
    content_blob_ref: requiredString(row, "content_blob_ref"),
    payload_format: requiredString(row, "payload_format"),
    delivery_behavior: requiredString(row, "delivery_behavior") as AssetPayloadRow["delivery_behavior"],
    display_filename: stringOrNull(row, "display_filename"),
    mime_type: requiredString(row, "mime_type"),
    size_bytes: Number(numberOrNull(row, "size_bytes")),
    content_hash: requiredString(row, "content_hash"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getAssetEnforcement(
  client: DbExecutor,
  assetId: string,
): Promise<AssetEnforcementRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT asset_id, enforcement_state, reason_code, authority_kind, authority_ref,
             moderation_action_id, actor_role, evidence_ref, decided_at, updated_at
      FROM asset_enforcement
      WHERE asset_id = ?1
      LIMIT 1
    `,
    args: [assetId],
  })
  if (!row) return null
  return {
    asset_id: requiredString(row, "asset_id"),
    enforcement_state: requiredString(row, "enforcement_state") as AssetEnforcementRow["enforcement_state"],
    reason_code: stringOrNull(row, "reason_code"),
    authority_kind: requiredString(row, "authority_kind") as AssetEnforcementRow["authority_kind"],
    authority_ref: requiredString(row, "authority_ref"),
    moderation_action_id: stringOrNull(row, "moderation_action_id"),
    actor_role: stringOrNull(row, "actor_role"),
    evidence_ref: stringOrNull(row, "evidence_ref"),
    decided_at: requiredString(row, "decided_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}
