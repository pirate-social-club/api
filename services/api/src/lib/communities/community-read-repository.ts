import type { Client } from "../sql-client"
import {
  getActiveCommunityDbCredentialRow,
  getCommunityRowById,
  getCommunityRowByNamespaceVerificationId,
  getJobRowById,
  getLatestCommunityProvisioningJobRow,
  getPrimaryCommunityDatabaseBindingRow,
} from "../auth/control-plane-auth-queries"
import type {
  CommunityDbCredentialRow,
  CommunityDatabaseBindingRow,
  CommunityRow,
  JobRow,
} from "../auth/control-plane-auth-rows"

export async function getCommunityById(client: Client, communityId: string): Promise<CommunityRow | null> {
  return getCommunityRowById(client, communityId)
}

export async function getCommunityByNamespaceVerificationId(
  client: Client,
  namespaceVerificationId: string,
): Promise<CommunityRow | null> {
  return getCommunityRowByNamespaceVerificationId(client, namespaceVerificationId)
}

export async function getPrimaryCommunityDatabaseBinding(
  client: Client,
  communityId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  return getPrimaryCommunityDatabaseBindingRow(client, communityId)
}

export async function getActiveCommunityDbCredential(
  client: Client,
  communityDatabaseBindingId: string,
): Promise<CommunityDbCredentialRow | null> {
  return getActiveCommunityDbCredentialRow(client, communityDatabaseBindingId)
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
