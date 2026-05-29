import type { Client } from "../sql-client"
import { getControlPlaneClient } from "../runtime-deps"
import {
  getCommunityCommentProjectionRowByCommentId,
  listCommunityFollowProjectionRowsByUserId,
  getCommunityPostProjectionRowByPostId,
  listCommunityMembershipProjectionRowsByUserId,
} from "../auth/auth-db-community-queries"
import type {
  CommunityCommentProjectionRow,
  CommunityDbCredentialRow,
  CommunityDatabaseBindingRow,
  CommunityFollowProjectionRow,
  CommunityMembershipProjectionRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "../auth/auth-db-rows"
import type {
  CommunityRepository,
  InitialCommunityDatabaseBinding,
} from "./community-repository-types"
import type { Env } from "../../env"

export type {
  CommunityCommentProjectionRepository,
  CommunityDatabaseBindingRepository,
  CommunityJobReadRepository,
  CommunityMembershipProjectionRepository,
  CommunityMutationRepository,
  CommunityPostProjectionRepository,
  CommunityProvisioningRepository,
  CommunityReadRepository,
  CommunityRepository,
  CommunityRepositoryLifecycle,
} from "./community-repository-types"

export {
  getCommunityById,
  getCommunityByIdentifierCandidates,
  getCommunityByRouteSlug,
  getCommunityByNamespaceVerificationId,
  listActiveCommunities,
  searchActiveCommunities,
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
} from "./provisioning/repository"

export { recordCommunityPostProjection } from "./community-post-projection-repository"
export {
  updateCommunityPostProjectionMetrics,
  updateCommunityPostProjectionPayload,
  updateCommunityPostProjectionStatus,
} from "./community-post-projection-repository"
export { recordCommunityCommentProjection } from "./community-comment-projection-repository"
export {
  incrementCommunityFollowerCount,
  setCommunityFollowerCount,
  upsertCommunityFollowProjection,
  upsertCommunityMembershipProjection,
} from "./membership/projection-repository"

export {
  attachNamespaceToCommunity,
  setPendingNamespaceVerificationSession,
} from "./community-mutation-repository"

import {
  getCommunityById,
  getCommunityByIdentifierCandidates,
  getCommunityByRouteSlug,
  getCommunityByNamespaceVerificationId,
  listActiveCommunities,
  searchActiveCommunities,
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
} from "./provisioning/repository"
import {
  recordCommunityPostProjection,
  updateCommunityPostProjectionMetrics,
  updateCommunityPostProjectionPayload,
  updateCommunityPostProjectionStatus,
} from "./community-post-projection-repository"
import { recordCommunityCommentProjection } from "./community-comment-projection-repository"
import {
  incrementCommunityFollowerCount,
  setCommunityFollowerCount,
  upsertCommunityFollowProjection,
  upsertCommunityMembershipProjection,
} from "./membership/projection-repository"
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

export async function listCommunityFollowProjectionsByUserId(
  client: Client,
  userId: string,
): Promise<CommunityFollowProjectionRow[]> {
  return listCommunityFollowProjectionRowsByUserId(client, userId)
}

export class DatabaseCommunityRepository implements CommunityRepository {
  constructor(private readonly client: Client) {}

  close(): void | Promise<void> {
    return this.client.close?.()
  }

  async getCommunityById(communityId: string): Promise<CommunityRow | null> {
    return getCommunityById(this.client, communityId)
  }

  async getCommunityByRouteSlug(routeSlug: string): Promise<CommunityRow | null> {
    return getCommunityByRouteSlug(this.client, routeSlug)
  }

  async getCommunityByIdentifierCandidates(candidates: string[]): Promise<CommunityRow | null> {
    return getCommunityByIdentifierCandidates(this.client, candidates)
  }

  async updateCommunitySeoProjection(input: {
    communityId: string
    description: string | null
    avatarRef: string | null
    bannerRef: string | null
    updatedAt: string
  }): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE communities
        SET description = ?2,
            avatar_ref = ?3,
            banner_ref = ?4,
            updated_at = ?5
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.description, input.avatarRef, input.bannerRef, input.updatedAt],
    })
  }

  async getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null> {
    return getCommunityByNamespaceVerificationId(this.client, namespaceVerificationId)
  }

  async listActiveCommunities(input?: {
    limit?: number
  }): Promise<CommunityRow[]> {
    return listActiveCommunities(this.client, input)
  }

  async searchActiveCommunities(input: {
    query: string
    limit: number
  }): Promise<CommunityRow[]> {
    return searchActiveCommunities(this.client, input)
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

  async listCommunityFollowProjectionsByUserId(userId: string): Promise<CommunityFollowProjectionRow[]> {
    return listCommunityFollowProjectionRowsByUserId(this.client, userId)
  }

  async recordCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song" | "crosspost"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    visibility: "public" | "members_only"
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

  async upsertCommunityFollowProjection(input: {
    communityId: string
    userId: string
    followState: CommunityFollowProjectionRow["follow_state"]
    sourceUpdatedAt: string
    unfollowedAt: string | null
    createdAt: string
  }): Promise<void> {
    return upsertCommunityFollowProjection(this.client, input)
  }

  async incrementCommunityFollowerCount(input: {
    communityId: string
    delta: 1 | -1
    updatedAt: string
  }): Promise<void> {
    return incrementCommunityFollowerCount(this.client, input)
  }

  async setCommunityFollowerCount(input: {
    communityId: string
    followerCount: number
    updatedAt: string
  }): Promise<void> {
    return setCommunityFollowerCount(this.client, input)
  }

  async updateCommunityPostProjectionStatus(input: {
    postId: string
    status: CommunityPostProjectionRow["status"]
    updatedAt: string
  }): Promise<void> {
    return updateCommunityPostProjectionStatus(this.client, input)
  }

  async updateCommunityPostProjectionPayload(input: {
    postId: string
    projectedPayloadJson: string
    updatedAt: string
  }): Promise<void> {
    return updateCommunityPostProjectionPayload(this.client, input)
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
    description?: string | null
    avatarRef?: string | null
    bannerRef?: string | null
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    routeSlug?: string | null
    binding: InitialCommunityDatabaseBinding
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
    binding: InitialCommunityDatabaseBinding
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
    description?: string | null
    avatarRef?: string | null
    bannerRef?: string | null
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
