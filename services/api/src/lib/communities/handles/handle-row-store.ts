import type { CommunityHandle, CommunityHandleProtocolIssuance } from "../../../types"
import { nullableUnixSeconds, unixSeconds } from "../../../serializers/time"
import type { DbExecutor } from "../../db-helpers"
import type { QueryResultRow } from "../../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { withHandlePrefix } from "./handle-policy-service"

export const HANDLE_PROTOCOL_ISSUANCE_SELECT = `
  ch.*,
  hpi.public_status AS protocol_issuance_status,
  hpi.sname AS protocol_issuance_sname,
  hpi.parent_space AS protocol_issuance_parent_space,
  hpi.issued_at AS protocol_issuance_issued_at
`

export const HANDLE_PROTOCOL_ISSUANCE_JOIN = `
  LEFT JOIN community_handle_protocol_issuances hpi
    ON hpi.community_handle_id = ch.community_handle_id
`

function serializeProtocolIssuance(row: QueryResultRow): CommunityHandleProtocolIssuance | null {
  const status = stringOrNull(rowValue(row, "protocol_issuance_status"))
  if (!status) {
    return null
  }
  return {
    status,
    sname: requiredString(row, "protocol_issuance_sname"),
    parent_space: requiredString(row, "protocol_issuance_parent_space"),
    issued_at: nullableUnixSeconds(stringOrNull(rowValue(row, "protocol_issuance_issued_at"))),
  }
}

export function serializeHandle(row: QueryResultRow): CommunityHandle {
  const protocolIssuance = serializeProtocolIssuance(row)
  return {
    id: withHandlePrefix("ch", requiredString(row, "community_handle_id")),
    object: "community_handle",
    community: withHandlePrefix("com", requiredString(row, "community_id")),
    namespace: withHandlePrefix("ns", requiredString(row, "namespace_id")),
    user: withHandlePrefix("usr", requiredString(row, "user_id")),
    label: requiredString(row, "label_display"),
    label_normalized: requiredString(row, "label_normalized"),
    status: requiredString(row, "status") as CommunityHandle["status"],
    issuance_source: requiredString(row, "issuance_source") as CommunityHandle["issuance_source"],
    quote: stringOrNull(rowValue(row, "handle_claim_quote_id"))
      ? withHandlePrefix("hcq", String(stringOrNull(rowValue(row, "handle_claim_quote_id"))))
      : null,
    price_cents: requiredNumber(row, "price_cents"),
    currency: "USD",
    pricing_model: stringOrNull(rowValue(row, "pricing_model")) as CommunityHandle["pricing_model"],
    pricing_tier: stringOrNull(rowValue(row, "pricing_tier")),
    settlement_wallet_attachment: stringOrNull(rowValue(row, "settlement_wallet_attachment_id")),
    protocol_owner_wallet_attachment: stringOrNull(rowValue(row, "protocol_owner_wallet_attachment_id")),
    funding_tx_ref: stringOrNull(rowValue(row, "funding_tx_ref")),
    settlement_tx_ref: stringOrNull(rowValue(row, "settlement_tx_ref")),
    lease_started_at: nullableUnixSeconds(stringOrNull(rowValue(row, "lease_started_at"))),
    lease_expires_at: nullableUnixSeconds(stringOrNull(rowValue(row, "lease_expires_at"))),
    ...(protocolIssuance ? { protocol_issuance: protocolIssuance } : {}),
    created: unixSeconds(requiredString(row, "created_at")),
  }
}

export async function getBlockingHandleForLabel(
  executor: DbExecutor,
  namespaceId: string,
  labelNormalized: string,
): Promise<QueryResultRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT *
      FROM community_handles
      WHERE namespace_id = ?1
        AND label_normalized = ?2
        AND status IN ('active', 'reserved')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END
      LIMIT 1
    `,
    args: [namespaceId, labelNormalized],
  })
  return result.rows[0] ?? null
}

export async function getActiveHandleForUser(
  executor: DbExecutor,
  namespaceId: string,
  userId: string,
): Promise<QueryResultRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT ${HANDLE_PROTOCOL_ISSUANCE_SELECT}
      FROM community_handles ch
      ${HANDLE_PROTOCOL_ISSUANCE_JOIN}
      WHERE ch.namespace_id = ?1
        AND ch.user_id = ?2
        AND ch.status = 'active'
      LIMIT 1
    `,
    args: [namespaceId, userId],
  })
  return result.rows[0] ?? null
}
