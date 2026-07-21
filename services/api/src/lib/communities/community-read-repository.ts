import type { Client } from "../sql-client"
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
  const result = await client.execute({
    sql: `
      SELECT cnb.namespace_verification_id, cnb.namespace_role,
             nv.family, nv.normalized_root_label,
             CASE
               WHEN nv.status = 'disputed' THEN 'disputed'
               WHEN nv.expires_at <= ?2 THEN 'expired'
               WHEN nv.status != 'verified' OR nv.club_attach_allowed != 1 THEN 'stale'
               WHEN nv.family = 'hns' AND (
                 nv.pirate_dns_authority_verified != 1 OR nv.pirate_web_routing_allowed != 1
               ) THEN 'stale'
               ELSE 'verified'
             END AS verification_status
      FROM community_namespace_bindings cnb
      JOIN namespace_verifications nv
        ON nv.namespace_verification_id = cnb.namespace_verification_id
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
  }))
}

export async function listActiveCommunities(
  client: Client,
  input?: {
    limit?: number
    requireReadyRouting?: boolean
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
