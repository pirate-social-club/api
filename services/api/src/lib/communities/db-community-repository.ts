import type { Client } from "../sql-client"
import { makeId } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { getCommunityPostProjectionRowByPostId } from "../auth/auth-db-queries"
import type {
  CommunityDbCredentialRow,
  CommunityDatabaseBindingRow,
  CommunityRegistryAttemptRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "../auth/auth-db-rows"
import type { Env } from "../../types"

export {
  getCommunityById,
  getCommunityByNamespaceVerificationId,
  getPrimaryCommunityDatabaseBinding,
  getActiveCommunityDbCredential,
  getJobById,
  getLatestCommunityProvisioningJob,
} from "./community-read-repository"

export {
  createCommunityProvisioningRequest,
  retryCommunityProvisioningRequest,
  markCommunityProvisioningSucceeded,
  persistProvisionedCommunityDatabaseAccess,
  markCommunityProvisioningFailed,
} from "./community-provisioning-repository"

export {
  createCommunityRegistryAttempt,
  markCommunityRegistryAttemptFailed,
  createCommunityRegistryPublicationRequest,
  markCommunityRegistryPublicationSucceeded,
  markCommunityRegistryPublicationFailed,
} from "./community-registry-repository"

export { recordCommunityPostProjection } from "./community-post-projection-repository"

export {
  attachNamespaceToCommunity,
  setPendingNamespaceVerificationSession,
} from "./community-mutation-repository"

import {
  getCommunityById,
  getCommunityByNamespaceVerificationId,
  getPrimaryCommunityDatabaseBinding,
  getActiveCommunityDbCredential,
  getJobById,
  getLatestCommunityProvisioningJob,
} from "./community-read-repository"
import {
  createCommunityProvisioningRequest,
  retryCommunityProvisioningRequest,
  markCommunityProvisioningSucceeded,
  persistProvisionedCommunityDatabaseAccess,
  markCommunityProvisioningFailed,
} from "./community-provisioning-repository"
import {
  createCommunityRegistryAttempt,
  markCommunityRegistryAttemptFailed,
  createCommunityRegistryPublicationRequest,
  markCommunityRegistryPublicationSucceeded,
  markCommunityRegistryPublicationFailed,
} from "./community-registry-repository"
import { recordCommunityPostProjection } from "./community-post-projection-repository"
import {
  attachNamespaceToCommunity,
  setPendingNamespaceVerificationSession,
} from "./community-mutation-repository"

export async function getLatestCommunityRegistryPublicationJob(
  client: Client,
  communityId: string,
): Promise<JobRow | null> {
  const { getLatestCommunityRegistryPublicationJobRow } = await import("../auth/auth-db-queries")
  return getLatestCommunityRegistryPublicationJobRow(client, communityId)
}

export async function getCommunityPostProjectionByPostId(
  client: Client,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  return getCommunityPostProjectionRowByPostId(client, postId)
}

export interface CommunityRepository {
  getCommunityById(communityId: string): Promise<CommunityRow | null>
  getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null>
  getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null>
  getActiveCommunityDbCredential(communityDatabaseBindingId: string): Promise<CommunityDbCredentialRow | null>
  getJobById(jobId: string): Promise<JobRow | null>
  getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null>
  getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null>
  createCommunityRegistryAttempt(input: {
    registryAttemptId?: string
    actorUserId: string
    namespaceVerificationId: string
    normalizedRootLabel: string
    actorPrimaryWalletSnapshot?: string | null
    actorGovernanceAddressSnapshot?: string | null
    createdAt: string
  }): Promise<CommunityRegistryAttemptRow>
  markCommunityRegistryAttemptFailed(input: {
    registryAttemptId: string
    failureCode: string
    updatedAt: string
  }): Promise<void>
  recordCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    projectedPayloadJson: string
    actorUserId: string
    createdAt: string
  }): Promise<CommunityPostProjectionRow>
  createCommunityProvisioningRequest(input: {
    communityId: string
    communityDatabaseBindingId: string
    registryAttemptId: string | null
    jobId: string
    creatorUserId: string
    displayName: string
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }>
  retryCommunityProvisioningRequest(input: {
    communityId: string
    fallbackBindingId: string
    registryAttemptId: string
    jobId: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }>
  markCommunityProvisioningSucceeded(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }>
  persistProvisionedCommunityDatabaseAccess(input: {
    communityDatabaseBindingId: string
    communityDbCredentialId: string
    organizationSlug: string
    groupName: string
    groupId: string | null
    databaseName: string
    databaseId: string | null
    databaseUrl: string
    location: string | null
    tokenName: string
    encryptedToken: string
    encryptionKeyVersion: number
    issuedAt: string
    expiresAt: string | null
    updatedAt: string
  }): Promise<void>
  markCommunityProvisioningFailed(input: {
    communityId: string
    jobId: string
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void>
  createCommunityRegistryPublicationRequest(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    createdAt: string
  }): Promise<JobRow>
  markCommunityRegistryPublicationSucceeded(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }>
  markCommunityRegistryPublicationFailed(input: {
    communityId: string
    registryAttemptId: string
    jobId: string | null
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void>
  attachNamespaceToCommunity(input: {
    communityId: string
    namespaceVerificationId: string
    routeSlug: string
    updatedAt: string
  }): Promise<CommunityRow>
  setPendingNamespaceVerificationSession(input: {
    communityId: string
    sessionId: string | null
    updatedAt: string
  }): Promise<void>
}

export class DatabaseCommunityRepository implements CommunityRepository {
  constructor(private readonly client: Client) {}

  async getCommunityById(communityId: string): Promise<CommunityRow | null> {
    return getCommunityById(this.client, communityId)
  }

  async getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null> {
    return getCommunityByNamespaceVerificationId(this.client, namespaceVerificationId)
  }

  async getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null> {
    return getPrimaryCommunityDatabaseBinding(this.client, communityId)
  }

  async getActiveCommunityDbCredential(communityDatabaseBindingId: string): Promise<CommunityDbCredentialRow | null> {
    return getActiveCommunityDbCredential(this.client, communityDatabaseBindingId)
  }

  async getJobById(jobId: string): Promise<JobRow | null> {
    return getJobById(this.client, jobId)
  }

  async getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null> {
    return getLatestCommunityProvisioningJob(this.client, communityId)
  }

  async getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null> {
    return getCommunityPostProjectionByPostId(this.client, postId)
  }

  async createCommunityRegistryAttempt(input: {
    registryAttemptId?: string
    actorUserId: string
    namespaceVerificationId: string
    normalizedRootLabel: string
    actorPrimaryWalletSnapshot?: string | null
    actorGovernanceAddressSnapshot?: string | null
    createdAt: string
  }): Promise<CommunityRegistryAttemptRow> {
    return createCommunityRegistryAttempt(this.client, {
      registryAttemptId: input.registryAttemptId ?? makeId("rga"),
      actorUserId: input.actorUserId,
      actorPrimaryWalletSnapshot: input.actorPrimaryWalletSnapshot ?? null,
      actorGovernanceAddressSnapshot: input.actorGovernanceAddressSnapshot ?? null,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: input.normalizedRootLabel,
      createdAt: input.createdAt,
    })
  }

  async markCommunityRegistryAttemptFailed(input: {
    registryAttemptId: string
    failureCode: string
    updatedAt: string
  }): Promise<void> {
    return markCommunityRegistryAttemptFailed(this.client, input)
  }

  async recordCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    projectedPayloadJson: string
    actorUserId: string
    createdAt: string
  }): Promise<CommunityPostProjectionRow> {
    return recordCommunityPostProjection(this.client, input)
  }

  async createCommunityProvisioningRequest(input: {
    communityId: string
    communityDatabaseBindingId: string
    registryAttemptId: string | null
    jobId: string
    creatorUserId: string
    displayName: string
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }> {
    return createCommunityProvisioningRequest(this.client, input)
  }

  async retryCommunityProvisioningRequest(input: {
    communityId: string
    fallbackBindingId: string
    registryAttemptId: string
    jobId: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }> {
    return retryCommunityProvisioningRequest(this.client, input)
  }

  async markCommunityProvisioningSucceeded(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }> {
    return markCommunityProvisioningSucceeded(this.client, input)
  }

  async persistProvisionedCommunityDatabaseAccess(input: {
    communityDatabaseBindingId: string
    communityDbCredentialId: string
    organizationSlug: string
    groupName: string
    groupId: string | null
    databaseName: string
    databaseId: string | null
    databaseUrl: string
    location: string | null
    tokenName: string
    encryptedToken: string
    encryptionKeyVersion: number
    issuedAt: string
    expiresAt: string | null
    updatedAt: string
  }): Promise<void> {
    return persistProvisionedCommunityDatabaseAccess(this.client, input)
  }

  async markCommunityProvisioningFailed(input: {
    communityId: string
    jobId: string
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void> {
    return markCommunityProvisioningFailed(this.client, input)
  }

  async createCommunityRegistryPublicationRequest(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    createdAt: string
  }): Promise<JobRow> {
    return createCommunityRegistryPublicationRequest(this.client, input)
  }

  async markCommunityRegistryPublicationSucceeded(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }> {
    return markCommunityRegistryPublicationSucceeded(this.client, input)
  }

  async markCommunityRegistryPublicationFailed(input: {
    communityId: string
    registryAttemptId: string
    jobId: string | null
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void> {
    return markCommunityRegistryPublicationFailed(this.client, input)
  }

  async attachNamespaceToCommunity(input: {
    communityId: string
    namespaceVerificationId: string
    routeSlug: string
    updatedAt: string
  }): Promise<CommunityRow> {
    return attachNamespaceToCommunity(this.client, input)
  }

  async setPendingNamespaceVerificationSession(input: {
    communityId: string
    sessionId: string | null
    updatedAt: string
  }): Promise<void> {
    return setPendingNamespaceVerificationSession(this.client, input)
  }
}

export function getCommunityRepository(env: Env): CommunityRepository {
  return new DatabaseCommunityRepository(getControlPlaneClient(env))
}
