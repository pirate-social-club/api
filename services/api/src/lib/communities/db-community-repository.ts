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
  CommunityDatabaseBindingRow,
  CommunityFollowProjectionRow,
  CommunityMembershipProjectionRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "../auth/auth-db-rows"
import type {
  CommunityNamespaceAttachmentRow,
  CommunityRepository,
  InitialCommunityDatabaseBinding,
} from "./community-repository-types"
import type { Post } from "../../types"
import type { Env } from "../../env"

export type {
  CommunityCommentProjectionRepository,
  CommunityDatabaseBindingRepository,
  CommunityJobReadRepository,
  CommunityMembershipProjectionRepository,
  CommunityMutationRepository,
  CommunityNamespaceReadRepository,
  CommunityPostProjectionRepository,
  CommunityProvisioningRepository,
  CommunityReadRepository,
  CommunityRepository,
} from "./community-repository-types"

// `getJobById` is the only re-export consumed through this barrel
// (src/lib/onboarding/db-reddit-onboarding-repository.ts). Every other read,
// provisioning, projection, and mutation helper is imported directly from its
// source module, so they are not re-exported here.
export { getJobById } from "./community-read-repository"

import {
  getCommunityById,
  getCommunityByIdentifierCandidates,
  getCommunityByRouteSlug,
  getCommunityByNamespaceVerificationId,
  listActiveCommunities,
  searchActiveCommunities,
  getPrimaryCommunityDatabaseBinding,
  getJobById,
  getLatestCommunityProvisioningJob,
  listCommunityNamespaceAttachments,
} from "./community-read-repository"
import {
  upsertD1CommunityRoutingRow as upsertD1CommunityRoutingRowRaw,
  listSettlementEligibleCommunities,
  type SettlementEligibleCommunity,
} from "./community-routing-repository"
import { persistProvisionedD1Binding as persistProvisionedD1BindingRaw } from "./provisioning/repository"
import {
  createCommunityProvisioningRequest,
  retryCommunityProvisioningRequest,
  markCommunityProvisioningSucceeded,
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
  setCommunityLifecycleStatus,
} from "./community-mutation-repository"

// Internal helpers for the repository class below (the projection-by-id lookups
// are not exported — callers go through DatabaseCommunityRepository).
async function getCommunityPostProjectionByPostId(
  client: Client,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  return getCommunityPostProjectionRowByPostId(client, postId)
}

async function getCommunityCommentProjectionByCommentId(
  client: Client,
  commentId: string,
): Promise<CommunityCommentProjectionRow | null> {
  return getCommunityCommentProjectionRowByCommentId(client, commentId)
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

  async listCommunityNamespaceAttachments(communityId: string): Promise<CommunityNamespaceAttachmentRow[]> {
    return listCommunityNamespaceAttachments(this.client, communityId)
  }

  async listActiveCommunities(input?: {
    limit?: number
    requireReadyRouting?: boolean
  }): Promise<CommunityRow[]> {
    return listActiveCommunities(this.client, input)
  }

  // Settlement-capable routes only (ready D1, not decommissioned). Used by the
  // unattended booking-settlement cron so it never enumerates decommissioned
  // or not-yet-ready communities (which cannot settle and would only emit errors).
  async listSettlementEligibleCommunities(input?: {
    limit?: number
  }): Promise<SettlementEligibleCommunity[]> {
    return listSettlementEligibleCommunities(this.client, input)
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
    status: Post["status"]
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
    communityNamespaceBindingId: string
    communityId: string
    namespaceVerificationId: string
    namespaceRole: "primary" | "mirror"
    replacesNamespaceVerificationId?: string
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

  async setCommunityLifecycleStatus(input: {
    communityId: string
    targetStatus: CommunityRow["status"]
    allowedFromStatuses: readonly CommunityRow["status"][]
    updatedAt: string
  }): Promise<CommunityRow> {
    return setCommunityLifecycleStatus(this.client, input)
  }

  // d1_native provisioning orchestrator helpers (step 4 of the D1-native
  // workstream). See D1-NATIVE-PROVISIONING-DESIGN.md §3, §4.

  async upsertD1CommunityRoutingRow(input: {
    communityId: string
    shardWorkerId: string
    bindingName: string
    region: string
    now: string
    provisioningState?: "provisioning" | "ready" | "degraded" | "decommissioned"
  }): Promise<{ written: boolean }> {
    return upsertD1CommunityRoutingRowRaw(this.client, input)
  }

  async persistProvisionedD1Binding(input: {
    communityDatabaseBindingId: string
    bindingName: string
    databaseUrl: string
    region: string
    updatedAt: string
  }): Promise<void> {
    return persistProvisionedD1BindingRaw(this.client, input)
  }
}

export function getCommunityRepository(env: Env): CommunityRepository {
  return new DatabaseCommunityRepository(getControlPlaneClient(env))
}
