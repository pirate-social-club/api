import type { CommunityRepository } from "../db-community-repository"

export const COMMUNITY_JOB_MAX_ATTEMPTS = 8
export const COMMUNITY_JOB_RETRY_BASE_MS = 30_000
export const COMMUNITY_JOB_RETRY_MAX_MS = 30 * 60_000
export const THREAD_SNAPSHOT_MIN_INTERVAL_MS = 60_000

export type CommunityJobRepository = Pick<
  CommunityRepository,
  | "getCommunityById"
  | "listActiveCommunities"
  | "getPrimaryCommunityDatabaseBinding"
  | "getActiveCommunityDbCredential"
  | "recordCommunityCommentProjection"
  | "getCommunityCommentProjectionByCommentId"
>
