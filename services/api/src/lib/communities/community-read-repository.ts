import type { Client, QueryResultRow } from "../sql-client"
import {
  getCommunityRowById,
  getCommunityRowByIdentifierCandidates,
  getCommunityRowByRouteSlug,
  getCommunityRowByNamespaceVerificationId,
  getJobRowById,
  getLatestCommunityProvisioningJobRow,
  listActiveCommunityRows,
  searchActiveCommunityRows,
} from "../auth/auth-db-community-queries"
import type {
  CommunityDatabaseBindingRow,
  CommunityRow,
  JobRow,
} from "../auth/auth-db-rows"
import type { CommunityNamespaceAttachmentRow } from "./community-repository-types"
import { requiredString } from "../sql-row"
import {
  evaluateJoinedRoot,
  projectDelegationResponse,
  ROOT_DELEGATION_JOIN_SQL,
  ROOT_DELEGATION_SELECT_SQL,
  type RootDelegationJoinRow,
} from "@pirate/hns-delegation"

function delegationJoinRow(row: QueryResultRow): RootDelegationJoinRow | null {
  if (row.delegation_root_label == null) return null
  return {
    delegation_root_label: requiredString(row, "delegation_root_label"),
    delegation_rollover_state: requiredString(row, "delegation_rollover_state") as RootDelegationJoinRow["delegation_rollover_state"],
    delegation_pending_evidence_kind: row.delegation_pending_evidence_kind as RootDelegationJoinRow["delegation_pending_evidence_kind"],
    delegation_authority_redundancy_ok: row.delegation_authority_redundancy_ok as RootDelegationJoinRow["delegation_authority_redundancy_ok"],
    delegation_authority_redundancy_evidence_class: row.delegation_authority_redundancy_evidence_class as RootDelegationJoinRow["delegation_authority_redundancy_evidence_class"],
    delegation_redundancy_observed_at: row.delegation_redundancy_observed_at as RootDelegationJoinRow["delegation_redundancy_observed_at"],
    delegation_canonical_routing_eligible: row.delegation_canonical_routing_eligible as RootDelegationJoinRow["delegation_canonical_routing_eligible"],
    delegation_routing_hard_denied: row.delegation_routing_hard_denied as RootDelegationJoinRow["delegation_routing_hard_denied"],
    delegation_last_parent_observation_id: row.delegation_last_parent_observation_id as RootDelegationJoinRow["delegation_last_parent_observation_id"],
    delegation_parent_observation_id: row.delegation_parent_observation_id as RootDelegationJoinRow["delegation_parent_observation_id"],
    delegation_security: row.delegation_security as RootDelegationJoinRow["delegation_security"],
    delegation_parent_ds_matches_live_dnskey: row.delegation_parent_ds_matches_live_dnskey as RootDelegationJoinRow["delegation_parent_ds_matches_live_dnskey"],
    delegation_authoritative_dnssec_valid: row.delegation_authoritative_dnssec_valid as RootDelegationJoinRow["delegation_authoritative_dnssec_valid"],
    delegation_observed_at: row.delegation_observed_at as RootDelegationJoinRow["delegation_observed_at"],
    delegation_earliest_rrsig_expires_at: row.delegation_earliest_rrsig_expires_at as RootDelegationJoinRow["delegation_earliest_rrsig_expires_at"],
  }
}

export async function getCommunityById(client: Client, communityId: string): Promise<CommunityRow | null> {
  return getCommunityRowById(client, communityId)
}

export async function getCommunityByRouteSlug(client: Client, routeSlug: string): Promise<CommunityRow | null> {
  return getCommunityRowByRouteSlug(client, routeSlug)
}

export async function getCommunityByIdentifierCandidates(
  client: Client,
  candidates: string[],
): Promise<CommunityRow | null> {
  return getCommunityRowByIdentifierCandidates(client, candidates)
}

export async function getCommunityByNamespaceVerificationId(
  client: Client,
  namespaceVerificationId: string,
): Promise<CommunityRow | null> {
  return getCommunityRowByNamespaceVerificationId(client, namespaceVerificationId)
}

export async function listCommunityNamespaceAttachments(
  client: Client,
  communityId: string,
): Promise<CommunityNamespaceAttachmentRow[]> {
  const now = new Date().toISOString()
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new TypeError("invalid namespace attachment evaluation time")
  const result = await client.execute({
    sql: `
      SELECT cnb.namespace_verification_id, cnb.namespace_role,
             nv.family, nv.normalized_root_label,
             ${ROOT_DELEGATION_SELECT_SQL},
             CASE
               WHEN nv.status = 'disputed' THEN 'disputed'
               WHEN nv.expires_at <= ?2 THEN 'expired'
               WHEN nv.status != 'verified' OR nv.club_attach_allowed != 1 THEN 'stale'
               ELSE 'verified'
             END AS verification_status
      FROM community_namespace_bindings cnb
      JOIN namespace_verifications nv
        ON nv.namespace_verification_id = cnb.namespace_verification_id
      ${ROOT_DELEGATION_JOIN_SQL}
      WHERE cnb.community_id = ?1
        AND cnb.status = 'active'
      ORDER BY CASE cnb.namespace_role WHEN 'primary' THEN 0 ELSE 1 END,
               cnb.created_at ASC,
               cnb.namespace_verification_id ASC
    `,
    args: [communityId, now],
  })
  return result.rows.map((row) => ({
    namespaceVerificationId: requiredString(row, "namespace_verification_id"),
    namespaceRole: requiredString(row, "namespace_role") as CommunityNamespaceAttachmentRow["namespaceRole"],
    family: requiredString(row, "family") as CommunityNamespaceAttachmentRow["family"],
    normalizedRootLabel: requiredString(row, "normalized_root_label"),
    verificationStatus: requiredString(row, "verification_status") as CommunityNamespaceAttachmentRow["verificationStatus"],
    delegation: requiredString(row, "family") === "hns"
      ? projectDelegationResponse(evaluateJoinedRoot(
          delegationJoinRow(row),
          nowMs,
        ))
      : null,
  }))
}

export async function listActiveCommunities(
  client: Client,
  input?: {
    limit?: number
    requireReadyRouting?: boolean
    communityIds?: string[]
  },
): Promise<CommunityRow[]> {
  return listActiveCommunityRows(client, input)
}

export async function searchActiveCommunities(
  client: Client,
  input: {
    query: string
    limit: number
  },
): Promise<CommunityRow[]> {
  return searchActiveCommunityRows(client, input)
}

export async function getPrimaryCommunityDatabaseBinding(
  client: Client,
  communityId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  void client
  void communityId
  return null
}

export async function getJobById(client: Client, jobId: string): Promise<JobRow | null> {
  return getJobRowById(client, jobId)
}

export async function getLatestCommunityProvisioningJob(
  client: Client,
  communityId: string,
): Promise<JobRow | null> {
  return getLatestCommunityProvisioningJobRow(client, communityId)
}
