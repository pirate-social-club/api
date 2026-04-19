import type { Client } from "../sql-client"
import { getControlPlaneClient } from "../runtime-deps"
import {
  getCommunityCommentProjectionRowByCommentId,
  getCommunityPostProjectionRowByPostId,
  listCommunityMembershipProjectionRowsByUserId,
} from "../auth/auth-db-queries"
import type {
  CommunityCommentProjectionRow,
  CommunityDbCredentialRow,
  CommunityDatabaseBindingRow,
  CommunityMembershipProjectionRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "../auth/auth-db-rows"
import type { Env } from "../../types"

export {
  getCommunityById,
  getCommunityByRouteSlug,
  getCommunityByNamespaceVerificationId,
  listActiveCommunities,
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

export { recordCommunityPostProjection } from "./community-post-projection-repository"
export {
  updateCommunityPostProjectionMetrics,
  updateCommunityPostProjectionStatus,
} from "./community-post-projection-repository"
export { recordCommunityCommentProjection } from "./community-comment-projection-repository"
export { upsertCommunityMembershipProjection } from "./community-membership-projection-repository"

export {
  attachNamespaceToCommunity,
  setPendingNamespaceVerificationSession,
} from "./community-mutation-repository"

import {
  getCommunityById,
  getCommunityByRouteSlug,
  getCommunityByNamespaceVerificationId,
  listActiveCommunities,
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
  recordCommunityPostProjection,
  updateCommunityPostProjectionMetrics,
  updateCommunityPostProjectionStatus,
} from "./community-post-projection-repository"
import { recordCommunityCommentProjection } from "./community-comment-projection-repository"
import { upsertCommunityMembershipProjection } from "./community-membership-projection-repository"
import {
  attachNamespaceToCommunity,
  setPendingNamespaceVerificationSession,
} from "./community-mutation-repository"

export async function getCommunityPostProjectionByPostId(
  client: Client,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  return getCommunityPostProjectionRowByPostId(client, postId)
}

export async function getCommunityCommentProjectionByCommentId(
  client: Client,
  commentId: string,
): Promise<CommunityCommentProjectionRow | null> {
  return getCommunityCommentProjectionRowByCommentId(client, commentId)
}

export async function listCommunityMembershipProjectionsByUserId(
  client: Client,
  userId: string,
): Promise<CommunityMembershipProjectionRow[]> {
  return listCommunityMembershipProjectionRowsByUserId(client, userId)
}

export interface CommunityRepository {
  getCommunityById(communityId: string): Promise<CommunityRow | null>
  getCommunityByRouteSlug(routeSlug: string): Promise<CommunityRow | null>
  getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null>
  listActiveCommunities(): Promise<CommunityRow[]>
  getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null>
  getActiveCommunityDbCredential(communityDatabaseBindingId: string): Promise<CommunityDbCredentialRow | null>
  getJobById(jobId: string): Promise<JobRow | null>
  getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null>
  getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null>
  getCommunityCommentProjectionByCommentId(commentId: string): Promise<CommunityCommentProjectionRow | null>
  listCommunityMembershipProjectionsByUserId(userId: string): Promise<CommunityMembershipProjectionRow[]>
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
  recordCommunityCommentProjection(input: {
    communityId: string
    threadRootPostId: string
    sourceCommentId: string
    parentCommentId: string | null
    depth: number
    status: "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    actorUserId: string
    createdAt: string
  }): Promise<CommunityCommentProjectionRow>
  upsertCommunityMembershipProjection(input: {
    communityId: string
    userId: string
    membershipState: CommunityMembershipProjectionRow["membership_state"]
    sourceUpdatedAt: string
    createdAt: string
  }): Promise<void>
  updateCommunityPostProjectionStatus(input: {
    postId: string
    status: CommunityPostProjectionRow["status"]
    updatedAt: string
  }): Promise<void>
  updateCommunityPostProjectionMetrics(input: {
    postId: string
    upvoteCount: number
    downvoteCount: number
    commentCount: number
    likeCount: number
    updatedAt: string
  }): Promise<void>
  createCommunityProvisioningRequest(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    creatorUserId: string
    displayName: string
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    routeSlug?: string | null
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
    jobId: string
    namespaceVerificationId: string
    routeSlug: string
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

  async getCommunityByRouteSlug(routeSlug: string): Promise<CommunityRow | null> {
    return getCommunityByRouteSlug(this.client, routeSlug)
  }

  async getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null> {
    return getCommunityByNamespaceVerificationId(this.client, namespaceVerificationId)
  }

  async listActiveCommunities(): Promise<CommunityRow[]> {
    return listActiveCommunities(this.client)
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

  async getCommunityCommentProjectionByCommentId(commentId: string): Promise<CommunityCommentProjectionRow | null> {
    return getCommunityCommentProjectionByCommentId(this.client, commentId)
  }

  async listCommunityMembershipProjectionsByUserId(userId: string): Promise<CommunityMembershipProjectionRow[]> {
    return listCommunityMembershipProjectionRowsByUserId(this.client, userId)
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

  async recordCommunityCommentProjection(input: {
    communityId: string
    threadRootPostId: string
    sourceCommentId: string
    parentCommentId: string | null
    depth: number
    status: "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    actorUserId: string
    createdAt: string
  }): Promise<CommunityCommentProjectionRow> {
    return recordCommunityCommentProjection(this.client, input)
  }

  async upsertCommunityMembershipProjection(input: {
    communityId: string
    userId: string
    membershipState: CommunityMembershipProjectionRow["membership_state"]
    sourceUpdatedAt: string
    createdAt: string
  }): Promise<void> {
    return upsertCommunityMembershipProjection(this.client, input)
  }

  async updateCommunityPostProjectionStatus(input: {
    postId: string
    status: CommunityPostProjectionRow["status"]
    updatedAt: string
  }): Promise<void> {
    return updateCommunityPostProjectionStatus(this.client, input)
  }

  async updateCommunityPostProjectionMetrics(input: {
    postId: string
    upvoteCount: number
    downvoteCount: number
    commentCount: number
    likeCount: number
    updatedAt: string
  }): Promise<void> {
    return updateCommunityPostProjectionMetrics(this.client, input)
  }

  async createCommunityProvisioningRequest(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    creatorUserId: string
    displayName: string
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    routeSlug?: string | null
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
    jobId: string
    namespaceVerificationId: string
    routeSlug: string
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
