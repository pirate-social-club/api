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

export interface CommunityRepositoryLifecycle {
  close?(): void | Promise<void>
}

export interface CommunityReadRepository {
  getCommunityById(communityId: string): Promise<CommunityRow | null>
  getCommunityByRouteSlug(routeSlug: string): Promise<CommunityRow | null>
  getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null>
  listActiveCommunities(): Promise<CommunityRow[]>
}

export interface CommunityDatabaseBindingRepository {
  getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null>
  getActiveCommunityDbCredential(communityDatabaseBindingId: string): Promise<CommunityDbCredentialRow | null>
}

export interface CommunityJobReadRepository {
  getJobById(jobId: string): Promise<JobRow | null>
  getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null>
}

export type CommunityProvisioningMode = "local_dev" | "turso_operator"

export type InitialCommunityDatabaseBinding = {
  organizationSlug: string
  groupName: string
  groupId: string | null
  databaseName: string
  databaseId: string | null
  databaseUrl: string
  location: string | null
  requiresCredentials: boolean
  provisioningMode: CommunityProvisioningMode
}

export interface CommunityPostProjectionRepository {
  getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null>
  recordCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    visibility: "public" | "members_only"
    sourceCreatedAt: string
    projectedPayloadJson: string
    actorUserId: string
    createdAt: string
  }): Promise<CommunityPostProjectionRow>
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
}

export interface CommunityCommentProjectionRepository {
  getCommunityCommentProjectionByCommentId(commentId: string): Promise<CommunityCommentProjectionRow | null>
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
}

export interface CommunityMembershipProjectionRepository {
  listCommunityMembershipProjectionsByUserId(userId: string): Promise<CommunityMembershipProjectionRow[]>
  listCommunityFollowProjectionsByUserId(userId: string): Promise<CommunityFollowProjectionRow[]>
  upsertCommunityMembershipProjection(input: {
    communityId: string
    userId: string
    membershipState: CommunityMembershipProjectionRow["membership_state"]
    sourceUpdatedAt: string
    createdAt: string
  }): Promise<void>
  upsertCommunityFollowProjection(input: {
    communityId: string
    userId: string
    followState: CommunityFollowProjectionRow["follow_state"]
    sourceUpdatedAt: string
    unfollowedAt: string | null
    createdAt: string
  }): Promise<void>
  incrementCommunityFollowerCount(input: {
    communityId: string
    delta: 1 | -1
    updatedAt: string
  }): Promise<void>
  setCommunityFollowerCount(input: {
    communityId: string
    followerCount: number
    updatedAt: string
  }): Promise<void>
}

export interface CommunityProvisioningRepository {
  createCommunityProvisioningRequest(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    creatorUserId: string
    displayName: string
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    routeSlug?: string | null
    binding: InitialCommunityDatabaseBinding
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
    binding: InitialCommunityDatabaseBinding
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
}

export interface CommunityMutationRepository {
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

export interface CommunityRepository
  extends CommunityRepositoryLifecycle,
    CommunityReadRepository,
    CommunityDatabaseBindingRepository,
    CommunityJobReadRepository,
    CommunityPostProjectionRepository,
    CommunityCommentProjectionRepository,
    CommunityMembershipProjectionRepository,
    CommunityProvisioningRepository,
    CommunityMutationRepository {}
