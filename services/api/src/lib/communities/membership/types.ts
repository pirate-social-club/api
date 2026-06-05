import type {
  CommunityDatabaseBindingRepository,
  CommunityJobReadRepository,
  CommunityMembershipProjectionRepository,
  CommunityMutationRepository,
  CommunityReadRepository,
} from "../db-community-repository"

export type MembershipResult = {
  community: string
  status: "joined" | "requested" | "left"
}

export type CommunityFollowResult = {
  community: string
  following: boolean
  follower_count: number | null
}

export type CommunityMembershipRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & CommunityMembershipProjectionRepository
  & CommunityMutationRepository
  & CommunityJobReadRepository

export type CommunityMembershipProjectionReconciliationSummary = {
  checked_communities: number
  synced_membership_projections: number
  synced_follow_projections: number
  corrected_follower_counts: number
  failed_communities: number
}
