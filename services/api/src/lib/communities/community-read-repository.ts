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
  getPrimaryCommunityDatabaseBindingRow,
} from "../auth/auth-db-community-queries"
import type {
  CommunityDatabaseBindingRow,
  CommunityRow,
  JobRow,
} from "../auth/auth-db-rows"

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

export async function listActiveCommunities(
  client: Client,
  input?: {
    limit?: number
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
  return getPrimaryCommunityDatabaseBindingRow(client, communityId)
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
